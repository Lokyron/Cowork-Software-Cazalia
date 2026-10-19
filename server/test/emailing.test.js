// Tests du module d'envoi d'e-mails : bascule de fournisseur, secrets, plafond
// quotidien et webhook de délivrabilité.
//
// Aucun appel réseau réel : `fetch` est remplacé par une doublure, et aucun
// serveur HTTP n'est démarré (les gestionnaires de route sont appelés avec des
// requêtes/réponses simulées). Exécution :
//   npm test          (depuis server/)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-mail-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const settings = await import('../src/lib/settings.js');
const { sendMail, getQuota } = await import('../src/lib/mailer.js');
const { eventToStatus, normalizeMessageId } = await import('../src/lib/brevo.js');
const { handleBrevoWebhook } = await import('../src/routes/webhooks.js');
const { parisDayStartUtc } = await import('../src/lib/time.js');
const { db } = await import('../src/db.js');

test.after(() => { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); });

// ── Doublures ────────────────────────────────────────────────────────────────

/** @returns {object} Réponse Express simulée. */
function fakeRes() {
  return {
    statusCode: null, body: null, ended: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { this.ended = true; return this; },
  };
}

/**
 * Remplace `fetch` par une doublure qui enregistre les appels.
 * @param {object} [response] Corps JSON renvoyé.
 * @returns {{calls: object[], restore: () => void}}
 */
function stubFetch(response = { messageId: '<abc-123@smtp-relay.mailin.fr>' }) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify(response) };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

/** Prépare un fournisseur Brevo configuré, avec expéditeur et plafond donnés. */
function configureBrevo({ dailyLimit = 300, reserve = 30 } = {}) {
  settings.setSmtp({ from_name: 'Cazalia', from_email: 'no-reply@cazalia.test' });
  settings.setBrevo({ api_key: 'xkeysib-cle-de-test' });
  settings.setMail({ provider: 'brevo', daily_limit: dailyLimit, marketing_reserve: reserve });
}

/** Insère `n` envois « consommés » dans le journal du jour. */
function fillQuota(n) {
  const stmt = db.prepare(`INSERT INTO email_log (to_email, status, provider) VALUES (?, 'sent', 'brevo')`);
  for (let i = 0; i < n; i++) stmt.run(`bourrage-${i}@cazalia.test`);
}

const clearLog = () => db.exec(`DELETE FROM email_log`);

// ─────────────────────────────────────────────────────────────────────────────
// Secrets : la clé d'API et le jeton de webhook ne sortent jamais (CWE-200)
// ─────────────────────────────────────────────────────────────────────────────

test("la vue publique n'expose jamais la clé d'API Brevo", () => {
  settings.setBrevo({ api_key: 'xkeysib-secret-absolu' });
  const pub = settings.getBrevoPublic();
  assert.equal(pub.has_api_key, true);
  assert.equal(JSON.stringify(pub).includes('xkeysib-secret-absolu'), false);
  // …mais le serveur, lui, la relit en clair pour appeler l'API.
  assert.equal(settings.getBrevo().apiKey, 'xkeysib-secret-absolu');
});

test('une clé vide conserve la clé enregistrée, `clear_api_key` l\'efface', () => {
  settings.setBrevo({ api_key: 'xkeysib-premiere' });
  settings.setBrevo({ api_key: '' });
  assert.equal(settings.getBrevo().apiKey, 'xkeysib-premiere');
  settings.setBrevo({ clear_api_key: true });
  assert.equal(settings.getBrevo().apiKey, '');
  assert.equal(settings.getBrevo().configured, false);
});

