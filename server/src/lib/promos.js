// Codes promotionnels adossés à Stripe (Coupons + Promotion Codes).
//
// Modèle :
//   - Un COUPON Stripe porte la règle de remise (percent_off / amount_off), sa
//     restriction éventuelle à une formule (applies_to.products) et ses limites
//     (max_redemptions, redeem_by).
//   - Un PROMOTION CODE Stripe est le code public saisi au paiement, rattaché au
//     coupon ; il porte aussi expires_at / max_redemptions côté code.
//   - Une ligne miroir en base (`promo_codes`) permet de lister et gérer les
//     codes côté admin sans dépendre d'un aller-retour Stripe à chaque affichage.
//     Stripe reste la SOURCE DE VÉRITÉ pour l'application de la remise et le
//     comptage réel des utilisations (times_redeemed).

import { db } from '../db.js';
import { fail } from './errors.js';
import { getClient, ensureFormuleProducts } from './stripe.js';

const VALID_TARIFS = new Set(['heure', 'demi_journee', 'journee']);

const insertStmt = db.prepare(
  `INSERT INTO promo_codes
     (code, stripe_coupon_id, stripe_promo_id, reduction_type, reduction_value,
      tarif_restriction, max_redemptions, expires_at, active)
   VALUES (@code, @stripe_coupon_id, @stripe_promo_id, @reduction_type, @reduction_value,
           @tarif_restriction, @max_redemptions, @expires_at, 1)`
);
const listStmt = db.prepare(`SELECT * FROM promo_codes ORDER BY created_at DESC`);
const getStmt = db.prepare(`SELECT * FROM promo_codes WHERE id = ?`);
const setActiveStmt = db.prepare(`UPDATE promo_codes SET active = @active WHERE id = @id`);
const deleteStmt = db.prepare(`DELETE FROM promo_codes WHERE id = ?`);
const byCodeStmt = db.prepare(`SELECT id FROM promo_codes WHERE code = ?`);

const toEpoch = (iso) => Math.floor(new Date(iso).getTime() / 1000);

function requireClient() {
  const stripe = getClient();
  if (!stripe) throw fail('STRIPE_NON_CONFIGURE');
  return stripe;
}

/**
 * Crée un code promo : coupon + promotion code Stripe, puis miroir local.
 *
 * @param {object} p
 * @param {string} [p.code] Code personnalisé (ex. `BIENVENUE2026`). Omis → Stripe
 *        en génère un aléatoire.
 * @param {'percent'|'amount'} p.reductionType Type de remise.
 * @param {number} p.reductionValue Pourcentage (1-100) ou montant en centimes.
 * @param {string|null} [p.tarifRestriction] Formule imposée (`journee`…), ou null.
 * @param {number|null} [p.maxRedemptions] Nombre maximal d'utilisations.
 * @param {string|null} [p.expiresAt] Date limite ISO 8601, ou null.
 * @returns {Promise<object>} Ligne miroir créée.
 */
