// Tests de GET /api/availability/month et de `monthAvailability` : statuts des
// jours d'un mois (open / partial / full / closed / past), en heure de Paris,
// en une seule passe SQL, sans aucune donnée personnelle dans la réponse.
//
// CONTRAINTE DE QUOTA : les tests de route de ce fichier partagent le limiteur de la
// route (60 requêtes / minute / IP, un compteur par processus ; `node --test` isole
// chaque fichier dans son propre processus). Toutes les requêtes passent par `get`
// ou `getReal`, qui comptent et ÉCHOUENT avec un message clair au-delà de `QUOTA_MAX`,
// plutôt que de laisser un 429 parasite rougir un test sans rapport. Pour ajouter des
// tests de route au-delà du budget, les déplacer dans un nouveau fichier.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-month-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const { db } = await import('../src/db.js');
const { monthAvailability, spaceAvailability, windowsFor, partialThreshold, PARTIAL_OCCUPANCY_RATIO } = await import('../src/lib/booking.js');
const { parisDateKey, parisLocalToUtcIso } = await import('../src/lib/time.js');
const { config } = await import('../src/config.js');
const { default: express } = await import('express');
const { default: cookieParser } = await import('cookie-parser');
const { attachUser } = await import('../src/middleware.js');
const { spacesRouter } = await import('../src/routes/spaces.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

// ── Données ──────────────────────────────────────────────────────────────────
const insSpace = db.prepare(
  `INSERT INTO spaces (name, kind, capacity, exclusive, credits_per_hour, active, online_bookable) VALUES (?, 'zone', ?, ?, 0, ?, ?)`
);
const OPEN = Number(insSpace.run('Open space', 10, 0, 1, 1).lastInsertRowid);
const ROOM = Number(insSpace.run('Salle réunion', 6, 1, 1, 1).lastInsertRowid);
const DEAD = Number(insSpace.run('Ancien espace', 4, 0, 0, 1).lastInsertRowid);
// Bureau privatif : actif, mais PAS réservable en ligne (id public, occupation privée).
const PRIVATE = Number(insSpace.run('Bureau privatif', 2, 1, 1, 0).lastInsertRowid);

const MEMBER_EMAIL = 'secret.membre@exemple.test';
const MEMBER_NAME = 'Zoé Confidentielle';
const memberId = Number(db.prepare(
  `INSERT INTO users (email, display_name, first_name, last_name, phone, password_hash) VALUES (?, ?, 'Zoé', 'Confidentielle', '0611223344', 'x')`
).run(MEMBER_EMAIL, MEMBER_NAME).lastInsertRowid);

const insResa = db.prepare(
  `INSERT INTO reservations (user_id, space_id, start_at, end_at, seats, status) VALUES (?, ?, ?, ?, ?, ?)`
);
const resa = (space, startIso, endIso, seats, status = 'confirmed') => insResa.run(memberId, space, startIso, endIso, seats, status);
const insHold = db.prepare(
  `INSERT INTO reservation_holds (user_id, space_id, start_at, end_at, seats, cost, expires_at) VALUES (?, ?, ?, ?, ?, 0, ?)`
);
const hold = (space, startIso, endIso, seats, expiresIso) => insHold.run(memberId, space, startIso, endIso, seats, expiresIso);

// « Maintenant » figé : mardi 24/11/2026 11:00 Paris. Hiver (UTC+1).
const NOW = new Date('2026-11-24T10:00:00.000Z');
const month = (m, opts = {}, space = OPEN) => monthAvailability(space, m, { now: NOW, ...opts });
const day = (r, date) => r.days.find((d) => d.date === date);
const dow = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();

// Novembre 2026 (heure d'hiver). Matin = 08:30-14:00 Paris = 07:30Z-13:00Z.
resa(OPEN, '2026-11-25T07:30:00.000Z', '2026-11-25T13:00:00.000Z', 10);          // mer. 25 : matin plein
resa(OPEN, '2026-11-27T07:30:00.000Z', '2026-11-27T18:30:00.000Z', 10);          // ven. 27 : journée pleine
resa(OPEN, '2026-11-30T07:30:00.000Z', '2026-11-30T13:00:00.000Z', 4);           // lun. 30 : matin à 4 places
resa(OPEN, '2026-11-24T14:00:00.000Z', '2026-11-24T15:00:00.000Z', 10, 'cancelled'); // annulée : ne compte pas
hold(OPEN, '2026-11-26T08:00:00.000Z', '2026-11-26T09:00:00.000Z', 3, '2026-11-24T11:00:00.000Z'); // jeu. 26 : verrou vivant
hold(OPEN, '2026-12-01T08:00:00.000Z', '2026-12-01T09:00:00.000Z', 3, '2026-11-24T09:00:00.000Z'); // expiré

test('mois normal : dimanche fermé, jours passés « past », jour vide « open »', () => {
  const r = month('2026-11');
  assert.equal(r.days.length, 30);
  assert.equal(r.month, '2026-11');
  assert.equal(r.timezone, 'Europe/Paris');
  assert.equal(r.capacity, 10);
  assert.equal(r.tarif_type, 'heure');
  // Dates consécutives, sans trou ni doublon.
  r.days.forEach((d, i) => assert.equal(d.date, `2026-11-${String(i + 1).padStart(2, '0')}`));
  // Passé : tout ce qui précède le 24, y compris le dimanche 22 (« past » prioritaire sur « closed »).
  for (let n = 1; n <= 23; n += 1) assert.equal(r.days[n - 1].status, 'past');
  assert.equal(day(r, '2026-11-22').seats_left, null);
  // Dimanche futur : fermé.
  assert.deepEqual(day(r, '2026-11-29'), { date: '2026-11-29', status: 'closed', seats_left: null });
  // Aujourd'hui (mardi 24) : vide, la réservation annulée ne compte pas.
  assert.deepEqual(day(r, '2026-11-24'), { date: '2026-11-24', status: 'open', seats_left: 10 });
  assert.deepEqual(day(r, '2026-11-23').status, 'past');
  // Aucun dimanche futur n'est autre chose que closed.
  for (const d of r.days) if (dow(d.date) === 0 && d.date >= '2026-11-24') assert.equal(d.status, 'closed');
});

test('réservation partielle : « partial » dès la moitié de la capacité occupée ; saturation : « full »', () => {
  const m = month('2026-11', { tarifType: 'demi_journee', slot: 'matin' });
  // Lun. 30 : 4 places sur 10 occupées, strictement moins de la moitié (5) : « open », 6 restantes.
  assert.deepEqual(day(m, '2026-11-30'), { date: '2026-11-30', status: 'open', seats_left: 6 });
  assert.deepEqual(day(m, '2026-11-25'), { date: '2026-11-25', status: 'full', seats_left: 0 });
  assert.deepEqual(day(m, '2026-11-27'), { date: '2026-11-27', status: 'full', seats_left: 0 });
  // Demande de 7 places : 6 restantes ne suffisent plus.
  const m7 = month('2026-11', { tarifType: 'demi_journee', slot: 'matin', seats: 7 });
  assert.deepEqual(day(m7, '2026-11-30'), { date: '2026-11-30', status: 'full', seats_left: 6 });
  assert.equal(m7.seats, 7);
  // L'après-midi du 25 est libre, celui du 27 pris.
  const a = month('2026-11', { tarifType: 'demi_journee', slot: 'aprem' });
  assert.deepEqual(day(a, '2026-11-25'), { date: '2026-11-25', status: 'open', seats_left: 10 });
  assert.equal(day(a, '2026-11-27').status, 'full');
  // Journée entière : le matin plein du 25 la rend pleine.
  const j = month('2026-11', { tarifType: 'journee' });
  assert.equal(day(j, '2026-11-25').status, 'full');
  // Jeu. 26 : verrou de 3 places sur 10 (< 5) : « open ».
  assert.equal(day(j, '2026-11-26').status, 'open');
});

test('formule « heure » : le meilleur moment de la journée compte', () => {
  const r = month('2026-11');
  // Matin plein mais après-midi libre : il reste des heures, donc « partial ». Le chiffre du
  // meilleur instant (10) contredirait le statut : il est omis (convention : test dédié plus bas).
  assert.deepEqual(day(r, '2026-11-25'), { date: '2026-11-25', status: 'partial', seats_left: null });
  // Journée entière saturée : « full ».
  assert.deepEqual(day(r, '2026-11-27'), { date: '2026-11-27', status: 'full', seats_left: 0 });
  // Verrou de 3 places sur une heure (< moitié de 10) : « open ».
  assert.equal(day(r, '2026-11-26').status, 'open');
});

test('plusieurs fenêtres : seats_left vaut null quand elles divergent, le nombre exact sinon', () => {
  // Demi-journée SANS slot : matin ET après-midi sont évalués.
  const d = month('2026-11', { tarifType: 'demi_journee' });
  // Mer. 25 : matin plein (0 place), après-midi libre (10) : « partial », mais AUCUN chiffre.
  assert.deepEqual(day(d, '2026-11-25'), { date: '2026-11-25', status: 'partial', seats_left: null });
  // Lun. 30 : matin à 4 places (6 restantes, sous le seuil de 5), après-midi libre (10) :
  // « open » (aucune fenêtre n'atteint la moitié), mais les chiffres divergent : AUCUN chiffre.
  assert.deepEqual(day(d, '2026-11-30'), { date: '2026-11-30', status: 'open', seats_left: null });
  // Ven. 27 : tout est pris, les deux fenêtres disent 0 : « full » et 0 (elles sont d'accord).
  assert.deepEqual(day(d, '2026-11-27'), { date: '2026-11-27', status: 'full', seats_left: 0 });
  // Aujourd'hui (mar. 24), jour vide : les deux fenêtres disent 10, le nombre reste affiché.
  assert.deepEqual(day(d, '2026-11-24'), { date: '2026-11-24', status: 'open', seats_left: 10 });
  // UNE seule fenêtre (slot demandé) : le nombre exact est conservé.
  const m = month('2026-11', { tarifType: 'demi_journee', slot: 'matin' });
  assert.deepEqual(day(m, '2026-11-30'), { date: '2026-11-30', status: 'open', seats_left: 6 });
  assert.deepEqual(day(m, '2026-11-25'), { date: '2026-11-25', status: 'full', seats_left: 0 });
});

test('verrou de panier : vivant = occupé, expiré = ignoré', () => {
  const m = month('2026-11', { tarifType: 'demi_journee', slot: 'matin' });
  assert.deepEqual(day(m, '2026-11-26'), { date: '2026-11-26', status: 'open', seats_left: 7 });
  const dec = month('2026-12', { tarifType: 'demi_journee', slot: 'matin' });
  assert.deepEqual(day(dec, '2026-12-01'), { date: '2026-12-01', status: 'open', seats_left: 10 });
  // Le verrou vivant expire une heure plus tard : il ne compte plus.
  const later = monthAvailability(OPEN, '2026-11', { now: new Date('2026-11-24T12:00:00.000Z'), tarifType: 'demi_journee', slot: 'matin' });
  assert.equal(day(later, '2026-11-26').status, 'open');
});

test('DIVERGENCE VOULUE en formule « heure » : monthAvailability retient le meilleur instant, spaceAvailability somme la plage', () => {
  // Mardi 2 mars 2027, open space de 10 places, hiver (UTC+1) : ouverture 08:30-19:30 Paris
  // = 07:30Z-18:30Z. UNE réservation de 3 places entre 10:00 et 12:00 Paris (09:00Z-11:00Z).
  resa(OPEN, '2027-03-02T09:00:00.000Z', '2027-03-02T11:00:00.000Z', 3);
  const OUV_DEB = '2027-03-02T07:30:00.000Z';
  const OUV_FIN = '2027-03-02T18:30:00.000Z';
  // spaceAvailability SOMME les places de tout ce qui chevauche la plage : 3 prises, 7 restantes.
  assert.equal(spaceAvailability(OPEN, OUV_DEB, OUV_FIN).seats_left, 7);
  // monthAvailability (formule « heure ») prend l'instant le MOINS occupé de la journée : à
  // 08:30 il n'y a personne, donc 10 places ; le pic (3 places) reste sous la moitié (5) : « open ».
  assert.deepEqual(day(month('2027-03'), '2027-03-02'), { date: '2027-03-02', status: 'open', seats_left: 10 });
  // Ce n'est PAS un bug : on ne sait pas encore quelles heures seront demandées, et sommer
  // la plage afficherait « complet » pour deux demi-journées à 60 % chacune. La même
  // réservation, vue par une formule à fenêtre fixe, redonne le chiffre de spaceAvailability.
  const matin = month('2027-03', { tarifType: 'demi_journee', slot: 'matin' });
  assert.equal(day(matin, '2027-03-02').seats_left,
    spaceAvailability(OPEN, '2027-03-02T07:30:00.000Z', '2027-03-02T13:00:00.000Z').seats_left);
  assert.equal(day(matin, '2027-03-02').seats_left, 7);
});

test('cohérence avec spaceAvailability sur un créneau forfaitaire', () => {
  // spaceAvailability lit l'horloge réelle pour les verrous : comparaison hors verrous.
  const m = month('2026-11', { tarifType: 'demi_journee', slot: 'matin' });
  for (const [date, from, to] of [
    ['2026-11-30', '2026-11-30T07:30:00.000Z', '2026-11-30T13:00:00.000Z'],
    ['2026-11-25', '2026-11-25T07:30:00.000Z', '2026-11-25T13:00:00.000Z'],
    ['2026-11-24', '2026-11-24T07:30:00.000Z', '2026-11-24T13:00:00.000Z'],
  ]) {
    assert.equal(day(m, date).seats_left, spaceAvailability(OPEN, from, to, { countHolds: false }).seats_left, date);
  }
});

test('espace exclusif : une réservation rend la demi-journée « full » (1/0)', () => {
  resa(ROOM, '2026-11-30T07:30:00.000Z', '2026-11-30T08:30:00.000Z', 1);
  const r = month('2026-11', { tarifType: 'demi_journee', slot: 'matin' }, ROOM);
  assert.equal(r.capacity, 6);
  assert.equal(r.seats, 1);
  assert.deepEqual(day(r, '2026-11-30'), { date: '2026-11-30', status: 'full', seats_left: 0 });
  assert.deepEqual(day(r, '2026-11-26'), { date: '2026-11-26', status: 'open', seats_left: 1 });
  // À l'heure, il reste d'autres heures dans la journée : « partial », salle réservable.
  assert.deepEqual(day(month('2026-11', {}, ROOM), '2026-11-30'), { date: '2026-11-30', status: 'partial', seats_left: 1 });
});

test('samedi : matin ouvert, après-midi et journée fermés', () => {
  const sat = '2026-11-28';
  assert.equal(dow(sat), 6);
  assert.deepEqual(day(month('2026-11', { tarifType: 'demi_journee', slot: 'matin' }), sat), { date: sat, status: 'open', seats_left: 10 });
  assert.deepEqual(day(month('2026-11', { tarifType: 'demi_journee', slot: 'aprem' }), sat), { date: sat, status: 'closed', seats_left: null });
  assert.deepEqual(day(month('2026-11', { tarifType: 'journee' }), sat), { date: sat, status: 'closed', seats_left: null });
  assert.deepEqual(day(month('2026-11', { tarifType: 'journee', slot: 'journee' }), sat), { date: sat, status: 'closed', seats_left: null });
  assert.equal(day(month('2026-11'), sat).status, 'open');
  // Sans slot, la demi-journée du samedi existe (le matin).
  assert.equal(day(month('2026-11', { tarifType: 'demi_journee' }), sat).status, 'open');
});

test('changement d\'heure de mars : les réservations restent sur le bon jour et la bonne demi-journée', () => {
  // Dimanche 28/03/2027 : passage à l'heure d'été (UTC+2 dès le lundi 29).
  // Lundi 29 : 14:00-15:00 Paris = 12:00Z-13:00Z. Le matin (fin 14:00 = 12:00Z) reste libre.
  resa(OPEN, '2027-03-29T12:00:00.000Z', '2027-03-29T13:00:00.000Z', 5);
  // Vendredi 26 (encore UTC+1) : 14:00-15:00 Paris = 13:00Z-14:00Z.
  resa(OPEN, '2027-03-26T13:00:00.000Z', '2027-03-26T14:00:00.000Z', 5);
  const matin = month('2027-03', { tarifType: 'demi_journee', slot: 'matin' });
  const aprem = month('2027-03', { tarifType: 'demi_journee', slot: 'aprem' });
  assert.equal(matin.days.length, 31);
  matin.days.forEach((d, i) => assert.equal(d.date, `2027-03-${String(i + 1).padStart(2, '0')}`));
  assert.equal(day(matin, '2027-03-29').status, 'open');
  assert.deepEqual(day(aprem, '2027-03-29'), { date: '2027-03-29', status: 'partial', seats_left: 5 });
  assert.equal(day(matin, '2027-03-26').status, 'open');
  assert.equal(day(aprem, '2027-03-26').status, 'partial');
  // Le jour du changement d'heure est un dimanche : fermé, pas décalé.
  assert.equal(day(matin, '2027-03-28').status, 'closed');
  assert.equal(day(matin, '2027-03-27').status, 'open'); // samedi, matin
  assert.equal(day(aprem, '2027-03-27').status, 'closed');
  for (const d of matin.days) assert.equal(d.status === 'closed' && dow(d.date) !== 0 && dow(d.date) !== 6, false);
});

test('changement d\'heure d\'octobre : idem, et le 1er du mois suivant n\'est pas contaminé', () => {
  // Dimanche 31/10/2027 : retour à l'heure d'hiver. Lundi 25 (UTC+2) : 14:00-15:00 = 12:00Z-13:00Z.
  resa(OPEN, '2027-10-25T12:00:00.000Z', '2027-10-25T13:00:00.000Z', 5);
  // Lundi 1er nov. (UTC+1) : 14:00-15:00 = 13:00Z-14:00Z.
  resa(OPEN, '2027-11-01T13:00:00.000Z', '2027-11-01T14:00:00.000Z', 5);
  const oct = month('2027-10', { tarifType: 'demi_journee', slot: 'matin' });
  const octA = month('2027-10', { tarifType: 'demi_journee', slot: 'aprem' });
  const nov = month('2027-11', { tarifType: 'demi_journee', slot: 'matin' });
  const novA = month('2027-11', { tarifType: 'demi_journee', slot: 'aprem' });
  assert.equal(oct.days.length, 31);
  assert.equal(day(oct, '2027-10-25').status, 'open');
  assert.equal(day(octA, '2027-10-25').status, 'partial');
  assert.equal(day(oct, '2027-10-31').status, 'closed');
  assert.equal(day(nov, '2027-11-01').status, 'open');
  assert.equal(day(novA, '2027-11-01').status, 'partial');
  assert.equal(nov.days.length, 30);
  assert.equal(day(octA, '2027-10-26').status, 'open');
});

test('le nombre de requêtes SQL ne dépend ni du nombre de jours ni du nombre de réservations', () => {
  const Statement = Object.getPrototypeOf(db.prepare('SELECT 1'));
  const counts = { n: 0 };
  const saved = {};
  for (const k of ['all', 'get', 'run', 'iterate']) {
    saved[k] = Statement[k];
    Statement[k] = function wrapped(...a) { counts.n += 1; return saved[k].apply(this, a); };
  }
  const measure = (m, opts) => { counts.n = 0; monthAvailability(OPEN, m, { now: NOW, ...opts }); return counts.n; };
  try {
    const feb = measure('2027-02', {});          // 28 jours
    const dec = measure('2026-12', {});          // 31 jours
    // On charge le mois de réservations : le nombre de requêtes ne bouge pas.
    for (let i = 0; i < 200; i += 1) {
      const hh = (n) => String(n).padStart(2, '0');
      const dd = hh(1 + (i % 28));
      resa(OPEN, `2027-02-${dd}T${hh(7 + (i % 5))}:00:00.000Z`, `2027-02-${dd}T${hh(8 + (i % 5))}:00:00.000Z`, 1);
    }
    const febDense = measure('2027-02', { tarifType: 'demi_journee' });
    assert.equal(feb, dec);
    assert.equal(febDense, feb);
    assert.ok(feb <= 3, `requêtes pour un mois : ${feb}`);
  } finally {
    for (const k of Object.keys(saved)) Statement[k] = saved[k];
  }
});

test('erreurs de la bibliothèque : mois mal formé, mois hors fenêtre, espace inconnu ou inactif', () => {
  const code = (c) => (e) => e.code === c;
  for (const bad of [undefined, '', '2026-1', '2026-13', '2026-00', '26-11', '2026-11-01', ['2026-11'], 'abc']) {
    assert.throws(() => month(bad), code('MOIS_INVALIDE'), String(bad));
  }
  assert.throws(() => month('2026-09'), code('MOIS_HORS_FENETRE'));   // -2 mois
  assert.doesNotThrow(() => month('2026-10'));                          // -1 mois : autorisé
  assert.doesNotThrow(() => month('2029-11'));                          // +36 mois : autorisé
  assert.throws(() => month('2029-12'), code('MOIS_HORS_FENETRE'));    // +37 mois
  assert.equal(month('2026-11', {}, 999999), null);
  assert.equal(month('2026-11', {}, DEAD), null);
  // Tout le mois précédent est « past ».
  assert.ok(month('2026-10').days.every((d) => d.status === 'past'));
});

// ── Route HTTP, visiteur NON connecté (aucun middleware de session monté) ───
const app = express();
// Doublure d'`attachUser` : sans l'en-tête, visiteur anonyme (req.user absent).
app.use((req, _res, next) => { const role = req.get('x-test-role'); if (role) req.user = { id: 1, role }; next(); });
app.use('/api', spacesRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(() => { server.close(); });
const BASE = `http://127.0.0.1:${server.address().port}/api/availability/month`;
// Budget de requêtes du fichier (voir l'en-tête) : 60 par minute et par processus.
const QUOTA_MAX = 55;
let sent = 0;
const countRequest = () => {
  sent += 1;
  assert.ok(sent <= QUOTA_MAX, `quota du limiteur épuisé (${sent} requêtes) : déplacer ce test de route dans un autre fichier`);
};
const get = async (qs, role) => {
  countRequest();
  const res = await fetch(`${BASE}?${qs}`, role ? { headers: { 'x-test-role': role } } : undefined);
  return { status: res.status, text: await res.text() };
};
const json = (r) => JSON.parse(r.text);

// Mois relatif à l'horloge réelle (la route n'a pas d'horloge injectable).
const monthOffset = (n) => {
  const [y, m] = parisDateKey().split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

test('route : un visiteur anonyme obtient le calendrier, sans aucune donnée personnelle', async () => {
  const target = monthOffset(2);
  const [y, m] = target.split('-').map(Number);
  // Une réservation d'un membre nommé, un lundi du mois visé.
  let d = 1; while (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 1) d += 1;
  const iso = `${target}-${String(d).padStart(2, '0')}`;
  resa(OPEN, `${iso}T09:00:00.000Z`, `${iso}T11:00:00.000Z`, 3);

  const r = await get(`space_id=${OPEN}&month=${target}`);
  assert.equal(r.status, 200);
  const body = json(r);
  assert.deepEqual(Object.keys(body).sort(), ['capacity', 'days', 'exclusive', 'month', 'seats', 'space_id', 'tarif_type', 'timezone'].sort());
  assert.equal(body.space_id, OPEN);
  assert.equal(body.exclusive, false);
  assert.equal(body.month, target);
  assert.equal(body.seats, 1);
  assert.equal(body.days.length, new Date(Date.UTC(y, m, 0)).getUTCDate());
  // Le jour réservé est bien présent ; son statut est l'objet d'un autre test (seuil).
  assert.ok(day(body, iso));
  for (const dd of body.days) assert.deepEqual(Object.keys(dd).sort(), ['date', 'seats_left', 'status']);
  // Aucune fuite : ni nom, ni e-mail, ni identifiant du membre, ni horaire de la réservation.
  for (const secret of [MEMBER_EMAIL, MEMBER_NAME, 'Zoé', 'Confidentielle', '0611223344', 'user', 'member', `T09:00`, `T11:00`]) {
    assert.equal(r.text.includes(secret), false, `fuite : ${secret}`);
  }
  assert.equal(r.text.includes(`"user_id"`), false);
});

test('route : tarif_type, slot et seats sont pris en compte', async () => {
  const target = monthOffset(2);
  const r = json(await get(`space_id=${OPEN}&month=${target}&tarif_type=demi_journee&slot=aprem&seats=2`));
  assert.equal(r.tarif_type, 'demi_journee');
  assert.equal(r.seats, 2);
  const saturdays = r.days.filter((x) => dow(x.date) === 6);
  assert.ok(saturdays.length >= 4);
  assert.ok(saturdays.every((x) => x.status === 'closed' && x.seats_left === null));
});

test('route : erreurs 400 / 404 avec un code métier explicite', async () => {
  const ok = monthOffset(1);
  const expectErr = async (qs, status, error) => {
    const r = await get(qs);
    assert.equal(r.status, status, qs);
    assert.deepEqual(json(r), { error }, qs);
  };
  await expectErr(`month=${ok}`, 400, 'SPACE_ID_REQUIS');
  await expectErr(`space_id=abc&month=${ok}`, 400, 'SPACE_ID_REQUIS');
  await expectErr(`space_id=0&month=${ok}`, 400, 'SPACE_ID_REQUIS');
  await expectErr(`space_id=${OPEN}`, 400, 'MOIS_INVALIDE');
  await expectErr(`space_id=${OPEN}&month=2026-13`, 400, 'MOIS_INVALIDE');
  await expectErr(`space_id=${OPEN}&month=novembre`, 400, 'MOIS_INVALIDE');
  await expectErr(`space_id=${OPEN}&month=${ok}&month=${ok}`, 400, 'MOIS_INVALIDE');
  await expectErr(`space_id=${OPEN}&month=${monthOffset(-2)}`, 400, 'MOIS_HORS_FENETRE');
  await expectErr(`space_id=${OPEN}&month=${monthOffset(37)}`, 400, 'MOIS_HORS_FENETRE');
  await expectErr(`space_id=${OPEN}&month=1999-01`, 400, 'MOIS_HORS_FENETRE');
  await expectErr(`space_id=${OPEN}&month=${ok}&tarif_type=semaine`, 400, 'TARIF_TYPE_INVALIDE');
  await expectErr(`space_id=${OPEN}&month=${ok}&slot=soir`, 400, 'SLOT_INVALIDE');
  await expectErr(`space_id=${OPEN}&month=${ok}&seats=0`, 400, 'PLACES_INVALIDES');
  await expectErr(`space_id=${OPEN}&month=${ok}&seats=deux`, 400, 'PLACES_INVALIDES');
  await expectErr(`space_id=${OPEN}&month=${ok}&exclude_reservation_id=0`, 400, 'RESERVATION_ID_INVALIDE');
  await expectErr(`space_id=${OPEN}&month=${ok}&exclude_reservation_id=abc`, 400, 'RESERVATION_ID_INVALIDE');
  await expectErr(`space_id=${OPEN}&month=${ok}&exclude_reservation_id=-3`, 400, 'RESERVATION_ID_INVALIDE');
  await expectErr(`space_id=999999&month=${ok}`, 404, 'ESPACE_INTROUVABLE');
  await expectErr(`space_id=${DEAD}&month=${ok}`, 404, 'ESPACE_INTROUVABLE');
});

// ── Nouveautés : `exclusive`, `exclude_reservation_id`, espaces hors ligne ───
test('`exclusive` est dans la réponse (au niveau de `capacity`) : salle = true, open space = false', () => {
  assert.equal(month('2026-11', {}, ROOM).exclusive, true);
  assert.equal(month('2026-11', {}, OPEN).exclusive, false);
});

test('exclude_reservation_id : la réservation déplacée ne se compte plus elle-même', () => {
  // Salle (exclusive) réservée de 10:00 à 11:00 Paris (09:00Z-10:00Z), mardi 8 déc. 2026.
  const id = Number(resa(ROOM, '2026-12-08T09:00:00.000Z', '2026-12-08T10:00:00.000Z', 1).lastInsertRowid);
  assert.deepEqual(day(month('2026-12', {}, ROOM), '2026-12-08'), { date: '2026-12-08', status: 'partial', seats_left: 1 });
  assert.deepEqual(day(month('2026-12', { excludeReservationId: id }, ROOM), '2026-12-08'), { date: '2026-12-08', status: 'open', seats_left: 1 });
  // Open space privatisé sur la journée (10 places, 8h30-19h30) : « full » tant qu'on ne l'exclut pas.
  const idDay = Number(resa(OPEN, '2026-12-09T07:30:00.000Z', '2026-12-09T18:30:00.000Z', 10).lastInsertRowid);
  assert.equal(day(month('2026-12', { tarifType: 'journee' }), '2026-12-09').status, 'full');
  assert.deepEqual(day(month('2026-12', { tarifType: 'journee', excludeReservationId: idDay }), '2026-12-09'), { date: '2026-12-09', status: 'open', seats_left: 10 });
  // Exclure une AUTRE réservation ne change rien ; l'identifiant 0 / absent n'exclut rien.
  assert.equal(day(month('2026-12', { tarifType: 'journee', excludeReservationId: id }), '2026-12-09').status, 'full');
  assert.equal(day(month('2026-12', { tarifType: 'journee', excludeReservationId: 0 }), '2026-12-09').status, 'full');
});

test('route : exclude_reservation_id n\'est honoré que pour un admin (pas de sonde par différence)', async () => {
  const [y, m] = monthOffset(3).split('-').map(Number);
  const target = monthOffset(3);
  let d = 1; while (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 2) d += 1; // un mardi
  const iso = `${target}-${String(d).padStart(2, '0')}`;
  const id = Number(resa(ROOM, `${iso}T09:00:00.000Z`, `${iso}T10:00:00.000Z`, 1).lastInsertRowid);
  const qs = (excl) => `space_id=${ROOM}&month=${target}${excl === undefined ? '' : `&exclude_reservation_id=${excl}`}`;
  const base = await get(qs());
  assert.equal(day(json(base), iso).status, 'partial');
  // Anonyme et membre : la réponse avec le vrai identifiant est IDENTIQUE à celle sans, et à celle
  // avec un identifiant inexistant : aucune différence à comparer.
  for (const role of [undefined, 'member']) {
    const real = await get(qs(id), role);
    const fake = await get(qs(987654), role);
    assert.equal(real.status, 200);
    assert.equal(real.text, base.text, `rôle ${role}`);
    assert.equal(fake.text, base.text, `rôle ${role}`);
  }
  // Admin : la réservation est retirée du calcul.
  const adm = await get(qs(id), 'admin');
  assert.equal(adm.status, 200);
  assert.deepEqual(day(json(adm), iso), { date: iso, status: 'open', seats_left: 1 });
  assert.equal(json(adm).exclusive, true);
});

test('route : un espace non réservable en ligne est refusé à un visiteur (409), servi à un admin', async () => {
  const ok = monthOffset(1);
  const anon = await get(`space_id=${PRIVATE}&month=${ok}`);
  assert.equal(anon.status, 409);
  assert.deepEqual(json(anon), { error: 'ESPACE_NON_RESERVABLE' });
  const member = await get(`space_id=${PRIVATE}&month=${ok}`, 'member');
  assert.equal(member.status, 409);
  const adm = await get(`space_id=${PRIVATE}&month=${ok}`, 'admin');
  assert.equal(adm.status, 200);
  assert.equal(json(adm).space_id, PRIVATE);
  assert.equal(json(adm).days.length > 0, true);
  // Un espace réservable en ligne reste servi à tous.
  assert.equal((await get(`space_id=${OPEN}&month=${ok}`)).status, 200);
  // Un espace inactif reste 404, même pour un admin.
  assert.equal((await get(`space_id=${DEAD}&month=${ok}`, 'admin')).status, 404);
});

// ── parisLocalToUtcIso : les jours de 23 h et de 25 h ─────────────────────────
test('parisLocalToUtcIso : jours de changement d\'heure (23 h et 25 h), décalage relu', () => {
  // Dimanche 29/03/2026 : 02:00 -> 03:00, journée de 23 h. Minuit début = CET (+1), minuit de fin = CEST (+2).
  assert.equal(parisLocalToUtcIso(2026, 3, 29, 0), '2026-03-28T23:00:00.000Z');
  assert.equal(parisLocalToUtcIso(2026, 3, 29, 1440), '2026-03-29T22:00:00.000Z');
  assert.equal(Date.parse(parisLocalToUtcIso(2026, 3, 29, 1440)) - Date.parse(parisLocalToUtcIso(2026, 3, 29, 0)), 23 * 3600 * 1000);
  // Dimanche 25/10/2026 : 03:00 -> 02:00, journée de 25 h. Minuit début = CEST (+2), minuit de fin = CET (+1).
  assert.equal(parisLocalToUtcIso(2026, 10, 25, 0), '2026-10-24T22:00:00.000Z');
  assert.equal(parisLocalToUtcIso(2026, 10, 25, 1440), '2026-10-25T23:00:00.000Z');
  assert.equal(Date.parse(parisLocalToUtcIso(2026, 10, 25, 1440)) - Date.parse(parisLocalToUtcIso(2026, 10, 25, 0)), 25 * 3600 * 1000);
  // 1440 min d'un jour = minuit du lendemain ; le jour 32 déborde sur le mois suivant.
  assert.equal(parisLocalToUtcIso(2026, 3, 29, 1440), parisLocalToUtcIso(2026, 3, 30, 0));
  assert.equal(parisLocalToUtcIso(2026, 3, 32, 0), parisLocalToUtcIso(2026, 4, 1, 0));
  assert.equal(parisLocalToUtcIso(2026, 3, 32, 0), '2026-03-31T22:00:00.000Z');
  // Heures ordinaires, hiver et été.
  assert.equal(parisLocalToUtcIso(2026, 1, 15, 510), '2026-01-15T07:30:00.000Z');
  assert.equal(parisLocalToUtcIso(2026, 7, 15, 510), '2026-07-15T06:30:00.000Z');
});

// ── Bascule de « past » autour de minuit (Paris) ──────────────────────────────
test('monthAvailability : « past » bascule exactement à minuit Paris (hiver, UTC+1)', () => {
  // 23:59:59 Paris le 24/11 = 22:59:59Z : le 24 est encore « aujourd\'hui ».
  const avant = monthAvailability(OPEN, '2026-11', { now: new Date('2026-11-24T22:59:59.000Z') });
  assert.equal(day(avant, '2026-11-24').status, 'open');
  assert.equal(day(avant, '2026-11-23').status, 'past');
  // 00:00:00 Paris le 25/11 = 23:00:00Z : le 24 devient « past ».
  const apres = monthAvailability(OPEN, '2026-11', { now: new Date('2026-11-24T23:00:00.000Z') });
  assert.equal(day(apres, '2026-11-24').status, 'past');
  assert.equal(day(apres, '2026-11-25').status, 'partial');
});

test('monthAvailability : « past » bascule exactement à minuit Paris (été, UTC+2)', () => {
  const avant = monthAvailability(OPEN, '2027-07', { now: new Date('2027-07-14T21:59:59.000Z') });
  assert.equal(day(avant, '2027-07-14').status, 'open');
  const apres = monthAvailability(OPEN, '2027-07', { now: new Date('2027-07-14T22:00:00.000Z') });
  assert.equal(day(apres, '2027-07-14').status, 'past');
  assert.equal(day(apres, '2027-07-15').status, 'open');
});

// ── Fenêtre « heure » avec une coupure déjeuner (piège latent) ────────────────
test('formule « heure » : une coupure déjeuner n\'est pas avalée par l\'enveloppe min..max', () => {
  // ATTENTION : ce test MUTE `config.openingHours` (objet partagé) et le restaure en `finally`.
  // C'est sûr tant que le corps est SYNCHRONE et que `node --test` isole chaque fichier dans son
  // processus. N'y ajoutez JAMAIS de `await` (ni de `t.test` imbriqué asynchrone) : un autre
  // test pourrait s'exécuter pendant que la config est modifiée et voir la coupure déjeuner.
  const saved = config.openingHours[2];
  try {
    config.openingHours[2] = [[510, 780], [840, 1170]]; // mardi : 8h30-13h et 14h-19h30
    assert.deepEqual(windowsFor(2, 'heure', null), [[510, 780], [840, 1170]]);
    // Mardi 2027-01-05, matin ET après-midi entièrement pris (10 places) : « full », pas « libre ».
    resa(OPEN, '2027-01-05T07:30:00.000Z', '2027-01-05T12:00:00.000Z', 10);
    resa(OPEN, '2027-01-05T13:00:00.000Z', '2027-01-05T18:30:00.000Z', 10);
    assert.deepEqual(day(month('2027-01', {}, OPEN), '2027-01-05'), { date: '2027-01-05', status: 'full', seats_left: 0 });
    // Seul le matin pris : il reste l'après-midi, « partial », mais AUCUN chiffre (la plage du
    // matin dit 0, celle de l'après-midi dit 10 : un seul nombre mentirait sur l'une des deux).
    resa(OPEN, '2027-01-12T07:30:00.000Z', '2027-01-12T12:00:00.000Z', 10);
    assert.deepEqual(day(month('2027-01', {}, OPEN), '2027-01-12'), { date: '2027-01-12', status: 'partial', seats_left: null });
  } finally {
    config.openingHours[2] = saved;
  }
  // Une seule plage : fenêtre identique à l'ancienne enveloppe.
  assert.deepEqual(windowsFor(2, 'heure', null), [[510, 1170]]);
  assert.deepEqual(windowsFor(0, 'heure', null), []);
});

// ── Route à travers la VRAIE chaîne de session (cookie -> attachUser -> route) ──
// Les tests ci-dessus simulent le rôle par un en-tête `x-test-role` : ils resteraient verts
// même si la route perdait son middleware de session. Ici, le rôle vient d'une vraie ligne
// `sessions`, lue par le vrai `attachUser`.
const realApp = express();
realApp.use(cookieParser());
realApp.use(attachUser);
realApp.use('/api', spacesRouter);
const realServer = await new Promise((resolve) => { const s = realApp.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(() => { realServer.close(); });
const REAL_BASE = `http://127.0.0.1:${realServer.address().port}/api/availability/month`;
const sessionCookie = (role) => {
  const uid = Number(db.prepare(
    `INSERT INTO users (email, password_hash, display_name, role) VALUES (?, 'x', ?, ?)`
  ).run(`${role}.${crypto.randomBytes(4).toString('hex')}@exemple.test`, `Compte ${role}`, role).lastInsertRowid);
  const sid = crypto.randomBytes(16).toString('hex');
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run(sid, uid, new Date(Date.now() + 3600e3).toISOString());
  return `${config.cookieName}=${sid}`;
};
const getReal = async (qs, cookie) => {
  countRequest();
  const res = await fetch(`${REAL_BASE}?${qs}`, cookie ? { headers: { cookie } } : undefined);
  return { status: res.status, text: await res.text() };
};

test('chaîne réelle : le rôle vient de la SESSION (cookie), pas d\'un en-tête', async () => {
  const ok = monthOffset(1);
  const adminCookie = sessionCookie('admin');
  const memberCookie = sessionCookie('member');
  // Espace hors ligne : refusé à l'anonyme et au membre, servi à l'admin (session réelle).
  assert.equal((await getReal(`space_id=${PRIVATE}&month=${ok}`)).status, 409);
  assert.equal((await getReal(`space_id=${PRIVATE}&month=${ok}`, memberCookie)).status, 409);
  assert.equal((await getReal(`space_id=${PRIVATE}&month=${ok}`, adminCookie)).status, 200);
  // Un en-tête `x-test-role` n'a AUCUN effet ici : il ne donne pas le rôle admin.
  countRequest();
  const forged = await fetch(`${REAL_BASE}?space_id=${PRIVATE}&month=${ok}`, { headers: { 'x-test-role': 'admin' } });
  assert.equal(forged.status, 409);
  // `exclude_reservation_id` n'est honoré que pour la session admin.
  const target = monthOffset(4);
  const [y, m] = target.split('-').map(Number);
  let d = 1; while (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 3) d += 1; // un mercredi
  const iso = `${target}-${String(d).padStart(2, '0')}`;
  const id = Number(resa(ROOM, `${iso}T09:00:00.000Z`, `${iso}T10:00:00.000Z`, 1).lastInsertRowid);
  const qs = `space_id=${ROOM}&month=${target}&exclude_reservation_id=${id}`;
  assert.equal(day(json(await getReal(qs, memberCookie)), iso).status, 'partial');
  assert.equal(day(json(await getReal(qs, adminCookie)), iso).status, 'open');
});

test('ordre de montage : `attachUser` précède le routeur des espaces dans index.js', () => {
  // La route lit `req.user` : monté avant `attachUser`, elle verrait toujours un anonyme et
  // le calendrier de déplacement (admin) cesserait d'honorer `exclude_reservation_id`, sans
  // qu'aucun test à rôle simulé ne le détecte. index.js démarre le serveur à l'import : on
  // vérifie donc l'ordre dans son source.
  const src = fs.readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');
  const attach = src.indexOf('app.use(attachUser)');
  const spaces = src.indexOf("app.use('/api', spacesRouter)");
  assert.ok(attach !== -1, 'app.use(attachUser) introuvable dans index.js');
  assert.ok(spaces !== -1, "app.use('/api', spacesRouter) introuvable dans index.js");
  assert.ok(attach < spaces, 'attachUser doit être monté AVANT spacesRouter');
});

// ── Seuil « quelques places » : la moitié de la capacité occupée ─────────────
// Journée entière (08:30-19:30 Paris = 07:30Z-18:30Z en hiver), décembre 2026.
const dayResa = (space, date, seats) => resa(space, `${date}T07:30:00.000Z`, `${date}T18:30:00.000Z`, seats);

test('seuil : constante nommée, moitié arrondie au-dessus, jamais de 7 en dur', () => {
  assert.equal(PARTIAL_OCCUPANCY_RATIO, 0.5);
  assert.equal(partialThreshold(7), 4);   // impaire : 4 occupées = « la moitié » pour le client
  assert.equal(partialThreshold(10), 5);  // paire : exactement la moitié
  assert.equal(partialThreshold(6), 3);
  assert.equal(partialThreshold(2), 1);
  assert.equal(partialThreshold(1), 1);
});

test('capacité impaire (7, cas du client) : 3 occupées « open », 4 « partial », 6 « partial », 7 « full »', () => {
  const SEVEN = Number(insSpace.run('Open space 7', 7, 0, 1, 1).lastInsertRowid);
  const cases = [['2026-12-14', 0, 'open', 7], ['2026-12-15', 3, 'open', 4], ['2026-12-16', 4, 'partial', 3],
    ['2026-12-17', 6, 'partial', 1], ['2026-12-18', 7, 'full', 0]];
  for (const [date, n] of cases) if (n) dayResa(SEVEN, date, n);
  const r = month('2026-12', { tarifType: 'journee' }, SEVEN);
  for (const [date, , status, left] of cases) assert.deepEqual(day(r, date), { date, status, seats_left: left }, date);
  // « open » reste cohérent avec seats_left : 4 places restantes sur 7, chiffre exact conservé.
  assert.equal(day(r, '2026-12-15').seats_left, 4);
});

test('convention du calendrier : pic pour le statut, chiffre seulement s\'il est cohérent, null sinon', () => {
  // Le calendrier qualifie la JOURNÉE (statut au PIC d'occupation), le badge de la page de
  // réservation chiffre le CRÉNEAU. À l'heure, `seats_left` suit le meilleur instant (souvent
  // l'ouverture) : sur un jour « partial » il contredirait le statut, d'où `null`.
  const SEVEN = Number(insSpace.run('Open space 7 convention', 7, 0, 1, 1).lastInsertRowid);
  const h = (date, from, to, n) => resa(SEVEN, `${date}T${from}:00.000Z`, `${date}T${to}:00.000Z`, n);
  h('2026-12-21', '08:00', '09:00', 3);   // pic 3 < 4 : « open », chiffre conservé
  h('2026-12-22', '08:00', '09:00', 4);   // pic 4 = seuil : « partial », 7 au meilleur instant
  h('2026-12-23', '07:30', '18:30', 7);   // 7 postes sur 7 toute la journée : « full »
  h('2026-12-24', '08:00', '17:00', 7);   // 7 sur 7 de 09:00 à 18:00 : surtout PAS « open »
  const r = month('2026-12', {}, SEVEN);
  assert.deepEqual(day(r, '2026-12-21'), { date: '2026-12-21', status: 'open', seats_left: 7 });
  assert.deepEqual(day(r, '2026-12-22'), { date: '2026-12-22', status: 'partial', seats_left: null });
  assert.deepEqual(day(r, '2026-12-23'), { date: '2026-12-23', status: 'full', seats_left: 0 });
  assert.deepEqual(day(r, '2026-12-24'), { date: '2026-12-24', status: 'partial', seats_left: null });
  // Forfaits : pic === capacité - restant, la garde ne change rien (chiffre exact conservé).
  for (const tarifType of ['demi_journee', 'journee']) {
    const f = month('2026-12', { tarifType, slot: tarifType === 'journee' ? null : 'matin' }, SEVEN);
    assert.deepEqual(day(f, '2026-12-22'), { date: '2026-12-22', status: 'partial', seats_left: 3 }, tarifType);
    assert.deepEqual(day(f, '2026-12-21'), { date: '2026-12-21', status: 'open', seats_left: 4 }, tarifType);
  }
});

test('capacité 1 : « full » l\'emporte sur « partial » (évalué avant), seuil à 1', () => {
  const ONE = Number(insSpace.run('Poste unique', 1, 0, 1, 1).lastInsertRowid);
  assert.equal(partialThreshold(1), 1);
  resa(ONE, '2026-12-21T07:30:00.000Z', '2026-12-21T18:30:00.000Z', 1);  // toute la journée
  resa(ONE, '2026-12-22T08:00:00.000Z', '2026-12-22T09:00:00.000Z', 1);  // une heure
  const j = month('2026-12', { tarifType: 'journee' }, ONE);
  assert.deepEqual(day(j, '2026-12-21'), { date: '2026-12-21', status: 'full', seats_left: 0 });
  assert.deepEqual(day(j, '2026-12-23'), { date: '2026-12-23', status: 'open', seats_left: 1 });
  const h = month('2026-12', {}, ONE);
  assert.deepEqual(day(h, '2026-12-21'), { date: '2026-12-21', status: 'full', seats_left: 0 });
  // Une heure prise : pic 1 >= seuil 1 : « partial », et le « 1 place » du meilleur instant est omis.
  assert.deepEqual(day(h, '2026-12-22'), { date: '2026-12-22', status: 'partial', seats_left: null });
});

test('capacité paire (6) : 2 occupées « open », 3 (la moitié exacte) « partial »', () => {
  const SIX = Number(insSpace.run('Open space 6', 6, 0, 1, 1).lastInsertRowid);
  dayResa(SIX, '2026-12-15', 2);
  dayResa(SIX, '2026-12-16', 3);
  const r = month('2026-12', { tarifType: 'journee' }, SIX);
  assert.deepEqual(day(r, '2026-12-15'), { date: '2026-12-15', status: 'open', seats_left: 4 });
  assert.deepEqual(day(r, '2026-12-16'), { date: '2026-12-16', status: 'partial', seats_left: 3 });
});

test('« full » inchangé : seats demandé > places restantes, même sous le seuil', () => {
  const SEVEN = Number(insSpace.run('Open space 7 bis', 7, 0, 1, 1).lastInsertRowid);
  dayResa(SEVEN, '2026-12-15', 3); // 3 occupées : « open » pour 1 poste, 4 restantes
  dayResa(SEVEN, '2026-12-16', 4); // 4 occupées : « partial » pour 1 poste, 3 restantes
  const un = month('2026-12', { tarifType: 'journee' }, SEVEN);
  assert.equal(day(un, '2026-12-15').status, 'open');
  assert.equal(day(un, '2026-12-16').status, 'partial');
  const quatre = month('2026-12', { tarifType: 'journee', seats: 4 }, SEVEN);
  assert.deepEqual(day(quatre, '2026-12-15'), { date: '2026-12-15', status: 'open', seats_left: 4 });
  // 4 postes demandés, 3 restants : « full » POUR LUI, alors que la salle n'est pas pleine.
  assert.deepEqual(day(quatre, '2026-12-16'), { date: '2026-12-16', status: 'full', seats_left: 3 });
  assert.equal(quatre.seats, 4);
});

test('espace exclusif : binaire, le seuil ne s\'applique pas (capacité 6 = occupants)', () => {
  // Salle de 6 occupants : une réservation d'1 « place » (unité = la salle) ne la met pas « partial ».
  dayResa(ROOM, '2026-12-15', 1);
  const j = month('2026-12', { tarifType: 'journee' }, ROOM);
  assert.deepEqual(day(j, '2026-12-15'), { date: '2026-12-15', status: 'full', seats_left: 0 });
  assert.deepEqual(day(j, '2026-12-16'), { date: '2026-12-16', status: 'open', seats_left: 1 });
  // À l'heure : une seule réservation d'une heure rend le jour « partial » (comportement d'avant).
  resa(ROOM, '2026-12-17T09:00:00.000Z', '2026-12-17T10:00:00.000Z', 1);
  assert.deepEqual(day(month('2026-12', {}, ROOM), '2026-12-17'), { date: '2026-12-17', status: 'partial', seats_left: 1 });
});
