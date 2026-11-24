// Journalisation des envois abandonnés avant `sendMail`, et échappement du gabarit
// de remboursement.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-journal-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const settings = await import('../src/lib/settings.js');
const mailer = await import('../src/lib/mailer.js');
const { db } = await import('../src/db.js');

test.after(() => { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); });

const clearLog = () => db.prepare(`DELETE FROM email_log`).run();
const lastLog = () => db.prepare(`SELECT * FROM email_log ORDER BY id DESC LIMIT 1`).get();
const count = () => db.prepare(`SELECT COUNT(*) AS n FROM email_log`).get().n;

test('utilisateur ou réservation introuvable, gabarit absent : une ligne « skipped » avec la raison', async () => {
  clearLog();
  assert.equal((await mailer.sendToUser({ userId: 999999, code: 'booking_confirmation' })).reason, 'UTILISATEUR_INTROUVABLE');
  let row = lastLog();
  assert.equal(count(), 1);
  assert.equal(row.status, 'skipped');
  assert.equal(row.error, 'UTILISATEUR_INTROUVABLE');
  assert.equal(row.template_code, 'booking_confirmation');

  clearLog();
  for (const [fn, code] of [
    [mailer.sendBookingConfirmation, 'booking_confirmation'],
    [mailer.sendBookingModified, 'booking_modified'],
    [mailer.sendBookingCancelled, 'booking_cancelled'],
  ]) {
    assert.equal((await fn(999999)).reason, 'RESA_INTROUVABLE');
    row = lastLog();
    assert.equal(row.status, 'skipped');
    assert.equal(row.error, 'RESA_INTROUVABLE');
    assert.equal(row.template_code, code);
  }
  assert.equal(count(), 3);

  clearLog();
  const uid = Number(db.prepare(
    `INSERT INTO users (email, password_hash, display_name, role) VALUES ('membre@exemple.test', 'x', 'Marie', 'member')`
  ).run().lastInsertRowid);
  db.prepare(`DELETE FROM email_templates WHERE code = 'booking_confirmation'`).run();
  assert.equal((await mailer.sendToUser({ userId: uid, code: 'booking_confirmation' })).reason, 'TEMPLATE_INTROUVABLE');
  row = lastLog();
  assert.equal(row.status, 'skipped');
  assert.equal(row.error, 'TEMPLATE_INTROUVABLE');
  assert.equal(row.to_email, 'membre@exemple.test');
  assert.equal(row.to_user_id, uid);
});

// Réservation payée d'un membre au nom hostile, dans un espace au nom hostile.
function makeReservation({ memberName, spaceName, paymentIntent }) {
  const uid = Number(db.prepare(
    `INSERT INTO users (email, password_hash, display_name, role) VALUES (?, 'x', ?, 'member')`
  ).run(`m${Math.random().toString(36).slice(2)}@exemple.test`, memberName).lastInsertRowid);
  const sid = Number(db.prepare(
    `INSERT INTO spaces (name, kind, category, online_bookable, exclusive, capacity, credits_per_hour)
     VALUES (?, 'room', 'MEETING_ROOM', 1, 1, 8, 1)`
  ).run(spaceName).lastInsertRowid);
  return Number(db.prepare(
    `INSERT INTO reservations (user_id, space_id, start_at, end_at, price_cents, payment_intent)
     VALUES (?, ?, '2027-01-13T09:00:00.000Z', '2027-01-13T10:00:00.000Z', 1200, ?)`
  ).run(uid, sid, paymentIntent).lastInsertRowid);
}

test('refund_request : sans administrateur, la raison AUCUN_ADMIN est journalisée', async () => {
  clearLog();
  db.prepare(`DELETE FROM users WHERE role = 'admin'`).run();
  const rid = makeReservation({ memberName: 'Marie', spaceName: 'Salle A', paymentIntent: 'pi_1' });
  const r = await mailer.sendRefundRequestToAdmin(rid, { amount: 1200 });
  assert.equal(r.reason, 'AUCUN_ADMIN');
  const row = lastLog();
  assert.equal(row.status, 'skipped');
  assert.equal(row.error, 'AUCUN_ADMIN');
  assert.equal(row.template_code, 'refund_request');
});

test('refund_request : un nom de membre hostile ressort échappé dans le HTML réellement envoyé', async () => {
  clearLog();
  db.prepare(`INSERT INTO users (email, password_hash, display_name, role) VALUES ('admin@exemple.test', 'x', 'Admin', 'admin')`).run();
  settings.setSmtp({ from_name: 'Cazalia', from_email: 'no-reply@cazalia.test' });
  settings.setBrevo({ api_key: 'xkeysib-cle-de-test' });
  settings.setMail({ provider: 'brevo' });

  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ messageId: '<m@x>' }) };
  };
  try {
    const rid = makeReservation({
      memberName: 'Eve <script>alert(1)</script> "x"',
      spaceName: 'Salle <b>"B"</b>',
      paymentIntent: 'pi_"><img src=x>',
    });
    const r = await mailer.sendRefundRequestToAdmin(rid, { amount: 1200 });
    assert.equal(r.sent, true);
  } finally { globalThis.fetch = real; }

  assert.equal(sent.length, 1);
  const html = sent[0].htmlContent;
  assert.ok(html, 'le corps HTML est bien celui transmis au fournisseur');
  assert.ok(!html.includes('<script>alert(1)'), 'aucune balise script brute');
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(!html.includes('<b>"B"</b>'));
  assert.ok(html.includes('Eve &lt;script&gt;alert(1)&lt;/script&gt; &quot;x&quot;'));
  assert.ok(html.includes('pi_&quot;&gt;&lt;img src=x&gt;'));
});
