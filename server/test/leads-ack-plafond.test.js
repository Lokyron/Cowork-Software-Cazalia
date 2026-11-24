// Plafond d'accusés de réception (2 / 24 h par adresse) : seuls les accusés
// réellement partis comptent. Fichier à part : le limiteur par IP de la route
// (6 requêtes / 10 min) est propre à chaque processus de test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-leadack-plafond-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const { db } = await import('../src/db.js');
const { default: express } = await import('express');
const { leadsRouter } = await import('../src/routes/leads.js');
const { LEAD_SUBJECTS } = await import('../src/lib/prospects.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

const app = express();
app.use(express.json());
app.use('/api', leadsRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(() => { server.close(); });
const URL_LEADS = `http://127.0.0.1:${server.address().port}/api/leads`;

const post = async (body) => {
  const res = await fetch(URL_LEADS, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const lead = (email) => ({
  first_name: 'Camille', last_name: 'Durand', email, phone: '0600000000',
  activity: 'independant', subject: LEAD_SUBJECTS[0], message: 'Bonjour.', consent: true,
});
const ackRows = (mail) => db.prepare(`SELECT * FROM email_log WHERE template_code = 'lead_ack' AND lower(to_email) = ?`).all(mail);
const insLog = db.prepare(`INSERT INTO email_log (to_email, template_code, subject, status) VALUES (?, 'lead_ack', 'x', ?)`);

test('des accusés « skipped » ou « failed » ne comptent pas dans le plafond : le visiteur reçoit un nouvel essai', async () => {
  const mail = 'legitime@exemple.test';
  insLog.run(mail, 'skipped'); insLog.run(mail, 'skipped'); insLog.run(mail, 'failed');

  const r = await post(lead(mail));
  assert.equal(r.status, 201);
  // Une 4e ligne est apparue : l'envoi a été tenté (« skipped » ici, aucun fournisseur en test).
  assert.equal(ackRows(mail).length, 4);
});

test('deux accusés réellement partis (« sent », « delivered ») bloquent toujours le 3e', async () => {
  const mail = 'arrosee@exemple.test';
  insLog.run(mail, 'sent'); insLog.run(mail, 'delivered');

  const r = await post(lead(mail));
  assert.equal(r.status, 201);
  assert.equal(r.json.ack_sent, false);
  assert.equal(ackRows(mail).length, 2);
});
