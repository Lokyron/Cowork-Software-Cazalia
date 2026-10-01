// Panier de réservation multi-espaces : verrous temporaires (10 min) puis paiement
// crédits groupé (transaction atomique). Utilisable côté client (pour soi) et côté
// admin (pour un client, avec droits bypass par ligne).
//
// Disponibilité : capacity − Σ(réservations confirmées) − Σ(verrous actifs des autres).
// L'expiration est « paresseuse » : purgée à chaque lecture/écriture.

import { db } from '../db.js';
import { config } from '../config.js';
import { fail } from './errors.js';
import { getBalance } from './wallet.js';
import {
  getActiveSpace, resolveSeats, quoteCost, validateSlot, withinOpeningHours, availableSeats,
} from './booking.js';

export const HOLD_MINUTES = 10;

// Un panier ne peut pas contenir plus de lignes que ce plafond. Chaque verrou
// retire des places de l'inventaire pendant 10 minutes : sans limite, un membre
// pourrait bloquer la totalité des espaces sans jamais payer (CWE-770).
const MAX_HOLDS_PER_CART = 40;

const countActiveHolds = db.prepare(
  `SELECT COUNT(*) AS n FROM reservation_holds WHERE user_id = ? AND expires_at > ?`
);

const insertHold = db.prepare(
  `INSERT INTO reservation_holds
     (user_id, space_id, start_at, end_at, seats, cost, ignore_hours, allow_overbooking, created_by, expires_at)
   VALUES (@user_id, @space_id, @start_at, @end_at, @seats, @cost, @ignore_hours, @allow_overbooking, @created_by, @expires_at)`
);
const getHold = db.prepare(`SELECT * FROM reservation_holds WHERE id = ?`);
const getHoldView = db.prepare(
  `SELECT h.*, s.name AS space_name, s.color AS space_color FROM reservation_holds h JOIN spaces s ON s.id = h.space_id WHERE h.id = ?`
);
const delHold = db.prepare(`DELETE FROM reservation_holds WHERE id = ?`);
const delExpired = db.prepare(`DELETE FROM reservation_holds WHERE expires_at <= ?`);
const listHolds = db.prepare(
  `SELECT h.*, s.name AS space_name, s.color AS space_color, s.exclusive, s.privatizable
     FROM reservation_holds h JOIN spaces s ON s.id = h.space_id
    WHERE h.user_id = ? AND h.expires_at > ? ORDER BY h.start_at`
);

/**
 * Supprime les verrous expirés. Appelée à chaque lecture/écriture du panier
 * (expiration « paresseuse », sans tâche de fond).
 * @returns {void}
 */
export function purgeExpired() { delExpired.run(new Date().toISOString()); }

/**
 * Ajoute une ligne au panier, en posant un verrou de `HOLD_MINUTES` minutes sur
 * les places demandées.
 *
 * @param {number} userId Bénéficiaire du panier.
 * @param {number} spaceId Espace concerné.
 * @param {string} startRaw Début du créneau.
 * @param {string} endRaw Fin du créneau.
 * @param {number} [seatsRaw] Places demandées.
 * @param {{ignoreHours?: boolean, allowOverbooking?: boolean, customCost?: number, createdBy?: number}} [opts]
 *        Options RÉSERVÉES À L'ADMINISTRATEUR : la route panier côté membre ne
 *        les transmet jamais (cf. `routes/cart.js`).
 * @returns {object} Ligne de panier créée.
 * @throws {Error} `ESPACE_INTROUVABLE`, `HORS_HORAIRES`, `COMPLET`, `PANIER_PLEIN`,
 *         `CRENEAU_INVALIDE`, `CRENEAU_PASSE`.
 */
export function addHold(userId, spaceId, startRaw, endRaw, seatsRaw = 1, opts = {}) {
  purgeExpired();
  const space = getActiveSpace(spaceId);
  if (!space) throw fail('ESPACE_INTROUVABLE');
  if (countActiveHolds.get(userId, new Date().toISOString()).n >= MAX_HOLDS_PER_CART) {
    throw fail('PANIER_PLEIN');
  }
  const { startIso, endIso } = validateSlot(startRaw, endRaw);
  const o = opts || {};
  if (!o.ignoreHours && !withinOpeningHours(startIso, endIso)) throw fail('HORS_HORAIRES');
  const seats = resolveSeats(space, seatsRaw);
  if (!o.allowOverbooking && availableSeats(spaceId, startIso, endIso) < seats) throw fail('COMPLET');
  const cost = o.customCost != null ? Math.max(0, Math.round(o.customCost)) : quoteCost(spaceId, startIso, endIso, seats);
  const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60000).toISOString();
  const info = insertHold.run({
    user_id: userId, space_id: spaceId, start_at: startIso, end_at: endIso, seats, cost,
    ignore_hours: o.ignoreHours ? 1 : 0, allow_overbooking: o.allowOverbooking ? 1 : 0,
    created_by: o.createdBy ?? userId, expires_at: expiresAt,
  });
  return getHoldView.get(info.lastInsertRowid);
}

