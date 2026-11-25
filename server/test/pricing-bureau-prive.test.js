// GET /api/pricing : clé `private_office` (tarifs du bureau privatif lus sur
// l'espace en base) et ses cas limites. Lecture seule : aucune règle de prix ici.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-pricing-bureau-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const { db } = await import('../src/db.js');
const { spacesRouter } = await import('../src/routes/spaces.js');
// Fonctions pures du front (aucune dépendance) : le test relie les deux bouts.
const { privateOfficeCard, ponctuelFrom } = await import('../../web/src/vitrine-tarifs.js');

const app = express();
app.use('/api', spacesRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => { server.close(); fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

// Intl met une espace insécable avant « € » : normalisée pour comparer.
const sp = (x) => x.replace(/\s/g, ' ');
const getPricing = async () => {
  const r = await fetch(`${base}/api/pricing`);
  assert.equal(r.status, 200);
  return r.json();
};
const clearOffices = () => db.prepare(`DELETE FROM spaces WHERE category = 'PRIVATE_OFFICE'`).run();
let n = 0;
const addOffice = (over = {}) => {
  const o = {
    name: `Bureau ${++n}`, online_bookable: 1, exclusive: 1, position: n, active: 1,
    half: 4000, day: 7000, ...over,
  };
  db.prepare(
    `INSERT INTO spaces (name, kind, category, online_bookable, capacity, exclusive, credits_per_hour,
                         price_half_day_cents, price_day_cents, position, active)
     VALUES (?, 'room', 'PRIVATE_OFFICE', ?, 4, ?, 0, ?, ?, ?, ?)`
  ).run(o.name, o.online_bookable, o.exclusive, o.half, o.day, o.position, o.active);
};

test('la forme existante de la réponse est conservée', async () => {
  clearOffices();
  const p = await getPricing();
  for (const k of ['open_space', 'meeting_room', 'subscriptions', 'confort_meeting_discount', 'essentiel_quota_days', 'samedi']) {
    assert.ok(k in p, k);
  }
});

test('aucun bureau privatif en base : non réservable, la route répond', async () => {
  clearOffices();
  assert.deepEqual((await getPricing()).private_office, {
    online_bookable: false, bookable: false, from: false, half_day_cents: null, day_cents: null,
  });
});

test('bureau réservable avec prix : montants en centimes', async () => {
  clearOffices();
  addOffice();
  assert.deepEqual((await getPricing()).private_office, {
    online_bookable: true, bookable: true, from: false, half_day_cents: 4000, day_cents: 7000,
  });
});

test('un seul forfait renseigné : réservable, l\'autre à null', async () => {
  clearOffices();
  addOffice({ half: null });
  const o = (await getPricing()).private_office;
  assert.equal(o.bookable, true);
  assert.equal(o.half_day_cents, null);
  assert.equal(o.day_cents, 7000);
});

test('bureau sans prix (NULL ou 0) : non réservable', async () => {
  for (const v of [null, 0]) {
    clearOffices();
    addOffice({ half: v, day: v });
    const o = (await getPricing()).private_office;
    assert.equal(o.bookable, false);
    assert.equal(o.online_bookable, true);
    assert.equal(o.half_day_cents, null);
    assert.equal(o.day_cents, null);
  }
});

test('bureau avec prix mais online_bookable = 0 : non réservable', async () => {
  clearOffices();
  addOffice({ online_bookable: 0 });
  const o = (await getPricing()).private_office;
  assert.equal(o.online_bookable, false);
  assert.equal(o.bookable, false);
});

test('bureau non exclusif (donnée aberrante) : non réservable, comme effectivePricing', async () => {
  clearOffices();
  addOffice({ exclusive: 0 });
  assert.equal((await getPricing()).private_office.bookable, false);
});

test('bureau inactif : ignoré', async () => {
  clearOffices();
  addOffice({ active: 0 });
  assert.equal((await getPricing()).private_office.bookable, false);
});

test('plusieurs bureaux : minimum par forfait sur les réservables, « à partir de »', async () => {
  clearOffices();
  addOffice({ position: 1, online_bookable: 0, half: 1000, day: 2000 }); // non réservable : ignoré
  addOffice({ position: 3, half: 5000, day: 9000 });
  addOffice({ position: 2, half: 4500, day: 8000 });
  addOffice({ position: 4, half: 4800, day: 7500 }); // demi-journée et journée moins chères ne viennent pas du même bureau
  assert.deepEqual((await getPricing()).private_office, {
    online_bookable: true, bookable: true, from: true, half_day_cents: 4500, day_cents: 7500,
  });
});

test('plusieurs bureaux : la position ne décide pas du prix annoncé', async () => {
  clearOffices();
  addOffice({ position: 1, half: 9000, day: 12000 }); // premier, mais le plus cher
  addOffice({ position: 2, half: 4000, day: 7000 });
  const o = (await getPricing()).private_office;
  assert.equal(o.half_day_cents, 4000);
  assert.equal(o.day_cents, 7000);
  assert.equal(o.from, true);
});

test('plusieurs bureaux : forfaits différents, chaque forfait réservable est annoncé', async () => {
  clearOffices();
  addOffice({ position: 1, half: null, day: 8000 }); // A : journée seule
  addOffice({ position: 2, half: 4500, day: 9000 }); // B : les deux
  const o = (await getPricing()).private_office;
  assert.equal(o.half_day_cents, 4500);
  assert.equal(o.day_cents, 8000);
  assert.equal(o.from, true);
});

test('plusieurs bureaux aux tarifs identiques : pas de « à partir de »', async () => {
  clearOffices();
  addOffice({ half: 4000, day: 7000 });
  addOffice({ half: 4000, day: 7000 });
  assert.equal((await getPricing()).private_office.from, false);
});

test('samedi : booléens (demi-journée ouverte, journée fermée)', async () => {
  assert.deepEqual((await getPricing()).samedi, { demi_journee: true, journee: false });
});

test('contrat : la forme renvoyée par la route est celle que privateOfficeCard consomme', async () => {
  clearOffices();
  addOffice({ half: 4050, day: 7000 });
  const t = await getPricing();
  const c = privateOfficeCard(t.private_office);
  assert.ok(c, 'la carte doit exister');
  assert.equal(c.price, '70 €');
  assert.equal(c.unit, '/ journée');
  assert.ok(c.lines.map(sp).includes('40,50 € la demi-journée'));
  assert.equal(c.from, false);
  // Une grille complète traverse aussi ponctuelFrom sans perdre la carte.
  assert.ok(ponctuelFrom(t).some((x) => x.name === 'Bureau privatif'));
  // Un second bureau moins cher : le prix de la carte suit la base, avec « à partir de ».
  addOffice({ half: 3000, day: 6000 });
  const c2 = privateOfficeCard((await getPricing()).private_office);
  assert.equal(c2.price, '60 €');
  assert.equal(c2.from, true);
  assert.ok(c2.lines.map(sp).includes('à partir de 30 € la demi-journée'));
});

test('plusieurs bureaux, aucun réservable : bookable false', async () => {
  clearOffices();
  addOffice({ online_bookable: 0 });
  addOffice({ half: null, day: null });
  const o = (await getPricing()).private_office;
  assert.equal(o.bookable, false);
});