test('le jeton de webhook est stocké chiffré et relisible une seule fois', () => {
  const token = settings.rotateBrevoWebhookToken();
  assert.ok(token.length >= 32);
  assert.equal(settings.getBrevo().webhookToken, token);
  assert.equal(JSON.stringify(settings.getBrevoPublic()).includes(token), false);
  // La rotation invalide le précédent.
  const next = settings.rotateBrevoWebhookToken();
  assert.notEqual(next, token);
  assert.equal(settings.getBrevo().webhookToken, next);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bascule de fournisseur
// ─────────────────────────────────────────────────────────────────────────────

test('le plafond revient au défaut du fournisseur à la bascule', () => {
  settings.setMail({ provider: 'brevo' });
  assert.equal(settings.getMail().dailyLimit, 300); // offre gratuite Brevo
  settings.setMail({ provider: 'smtp' });
  assert.equal(settings.getMail().dailyLimit, 0);   // SMTP maison : pas de plafond inventé
});

test('un fournisseur inconnu est ignoré au profit du courant', () => {
  settings.setMail({ provider: 'brevo' });
  settings.setMail({ provider: 'pigeon-voyageur' });
  assert.equal(settings.getMail().provider, 'brevo');
});

test("la réserve ne peut pas dépasser le plafond", () => {
  settings.setMail({ provider: 'brevo', daily_limit: 10, marketing_reserve: 50 });
  assert.equal(settings.getMail().marketingReserve, 10);
});

// ─────────────────────────────────────────────────────────────────────────────
// Envoi via l'API Brevo
// ─────────────────────────────────────────────────────────────────────────────

test("l'envoi passe par l'API Brevo, authentifié, et journalise le messageId", async () => {
  clearLog();
  configureBrevo();
  const f = stubFetch();
  try {
    const r = await sendMail({ to: 'client@exemple.test', subject: 'Sujet', html: '<p>Corps</p>', templateCode: 'booking_confirmation' });
    assert.equal(r.sent, true);
    assert.equal(r.messageId, 'abc-123@smtp-relay.mailin.fr'); // chevrons retirés
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(f.calls[0].opts.headers['api-key'], 'xkeysib-cle-de-test');
    const body = JSON.parse(f.calls[0].opts.body);
    assert.equal(body.sender.email, 'no-reply@cazalia.test');
    assert.deepEqual(body.to, [{ email: 'client@exemple.test' }]);
    assert.deepEqual(body.tags, ['booking_confirmation']);
  } finally { f.restore(); }

  const row = db.prepare(`SELECT * FROM email_log ORDER BY id DESC LIMIT 1`).get();
  assert.equal(row.status, 'sent');
  assert.equal(row.provider, 'brevo');
  assert.equal(row.message_id, 'abc-123@smtp-relay.mailin.fr');
});

test("un refus du fournisseur est journalisé sans jamais lever", async () => {
  clearLog();
  configureBrevo();
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 400, statusText: 'Bad Request',
    text: async () => JSON.stringify({ code: 'invalid_parameter', message: 'Domaine non authentifié' }),
  });
  try {
    const r = await sendMail({ to: 'client@exemple.test', subject: 'S', html: '<p>c</p>', templateCode: 'manual' });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'ENVOI_ECHOUE');
    assert.match(r.error, /Domaine non authentifié/);
  } finally { globalThis.fetch = real; }
  const row = db.prepare(`SELECT * FROM email_log ORDER BY id DESC LIMIT 1`).get();
  assert.equal(row.status, 'failed');
  // Un échec n'a pas consommé le quota du jour.
  assert.equal(getQuota().sentToday, 0);
});

