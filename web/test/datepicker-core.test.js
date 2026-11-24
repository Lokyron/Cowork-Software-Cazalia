// Tests de la logique pure du sélecteur de jour (`src/datePickerCore.js`) :
//   cd web && npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFR, fmtFR, longLabel, weekday, daysIn, dayInfo, formuleOf } from '../src/datePickerCore.js';

test('parseFR : dates valides, invalides, inexistantes', () => {
  assert.equal(parseFR('01/03/2026'), '2026-03-01');
  assert.equal(parseFR(' 31/12/2026 '), '2026-12-31');
  assert.equal(parseFR('29/02/2028'), '2028-02-29');
  assert.equal(parseFR('29/02/2027'), null);
  assert.equal(parseFR('31/04/2026'), null);
  assert.equal(parseFR('00/01/2026'), null);
  assert.equal(parseFR('15/13/2026'), null);
  assert.equal(parseFR('15/00/2026'), null);
  assert.equal(parseFR('01/01/1899'), null);
  assert.equal(parseFR('1/3/2026'), null);
  assert.equal(parseFR('2026-03-01'), null);
  assert.equal(parseFR(''), null);
});

test('fmtFR, longLabel, weekday, daysIn', () => {
  assert.equal(fmtFR('2026-03-01'), '01/03/2026');
  assert.equal(parseFR(fmtFR('2026-11-24')), '2026-11-24');
  assert.equal(weekday('2026-03-01'), 0); // dimanche
  assert.equal(longLabel('2026-03-01'), 'dimanche 1er mars 2026');
  assert.equal(longLabel('2026-11-24'), 'mardi 24 novembre 2026');
  assert.equal(daysIn(2028, 1), 29);
  assert.equal(daysIn(2027, 1), 28);
});

test('D1 : sans disponibilités (neutre), le dimanche n\'est PAS fermé', () => {
  const sunday = '2026-03-01';
  assert.equal(weekday(sunday), 0);
  assert.deepEqual(dayInfo(sunday, { lo: '2026-02-01', hi: '2029-02-01' }), { k: 'neutral', sel: true });
  assert.deepEqual(dayInfo(sunday, {}), { k: 'neutral', sel: true });
});

test('bornes lo / hi : désactivé, avec le motif', () => {
  const ctx = { lo: '2026-11-24', hi: '2029-11-24' };
  assert.equal(dayInfo('2026-11-23', ctx).k, 'disabled');
  assert.equal(dayInfo('2026-11-23', ctx).sel, false);
  assert.equal(dayInfo('2026-11-24', ctx).sel, true);
  assert.equal(dayInfo('2029-11-24', ctx).sel, true);
  const far = dayInfo('2029-11-25', ctx);
  assert.equal(far.sel, false);
  assert.match(far.why, /24\/11\/2029/);
  // Une date à 30 mois reste choisissable avec le plafond par défaut de 36 mois.
  assert.equal(dayInfo('2029-05-24', ctx).sel, true);
  // `permissive` ne lève jamais les bornes.
  assert.equal(dayInfo('2026-11-23', { ...ctx, permissive: true }).sel, false);
});

test('chargement : aucune promesse de disponibilité, pas de choix (sauf admin)', () => {
  assert.deepEqual(dayInfo('2026-12-01', { state: 'loading' }).k, 'pending');
  assert.equal(dayInfo('2026-12-01', { state: 'loading' }).sel, false);
  assert.equal(dayInfo('2026-12-01', { state: 'loading', permissive: true }).sel, true);
});

test('réponse absente (erreur, limiteur) : ni libre ni complet, choisissable', () => {
  const i = dayInfo('2026-12-01', { state: 'unknown' });
  assert.equal(i.k, 'unknown');
  assert.equal(i.sel, true);
  assert.equal(i.rec, undefined);
});

test('réponse du serveur : statuts open / partial / full / closed / past', () => {
  const at = (status, left = null, extra = {}) => dayInfo('2026-12-01', { state: 'ready', rec: { status, left }, ...extra });
  assert.equal(at('open', 10).k, 'open');
  assert.deepEqual([at('partial', 3).k, at('partial', 3).left, at('partial', 3).sel], ['partial', 3, true]);
  assert.deepEqual([at('full', 0).k, at('full', 0).sel], ['full', false]);
  assert.equal(at('full', 0, { permissive: true }).sel, true);
  assert.deepEqual([at('closed').k, at('closed').sel], ['closed', false]);
  assert.equal(at('closed', null, { permissive: true }).sel, true);
  assert.deepEqual([at('past').k, at('past').sel], ['disabled', false]);
  assert.equal(at('past', null, { permissive: true }).sel, true);
});

test('espace exclusif : « réservé », pas « complet »', () => {
  const full = dayInfo('2026-12-01', { state: 'ready', rec: { status: 'full', left: 0 }, exclusive: true });
  assert.match(full.why, /réservé/);
  const open = dayInfo('2026-12-01', { state: 'ready', rec: { status: 'full', left: 0 }, exclusive: false });
  assert.match(open.why, /complet/);
});

test('formuleOf : la formule du calendrier de déplacement est celle de la réservation', () => {
  // Hiver (UTC+1) : 08:30 Paris = 07:30Z ; 14:00 Paris = 13:00Z.
  assert.deepEqual(formuleOf({ tarif_type: 'journee', start_at: '2026-12-09T07:30:00.000Z' }), { tarifType: 'journee', slot: undefined });
  assert.deepEqual(formuleOf({ tarif_type: 'demi_journee', start_at: '2026-12-09T07:30:00.000Z' }), { tarifType: 'demi_journee', slot: 'matin' });
  assert.deepEqual(formuleOf({ tarif_type: 'demi_journee', start_at: '2026-12-09T13:00:00.000Z' }), { tarifType: 'demi_journee', slot: 'aprem' });
  // Été (UTC+2) : 14:00 Paris = 12:00Z, toujours « aprem » ; 09:00 Paris = 07:00Z, « matin ».
  assert.equal(formuleOf({ tarif_type: 'demi_journee', start_at: '2027-07-14T12:00:00.000Z' }).slot, 'aprem');
  assert.equal(formuleOf({ tarif_type: 'demi_journee', start_at: '2027-07-14T07:00:00.000Z' }).slot, 'matin');
  // Colonne NULL (héritage), 'heure' ou valeur inconnue : formule horaire, pas de slot.
  for (const tarif_type of [null, undefined, 'heure', 'semaine']) {
    assert.deepEqual(formuleOf({ tarif_type, start_at: '2026-12-09T07:30:00.000Z' }), { tarifType: 'heure', slot: undefined });
  }
});
