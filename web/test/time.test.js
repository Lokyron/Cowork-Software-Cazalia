// Tests des fonctions pures de calendrier (aucune dépendance React) :
//   cd web && npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonthsStr, addDaysStr, startOfWeekStr } from '../src/time.js';

test('addMonthsStr : le jour est ramené au dernier jour du mois d\'arrivée', () => {
  assert.equal(addMonthsStr('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsStr('2026-03-31', 1), '2026-04-30'); // 31 -> 30
  assert.equal(addMonthsStr('2026-05-31', -1), '2026-04-30');
  assert.equal(addMonthsStr('2026-08-31', 1), '2026-09-30');
});

test('addMonthsStr : fin février et année bissextile', () => {
  assert.equal(addMonthsStr('2028-01-31', 1), '2028-02-29'); // 2028 bissextile
  assert.equal(addMonthsStr('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonthsStr('2028-02-29', 12), '2029-02-28');
  assert.equal(addMonthsStr('2028-02-29', 48), '2032-02-29');
  assert.equal(addMonthsStr('2026-02-28', 1), '2026-03-28');
  assert.equal(addMonthsStr('2100-01-31', 1), '2100-02-28'); // 2100 n'est pas bissextile
});

test('addMonthsStr : passage d\'année, négatifs, zéro, +36 mois', () => {
  assert.equal(addMonthsStr('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonthsStr('2026-01-15', -1), '2025-12-15');
  assert.equal(addMonthsStr('2026-01-15', -13), '2024-12-15');
  assert.equal(addMonthsStr('2026-11-24', 0), '2026-11-24');
  assert.equal(addMonthsStr('2026-11-24', 36), '2029-11-24');
  assert.equal(addMonthsStr('2026-11-24', -1), '2026-10-24');
});

test('addDaysStr : mois, année, bissextile, et pas de dérive aux changements d\'heure', () => {
  assert.equal(addDaysStr('2026-01-31', 1), '2026-02-01');
  assert.equal(addDaysStr('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysStr('2028-02-28', 1), '2028-02-29');
  assert.equal(addDaysStr('2027-02-28', 1), '2027-03-01');
  assert.equal(addDaysStr('2026-03-01', -1), '2026-02-28');
  assert.equal(addDaysStr('2026-03-28', 1), '2026-03-29'); // passage à l'heure d'été
  assert.equal(addDaysStr('2026-03-29', 1), '2026-03-30');
  assert.equal(addDaysStr('2026-10-25', 1), '2026-10-26'); // retour à l'heure d'hiver
  assert.equal(addDaysStr('2026-10-24', 2), '2026-10-26');
  assert.equal(addDaysStr('2026-11-24', 0), '2026-11-24');
  assert.equal(addDaysStr('2026-11-24', -7), '2026-11-17');
  assert.equal(addDaysStr('2026-11-24', 366), '2027-11-25');
});

test('startOfWeekStr : lundi de la semaine', () => {
  assert.equal(startOfWeekStr('2026-11-24'), '2026-11-23'); // mardi
  assert.equal(startOfWeekStr('2026-11-22'), '2026-11-16'); // dimanche
  assert.equal(startOfWeekStr('2026-11-23'), '2026-11-23');
});
