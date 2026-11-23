// Tests du champ « Sujet » du formulaire de contact / devis unifié.
// Base jetable : `DB_PATH` est positionné AVANT le premier import de `db.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-leads-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');

const { db } = await import('../src/db.js');
const { createProspect, LEAD_SUBJECTS } = await import('../src/lib/prospects.js');
const { leadsRouter } = await import('../src/routes/leads.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

const base = () => ({
  first_name: 'Jeanne', last_name: 'Test', email: 'jeanne@example.com',
  phone: '06 12 34 56 78', consent: true, message: 'Bonjour',
});

/** Appelle le gestionnaire de POST /leads sans le limiteur ni serveur HTTP. */
async function postLead(body) {
  const layer = leadsRouter.stack.find((l) => l.route?.path === '/leads');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await handler({ body }, res);
  return res;
}

test('la liste des sujets compte six entrées, dans l\'ordre attendu', () => {
  assert.deepEqual(LEAD_SUBJECTS, [
    'Informations sur les espaces', 'Tarifs et offres', 'Réservation et disponibilités',
    'Location du bureau privatif (longue durée)', 'Location de la salle de réunion', 'Autre demande',
  ]);
});

test('la colonne prospects.subject existe', () => {
  const cols = db.prepare(`PRAGMA table_info(prospects)`).all().map((c) => c.name);
  assert.ok(cols.includes('subject'));
});

test('createProspect : sujet absent ou vide refusé', () => {
  assert.throws(() => createProspect(base()), { code: 'SUJET_INVALIDE' });
  assert.throws(() => createProspect({ ...base(), subject: '  ' }), { code: 'SUJET_INVALIDE' });
});

test('createProspect : sujet hors liste ou de mauvais type refusé', () => {
  assert.throws(() => createProspect({ ...base(), subject: 'Autre chose' }), { code: 'SUJET_INVALIDE' });
  assert.throws(() => createProspect({ ...base(), subject: 'autre demande' }), { code: 'SUJET_INVALIDE' });
  assert.throws(() => createProspect({ ...base(), subject: ['Autre demande'] }), { code: 'SUJET_INVALIDE' });
});

test('createProspect : sujet valide écrit en base', () => {
  for (const subject of LEAD_SUBJECTS) {
    // Le bureau privatif exige désormais son bloc « besoin » (postes + durée).
    const need = subject.startsWith('Location du bureau privatif') ? { office_seats: 2, office_duration: '12 mois' } : {};
    const { id } = createProspect({ ...base(), subject, ...need }, 'test');
    assert.equal(db.prepare(`SELECT subject FROM prospects WHERE id = ?`).get(id).subject, subject);
  }
});

test('POST /leads : sans sujet -> 400 SUJET_INVALIDE, rien en base', async () => {
  const before = db.prepare(`SELECT COUNT(*) n FROM prospects`).get().n;
  const res = await postLead(base());
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'SUJET_INVALIDE' });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM prospects`).get().n, before);
});

test('POST /leads : sujet hors liste -> 400 SUJET_INVALIDE', async () => {
  const res = await postLead({ ...base(), subject: 'Spam' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'SUJET_INVALIDE');
});

test('POST /leads : sujet valide -> 201 et sujet en base', async () => {
  const res = await postLead({ ...base(), email: 'ok@example.com', subject: 'Tarifs et offres', source: 'aide_contact' });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { ok: true });
  const row = db.prepare(`SELECT subject, note FROM prospects WHERE email = 'ok@example.com'`).get();
  assert.equal(row.subject, 'Tarifs et offres');
  assert.equal(row.note, 'Bonjour');
});
