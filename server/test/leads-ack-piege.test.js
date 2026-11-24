// POST /api/leads : le champ piège (`website`) ne doit être un oracle ni par le statut, ni par le
// corps, ni au fil des requêtes. Pour une même série de requêtes sur une même adresse, la réponse
// avec champ piège est identique, champ pour champ, à celle du chemin nominal.
// Fichier à part : limiteur par IP propre à chaque processus (on varie l'IP via X-Forwarded-For).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-leadack-piege-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const { db } = await import('../src/db.js');
const { default: express } = await import('express');
const { leadsRouter } = await import('../src/routes/leads.js');
const settings = await import('../src/lib/settings.js');
const { LEAD_SUBJECTS } = await import('../src/lib/prospects.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/api', leadsRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(() => { server.close(); });
const URL_LEADS = `http://127.0.0.1:${server.address().port}/api/leads`;

const realFetch = globalThis.fetch;
let ipSeq = 0;
const post = async (body) => {
  ipSeq += 1;
  const res = await realFetch(URL_LEADS, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${ipSeq}` }, body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
};
const lead = (email, over = {}) => ({
  first_name: 'Camille', last_name: 'Durand', email, phone: '0600000000',
  activity: 'independant', subject: LEAD_SUBJECTS[0], message: 'Bonjour.', consent: true, ...over,
});
const piege = { website: 'http://spam.example' };
const serie = async (email, over = {}) => {
  const out = [];
  for (let i = 0; i < 3; i++) out.push(await post(lead(email, over)));
  return out;
};

function stubBrevo() {
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
    return { ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ messageId: '<mid@smtp-relay.mailin.fr>' }) };
  };
  return () => { globalThis.fetch = realFetch; };
}

test('sans fournisseur configuré : trois requêtes, mêmes réponses avec et sans champ piège (octet pour octet)', async () => {
  const nominal = await serie('serie.a@exemple.test');
  const trap = await serie('serie.b@exemple.test', piege);
  assert.deepEqual(nominal.map((r) => r.json), [{ ok: true, ack_sent: false }, { ok: true, ack_sent: false }, { ok: true, ack_sent: false }]);
  assert.deepEqual(trap.map((r) => [r.status, r.text]), nominal.map((r) => [r.status, r.text]));
});

test('fournisseur qui répond : true, true, puis false au plafond (2 / 24 h), identique avec et sans champ piège', async () => {
  settings.setSmtp({ from_name: 'Cazalia', from_email: 'no-reply@cazalia.test' });
  settings.setBrevo({ api_key: 'xkeysib-cle-de-test' });
  settings.setMail({ provider: 'brevo', daily_limit: 300, marketing_reserve: 30 });
  const restore = stubBrevo();
  try {
    const prospects = () => db.prepare(`SELECT COUNT(*) AS n FROM prospects`).get().n;
    const nominal = await serie('serie.c@exemple.test');
    const avant = [prospects(), db.prepare(`SELECT COUNT(*) AS n FROM email_log`).get().n];
    const trap = await serie('serie.d@exemple.test', piege);
    assert.deepEqual(nominal.map((r) => r.json.ack_sent), [true, true, false]);
    assert.deepEqual(trap.map((r) => [r.status, r.text]), nominal.map((r) => [r.status, r.text]), 'même statut et même corps, champ pour champ');
    // Le piège n'a rien enregistré ni envoyé.
    assert.deepEqual([prospects(), db.prepare(`SELECT COUNT(*) AS n FROM email_log`).get().n], avant);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM prospects WHERE email = 'serie.d@exemple.test'`).get().n, 0);

    // Casse de l'adresse sans effet : « SERIE.D@… » partage le compteur de « serie.d@… ».
    const memeAdresse = await post(lead('SERIE.D@exemple.test', piege));
    assert.equal(memeAdresse.json.ack_sent, false);

    // Gabarit absent : nominal et piège répondent `false`.
    const saved = db.prepare(`SELECT * FROM email_templates WHERE code = 'lead_ack'`).get();
    db.prepare(`DELETE FROM email_templates WHERE code = 'lead_ack'`).run();
    try {
      assert.equal((await post(lead('serie.e@exemple.test'))).json.ack_sent, false);
      assert.equal((await post(lead('serie.f@exemple.test', piege))).json.ack_sent, false);
    } finally {
      const cols = Object.keys(saved);
      db.prepare(`INSERT INTO email_templates (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(saved);
    }
  } finally { restore(); }
});
