// Panier de réservation multi-créneaux : verrous temporaires puis paiement.
//
//   • Membre  : le checkout crée une session Stripe (paiement CB à la résa) ;
//               les réservations sont créées au webhook (cf. lib/orders.js).
//   • Admin   : le checkout crée directement les réservations (gratuit, paiement
//               géré hors ligne) - aucun passage par Stripe.
//
// Disponibilité : capacity − Σ(réservations confirmées) − Σ(verrous actifs des autres).
// L'expiration est « paresseuse » : purgée à chaque lecture/écriture.

import { db } from '../db.js';
import { config } from '../config.js';
import { fail } from './errors.js';
import { createBookingCheckoutSession } from './stripe.js';
import { createPendingOrder } from './orders.js';
import { validatePromoForCheckout, computeDiscount, ensurePromoMirrored } from './promos.js';
import { ensureVoucherForReservation } from './unifi.js';
import { ensureAccessPinForReservation } from './unifiAccess.js';
import { sendBookingConfirmation } from './mailer.js';
import {
  getActiveSpace, resolveSeats, priceCents, validateSlot, withinOpeningHours, availableSeats, insertReservation,
} from './booking.js';
import { effectivePricing, isOnlineBookable, loadPricingUser } from './pricing.js';

export const HOLD_MINUTES = 10;
// Fenêtre élargie pendant un paiement Stripe en cours : on prolonge les verrous
// pour que les places restent tenues le temps que le membre paie.
const CHECKOUT_HOLD_MINUTES = 30;

// Un panier ne peut pas contenir plus de lignes que ce plafond (anti-DoS CWE-770).
const MAX_HOLDS_PER_CART = 40;

const countActiveHolds = db.prepare(
  `SELECT COUNT(*) AS n FROM reservation_holds WHERE user_id = ? AND expires_at > ?`
);
const insertHold = db.prepare(
  `INSERT INTO reservation_holds
     (user_id, space_id, start_at, end_at, seats, cost, tarif_type, payment_method, quota_days,
      ignore_hours, allow_overbooking, created_by, expires_at)
   VALUES (@user_id, @space_id, @start_at, @end_at, @seats, @cost, @tarif_type, @payment_method, @quota_days,
           @ignore_hours, @allow_overbooking, @created_by, @expires_at)`
);
const getHold = db.prepare(`SELECT * FROM reservation_holds WHERE id = ?`);
const getHoldView = db.prepare(
  `SELECT h.*, s.name AS space_name, s.color AS space_color FROM reservation_holds h JOIN spaces s ON s.id = h.space_id WHERE h.id = ?`
);
const delHold = db.prepare(`DELETE FROM reservation_holds WHERE id = ?`);
const delExpired = db.prepare(`DELETE FROM reservation_holds WHERE expires_at <= ?`);
const extendHold = db.prepare(`UPDATE reservation_holds SET expires_at = ? WHERE id = ?`);
const listHolds = db.prepare(
  `SELECT h.*, s.name AS space_name, s.color AS space_color, s.exclusive, s.privatizable
     FROM reservation_holds h JOIN spaces s ON s.id = h.space_id
    WHERE h.user_id = ? AND h.expires_at > ? ORDER BY h.start_at`
);

const TARIF_LABELS = { heure: "à l'heure", demi_journee: 'demi-journée', journee: 'journée' };
const dtFmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});
function lineLabel(h) {
  const tarif = TARIF_LABELS[h.tarif_type] || TARIF_LABELS.heure;
  const when = dtFmt.format(new Date(h.start_at));
  const seats = h.seats > 1 ? ` ×${h.seats}` : '';
  return `${h.space_name} - ${tarif}${seats} (${when})`;
}

/** Supprime les verrous expirés (expiration « paresseuse »). */
export function purgeExpired() { delExpired.run(new Date().toISOString()); }

/**
 * Ajoute une ligne au panier (pose un verrou de `HOLD_MINUTES` minutes).
 * @param {number} userId
 * @param {number} spaceId
 * @param {string} startRaw
 * @param {string} endRaw
 * @param {number} [seatsRaw]
 * @param {{tarifType?:string, ignoreHours?:boolean, allowOverbooking?:boolean, customCostCents?:number, createdBy?:number}} [opts]
 * @returns {object} Ligne de panier créée.
 * @throws {Error} `ESPACE_INTROUVABLE`, `HORS_HORAIRES`, `COMPLET`, `PANIER_PLEIN`,
 *         `CRENEAU_INVALIDE`, `CRENEAU_PASSE`, `TARIF_INDISPONIBLE`, `CRENEAU_FORFAIT_INVALIDE`.
 */
