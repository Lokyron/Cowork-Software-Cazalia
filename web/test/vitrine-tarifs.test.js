// Fonctions pures de la page Tarifs : carte « Bureau privatif » et section Ponctuel.
//   cd web && npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { eurc, privateOfficeCard, ponctuelFrom, bureauForfaitsLabel, samediNote, ponctuelColumns } from '../src/vitrine-tarifs.js';

const GRILLE = {
  open_space: { demi_journee: 1200, journee: 2000 },
  meeting_room: { heure: 2000, demi_journee: 3500, journee: 5000 },
};
const office = (over = {}) => ({
  count: 1, online_bookable: true, bookable: true, half_day_cents: 4000, day_cents: 7000, ...over,
});
const names = (t) => ponctuelFrom(t).map((c) => c.name);

test('eurc : montants ronds sans centimes', () => {
  assert.equal(eurc(2000), '20 €');
});

test('eurc : montant non multiple de 100, centimes conservés', () => {
  // Intl met une espace insécable avant « € » : on la normalise pour comparer.
  assert.equal(eurc(4050).replace(/\s/g, ' '), '40,50 €');
});

test('bureau réservable avec les deux forfaits : journée en prix, demi-journée en ligne', () => {
  const c = privateOfficeCard(office());
  assert.equal(c.name, 'Bureau privatif');
  assert.equal(c.price, '70 €');
  assert.equal(c.unit, '/ journée');
  assert.deepEqual(c.lines, ['40 € la demi-journée', 'Même pièce que la salle confidentielle']);
});

test('bureau avec un seul forfait : pas de ligne pour l\'autre', () => {
  const half = privateOfficeCard(office({ day_cents: null }));
  assert.equal(half.price, '40 €');
  assert.equal(half.unit, '/ demi-journée');
  assert.equal(half.lines.length, 1);
  const day = privateOfficeCard(office({ half_day_cents: null }));
  assert.equal(day.price, '70 €');
  assert.equal(day.unit, '/ journée');
  assert.equal(day.lines.length, 1);
});

test('pas de carte si le bureau n\'est pas réservable ou sans prix', () => {
  assert.equal(privateOfficeCard(null), null);
  assert.equal(privateOfficeCard(undefined), null);
  assert.equal(privateOfficeCard(office({ bookable: false })), null);
  assert.equal(privateOfficeCard(office({ half_day_cents: null, day_cents: 0 })), null);
});

test('section Ponctuel : trois cartes sans bureau, quatre avec, ordre stable', () => {
  assert.deepEqual(names({ ...GRILLE, private_office: null }), ['Open Space', 'Salle de réunion', 'Salle confidentielle']);
  assert.deepEqual(names({ ...GRILLE, private_office: office({ bookable: false }) }), ['Open Space', 'Salle de réunion', 'Salle confidentielle']);
  assert.deepEqual(names({ ...GRILLE, private_office: office() }), ['Open Space', 'Salle de réunion', 'Bureau privatif', 'Salle confidentielle']);
});

test('carte Open Space : la salle confidentielle incluse, sous réserve de non-privatisation, ligne courte', () => {
  const open = ponctuelFrom({ ...GRILLE, private_office: null })[0];
  const l = open.lines.find((x) => x.includes('Salle confidentielle incluse'));
  assert.ok(l && l.includes('sous réserve de non-privatisation'));
  assert.ok(l.length <= 70, `${l.length} caractères`);
});

test('« à partir de » quand les bureaux diffèrent', () => {
  const c = privateOfficeCard(office({ from: true }));
  assert.equal(c.from, true);
  assert.deepEqual(c.lines, ['à partir de 40 € la demi-journée', 'Même pièce que la salle confidentielle']);
  assert.equal(privateOfficeCard(office()).from, false);
});

test('forfaits réellement réservables, en toutes lettres', () => {
  assert.equal(bureauForfaitsLabel(office()), 'une demi-journée ou une journée');
  assert.equal(bureauForfaitsLabel(office({ day_cents: null })), 'une demi-journée');
  assert.equal(bureauForfaitsLabel(office({ half_day_cents: null })), 'une journée');
  assert.equal(bureauForfaitsLabel(office({ bookable: false })), null);
});

test('note du samedi : booléens de l\'API ou listes de fenêtres', () => {
  const note = 'Le samedi, seule la demi-journée du matin est ouverte.';
  assert.equal(samediNote({ demi_journee: true, journee: false }), note);
  assert.equal(samediNote({ demi_journee: [[540, 780]], journee: [] }), note);
  assert.equal(samediNote({ demi_journee: true, journee: true }), '');
  assert.equal(samediNote({ demi_journee: false, journee: false }), '');
  assert.equal(samediNote(undefined), '');
});

test('grille Ponctuel : 2x2 pour 4 cartes, 3 colonnes sinon', () => {
  assert.deepEqual([3, 4, 5, 6, 8].map(ponctuelColumns), [3, 2, 3, 3, 2]);
});
