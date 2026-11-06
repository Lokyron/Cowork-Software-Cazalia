// Codes promotionnels adossés à Stripe (Coupons + Promotion Codes).
//
// Modèle « PASSERELLE » :
//   - Les codes sont créés et gérés DANS STRIPE (dashboard). Stripe est la SOURCE
//     DE VÉRITÉ : règle de remise (coupon percent_off / amount_off), restriction
//     éventuelle à une formule (coupon applies_to.products), limite globale
//     (max_redemptions), expiration (expires_at / redeem_by) et état (active).
//   - L'application tient un MIROIR local (`promo_codes`) synchronisé depuis
//     Stripe. Ce miroir n'est PAS une interface d'édition : il sert uniquement à
//     (1) appliquer la remise au panier et (2) faire respecter la limite PAR
//     PERSONNE, que Stripe ne sait pas gérer pour un code partagé.
//   - La limite « N fois par personne » n'existe pas côté Stripe : on la lit dans
//     la MÉTADONNÉE `max_per_user` du Promotion Code Stripe (absente = illimité).
//
// La synchro se fait :
//   - en bloc, à l'ouverture de la page admin (`syncPromosFromStripe`) ;
//   - à la volée pour un code précis saisi au panier (`ensurePromoMirrored`), afin
//     qu'un code tout juste créé dans Stripe soit applicable sans attendre une
//     visite de la page admin.

import { db } from '../db.js';
import { fail } from './errors.js';
import { getClient, ensureFormuleProducts } from './stripe.js';

const VALID_TARIFS = new Set(['heure', 'demi_journee', 'journee']);