export function addHold(userId, spaceId, startRaw, endRaw, seatsRaw = 1, opts = {}) {
  purgeExpired();
  const space = getActiveSpace(spaceId);
  if (!space) throw fail('ESPACE_INTROUVABLE');
  if (countActiveHolds.get(userId, new Date().toISOString()).n >= MAX_HOLDS_PER_CART) throw fail('PANIER_PLEIN');
  const { startIso, endIso } = validateSlot(startRaw, endRaw);
  const o = opts || {};
  const tarifType = o.tarifType || 'heure';
  if (!o.ignoreHours && !withinOpeningHours(startIso, endIso)) throw fail('HORS_HORAIRES');
  const seats = resolveSeats(space, seatsRaw);
  if (!o.allowOverbooking && availableSeats(spaceId, startIso, endIso) < seats) throw fail('COMPLET');

  // Deux régimes de tarification :
  //   • ADMIN (opts.adminMode) : prix libre/custom, réservation gratuite hors
  //     ligne (FREE_ADMIN), sans impact sur le quota du client - l'admin décide.
  //   • MEMBRE : prix effectif selon l'abonnement du bénéficiaire (moteur
  //     lib/pricing.js) ; refuse les espaces non réservables en ligne.
  let cost, paymentMethod, quotaDays;
  if (o.adminMode) {
    cost = o.customCostCents != null
      ? Math.max(0, Math.round(o.customCostCents))
      : priceCents(space, startIso, endIso, seats, tarifType);
    paymentMethod = 'FREE_ADMIN';
    quotaDays = 0;
  } else {
    if (!isOnlineBookable(space)) throw fail('ESPACE_NON_RESERVABLE');
    const user = loadPricingUser(userId);
    const p = effectivePricing({ user, space, startIso, endIso, seats, tarifType });
    cost = p.cents;
    paymentMethod = p.method;
    quotaDays = p.quotaDays;
  }

  const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60000).toISOString();
  const info = insertHold.run({
    user_id: userId, space_id: spaceId, start_at: startIso, end_at: endIso, seats, cost, tarif_type: tarifType,
    payment_method: paymentMethod, quota_days: quotaDays,
    ignore_hours: o.ignoreHours ? 1 : 0, allow_overbooking: o.allowOverbooking ? 1 : 0,
    created_by: o.createdBy ?? userId, expires_at: expiresAt,
  });
  return getHoldView.get(info.lastInsertRowid);
}

/**
 * Contenu du panier d'un bénéficiaire (total en centimes d'euro).
 * @param {number} userId
 * @returns {{holds:object[], total:number, count:number}}
 */
export function listCart(userId) {
  purgeExpired();
  const holds = listHolds.all(userId, new Date().toISOString());
  const total = holds.reduce((s, h) => s + h.cost, 0);
  return { holds, total, count: holds.length };
}

/**
 * Retire une ligne du panier (appartenance vérifiée - anti-IDOR).
 * @param {number} holdId
 * @param {{id:number, role:string}} actor
 * @returns {{removed:boolean}}
 * @throws {Error} `INTERDIT`
 */
export function removeHold(holdId, actor) {
  const h = getHold.get(holdId);
  if (!h) return { removed: false };
  if (actor.role !== 'admin' && h.user_id !== actor.id && h.created_by !== actor.id) throw fail('INTERDIT');
  delHold.run(holdId);
  return { removed: true };
}

// ── Checkout ADMIN (gratuit, immédiat) ───────────────────────────────────────
/**
 * Convertit les verrous du panier en réservations GRATUITES (paiement hors ligne),
 * dans une transaction tout-ou-rien. Réservé au back-office.
 * @param {number} userId Bénéficiaire du panier.
 * @returns {{reservations:Array<{reservationId:number|bigint, cost:number}>, total:number, count:number}}
 * @throws {Error} `PANIER_VIDE`, `HORS_HORAIRES`, `COMPLET`.
 */
