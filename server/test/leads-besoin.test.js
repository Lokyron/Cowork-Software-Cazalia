// Tests du bloc « Votre besoin » (bureau privatif) du formulaire de contact.
// Base jetable : `DB_PATH` est positionné AVANT le premier import de `db.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-besoin-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');

const { db } = await import('../src/db.js');
const { createProspect, LEAD_SUBJECTS, OFFICE_DURATIONS, exportCsv } = await import('../src/lib/prospects.js');
const { leadsRouter } = await import('../src/routes/leads.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

const OFFICE = 'Location du bureau privatif (longue durée)';
const OLD_OFFICE = 'Location du bureau privatif';
const base = () => ({
  first_name: 'Jeanne', last_name: 'Test', email: 'jeanne@example.com',
  phone: '06 12 34 56 78', consent: true, subject: OFFICE,
});
const need = (extra = {}) => ({ ...base(), office_seats: 2, office_duration: '3 à 6 mois', ...extra });
const row = (id) => db.prepare(`SELECT office_seats, office_duration, office_start FROM prospects WHERE id = ?`).get(id);

// Date ISO décalée de `days` jours par rapport à aujourd'hui (Paris, comme le serveur).
function isoPlus(days) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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

test('nouveau libellé accepté, ancien libellé refusé', () => {
  assert.ok(LEAD_SUBJECTS.includes(OFFICE));
  assert.ok(!LEAD_SUBJECTS.includes(OLD_OFFICE));
  assert.doesNotThrow(() => createProspect(need()));
  assert.throws(() => createProspect({ ...need(), subject: OLD_OFFICE }), { code: 'SUJET_INVALIDE' });
});

test('la liste des durées est celle attendue, dans l\'ordre', () => {
  assert.deepEqual(OFFICE_DURATIONS, [
    '1 à 3 mois', '3 à 6 mois', '6 à 12 mois', '12 mois', "Plus d'un an", 'Je ne sais pas encore',
  ]);
});

test('bureau privatif : nombre de postes ou durée absents -> refusé', () => {
  assert.throws(() => createProspect(base()), { code: 'BESOIN_INVALIDE' });
  assert.throws(() => createProspect({ ...base(), office_duration: '12 mois' }), { code: 'BESOIN_INVALIDE' });
  assert.throws(() => createProspect({ ...base(), office_seats: 2 }), { code: 'BESOIN_INVALIDE' });
  assert.throws(() => createProspect(need({ office_seats: '' })), { code: 'BESOIN_INVALIDE' });
  assert.throws(() => createProspect(need({ office_duration: '' })), { code: 'BESOIN_INVALIDE' });
});

test('durée hors liste ou de mauvais type -> refusée', () => {
  for (const d of ['2 ans', '12 MOIS', 'Plus d’un an', ['12 mois'], 12, null]) {
    assert.throws(() => createProspect(need({ office_duration: d })), { code: 'BESOIN_INVALIDE' }, String(d));
  }
});

test('nombre de postes : 0, négatif, non entier, > 50, non numérique -> refusé', () => {
  for (const n of [0, -1, 1.5, 51, 1000, 'abc', '2.5', '-3', NaN, Infinity, null, [2], {}, '1e1']) {
    assert.throws(() => createProspect(need({ office_seats: n })), { code: 'BESOIN_INVALIDE' }, String(n));
  }
});

test('nombre de postes : bornes 1 et 50 acceptées, chaîne numérique acceptée', () => {
  assert.equal(row(createProspect(need({ office_seats: 1 })).id).office_seats, 1);
  assert.equal(row(createProspect(need({ office_seats: 50 })).id).office_seats, 50);
  assert.equal(row(createProspect(need({ office_seats: '4' })).id).office_seats, 4);
});

test('office_start : absent, vide, DES_QUE_POSSIBLE, aujourd\'hui et futur acceptés', () => {
  assert.equal(row(createProspect(need()).id).office_start, null);
  assert.equal(row(createProspect(need({ office_start: '' })).id).office_start, null);
  assert.equal(row(createProspect(need({ office_start: 'DES_QUE_POSSIBLE' })).id).office_start, 'DES_QUE_POSSIBLE');
  assert.equal(row(createProspect(need({ office_start: isoPlus(0) })).id).office_start, isoPlus(0));
  assert.equal(row(createProspect(need({ office_start: isoPlus(90) })).id).office_start, isoPlus(90));
});

// La veille est tolérée : le `min` du champ est calculé sur l'heure locale du
// navigateur, et un formulaire ouvert avant minuit et validé après serait refusé.
test('office_start : la veille est tolérée (passage de minuit)', () => {
  assert.equal(row(createProspect(need({ office_start: isoPlus(-1) })).id).office_start, isoPlus(-1));
});

test('office_start : date passée, absurde, trop lointaine ou mal formée -> refusée', () => {
  for (const d of [isoPlus(-2), '2020-01-01', isoPlus(365 * 4), '2026-02-31', '12/03/2027', 'demain', 20270101, 'des_que_possible']) {
    assert.throws(() => createProspect(need({ office_start: d })), { code: 'BESOIN_INVALIDE' }, String(d));
  }
});

test('cas nominal : les trois valeurs sont écrites en base', () => {
  const { id } = createProspect(need({ office_seats: 3, office_duration: 'Plus d\'un an', office_start: isoPlus(30) }), 'test');
  assert.deepEqual(row(id), { office_seats: 3, office_duration: "Plus d'un an", office_start: isoPlus(30) });
});

test('ANTI-POLLUTION : sujet autre + champs envoyés -> ignorés et stockés NULL', () => {
  for (const subject of LEAD_SUBJECTS.filter((s) => s !== OFFICE)) {
    const { id, data } = createProspect({
      ...base(), subject, office_seats: 7, office_duration: '12 mois', office_start: 'DES_QUE_POSSIBLE',
    });
    assert.deepEqual(row(id), { office_seats: null, office_duration: null, office_start: null }, subject);
    assert.equal(data.office_seats, null);
  }
  // Même des valeurs invalides ne bloquent pas un sujet hors bureau privatif : elles sont simplement ignorées.
  const { id } = createProspect({ ...base(), subject: 'Tarifs et offres', office_seats: 999, office_duration: 'x', office_start: '1999-01-01' });
  assert.deepEqual(row(id), { office_seats: null, office_duration: null, office_start: null });
});

test('POST /leads : besoin invalide -> 400 BESOIN_INVALIDE, rien en base', async () => {
  const before = db.prepare(`SELECT COUNT(*) n FROM prospects`).get().n;
  const res = await postLead({ ...base(), email: 'x@example.com', office_seats: 0, office_duration: '12 mois' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'BESOIN_INVALIDE' });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM prospects`).get().n, before);
});

test('POST /leads : besoin valide -> 201 et valeurs en base', async () => {
  const res = await postLead({ ...base(), email: 'besoin@example.com', office_seats: 2, office_duration: '6 à 12 mois', office_start: 'DES_QUE_POSSIBLE', message: 'Accès le soir' });
  assert.equal(res.statusCode, 201);
  const r = db.prepare(`SELECT office_seats, office_duration, office_start, note FROM prospects WHERE email = 'besoin@example.com'`).get();
  assert.deepEqual(r, { office_seats: 2, office_duration: '6 à 12 mois', office_start: 'DES_QUE_POSSIBLE', note: 'Accès le soir' });
});

test('export CSV : colonnes du besoin présentes, sans « null » pour les anciens prospects', () => {
  const csv = exportCsv();
  assert.match(csv.split('\r\n')[0], /Postes;Durée;Début souhaité/);
  assert.ok(!/null|undefined/.test(csv));
});
