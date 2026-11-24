// POST /api/admin/email/preview : l'aperçu rend le pied de page qui partira réellement.
// Le seul chemin d'envoi de masse (POST /send) est commercial : `renderTemplate(code, …, {marketing:true})`
// avec un code, `renderRaw(…, {footer:'marketing'})` sans code. Les codes critiques gardent le pied « compte ».

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-emailpreview-'));
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
const BASE = `http://127.0.0.1:${server.address().port}/api/admin/email`;

const uid = Number(db.prepare(`INSERT INTO users (email, password_hash, display_name, role) VALUES ('admin@exemple.test', 'x', 'Admin', 'admin')`).run().lastInsertRowid);
const sid = crypto.randomBytes(16).toString('hex');
db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run(sid, uid, new Date(Date.now() + 3600e3).toISOString());
const cookie = `${config.cookieName}=${sid}`;

const preview = async (body) => {
  const res = await fetch(`${BASE}/preview`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const COMMERCIAL = /Vous recevez cet e-mail car vous avez accepté de recevoir nos actualités/;
const SERVICE = /E-mail de service lié à votre compte/;

test('aperçu d\'une campagne ponctuelle (sujet + corps libres) : pied commercial, comme à l\'envoi', async () => {
  const r = await preview({ subject: 'Offre de rentrée', body_html: '<p>Bonjour {{first_name}}</p>' });
  assert.equal(r.status, 200);
  assert.match(r.json.html, COMMERCIAL);
  assert.doesNotMatch(r.json.html, SERVICE);
});

test('aperçu d\'un gabarit à code avant une campagne : pied commercial ; codes critiques : pied de service', async () => {
  const conf = await preview({ code: 'booking_confirmation' });
  assert.match(conf.json.html, COMMERCIAL);
  assert.doesNotMatch(conf.json.html, SERVICE);
  for (const code of ['password_reset', 'email_verification']) {
    const r = await preview({ code });
    assert.match(r.json.html, SERVICE, code);
    assert.doesNotMatch(r.json.html, COMMERCIAL, code);
  }
  assert.equal((await preview({ code: 'inexistant' })).status, 404);
});