/**
 * Contenu du panier d'un bénéficiaire, avec total et solde disponible.
 * @param {number} userId Bénéficiaire.
 * @returns {{holds: object[], total: number, count: number, balance: number}}
 */
export function listCart(userId) {
  purgeExpired();
  const holds = listHolds.all(userId, new Date().toISOString());
  const total = holds.reduce((s, h) => s + h.cost, 0);
  return { holds, total, count: holds.length, balance: getBalance(userId) };
}

/**
 * Retire une ligne du panier.
 *
 * CONTRÔLE D'ACCÈS : un membre ne peut retirer qu'un verrou lui appartenant, ou
 * qu'il a lui-même posé. Sans cette vérification, connaître l'identifiant d'un
 * verrou suffirait à vider le panier d'un autre membre (IDOR, OWASP A01).
 *
 * @param {number} holdId Verrou visé.
 * @param {{id: number, role: string}} actor Utilisateur à l'origine de l'action.
 * @returns {{removed: boolean}}
 * @throws {Error} `INTERDIT` si le verrou appartient à un tiers.
 */
export function removeHold(holdId, actor) {
  const h = getHold.get(holdId);
  if (!h) return { removed: false };
  if (actor.role !== 'admin' && h.user_id !== actor.id && h.created_by !== actor.id) throw fail('INTERDIT');
  delHold.run(holdId);
  return { removed: true };
}

// ── Checkout atomique (crédits) ───────────────────────────────────────────────
const insertResStmt = db.prepare(
  `INSERT INTO reservations (user_id, space_id, start_at, end_at, credits_cost, seats) VALUES (?, ?, ?, ?, ?, ?)`
);
const insertBookingTxStmt = db.prepare(
  `INSERT INTO credit_transactions (user_id, amount, reason, reservation_id, created_by) VALUES (?, ?, 'booking', ?, ?)`
);

/**
 * Convertit les verrous actifs du panier en réservations et débite les crédits,
 * dans UNE seule transaction (tout ou rien).
 *
 * La disponibilité et les horaires sont RE-VÉRIFIÉS au moment du paiement : le
 * coût et les places ont été calculés à la pose du verrou, et l'état de
 * l'inventaire a pu changer entre-temps.
 *
 * @param {number} userId Bénéficiaire du panier.
 * @param {{id: number, role: string}} actor Utilisateur qui valide (membre ou admin).
 * @returns {{reservations: Array<{reservationId: number|bigint, cost: number}>, total: number, count: number}}
 * @throws {Error} `PANIER_VIDE`, `CREDITS_INSUFFISANTS`, `HORS_HORAIRES`, `COMPLET`.
 */
export function checkout(userId, actor) {
  purgeExpired();
  const holds = listHolds.all(userId, new Date().toISOString());
  if (!holds.length) throw fail('PANIER_VIDE');
  const tx = db.transaction(() => {
    const total = holds.reduce((s, h) => s + h.cost, 0);
    if (getBalance(userId) < total) throw fail('CREDITS_INSUFFISANTS');
    const created = [];
    for (const h of holds) {
      if (!h.ignore_hours && !withinOpeningHours(h.start_at, h.end_at)) throw fail('HORS_HORAIRES');
      // On exclut le hold courant du calcul (il représente CE qu'on est en train de confirmer).
      if (!h.allow_overbooking && availableSeats(h.space_id, h.start_at, h.end_at, { excludeHoldId: h.id }) < h.seats) throw fail('COMPLET');
      const r = insertResStmt.run(userId, h.space_id, h.start_at, h.end_at, h.cost, h.seats);
      insertBookingTxStmt.run(userId, -h.cost, r.lastInsertRowid, h.created_by ?? userId);
      created.push({ reservationId: r.lastInsertRowid, cost: h.cost });
      delHold.run(h.id);
    }
    return { reservations: created, total, count: created.length };
  });
  return tx();
}
