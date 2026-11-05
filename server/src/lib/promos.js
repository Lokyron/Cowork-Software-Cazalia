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
      tarif_restriction, max_redemptions, max_per_user, expires_at, active)
   VALUES (@code, @stripe_coupon_id, @stripe_promo_id, @reduction_type, @reduction_value,
           @tarif_restriction, @max_redemptions, @max_per_user, @expires_at, 1)`
);
const listStmt = db.prepare(`SELECT * FROM promo_codes ORDER BY created_at DESC`);
const getStmt = db.prepare(`SELECT * FROM promo_codes WHERE id = ?`);
const setActiveStmt = db.prepare(`UPDATE promo_codes SET active = @active WHERE id = @id`);
const deleteStmt = db.prepare(`DELETE FROM promo_codes WHERE id = ?`);
const byCodeStmt = db.prepare(`SELECT id FROM promo_codes WHERE code = ?`);
// Recherche insensible à la casse (Stripe normalise les codes en majuscules, mais
// le client peut saisir en minuscules).
const fullByCodeCiStmt = db.prepare(`SELECT * FROM promo_codes WHERE UPPER(code) = UPPER(?)`);

// Comptage des utilisations (table locale) : global et par personne.
const countGlobalStmt = db.prepare(`SELECT COUNT(*) AS n FROM promo_redemptions WHERE promo_id = ?`);
const countUserStmt = db.prepare(`SELECT COUNT(*) AS n FROM promo_redemptions WHERE promo_id = ? AND user_id = ?`);
const insertRedemptionStmt = db.prepare(
  `INSERT INTO promo_redemptions (promo_id, user_id, order_id) VALUES (@promo_id, @user_id, @order_id)`
);

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
 * @param {number|null} [p.maxRedemptions] Nombre maximal d'utilisations (global).
 * @param {number|null} [p.maxPerUser] Nombre maximal d'utilisations par personne.
 * @param {string|null} [p.expiresAt] Date limite ISO 8601, ou null.
 * @returns {Promise<object>} Ligne miroir créée.
 */
export async function createPromo({
  code, reductionType, reductionValue, tarifRestriction = null,
  maxRedemptions = null, maxPerUser = null, expiresAt = null,
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
  const perUser = maxPerUser != null && maxPerUser !== '' ? Math.round(Number(maxPerUser)) : null;
  if (perUser != null && (!Number.isFinite(perUser) || perUser < 1)) throw fail('PROMO_LIMITE_INVALIDE');
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
    max_per_user: perUser,
    expires_at: expiresAt || null,
  });
  return getStmt.get(info.lastInsertRowid);
}

/**
 * Valide un code saisi au panier, pour l'utilisateur et le contenu donnés.
 * Fait respecter : existence, activation, expiration, restriction de formule,
 * limite globale et limite PAR PERSONNE (via la table locale `promo_redemptions`).
 *
 * @param {object} p
 * @param {string} p.code Code saisi par le client.
 * @param {number} p.userId Membre qui paie.
 * @param {Array<{tarif_type:string}>} p.items Lignes du panier.
 * @returns {object} Ligne `promo_codes` validée (contient `stripe_promo_id`, `id`).
 * @throws {Error} `PROMO_INTROUVABLE`, `PROMO_INACTIVE`, `PROMO_EXPIREE`,
 *         `PROMO_NON_APPLICABLE`, `PROMO_EPUISE`, `PROMO_DEJA_UTILISE`.
 */
export function validatePromoForCheckout({ code, userId, items }) {
  const wanted = String(code || '').trim();
  if (!wanted) throw fail('PROMO_INTROUVABLE');
  const row = fullByCodeCiStmt.get(wanted);
  if (!row) throw fail('PROMO_INTROUVABLE');
  if (!row.active) throw fail('PROMO_INACTIVE');
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) throw fail('PROMO_EXPIREE');
  if (row.tarif_restriction && !(items || []).some((it) => it.tarif_type === row.tarif_restriction)) {
    throw fail('PROMO_NON_APPLICABLE');
  }
  if (row.max_redemptions != null && countGlobalStmt.get(row.id).n >= row.max_redemptions) {
    throw fail('PROMO_EPUISE');
  }
  if (row.max_per_user != null && countUserStmt.get(row.id, userId).n >= row.max_per_user) {
    throw fail('PROMO_DEJA_UTILISE');
  }
  return row;
}

/**
 * Calcule la remise (centimes) qu'un code applique à un panier, de la même façon
 * que Stripe : la réduction ne porte que sur les lignes éligibles (restriction de
 * formule). POUR AFFICHAGE UNIQUEMENT — Stripe reste la référence au paiement, et
 * ce calcul n'enregistre aucune utilisation.
 *
 * @param {object} promo Ligne `promo_codes`.
 * @param {Array<{tarif_type:string, price_cents:number}>} items Lignes du panier.
 * @returns {number} Remise en centimes (bornée au sous-total éligible).
 */
export function computeDiscount(promo, items) {
  const eligible = (items || []).filter(
    (it) => !promo.tarif_restriction || it.tarif_type === promo.tarif_restriction,
  );
  const eligibleSubtotal = eligible.reduce((s, it) => s + (it.price_cents || 0), 0);
  const raw = promo.reduction_type === 'percent'
    ? Math.round((eligibleSubtotal * promo.reduction_value) / 100)
    : promo.reduction_value;
  return Math.max(0, Math.min(raw, eligibleSubtotal));
}

/**
 * Enregistre une utilisation d'un code promo (appelée à la confirmation du
 * paiement, dans la transaction idempotente de `fulfillOrder`).
 * @param {{promoId:number, userId:number, orderId:number|null}} p
 */
export function recordRedemption({ promoId, userId, orderId = null }) {
  if (!promoId) return;
  insertRedemptionStmt.run({ promo_id: promoId, user_id: userId, order_id: orderId });
}

/**
 * Liste les codes promo (miroir local) enrichis du nombre d'utilisations : le
 * compteur local (`used`, qui fait foi pour nos limites) et, best-effort, celui
 * de Stripe (`times_redeemed`).
 * @returns {Promise<object[]>}
 */
export async function listPromos() {
  const rows = listStmt.all();
  const stripe = getClient();
  const withLocal = rows.map((r) => ({ ...r, active: !!r.active, used: countGlobalStmt.get(r.id).n }));
  if (!stripe || !rows.length) {
    return withLocal.map((r) => ({ ...r, times_redeemed: null }));
  }
  const live = new Map();
  try {
    const resp = await stripe.promotionCodes.list({ limit: 100 });
    for (const pc of resp.data) live.set(pc.id, pc);
  } catch { /* best-effort : on affiche sans le compteur Stripe en cas d'échec */ }
  return withLocal.map((r) => {
    const pc = live.get(r.stripe_promo_id);
    return { ...r, times_redeemed: pc ? pc.times_redeemed : null, stripe_active: pc ? pc.active : null };
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
