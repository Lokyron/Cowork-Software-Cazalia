// POST /api/leads : accusé réellement remis (`ack_sent: true`) et indiscernabilité du
// champ piège. Fichier à part : le limiteur par IP de la route (6 requêtes / 10 min)
// est propre à chaque processus de test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-leadack-envoi-'));
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
app.use(express.json());
app.use('/api', leadsRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(() => { server.close(); });
const URL_LEADS = `http://127.0.0.1:${server.address().port}/api/leads`;

const realFetch = globalThis.fetch;
const post = async (body) => {
  const res = await realFetch(URL_LEADS, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const lead = (over = {}) => ({
  first_name: 'Camille', last_name: 'Durand', email: 'camille@exemple.test', phone: '0600000000',
  activity: 'independant', subject: LEAD_SUBJECTS[0], message: 'Bonjour.', consent: true, ...over,
});
const count = (sql) => db.prepare(sql).get().n;

/** Doublure de `fetch` : Brevo répond « envoyé » ; les appels vers le serveur de test passent. */
function stubBrevo() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
    calls.push({ url: String(url), opts });
    return { ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ messageId: `<mid-${calls.length}@smtp-relay.mailin.fr>` }) };
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('fournisseur qui réussit : 201 { ok:true, ack_sent:true }, accusé adressé au visiteur et journalisé « sent »', async () => {
  settings.setSmtp({ from_name: 'Cazalia', from_email: 'no-reply@cazalia.test' });
  settings.setBrevo({ api_key: 'xkeysib-cle-de-test' });
  settings.setMail({ provider: 'brevo', daily_limit: 300, marketing_reserve: 30 });
  const stub = stubBrevo();
  try {
    const r = await post(lead());
    assert.equal(r.status, 201);
    assert.deepEqual(r.json, { ok: true, ack_sent: true });
    const ack = db.prepare(`SELECT * FROM email_log WHERE template_code = 'lead_ack'`).all();
    assert.equal(ack.length, 1);
    assert.equal(ack[0].status, 'sent');
    assert.equal(ack[0].to_email, 'camille@exemple.test');
    assert.ok(stub.calls.length >= 2, 'notification à la gérante + accusé au visiteur');
  } finally { stub.restore(); }
});

test('champ piège : même réponse qu\'un envoi nominal, y compris pour les charges invalides ; rien n\'est enregistré ni envoyé', async () => {
  const stub = stubBrevo();
  try {
    const prospects = count(`SELECT COUNT(*) AS n FROM prospects`);
    const logs = count(`SELECT COUNT(*) AS n FROM email_log`);
    const website = 'http://spam.example';

    // Chaque charge invalide : mêmes statut et erreur avec et sans champ piège.
    for (const [nom, over] of [
      ['e-mail mal formé', { email: 'pas-un-email' }],
      ['consentement absent', { consent: false }],
    ]) {
      const sans = await post(lead(over));
      const avec = await post(lead({ ...over, website }));
      assert.equal(sans.status, 400, nom);
      assert.deepEqual(avec, sans, `${nom} : le champ piège ne change pas la réponse`);
    }

    // Charge valide + piège : 201 { ok:true, ack_sent:true }, comme un envoi nominal réussi.
    const piege = await post(lead({ email: 'robot@exemple.test', website }));
    assert.equal(piege.status, 201);
    assert.deepEqual(piege.json, { ok: true, ack_sent: true });

    assert.equal(count(`SELECT COUNT(*) AS n FROM prospects`), prospects);
    assert.equal(count(`SELECT COUNT(*) AS n FROM email_log`), logs);
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});