export async function createPromo({
  code, reductionType, reductionValue, tarifRestriction = null,
  maxRedemptions = null, expiresAt = null,
}) {
  const stripe = requireClient();

  // ── Validation des entrées (le serveur reste seul juge) ────────────────────
  if (reductionType !== 'percent' && reductionType !== 'amount') throw fail('PROMO_TYPE_INVALIDE');
  const value = Math.round(Number(reductionValue));
  if (!Number.isFinite(value) || value <= 0) throw fail('PROMO_VALEUR_INVALIDE');
  if (reductionType === 'percent' && value > 100) throw fail('PROMO_VALEUR_INVALIDE');
  if (tarifRestriction && !VALID_TARIFS.has(tarifRestriction)) throw fail('PROMO_TARIF_INVALIDE');
  const max = maxRedemptions != null && maxRedemptions !== '' ? Math.round(Number(maxRedemptions)) : null;
  if (max != null && (!Number.isFinite(max) || max < 1)) throw fail('PROMO_LIMITE_INVALIDE');
  let expiresEpoch = null;
  if (expiresAt) {
    const t = new Date(expiresAt).getTime();
    if (Number.isNaN(t)) throw fail('PROMO_DATE_INVALIDE');
    if (t <= Date.now()) throw fail('PROMO_DATE_PASSEE');
    expiresEpoch = Math.floor(t / 1000);
  }
  const customCode = code ? String(code).trim().toUpperCase() : null;
  if (customCode) {
    if (!/^[A-Z0-9_-]{3,40}$/.test(customCode)) throw fail('PROMO_CODE_INVALIDE');
    if (byCodeStmt.get(customCode)) throw fail('PROMO_CODE_EXISTE');
  }

  // ── 1. Coupon (règle de remise) ─────────────────────────────────────────────
  const couponParams = { duration: 'once' };
  if (reductionType === 'percent') couponParams.percent_off = value;
  else { couponParams.amount_off = value; couponParams.currency = 'eur'; }
  if (max != null) couponParams.max_redemptions = max;
  if (expiresEpoch) couponParams.redeem_by = expiresEpoch;
  if (tarifRestriction) {
    const formules = await ensureFormuleProducts(stripe);
    couponParams.applies_to = { products: [formules[tarifRestriction]] };
  }
  const coupon = await stripe.coupons.create(couponParams);

  // ── 2. Promotion code (code public) ─────────────────────────────────────────
  const promoParams = { coupon: coupon.id };
  if (customCode) promoParams.code = customCode;
  if (max != null) promoParams.max_redemptions = max;
  if (expiresEpoch) promoParams.expires_at = expiresEpoch;
  const promo = await stripe.promotionCodes.create(promoParams);

  // ── 3. Miroir local ─────────────────────────────────────────────────────────
  const info = insertStmt.run({
    code: promo.code, // code effectif retourné par Stripe (normalisé)
    stripe_coupon_id: coupon.id,
    stripe_promo_id: promo.id,
    reduction_type: reductionType,
    reduction_value: value,
    tarif_restriction: tarifRestriction || null,
    max_redemptions: max,
    expires_at: expiresAt || null,
  });
  return getStmt.get(info.lastInsertRowid);
}

/**
 * Liste les codes promo (miroir local) enrichis du nombre d'utilisations réel
 * lu chez Stripe (un seul appel de liste, best-effort).
 * @returns {Promise<object[]>}
 */
export async function listPromos() {
  const rows = listStmt.all();
  const stripe = getClient();
  if (!stripe || !rows.length) {
    return rows.map((r) => ({ ...r, active: !!r.active, times_redeemed: null }));
  }
  const live = new Map();
  try {
    const resp = await stripe.promotionCodes.list({ limit: 100 });
    for (const pc of resp.data) live.set(pc.id, pc);
  } catch { /* best-effort : on affiche sans le compteur en cas d'échec */ }
  return rows.map((r) => {
    const pc = live.get(r.stripe_promo_id);
    return {
      ...r,
      active: !!r.active,
      times_redeemed: pc ? pc.times_redeemed : null,
      stripe_active: pc ? pc.active : null,
    };
  });
}

/**
 * Active ou désactive un code (bascule `active` du promotion code Stripe).
 * @param {number} id Id miroir.
 * @param {boolean} active Nouvel état.
 */
export async function setPromoActive(id, active) {
  const row = getStmt.get(id);
  if (!row) throw fail('PROMO_INTROUVABLE');
  const stripe = requireClient();
  await stripe.promotionCodes.update(row.stripe_promo_id, { active: Boolean(active) });
  setActiveStmt.run({ id, active: active ? 1 : 0 });
  return getStmt.get(id);
}

/**
 * Supprime un code : supprime le coupon Stripe (ce qui révoque ses codes) puis
 * la ligne miroir. Les réservations déjà payées ne sont pas affectées.
 * @param {number} id Id miroir.
 */
export async function deletePromo(id) {
  const row = getStmt.get(id);
  if (!row) throw fail('PROMO_INTROUVABLE');
  const stripe = requireClient();
  try {
    await stripe.coupons.del(row.stripe_coupon_id);
  } catch (err) {
    // Coupon déjà absent côté Stripe : on nettoie quand même le miroir.
    if (err?.code !== 'resource_missing') throw err;
  }
  deleteStmt.run(id);
  return { deleted: true };
}
