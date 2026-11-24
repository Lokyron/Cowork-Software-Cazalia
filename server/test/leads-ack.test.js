// Accusé de réception du formulaire de contact + résolution de l'expéditeur.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-leadack-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';
delete process.env.SMTP_FROM;

const { db } = await import('../src/db.js');
const { default: express } = await import('express');
const { leadsRouter } = await import('../src/routes/leads.js');
const { getSmtp, parseFromAddress, setSetting } = await import('../src/lib/settings.js');
const { LEAD_SUBJECTS } = await import('../src/lib/prospects.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

const app = express();
app.set('trust proxy', true); // permet de varier l'IP vue par le limiteur (X-Forwarded-For)
app.use(express.json());
app.use('/api', leadsRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(() => { server.close(); });
const URL_LEADS = `http://127.0.0.1:${server.address().port}/api/leads`;

const post = async (body, ip) => {
  const headers = { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) };
  const res = await fetch(URL_LEADS, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const lead = (over = {}) => ({
  first_name: 'Camille', last_name: 'Durand', email: 'camille@exemple.test', phone: '0600000000',
  activity: 'independant', subject: LEAD_SUBJECTS[0], message: 'Bonjour, je voudrais visiter.', consent: true, ...over,
});
const logs = (code) => db.prepare(`SELECT * FROM email_log WHERE template_code = ? ORDER BY id`).all(code);

test('le template lead_ack est semé et mentionne sujet et message', () => {
  const t = db.prepare(`SELECT body_html FROM email_templates WHERE code = 'lead_ack'`).get();
  assert.ok(t);
  assert.match(t.body_html, /\{\{lead_subject\}\}/);
  assert.match(t.body_html, /\{\{lead_message\}\}/);
  assert.ok(db.prepare(`SELECT 1 FROM email_templates WHERE code = 'email_verification'`).get());
});

test('un envoi valide : 201, prospect enregistré, accusé de réception adressé au visiteur', async () => {
  const r = await post(lead());
  assert.equal(r.status, 201);
  // Aucun fournisseur d'e-mail en test : l'accusé est journalisé « skipped », donc non remis.
  assert.deepEqual(r.json, { ok: true, ack_sent: false });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM prospects WHERE email = 'camille@exemple.test'`).get().n, 1);
  const ack = logs('lead_ack');
  assert.equal(ack.length, 1);
  assert.equal(ack[0].to_email, 'camille@exemple.test');
  assert.equal(logs('lead_notification').length, 1); // la notification à la gérante est conservée
});

test('plafond par adresse : au plus 2 accusés par 24 h, le prospect et la notification restent enregistrés', async () => {
  // Le limiteur par IP (6 requêtes) borne les appels de ce fichier : deux accusés
  // déjà journalisés pour l'adresse sont posés directement en base.
  const mail = 'victime@exemple.test';
  const insLog = db.prepare(`INSERT INTO email_log (to_email, template_code, subject, status) VALUES (?, 'lead_ack', 'x', 'sent')`);
  insLog.run(mail); insLog.run(mail.toUpperCase()); // la casse ne contourne pas le plafond
  const notifBefore = logs('lead_notification').length;

  const r = await post(lead({ email: mail }));
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, { ok: true, ack_sent: false }); // plafond atteint : accusé omis, et le dit
  assert.equal(logs('lead_ack').filter((l) => l.to_email.toLowerCase() === mail).length, 2); // aucun 3e accusé
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM prospects WHERE email = ?`).get(mail).n, 1);
  assert.equal(logs('lead_notification').length, notifBefore + 1); // la gérante est toujours notifiée

  // Passé 24 h, l'adresse peut de nouveau recevoir un accusé.
  db.prepare(`UPDATE email_log SET created_at = datetime('now', '-25 hours') WHERE template_code = 'lead_ack' AND lower(to_email) = ?`).run(mail);
  const r2 = await post(lead({ email: mail }));
  assert.equal(r2.status, 201);
  assert.equal(logs('lead_ack').filter((l) => l.to_email.toLowerCase() === mail).length, 3); // un nouvel accusé est parti
});

test('honeypot rempli + charge valide : 201 factice, rien d\'enregistré, AUCUN e-mail', async () => {
  const before = db.prepare(`SELECT COUNT(*) AS n FROM email_log`).get().n;
  const r = await post(lead({ email: 'robot@exemple.test', website: 'http://spam.example' }));
  assert.equal(r.status, 201);
  // Le honeypot répond ce que le chemin nominal aurait répondu : ici aucun fournisseur n'est configuré,
  // l'accusé nominal serait « skipped », donc `ack_sent: false` (cf. leads-ack-piege.test.js pour la série).
  assert.deepEqual(r.json, { ok: true, ack_sent: false });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM prospects WHERE email = 'robot@exemple.test'`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_log`).get().n, before);

  // Charge INVALIDE + champ piège : 400 comme un envoi nominal (sinon un robot distinguerait
  // le piège d'un envoi réel). IP distincte : le limiteur de la route (6 requêtes) est épuisé
  // par les autres tests du fichier ; e-mail mal formé et consentement absent sont couverts
  // dans leads-ack-envoi.test.js.
  const prospectsBefore = db.prepare(`SELECT COUNT(*) AS n FROM prospects`).get().n;
  const invalide = await post(lead({ email: 'robot2@exemple.test', subject: 'Sujet inventé', website: 'http://spam.example' }), '203.0.113.9');
  assert.equal(invalide.status, 400);
  assert.equal(invalide.json.error, 'SUJET_INVALIDE');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM prospects`).get().n, prospectsBefore);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_log`).get().n, before);
});