export function checkout(userId) {
  purgeExpired();
  const holds = listHolds.all(userId, new Date().toISOString());
  if (!holds.length) throw fail('PANIER_VIDE');
  const tx = db.transaction(() => {
    const total = holds.reduce((s, h) => s + h.cost, 0);
    const created = [];
    for (const h of holds) {
      if (!h.ignore_hours && !withinOpeningHours(h.start_at, h.end_at)) throw fail('HORS_HORAIRES');
      if (!h.allow_overbooking && availableSeats(h.space_id, h.start_at, h.end_at, { excludeHoldId: h.id }) < h.seats) throw fail('COMPLET');
      const reservationId = insertReservation({
        userId, spaceId: h.space_id, startIso: h.start_at, endIso: h.end_at, seats: h.seats,
        priceCents: h.cost, tarifType: h.tarif_type, paymentStatus: 'free',
        paymentMethod: h.payment_method || 'FREE_ADMIN', quotaDays: h.quota_days || 0,
      });
      created.push({ reservationId, cost: h.cost });
      delHold.run(h.id);
    }
    return { reservations: created, total, count: created.length };
  });
  return tx();
}

// Décompte du quota Open Space (abonné Essentiel) : une réservation couverte par
// le quota consomme `quota_days` jours sur la période en cours.
const consumeQuotaStmt = db.prepare(
  `UPDATE users SET open_space_quota_used = open_space_quota_used + ? WHERE id = ?`
);

// ── Checkout MEMBRE « tout couvert » (total 0 €, sans Stripe) ─────────────────
// Un abonné dont le panier est entièrement couvert (Confort/Premium, ou Essentiel
// dans son quota) confirme en 1 clic, sans paiement. On crée les réservations en
// conservant leur mode de couverture, et on DÉCRÉMENTE le quota pour les lignes
// SUBSCRIPTION_QUOTA - le tout dans une transaction atomique.
const checkoutCoveredTx = db.transaction((userId, holds) => {
  const created = [];
  for (const h of holds) {
    if (!withinOpeningHours(h.start_at, h.end_at)) throw fail('HORS_HORAIRES');
    if (availableSeats(h.space_id, h.start_at, h.end_at, { excludeHoldId: h.id }) < h.seats) throw fail('COMPLET');
    const reservationId = insertReservation({
      userId, spaceId: h.space_id, startIso: h.start_at, endIso: h.end_at, seats: h.seats,
      priceCents: h.cost, tarifType: h.tarif_type, paymentStatus: 'free',
      paymentMethod: h.payment_method, quotaDays: h.quota_days || 0,
    });
    if (h.payment_method === 'SUBSCRIPTION_QUOTA' && h.quota_days > 0) {
      consumeQuotaStmt.run(h.quota_days, userId);
    }
    created.push({ reservationId, cost: h.cost });
    delHold.run(h.id);
  }
  return { reservations: created, total: 0, count: created.length };
});

async function checkoutCovered(userId, holds) {
  const result = checkoutCoveredTx(userId, holds);
  await Promise.allSettled(
    result.reservations.flatMap((r) => [
      ensureVoucherForReservation(r.reservationId),
      ensureAccessPinForReservation(r.reservationId),
    ]),
  );
  result.reservations.forEach((r) => sendBookingConfirmation(r.reservationId).catch(() => {}));
  return { free: true, ...result };
}

/**
 * Checkout GRATUIT complet : convertit le panier en réservations gratuites puis
 * déclenche le post-traitement (voucher Wi-Fi + PIN de porte + e-mail de
 * confirmation), exactement comme une réservation payée.
 *
 * Utilisé pour toute réservation NON facturée : back-office admin (pour un
 * client) et - surtout - un utilisateur de rôle `admin` qui réserve pour
 * lui-même via le parcours membre (il ne doit jamais voir de paiement).
 *
 * @param {number} userId Bénéficiaire du panier.
 * @returns {Promise<{free:true, reservations:Array, total:number, count:number}>}
 * @throws {Error} `PANIER_VIDE`, `HORS_HORAIRES`, `COMPLET`.
 */
export async function checkoutFree(userId) {
  const result = checkout(userId); // crée les réservations gratuites (transaction)
  await Promise.allSettled(
    result.reservations.flatMap((r) => [
      ensureVoucherForReservation(r.reservationId),
      ensureAccessPinForReservation(r.reservationId),
    ]),
  );
  result.reservations.forEach((r) => sendBookingConfirmation(r.reservationId).catch(() => {}));
  return { free: true, ...result };
}

