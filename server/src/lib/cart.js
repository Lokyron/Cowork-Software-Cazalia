// Panier de réservation multi-créneaux : verrous temporaires puis paiement.
//
//   • Membre  : le checkout crée une session Stripe (paiement CB à la résa) ;
//               les réservations sont créées au webhook (cf. lib/orders.js).
//   • Admin   : le checkout crée directement les réservations (gratuit, paiement
//               géré hors ligne) — aucun passage par Stripe.
//
// Disponibilité : capacity − Σ(réservations confirmées) − Σ(verrous actifs des autres).
// L'expiration est « paresseuse » : purgée à chaque lecture/écriture.

import { db } from '../db.js';
import { config } from '../config.js';
import { fail } from './errors.js';
import { createBookingCheckoutSession } from './stripe.js';
import { createPendingOrder } from './orders.js';
import {
  getActiveSpace, resolveSeats, quoteCost, validateSlot, withinOpeningHours, availableSeats, insertReservation,
} from './booking.js';

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
     (user_id, space_id, start_at, end_at, seats, cost, tarif_type, ignore_hours, allow_overbooking, created_by, expires_at)
   VALUES (@user_id, @space_id, @start_at, @end_at, @seats, @cost, @tarif_type, @ignore_hours, @allow_overbooking, @created_by, @expires_at)`
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
  return `${h.space_name} — ${tarif}${seats} (${when})`;
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
  const cost = o.customCostCents != null ? Math.max(0, Math.round(o.customCostCents)) : quoteCost(spaceId, startIso, endIso, seats, tarifType);
  const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60000).toISOString();
  const info = insertHold.run({
    user_id: userId, space_id: spaceId, start_at: startIso, end_at: endIso, seats, cost, tarif_type: tarifType,
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
 * Retire une ligne du panier (appartenance vérifiée — anti-IDOR).
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
      });
      created.push({ reservationId, cost: h.cost });
      delHold.run(h.id);
    }
    return { reservations: created, total, count: created.length };
  });
  return tx();
}

// ── Checkout MEMBRE (paiement CB via Stripe) ─────────────────────────────────
/**
 * Lance le paiement du panier : fige une commande et crée une session Stripe
 * Checkout. Les réservations ne sont créées qu'au webhook (paiement confirmé).
 * Les verrous sont prolongés le temps du paiement et conservés (place tenue).
 *
 * @param {number} userId Bénéficiaire du panier.
 * @param {string} baseUrl Origine publique (URL de retour Stripe).
 * @returns {Promise<{url:string, total:number, count:number}>}
 * @throws {Error} `PANIER_VIDE`, `HORS_HORAIRES`, `COMPLET`, `STRIPE_NON_CONFIGURE`.
 */
export async function startBookingCheckout(userId, baseUrl) {
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
  }));
  const totalCents = items.reduce((s, it) => s + it.price_cents, 0);

  const session = await createBookingCheckoutSession({ userId, items, baseUrl });
  createPendingOrder({ userId, sessionId: session.id, items, totalCents });

  // Prolonge les verrous le temps du paiement (places tenues jusqu'au webhook).
  const until = new Date(Date.now() + CHECKOUT_HOLD_MINUTES * 60000).toISOString();
  for (const h of holds) extendHold.run(until, h.id);

  return { url: session.url, total: totalCents, count: items.length };
}