// Upsert idempotent du miroir, clé sur le `code` (identité publique stable). On
// conserve l'`id` local et donc l'historique des utilisations (promo_redemptions)
// d'une synchro à l'autre.
const upsertStmt = db.prepare(
  `INSERT INTO promo_codes
     (code, stripe_coupon_id, stripe_promo_id, reduction_type, reduction_value,
      tarif_restriction, max_redemptions, max_per_user, expires_at, active)
   VALUES (@code, @stripe_coupon_id, @stripe_promo_id, @reduction_type, @reduction_value,
           @tarif_restriction, @max_redemptions, @max_per_user, @expires_at, @active)
   ON CONFLICT(code) DO UPDATE SET
     stripe_coupon_id  = excluded.stripe_coupon_id,
     stripe_promo_id   = excluded.stripe_promo_id,
     reduction_type    = excluded.reduction_type,
     reduction_value   = excluded.reduction_value,
     tarif_restriction = excluded.tarif_restriction,
     max_redemptions   = excluded.max_redemptions,
     max_per_user      = excluded.max_per_user,
     expires_at        = excluded.expires_at,
     active            = excluded.active`
);
const listStmt = db.prepare(`SELECT * FROM promo_codes ORDER BY created_at DESC`);
const deleteByPromoIdsNotIn = (ids) => {
  // Purge les codes du miroir qui n'existent plus dans Stripe. Clé sur
  // stripe_promo_id (identité Stripe) ; placeholders générés dynamiquement.
  if (!ids.length) {
    db.prepare(`DELETE FROM promo_codes`).run();
    return;
  }
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM promo_codes WHERE stripe_promo_id NOT IN (${ph})`).run(...ids);
};
// Recherche insensible à la casse (Stripe normalise les codes en majuscules, mais
// le client peut saisir en minuscules).
const fullByCodeCiStmt = db.prepare(`SELECT * FROM promo_codes WHERE UPPER(code) = UPPER(?)`);

// Comptage des utilisations (table locale) : global et par personne.
const countGlobalStmt = db.prepare(`SELECT COUNT(*) AS n FROM promo_redemptions WHERE promo_id = ?`);
const countUserStmt = db.prepare(`SELECT COUNT(*) AS n FROM promo_redemptions WHERE promo_id = ? AND user_id = ?`);
const insertRedemptionStmt = db.prepare(
  `INSERT INTO promo_redemptions (promo_id, user_id, order_id) VALUES (@promo_id, @user_id, @order_id)`
);

const epochToIso = (epoch) => (epoch ? new Date(epoch * 1000).toISOString() : null);

/**
 * Lit la limite « par personne » portée par la métadonnée `max_per_user`, sur le
 * Promotion Code OU, à défaut, sur le Coupon (le dashboard Stripe expose plus
 * facilement les métadonnées du coupon). Absente ou invalide → null (illimité).
 * @param {object} promo Promotion Code Stripe (promo.coupon = objet Coupon).
 * @returns {number|null}
 */
function maxPerUserFromMetadata(promo) {
  const raw = promo?.metadata?.max_per_user ?? promo?.coupon?.metadata?.max_per_user;
  if (raw == null || raw === '') return null;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Convertit un couple (Promotion Code + Coupon) Stripe en ligne miroir locale.
 * @param {object} promo Promotion Code Stripe (promo.coupon = objet Coupon).
 * @param {Map<string,string>} productToTarif Map productId → clé de formule.
 * @returns {object|null} Paramètres d'upsert, ou null si inexploitable.
 */
function toMirrorRow(promo, productToTarif) {
  const coupon = promo?.coupon;
  if (!promo?.code || !coupon?.id) return null;

  let reductionType;
  let reductionValue;
  if (coupon.percent_off != null) {
    reductionType = 'percent';
    reductionValue = Math.round(coupon.percent_off);
  } else if (coupon.amount_off != null) {
    reductionType = 'amount';
    reductionValue = Math.round(coupon.amount_off); // déjà en centimes
  } else {
    return null; // coupon sans remise exploitable
  }

  // Restriction de formule : on mappe le 1er produit de applies_to vers sa clé.
  let tarifRestriction = null;
  const products = coupon.applies_to?.products || [];
  for (const pid of products) {
    const key = productToTarif.get(pid);
    if (key) { tarifRestriction = key; break; }
  }

  const expiresAt = epochToIso(promo.expires_at) || epochToIso(coupon.redeem_by);
  // L'état « actif » exige un Promotion Code actif ET un coupon encore valide.
  const active = promo.active && coupon.valid ? 1 : 0;

  return {
    code: promo.code,
    stripe_coupon_id: coupon.id,
    stripe_promo_id: promo.id,
    reduction_type: reductionType,
    reduction_value: reductionValue,
    tarif_restriction: tarifRestriction,
    max_redemptions: promo.max_redemptions ?? coupon.max_redemptions ?? null,
    max_per_user: maxPerUserFromMetadata(promo),
    expires_at: expiresAt,
    active,
  };
}

/**
 * Construit la map productId Stripe → clé de formule (`journee`…), pour retrouver
 * la restriction de formule d'un coupon à partir de son `applies_to.products`.
 * @param {import('stripe').Stripe} stripe
 * @returns {Promise<Map<string,string>>}
 */
async function productToTarifMap(stripe) {
  const formules = await ensureFormuleProducts(stripe); // {heure, demi_journee, journee}
  const m = new Map();
  for (const [key, productId] of Object.entries(formules)) m.set(productId, key);
  return m;
}

/**
 * Synchronise le miroir local depuis Stripe : récupère TOUS les Promotion Codes,
 * met à jour/insère les lignes correspondantes et purge celles qui n'existent
 * plus côté Stripe. Idempotent.
 *
 * @returns {Promise<void>}
 * @throws {Error} `STRIPE_NON_CONFIGURE` si Stripe n'est pas configuré.
 */
export async function syncPromosFromStripe() {
  const stripe = getClient();
  if (!stripe) throw fail('STRIPE_NON_CONFIGURE');
  const productToTarif = await productToTarifMap(stripe);

  // Pagination complète des Promotion Codes (coupon inclus par défaut).
  const rows = [];
  const seenPromoIds = [];
  let startingAfter;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resp = await stripe.promotionCodes.list({ limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const promo of resp.data) {
      seenPromoIds.push(promo.id);
      const row = toMirrorRow(promo, productToTarif);
      if (row) rows.push(row);
    }
    if (!resp.has_more || !resp.data.length) break;
    startingAfter = resp.data[resp.data.length - 1].id;
  }

  const apply = db.transaction(() => {
    for (const row of rows) upsertStmt.run(row);
    deleteByPromoIdsNotIn(seenPromoIds);
  });
  apply();
}

/**
 * Garantit qu'un code précis (saisi au panier) est présent dans le miroir, par un
 * aller-retour Stripe ciblé. Best-effort : en cas d'échec ou de Stripe non
 * configuré, on n'altère pas le miroir et la validation se fera sur l'existant.
 *
 * @param {string} code Code saisi par le client.
 * @returns {Promise<void>}
 */
export async function ensurePromoMirrored(code) {
  const wanted = String(code || '').trim();
  if (!wanted) return;
  const stripe = getClient();
  if (!stripe) return;
  try {
    const productToTarif = await productToTarifMap(stripe);
    // Stripe stocke les codes en majuscules ; on filtre sur cette forme.
    const resp = await stripe.promotionCodes.list({ code: wanted.toUpperCase(), limit: 1 });
    const promo = resp.data[0];
    if (!promo) return;
    const row = toMirrorRow(promo, productToTarif);
    if (row) upsertStmt.run(row);
  } catch { /* best-effort : on laisse le miroir en l'état */ }
}

/**
 * Valide un code saisi au panier, pour l'utilisateur et le contenu donnés
 * (lecture du miroir local). Fait respecter : existence, activation, expiration,
 * restriction de formule, limite globale et limite PAR PERSONNE (via la table
 * locale `promo_redemptions`). Appeler `ensurePromoMirrored(code)` AVANT pour
 * garantir la fraîcheur du miroir.
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
 * formule) et, pour un MONTANT FIXE, elle est bornée au sous-total éligible — ce
 * qui limite de fait un « −20 € sur la Journée » à la valeur d'UNE journée même si
 * le panier en contient plusieurs. POUR AFFICHAGE UNIQUEMENT — Stripe reste la
 * référence au paiement, et ce calcul n'enregistre aucune utilisation.
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
 * Liste les codes promo pour l'admin : synchronise d'abord le miroir depuis
 * Stripe (source de vérité), puis renvoie les lignes enrichies du compteur local
 * d'utilisations (`used`, qui fait foi pour nos limites).
 * @returns {Promise<object[]>}
 */
export async function listPromos() {
  await syncPromosFromStripe();
  return listStmt.all().map((r) => ({
    ...r,
    active: !!r.active,
    used: countGlobalStmt.get(r.id).n,
  }));
}

export { VALID_TARIFS };