/**
 * Prévisualise l'effet d'un code promo sur le panier courant SANS l'enregistrer :
 * valide le code (mêmes contrôles que le paiement, y compris la limite par
 * personne) et calcule la remise à afficher. Aucune réservation, aucun paiement,
 * aucune utilisation comptabilisée - ce qui n'arrive qu'à la confirmation du
 * paiement (webhook). Un retour en arrière du client ne consomme donc rien.
 *
 * @param {number} userId Bénéficiaire du panier.
 * @param {string} code Code saisi.
 * @returns {{code:string, reduction_type:string, reduction_value:number,
 *            discount_cents:number, total_cents:number, new_total_cents:number}}
 * @throws {Error} `PANIER_VIDE` et les codes `PROMO_*`.
 */
export async function previewPromo(userId, code) {
  purgeExpired();
  const holds = listHolds.all(userId, new Date().toISOString());
  if (!holds.length) throw fail('PANIER_VIDE');
  const items = holds.map((h) => ({ tarif_type: h.tarif_type, price_cents: h.cost }));
  const total = items.reduce((s, it) => s + it.price_cents, 0);
  await ensurePromoMirrored(code); // rafraîchit le miroir depuis Stripe pour ce code
  const promo = validatePromoForCheckout({ code, userId, items }); // lève si invalide
  const discount = computeDiscount(promo, items);
  return {
    code: promo.code,
    reduction_type: promo.reduction_type,
    reduction_value: promo.reduction_value,
    discount_cents: discount,
    total_cents: total,
    new_total_cents: Math.max(0, total - discount),
  };
}

// ── Checkout MEMBRE (paiement CB via Stripe) ─────────────────────────────────
/**
 * Lance le paiement du panier : fige une commande et crée une session Stripe
 * Checkout. Les réservations ne sont créées qu'au webhook (paiement confirmé).
 * Les verrous sont prolongés le temps du paiement et conservés (place tenue).
 *
 * @param {number} userId Bénéficiaire du panier.
 * @param {string} baseUrl Origine publique (URL de retour Stripe).
 * @param {{promoCode?: string|null}} [opts] Code promo saisi au panier (facultatif).
 * @returns {Promise<{url:string, total:number, count:number}>}
 * @throws {Error} `PANIER_VIDE`, `HORS_HORAIRES`, `COMPLET`, `STRIPE_NON_CONFIGURE`,
 *         et les codes `PROMO_*` si le code promo est refusé.
 */
export async function startBookingCheckout(userId, baseUrl, { promoCode = null } = {}) {
  purgeExpired();
  const holds = listHolds.all(userId, new Date().toISOString());
  if (!holds.length) throw fail('PANIER_VIDE');

  // Re-vérifie horaires + disponibilité avant d'engager le paiement.
  for (const h of holds) {
    if (!withinOpeningHours(h.start_at, h.end_at)) throw fail('HORS_HORAIRES');
    if (availableSeats(h.space_id, h.start_at, h.end_at, { excludeHoldId: h.id }) < h.seats) throw fail('COMPLET');
  }

  const items = holds.map((h) => ({
    space_id: h.space_id, start_at: h.start_at, end_at: h.end_at, seats: h.seats,
    tarif_type: h.tarif_type, price_cents: h.cost, label: lineLabel(h),
    payment_method: h.payment_method, quota_days: h.quota_days || 0,
  }));
  const totalCents = items.reduce((s, it) => s + it.price_cents, 0);

  // Panier ENTIÈREMENT couvert par l'abonnement (0 €) : aucune étape de paiement,
  // confirmation immédiate + décompte du quota (cf. brief §2.B cas 1 / §2.C cas 3).
  if (totalCents === 0) {
    return checkoutCovered(userId, holds);
  }

  // Code promo : validé côté serveur (formule, dates, limites globale et par
  // personne) AVANT d'engager le paiement, puis appliqué par Stripe via `discounts`.
  // On rafraîchit d'abord le miroir depuis Stripe pour ce code précis.
  if (promoCode) await ensurePromoMirrored(promoCode);
  const promo = promoCode ? validatePromoForCheckout({ code: promoCode, userId, items }) : null;

  const session = await createBookingCheckoutSession({
    userId, items, baseUrl, promotionCodeId: promo?.stripe_promo_id || null,
  });
  createPendingOrder({ userId, sessionId: session.id, items, totalCents, promoId: promo?.id || null });

  // Prolonge les verrous le temps du paiement (places tenues jusqu'au webhook).
  const until = new Date(Date.now() + CHECKOUT_HOLD_MINUTES * 60000).toISOString();
  for (const h of holds) extendHold.run(until, h.id);

  return { url: session.url, total: totalCents, count: items.length };
}