test('sans clé configurée, rien ne part et le refus est tracé', async () => {
  clearLog();
  settings.setBrevo({ clear_api_key: true });
  settings.setMail({ provider: 'brevo' });
  const r = await sendMail({ to: 'client@exemple.test', subject: 'S', html: '<p>c</p>' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'BREVO_NON_CONFIGURE');
  assert.equal(db.prepare(`SELECT status FROM email_log ORDER BY id DESC LIMIT 1`).get().status, 'skipped');
});

// ─────────────────────────────────────────────────────────────────────────────
// Plafond quotidien : la réserve protège les e-mails critiques
// ─────────────────────────────────────────────────────────────────────────────

test('une campagne s\'arrête à la réserve, le reste du quota reste disponible', async () => {
  clearLog();
  configureBrevo({ dailyLimit: 10, reserve: 3 });
  fillQuota(7); // 7/10 envoyés → la part commerciale (10 − 3) est épuisée
  const f = stubFetch();
  try {
    const marketing = await sendMail({ to: 'client@exemple.test', subject: 'Promo', html: '<p>c</p>', templateCode: 'manual' });
    assert.equal(marketing.sent, false);
    assert.equal(marketing.reason, 'QUOTA_RESERVE_TRANSACTIONNEL');
    assert.equal(f.calls.length, 0, "aucun appel réseau n'est tenté quand le plafond refuse l'envoi");

    // …tandis qu'une confirmation de réservation et un reset passent encore.
    const booking = await sendMail({ to: 'client@exemple.test', subject: 'Résa', html: '<p>c</p>', templateCode: 'booking_confirmation' });
    assert.equal(booking.sent, true);
    const reset = await sendMail({ to: 'client@exemple.test', subject: 'Mot de passe', html: '<p>c</p>', templateCode: 'password_reset' });
    assert.equal(reset.sent, true);
  } finally { f.restore(); }
});

test('au plafond absolu, même un reset de mot de passe est refusé et tracé', async () => {
  clearLog();
  configureBrevo({ dailyLimit: 5, reserve: 2 });
  fillQuota(5);
  const f = stubFetch();
  try {
    const r = await sendMail({ to: 'client@exemple.test', subject: 'Mot de passe', html: '<p>c</p>', templateCode: 'password_reset' });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'QUOTA_JOURNALIER_ATTEINT');
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
  const row = db.prepare(`SELECT * FROM email_log ORDER BY id DESC LIMIT 1`).get();
  assert.equal(row.error, 'QUOTA_JOURNALIER_ATTEINT');
});

test('un plafond à 0 signifie « aucun plafond »', async () => {
  clearLog();
  configureBrevo({ dailyLimit: 0, reserve: 0 });
  fillQuota(1000);
  const q = getQuota();
  assert.equal(q.remaining, null);
  const f = stubFetch();
  try {
    const r = await sendMail({ to: 'client@exemple.test', subject: 'S', html: '<p>c</p>', templateCode: 'manual' });
    assert.equal(r.sent, true);
  } finally { f.restore(); }
});

test('le quota se compte sur le jour civil de Paris, pas sur le jour UTC', () => {
  // Le 1er janvier à 00 h 30 UTC, Paris est déjà le 1er à 01 h 30 : le début de
  // journée parisien est le 31 décembre à 23 h 00 UTC.
  assert.equal(parisDayStartUtc(new Date('2026-01-01T00:30:00Z')), '2025-12-31 23:00:00');
  // En heure d'été (UTC+2), minuit à Paris correspond à 22 h 00 UTC la veille.
  assert.equal(parisDayStartUtc(new Date('2026-07-15T12:00:00Z')), '2026-07-14 22:00:00');
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook de délivrabilité
// ─────────────────────────────────────────────────────────────────────────────

test('les événements Brevo sont traduits quelle que soit leur graphie', () => {
  assert.equal(eventToStatus('delivered'), 'delivered');
  assert.equal(eventToStatus('hard_bounce'), 'bounced');
  assert.equal(eventToStatus('hardBounce'), 'bounced');
  assert.equal(eventToStatus('soft_bounce'), 'bounced');
  assert.equal(eventToStatus('unsubscribed'), 'unsubscribed');
  assert.equal(eventToStatus('spam'), 'spam');
  // Événements non suivis (ouverture, clic, accusé de prise en charge).
  assert.equal(eventToStatus('opened'), null);
  assert.equal(eventToStatus('click'), null);
  assert.equal(eventToStatus('request'), null);
  assert.equal(eventToStatus(undefined), null);
});

test('normalizeMessageId retire les chevrons', () => {
  assert.equal(normalizeMessageId('<x@y>'), 'x@y');
  assert.equal(normalizeMessageId('x@y'), 'x@y');
  assert.equal(normalizeMessageId(''), null);
  assert.equal(normalizeMessageId(undefined), null);
});

test('un jeton de webhook erroné est rejeté', () => {
  settings.rotateBrevoWebhookToken();
  const res = fakeRes();
  handleBrevoWebhook({ params: { token: 'jeton-bidon' }, body: { event: 'delivered' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'JETON_INVALIDE');
});

test('sans jeton configuré, aucun appel entrant n\'est accepté', () => {
  db.prepare(`DELETE FROM app_settings WHERE key = 'brevo'`).run();
  const res = fakeRes();
  handleBrevoWebhook({ params: { token: '' }, body: { event: 'delivered' } }, res);
  assert.equal(res.statusCode, 403);
});

test('le statut du journal suit les événements, sans régresser', () => {
  clearLog();
  const token = settings.rotateBrevoWebhookToken();
  db.prepare(`INSERT INTO email_log (to_email, status, provider, message_id) VALUES (?, 'sent', 'brevo', 'mid-1')`)
    .run('client@exemple.test');
  const status = () => db.prepare(`SELECT status FROM email_log WHERE message_id = 'mid-1'`).get().status;

  let res = fakeRes();
  handleBrevoWebhook({ params: { token }, body: { event: 'delivered', 'message-id': '<mid-1>' } }, res);
  assert.equal(res.statusCode, 204);
  assert.equal(status(), 'delivered');

  // Un rejet est plus grave : il remplace « remis ».
  handleBrevoWebhook({ params: { token }, body: { event: 'hard_bounce', 'message-id': 'mid-1', reason: 'unknown recipient' } }, fakeRes());
  assert.equal(status(), 'bounced');

  // Un « remis » tardif ne doit PAS effacer le rejet.
  handleBrevoWebhook({ params: { token }, body: { event: 'delivered', 'message-id': 'mid-1' } }, fakeRes());
  assert.equal(status(), 'bounced');

  const row = db.prepare(`SELECT error, updated_at FROM email_log WHERE message_id = 'mid-1'`).get();
  assert.equal(row.error, 'unknown recipient');
  assert.ok(row.updated_at, "l'horodatage du dernier événement est renseigné");
});

test('un message inconnu ou un événement non suivi répond 204 sans rien écrire', () => {
  clearLog();
  const token = settings.rotateBrevoWebhookToken();
  const res = fakeRes();
  handleBrevoWebhook({ params: { token }, body: [{ event: 'delivered', 'message-id': 'inconnu' }, { event: 'opened', 'message-id': 'x' }] }, res);
  // 204 et non 4xx : un code d'erreur ferait réessayer Brevo en boucle, puis
  // désactiverait le webhook.
  assert.equal(res.statusCode, 204);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_log`).get().n, 0);
});

test('un désabonnement coupe les communications commerciales du membre', () => {
  clearLog();
  const token = settings.rotateBrevoWebhookToken();
  const userId = db.prepare(
    `INSERT INTO users (email, password_hash, display_name, role, notify_marketing) VALUES (?, 'x', 'Marie', 'member', 1)`
  ).run('marie@exemple.test').lastInsertRowid;
  db.prepare(`INSERT INTO email_log (to_email, to_user_id, status, provider, message_id) VALUES (?, ?, 'sent', 'brevo', 'mid-2')`)
    .run('marie@exemple.test', userId);

  handleBrevoWebhook({ params: { token }, body: { event: 'unsubscribed', 'message-id': 'mid-2' } }, fakeRes());

  const u = db.prepare(`SELECT notify_marketing, notify_booking FROM users WHERE id = ?`).get(userId);
  assert.equal(u.notify_marketing, 0);
  // Les e-mails liés à une réservation restent dus : ce n'est pas de la prospection.
  assert.equal(u.notify_booking, 1);
});