test('gabarit lead_ack absent : 201 et prospect enregistrés, MAIS une ligne « skipped / TEMPLATE_INTROUVABLE » est journalisée', async () => {
  const saved = db.prepare(`SELECT * FROM email_templates WHERE code = 'lead_ack'`).get();
  db.prepare(`DELETE FROM email_templates WHERE code = 'lead_ack'`).run(); // rendu impossible
  try {
    const r = await post(lead({ email: 'sans.ack@exemple.test' }));
    assert.equal(r.status, 201);
    assert.deepEqual(r.json, { ok: true, ack_sent: false });
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM prospects WHERE email = 'sans.ack@exemple.test'`).get().n, 1);
    const rows = logs('lead_ack').filter((l) => l.to_email === 'sans.ack@exemple.test');
    assert.equal(rows.length, 1, "l'omission de l'accusé laisse une trace dans email_log");
    assert.equal(rows[0].status, 'skipped');
    assert.equal(rows[0].error, 'TEMPLATE_INTROUVABLE');
  } finally {
    const cols = Object.keys(saved);
    db.prepare(`INSERT INTO email_templates (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(saved);
  }
});

test('sujet invalide : 400 SUJET_INVALIDE via sendBusinessError, aucun e-mail', async () => {
  const before = db.prepare(`SELECT COUNT(*) AS n FROM email_log`).get().n;
  const r = await post(lead({ subject: 'Sujet inventé' }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'SUJET_INVALIDE');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_log`).get().n, before);
});

// ── Expéditeur (getSmtp) ─────────────────────────────────────────────────────

test('parseFromAddress : adresse nue inchangée, « Nom <adresse> » éclaté', () => {
  assert.deepEqual(parseFromAddress('contact@cazalia.fr'), { email: 'contact@cazalia.fr', name: null });
  assert.deepEqual(parseFromAddress('Cazalia <no-reply@cazalia.fr>'), { email: 'no-reply@cazalia.fr', name: 'Cazalia' });
  assert.deepEqual(parseFromAddress('"Lucie, Cowork" <a@b.fr>'), { email: 'a@b.fr', name: 'Lucie, Cowork' });
  assert.deepEqual(parseFromAddress('<a@b.fr>'), { email: 'a@b.fr', name: null });
  assert.deepEqual(parseFromAddress(''), { email: '', name: null });
});

test('getSmtp : sans réglage en base, le défaut « Nom <adresse> » est éclaté (plus de chevrons imbriqués)', () => {
  const s = getSmtp();
  assert.equal(s.fromEmail, 'no-reply@cazalia.fr');
  assert.equal(s.fromName, 'Cazalia');
});

test('getSmtp : une adresse nue saisie par l\'admin et son nom sont conservés tels quels', () => {
  setSetting('smtp', { from_email: 'contact@exemple.test', from_name: 'Mon Espace' });
  const s = getSmtp();
  assert.equal(s.fromEmail, 'contact@exemple.test');
  assert.equal(s.fromName, 'Mon Espace');
});

test('getSmtp : le nom saisi par l\'admin prime sur celui extrait de l\'adresse', () => {
  setSetting('smtp', { from_email: 'Autre <x@exemple.test>', from_name: 'Nom admin' });
  const s = getSmtp();
  assert.equal(s.fromEmail, 'x@exemple.test');
  assert.equal(s.fromName, 'Nom admin');
});
