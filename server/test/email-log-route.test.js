// GET /api/admin/email/log : filtres, bornes de pagination, cohérence de `total`
// et maintien du contrôle d'accès administrateur.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-emaillog-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const { db } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { default: express } = await import('express');
const { default: cookieParser } = await import('cookie-parser');
const { attachUser } = await import('../src/middleware.js');
const { emailsRouter } = await import('../src/routes/emails.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(attachUser);
app.use('/api/admin/email', emailsRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(() => { server.close(); });
const BASE = `http://127.0.0.1:${server.address().port}/api/admin/email/log`;

let seq = 0;
const makeUser = (role) => {
  seq += 1;
  return Number(db.prepare(
    `INSERT INTO users (email, password_hash, display_name, role) VALUES (?, 'x', ?, ?)`
  ).run(`u${seq}@exemple.test`, `Utilisateur ${seq}`, role).lastInsertRowid);
};
const sessionCookie = (uid) => {
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run(id, uid, new Date(Date.now() + 3600e3).toISOString());
  return `${config.cookieName}=${id}`;
};
const admin = sessionCookie(makeUser('admin'));
const member = sessionCookie(makeUser('member'));

const get = async (query = '', cookie = admin) => {
  const res = await fetch(`${BASE}${query}`, { headers: cookie ? { cookie } : {} });
  return { status: res.status, json: await res.json() };
};

// Jeu de données : 250 envois « bourrage » + quelques lignes aux propriétés distinctes.
db.exec(`DELETE FROM email_log`);
const ins = db.prepare(`INSERT INTO email_log (to_email, template_code, subject, status) VALUES (?, ?, 'x', ?)`);
for (let i = 0; i < 250; i++) ins.run(`bourrage${i}@cazalia.test`, 'booking_confirmation', 'sent');
ins.run('Marie.Dupont@Exemple.test', 'password_reset', 'sent');
ins.run('marie.durand@exemple.test', 'manual', 'failed');
ins.run('jo%joker@exemple.test', 'manual', 'sent');
ins.run('joXjoker@exemple.test', 'manual', 'sent');
ins.run('a_b@exemple.test', 'lead_ack', 'skipped');
ins.run('aXb@exemple.test', 'lead_ack', 'skipped');
const TOTAL = 256;

test('accès : anonyme refusé (401), membre refusé (403), administrateur accepté', async () => {
  assert.equal((await get('', null)).status, 401);
  assert.equal((await get('', member)).status, 403);
  const ok = await get();
  assert.equal(ok.status, 200);
  assert.equal(ok.json.total, TOTAL);
});

test('filtre email : partiel, insensible à la casse', async () => {
  const r = await get('?email=MARIE.d');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.log.map((l) => l.to_email).sort(), ['Marie.Dupont@Exemple.test', 'marie.durand@exemple.test']);
  assert.equal(r.json.total, 2);
  assert.equal((await get('?email=du%70ont')).json.total, 1); // « dupont » décodé
});

test('filtre email : « % » et « _ » sont littéraux, jamais des jokers', async () => {
  const pct = await get(`?email=${encodeURIComponent('jo%joker')}`);
  assert.deepEqual(pct.json.log.map((l) => l.to_email), ['jo%joker@exemple.test']);
  assert.equal(pct.json.total, 1);
  const und = await get(`?email=${encodeURIComponent('a_b')}`);
  assert.deepEqual(und.json.log.map((l) => l.to_email), ['a_b@exemple.test']);
  assert.equal((await get(`?email=${encodeURIComponent('%')}`)).json.total, 1); // seule adresse contenant « % »
});

test('filtres status et template_code, seuls et combinés', async () => {
  const failed = await get('?status=failed');
  assert.equal(failed.json.total, 1);
  assert.equal(failed.json.log[0].to_email, 'marie.durand@exemple.test');
  assert.equal((await get('?template_code=manual')).json.total, 3);
  const both = await get('?template_code=manual&status=sent');
  assert.equal(both.json.total, 2);
  assert.ok(both.json.log.every((l) => l.template_code === 'manual' && l.status === 'sent'));
  const none = await get('?status=inexistant');
  assert.deepEqual([none.json.total, none.json.log.length], [0, 0]);
});

test('limit : défaut 100, bornes 1-200, valeurs absurdes ramenées au défaut', async () => {
  assert.equal((await get()).json.log.length, 100);
  assert.equal((await get()).json.limit, 100);
  assert.equal((await get('?limit=5')).json.log.length, 5);
  assert.equal((await get('?limit=1000')).json.limit, 200);
  assert.equal((await get('?limit=1000')).json.log.length, 200);
  assert.equal((await get('?limit=-3')).json.limit, 1);
  assert.equal((await get('?limit=abc')).json.limit, 100);
  assert.equal((await get('?limit=0')).json.limit, 1); // 0 est une vraie valeur : ramenée à la borne basse
  assert.equal((await get('?limit=')).json.limit, 100); // vide : défaut
  for (const bad of ['1e400', '1e20', '-1e400', 'NaN', 'Infinity']) {
    const r = await get(`?limit=${bad}`);
    assert.equal(r.status, 200, `limit=${bad}`);
    assert.ok(r.json.limit >= 1 && r.json.limit <= 200, `limit=${bad}`);
  }
});

test('offset : négatif, non numérique, 1e400 et 1e20 ne provoquent jamais de 500', async () => {
  assert.equal((await get('?offset=-7')).json.offset, 0);
  assert.equal((await get('?offset=abc')).json.offset, 0);
  assert.equal((await get('?offset=2.9')).json.offset, 2);
  for (const bad of ['1e400', '-1e400', '1e20', '1e308', 'Infinity', 'NaN', '9007199254740993']) {
    const r = await get(`?offset=${bad}`);
    assert.equal(r.status, 200, `offset=${bad}`);
    assert.ok(Number.isSafeInteger(r.json.offset) && r.json.offset >= 0, `offset=${bad}`);
    assert.equal(r.json.total, TOTAL, `offset=${bad}`);
  }
  // Paramètre répété (tableau) : ignoré, pas d'exception.
  assert.equal((await get('?offset=1&offset=2')).status, 200);
});

test('pagination : `total` suit le WHERE, indépendamment de limit/offset', async () => {
  const p1 = await get('?limit=100&offset=0');
  const p3 = await get('?limit=100&offset=200');
  assert.equal(p1.json.total, TOTAL);
  assert.equal(p3.json.total, TOTAL);
  assert.equal(p3.json.log.length, TOTAL - 200);
  // Pages disjointes, ordre décroissant d'id.
  const ids = [...p1.json.log, ...(await get('?limit=100&offset=100')).json.log, ...p3.json.log].map((l) => l.id);
  assert.equal(new Set(ids).size, TOTAL);
  assert.deepEqual([...ids].sort((a, b) => b - a), ids);
  // Filtre + pagination : le total reste celui du filtre, même au-delà de la dernière page.
  const filtered = await get('?template_code=manual&limit=1&offset=1');
  assert.equal(filtered.json.total, 3);
  assert.equal(filtered.json.log.length, 1);
  const beyond = await get('?template_code=manual&offset=50');
  assert.equal(beyond.json.total, 3);
  assert.equal(beyond.json.log.length, 0);
});
