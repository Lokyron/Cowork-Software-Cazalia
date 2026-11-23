// Tests des modes de réservation d'un espace (réservation en ligne / devis) et
// du moteur de prix du bureau privé. Argent réel : le test le plus important est
// celui qui garantit qu'un bureau privé n'est JAMAIS offert à un abonné.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-modes-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const { effectivePricing, isOnlineBookable } = await import('../src/lib/pricing.js');
const { db } = await import('../src/db.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

// Mercredi 13/01/2027 (heure d'hiver, UTC+1) : fenêtres de forfait en UTC.
const SLOTS = {
  demi_journee: { startIso: '2027-01-13T07:30:00.000Z', endIso: '2027-01-13T13:00:00.000Z' },
  journee: { startIso: '2027-01-13T07:30:00.000Z', endIso: '2027-01-13T18:30:00.000Z' },
  heure: { startIso: '2027-01-13T08:00:00.000Z', endIso: '2027-01-13T09:00:00.000Z' },
};
const TIERS = ['NONE', 'ESSENTIEL', 'CONFORT', 'PREMIUM'];
const userOf = (tier) => ({
  id: 999999, subscription_tier: tier, subscription_status: tier === 'NONE' ? 'none' : 'active', open_space_quota_used: 0,
});
const office = (over = {}) => ({
  category: 'PRIVATE_OFFICE', online_bookable: 1, quote_available: 1, exclusive: 1, capacity: 4,
  price_half_day_cents: 4000, price_day_cents: 7000, ...over,
});
const price = (space, tarifType, tier = 'NONE', seats = 1) =>
  effectivePricing({ user: userOf(tier), space, seats, tarifType, ...SLOTS[tarifType] });
const code = (c) => (e) => e.code === c;

test('bureau privé : prix lu dans les colonnes de l\'espace', () => {
  const sp = office();
  assert.equal(price(sp, 'demi_journee').cents, 4000);
  assert.equal(price(sp, 'journee').cents, 7000);
});

test('bureau privé : tarif horaire refusé', () => {
  assert.throws(() => price(office({ price_per_hour_cents: 1000 }), 'heure'), code('TARIF_INDISPONIBLE'));
});

test('bureau privé : prix NULL ou 0 => TARIF_INDISPONIBLE (jamais 0 €)', () => {
  for (const v of [null, 0, undefined]) {
    assert.throws(() => price(office({ price_half_day_cents: v }), 'demi_journee'), code('TARIF_INDISPONIBLE'));
    assert.throws(() => price(office({ price_day_cents: v }), 'journee'), code('TARIF_INDISPONIBLE'));
  }
  // Une seule colonne manquante n'invalide pas l'autre forfait.
  assert.equal(price(office({ price_half_day_cents: null }), 'journee').cents, 7000);
});

test('bureau privé : JAMAIS inclus dans un abonnement, tous tiers (dont PREMIUM)', () => {
  for (const tier of TIERS) {
    for (const t of ['demi_journee', 'journee']) {
      const p = price(office(), t, tier);
      assert.equal(p.method, 'STRIPE_ONE_OFF', `${tier}/${t}`);
      assert.equal(p.quotaDays, 0, `${tier}/${t}`);
      assert.equal(p.discountLabel, null, `${tier}/${t}`);
      assert.ok(p.cents > 0, `${tier}/${t} ne doit pas être gratuit`);
    }
  }
});

test('bureau privé NON exclusif : refusé (ESPACE_NON_RESERVABLE), demi-journée comme journée', () => {
  for (const t of ['demi_journee', 'journee']) {
    for (const ex of [0, null, undefined]) {
      assert.throws(() => price(office({ exclusive: ex }), t), code('ESPACE_NON_RESERVABLE'), `${t}/${ex}`);
    }
  }
});

test('bureau privé exclusif, 3 places demandées : forfait facturé UNE seule fois', () => {
  const sp = office({ exclusive: 1, capacity: 4 });
  assert.equal(price(sp, 'journee', 'NONE', 3).cents, 7000);
  assert.equal(price(sp, 'demi_journee', 'NONE', 3).cents, 4000);
  assert.equal(price(sp, 'journee', 'NONE', 3).baseCents, 7000);
});

test('bureau privé : non réservable en ligne si online_bookable = 0', () => {
  assert.throws(() => price(office({ online_bookable: 0 }), 'journee'), code('ESPACE_NON_RESERVABLE'));
});

test('espace réservable en ligne sans catégorie tarifée => TARIF_INDISPONIBLE', () => {
  assert.throws(() => price({ category: null, online_bookable: 1, exclusive: 0, capacity: 2 }, 'journee'), code('TARIF_INDISPONIBLE'));
  assert.throws(() => price({ category: 'CONFIDENTIAL', online_bookable: 1, exclusive: 0, capacity: 2 }, 'journee'), code('TARIF_INDISPONIBLE'));
});

test('isOnlineBookable : colonnes, avec repli sur la catégorie', () => {
  assert.equal(isOnlineBookable({ category: 'PRIVATE_OFFICE', online_bookable: 1 }), true);
  assert.equal(isOnlineBookable({ category: 'OPEN_SPACE', online_bookable: 0 }), false);
  // Repli : propriété absente.
  assert.equal(isOnlineBookable({ category: 'OPEN_SPACE' }), true);
  assert.equal(isOnlineBookable({ category: 'MEETING_ROOM' }), true);
  assert.equal(isOnlineBookable({ category: 'PRIVATE_OFFICE' }), false);
  assert.equal(isOnlineBookable({ category: 'CONFIDENTIAL' }), false);
  assert.equal(isOnlineBookable({ category: null }), false);
});

// ── Non-régression : montants, remises et quota des catégories existantes ────
const open = { category: 'OPEN_SPACE', online_bookable: 1, exclusive: 0, capacity: 12 };
const room = { category: 'MEETING_ROOM', online_bookable: 1, exclusive: 1, capacity: 8 };

test('non-régression OPEN_SPACE : montants, méthodes et quota par tier', () => {
  const exp = {
    NONE: { demi_journee: [1200, 'STRIPE_ONE_OFF', 0], journee: [2000, 'STRIPE_ONE_OFF', 0] },
    ESSENTIEL: { demi_journee: [0, 'SUBSCRIPTION_QUOTA', 0.5], journee: [0, 'SUBSCRIPTION_QUOTA', 1] },
    CONFORT: { demi_journee: [0, 'SUBSCRIPTION_UNLIMITED', 0], journee: [0, 'SUBSCRIPTION_UNLIMITED', 0] },
    PREMIUM: { demi_journee: [0, 'SUBSCRIPTION_UNLIMITED', 0], journee: [0, 'SUBSCRIPTION_UNLIMITED', 0] },
  };
  for (const tier of TIERS) {
    for (const t of ['demi_journee', 'journee']) {
      const p = price(open, t, tier);
      assert.deepEqual([p.cents, p.method, p.quotaDays], exp[tier][t], `${tier}/${t}`);
    }
  }
  assert.throws(() => price(open, 'heure'), code('TARIF_INDISPONIBLE'));
  assert.equal(price(open, 'journee', 'NONE', 3).cents, 6000);
});

test('non-régression MEETING_ROOM : montants et méthodes par tier', () => {
  const exp = {
    NONE: { heure: [2000, 'STRIPE_ONE_OFF'], demi_journee: [3500, 'STRIPE_ONE_OFF'], journee: [5000, 'STRIPE_ONE_OFF'] },
    ESSENTIEL: { heure: [2000, 'STRIPE_ONE_OFF'], demi_journee: [3500, 'STRIPE_ONE_OFF'], journee: [5000, 'STRIPE_ONE_OFF'] },
    CONFORT: { heure: [1000, 'STRIPE_ONE_OFF'], demi_journee: [1750, 'STRIPE_ONE_OFF'], journee: [2500, 'STRIPE_ONE_OFF'] },
    PREMIUM: { heure: [0, 'SUBSCRIPTION_UNLIMITED'], demi_journee: [0, 'SUBSCRIPTION_UNLIMITED'], journee: [0, 'SUBSCRIPTION_UNLIMITED'] },
  };
  for (const tier of TIERS) {
    for (const t of ['heure', 'demi_journee', 'journee']) {
      const p = price(room, t, tier);
      assert.deepEqual([p.cents, p.method], exp[tier][t], `${tier}/${t}`);
      assert.equal(p.quotaDays, 0);
    }
  }
});

test('non-régression : sans colonne online_bookable, le repli catégorie reste en vigueur', () => {
  const { online_bookable, ...openLegacy } = open;
  assert.equal(price(openLegacy, 'journee').cents, 2000);
  assert.throws(() => price({ category: 'PRIVATE_OFFICE', exclusive: 1, price_day_cents: 7000 }, 'journee'), code('ESPACE_NON_RESERVABLE'));
});

test('base neuve : colonnes présentes avec défaut 0', () => {
  const cols = db.prepare(`PRAGMA table_info(spaces)`).all();
  for (const n of ['online_bookable', 'quote_available']) {
    const c = cols.find((x) => x.name === n);
    assert.ok(c, n);
    assert.equal(c.notnull, 1);
    assert.equal(String(c.dflt_value), '0');
  }
});
