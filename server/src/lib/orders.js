// Commandes de réservation payées en ligne (euros).
//
// Modèle : au moment du paiement, on fige le « panier » de créneaux dans une
// commande (`reservation_orders.payload`, JSON) rattachée à la session Checkout
// Stripe. La réservation réelle n'est créée qu'à la confirmation du paiement
// (webhook `checkout.session.completed`), jamais à la redirection de retour :
// seul le webhook signé fait foi. La conversion est IDEMPOTENTE (session_id
// unique + garde `status != 'paid'`) : Stripe pouvant rejouer un événement, un
// même paiement ne crée jamais deux fois les réservations.
//
// La commande sert aussi de TRACE DE TRANSACTION durable (montant réellement
// encaissé, reçu Stripe, remboursements) exposée dans l'espace client.

import { db } from '../db.js';
import { insertReservation, availableSeats } from './booking.js';
import { recordRedemption } from './promos.js';
import { retrieveCheckoutSession } from './stripe.js';

const insertOrder = db.prepare(
  `INSERT INTO reservation_orders (user_id, session_id, total_cents, payload, status, promo_id)
   VALUES (@user_id, @session_id, @total_cents, @payload, 'pending', @promo_id)`
);
const getOrderBySession = db.prepare(`SELECT * FROM reservation_orders WHERE session_id = ?`);
const markOrderPaid = db.prepare(
  `UPDATE reservation_orders
      SET status = 'paid', payment_intent = @pi, amount_paid_cents = @amount_paid_cents,
          updated_at = datetime('now')
    WHERE id = @id AND status != 'paid'`
);
// Les verrous du panier ne servent plus une fois la commande transformée en résas.
const clearUserHolds = db.prepare(`DELETE FROM reservation_holds WHERE user_id = ?`);
// Décompte du quota Open Space pour les lignes couvertes par le quota Essentiel.
const consumeQuota = db.prepare(`UPDATE users SET open_space_quota_used = open_space_quota_used + ? WHERE id = ?`);

/**
 * Enregistre une commande en attente de paiement.
 * @param {{userId:number, sessionId:string, items:object[], totalCents:number, promoId?:number|null}} p
 * @returns {void}
 */
export function createPendingOrder({ userId, sessionId, items, totalCents, promoId = null }) {
  insertOrder.run({
    user_id: userId, session_id: sessionId, total_cents: totalCents,
    payload: JSON.stringify(items), promo_id: promoId ?? null,
  });
}

/**
 * Convertit une commande payée en réservations, de façon IDEMPOTENTE.
 * Le paiement étant encaissé, les créneaux sont honorés. On revérifie toutefois
 * la disponibilité (confirmées) de chaque créneau : si une place a été prise
 * entre-temps (paiement abouti après expiration du verrou), la réservation est
 * tout de même créée (le client a payé) mais SIGNALÉE en conflit pour que
 * l'exploitant arbitre (déplacement / remboursement). Cf. audit M4.
 *
 * @param {string} sessionId Session Checkout Stripe.
 * @param {string|null} [paymentIntent] PaymentIntent associé.
 * @param {number|null} [amountPaidCents] Montant réellement encaissé (amount_total Stripe).
 * @returns {{created:number[], conflicts:object[], alreadyProcessed:boolean, unknown?:boolean, userId?:number}}
 */
export const fulfillOrder = db.transaction((sessionId, paymentIntent = null, amountPaidCents = null) => {
  const order = getOrderBySession.get(sessionId);
  if (!order) return { created: [], conflicts: [], alreadyProcessed: false, unknown: true };
  if (order.status === 'paid') return { created: [], conflicts: [], alreadyProcessed: true, userId: order.user_id };

  const items = JSON.parse(order.payload);
  const created = [];
  const conflicts = [];
  for (const it of items) {
    // Disponibilité « confirmées » uniquement (hors verrous) : les résas déjà
    // insérées dans CETTE transaction sont comptées (status='confirmed').
    const left = availableSeats(it.space_id, it.start_at, it.end_at, { countHolds: false });
    if (left < it.seats) conflicts.push({ space_id: it.space_id, start_at: it.start_at, end_at: it.end_at, seats: it.seats, seats_left: left });
    // Mode de couverture figé au moment du panier. Les lignes couvertes par
    // l'abonnement (SUBSCRIPTION_*) sont « payées » à 0 € (payment_status 'free') ;
    // seules les lignes STRIPE_ONE_OFF ont été réellement encaissées.
    const method = it.payment_method || 'STRIPE_ONE_OFF';
    const paid = method === 'STRIPE_ONE_OFF';
    const reservationId = insertReservation({
      userId: order.user_id, spaceId: it.space_id, startIso: it.start_at, endIso: it.end_at,
      seats: it.seats, priceCents: it.price_cents, tarifType: it.tarif_type,
      paymentStatus: paid ? 'paid' : 'free', paymentMethod: method, quotaDays: it.quota_days || 0,
      stripeSessionId: sessionId, paymentIntent,
    });
    // Décompte du quota (une seule fois, dans la transaction idempotente).
    if (method === 'SUBSCRIPTION_QUOTA' && it.quota_days > 0) consumeQuota.run(it.quota_days, order.user_id);
    created.push(reservationId);
  }
  markOrderPaid.run({ id: order.id, pi: paymentIntent, amount_paid_cents: amountPaidCents });
  // Comptabilise l'utilisation du code promo (limite par personne / globale).
  // Dans la transaction idempotente : ne s'exécute qu'une fois par commande.
  if (order.promo_id) recordRedemption({ promoId: order.promo_id, userId: order.user_id, orderId: order.id });
  clearUserHolds.run(order.user_id); // vide le panier : les places sont désormais réservées
  return { created, conflicts, alreadyProcessed: false, userId: order.user_id };
});

// ── Reçu Stripe ───────────────────────────────────────────────────────────────
const setOrderReceipt = db.prepare(`UPDATE reservation_orders SET receipt_url = ? WHERE session_id = ? AND receipt_url IS NULL`);
const setResReceipt = db.prepare(`UPDATE reservations SET receipt_url = ? WHERE stripe_session_id = ? AND receipt_url IS NULL`);

/**
 * Attache l'URL du reçu Stripe à la commande et à ses réservations.
 * Appelé hors transaction, après fulfillOrder (le reçu est récupéré par un appel
 * réseau à Stripe). Best-effort, idempotent (ne réécrit pas un reçu déjà posé).
 *
 * @param {string} sessionId Session Checkout Stripe.
 * @param {string|null} receiptUrl URL du reçu.
 * @returns {void}
 */
export function attachReceipt(sessionId, receiptUrl) {
  if (!receiptUrl) return;
  setOrderReceipt.run(receiptUrl, sessionId);
  setResReceipt.run(receiptUrl, sessionId);
}

// ── Remboursement (event Stripe `charge.refunded`) ────────────────────────────
const getOrderByPi = db.prepare(`SELECT * FROM reservation_orders WHERE payment_intent = ?`);
const setOrderRefund = db.prepare(`UPDATE reservation_orders SET refunded_cents = @cents, updated_at = datetime('now') WHERE id = @id`);
const refundResFull = db.prepare(
  `UPDATE reservations SET payment_status = 'refunded', refunded_cents = price_cents, refunded_at = @at
    WHERE payment_intent = @pi AND payment_status != 'refunded'`
);
const refundResPartial = db.prepare(
  `UPDATE reservations SET payment_status = 'partially_refunded', refunded_at = @at
    WHERE payment_intent = @pi AND payment_status = 'paid'`
);

/**
 * Applique un remboursement confirmé par Stripe à la trace locale, de façon
 * idempotente. Relie l'événement aux réservations/commande via le PaymentIntent.
 *
 * @param {{paymentIntent:string|null, amountRefundedCents:number, amountCents:number}} p
 *        `amountRefundedCents` : total déjà remboursé sur la charge ;
 *        `amountCents` : montant initial de la charge.
 * @returns {{matched:number, fully:boolean}}
 */
export const applyRefund = db.transaction(({ paymentIntent, amountRefundedCents = 0, amountCents = 0 }) => {
  if (!paymentIntent) return { matched: 0, fully: false };
  const at = new Date().toISOString();
  const fully = amountCents > 0 && amountRefundedCents >= amountCents;
  const info = fully
    ? refundResFull.run({ pi: paymentIntent, at })
    : refundResPartial.run({ pi: paymentIntent, at });
  const order = getOrderByPi.get(paymentIntent);
  if (order) setOrderRefund.run({ id: order.id, cents: amountRefundedCents });
  return { matched: info.changes, fully };
});

// ── Lecture : transactions de l'espace client ─────────────────────────────────
const myTxStmt = db.prepare(
  `SELECT o.id, o.session_id, o.created_at, o.updated_at, o.status,
          o.total_cents, o.amount_paid_cents, o.receipt_url, o.refunded_cents,
          (SELECT GROUP_CONCAT(sp.name, ', ')
             FROM reservations r JOIN spaces sp ON sp.id = r.space_id
            WHERE r.stripe_session_id = o.session_id) AS spaces,
          (SELECT MIN(r.start_at) FROM reservations r WHERE r.stripe_session_id = o.session_id) AS first_start,
          (SELECT COUNT(*)        FROM reservations r WHERE r.stripe_session_id = o.session_id) AS reservations_count
     FROM reservation_orders o
    WHERE o.user_id = ? AND o.status = 'paid'
    ORDER BY o.created_at DESC`
);

/**
 * Transactions (paiements en ligne) d'un membre, pour l'espace client.
 * L'identité vient de la session appelante : aucun paiement d'un autre membre
 * n'est accessible.
 *
 * @param {number} userId Membre concerné.
 * @returns {object[]} Transactions, de la plus récente à la plus ancienne, avec
 *          `amount_cents` (encaissé, repli sur total), `status` de paiement et reçu.
 */
export function listMyTransactions(userId) {
  return myTxStmt.all(userId).map((o) => {
    const amount = o.amount_paid_cents ?? o.total_cents;
    const status = o.refunded_cents > 0
      ? (o.refunded_cents >= amount ? 'refunded' : 'partially_refunded')
      : 'paid';
    return {
      id: o.id,
      created_at: o.created_at,
      spaces: o.spaces,
      first_start: o.first_start,
      reservations_count: o.reservations_count,
      amount_cents: amount,
      refunded_cents: o.refunded_cents,
      status,
      receipt_url: o.receipt_url,
    };
  });
}

// ── Clôture d'une tentative de paiement caduque ───────────────────────────────
const listUserPendingStmt = db.prepare(
  `SELECT session_id FROM reservation_orders WHERE user_id = ? AND status = 'pending'`
);
const abandonUserPendingStmt = db.prepare(
  `UPDATE reservation_orders SET status = 'abandoned', updated_at = datetime('now')
    WHERE user_id = ? AND status = 'pending'`
);
const abandonOneStmt = db.prepare(
  `UPDATE reservation_orders SET status = 'abandoned', updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'`
);

/**
 * Marque comme abandonnées les commandes encore en attente d'un membre, et
 * renvoie leurs sessions Checkout pour que l'appelant les clôture chez Stripe.
 *
 * Appelé quand le membre relance un paiement : la tentative précédente ne peut
 * plus aboutir et ne doit plus être présentée comme « en cours ».
 *
 * @param {number} userId
 * @returns {string[]} Sessions Checkout des commandes abandonnées.
 */
export function abandonPendingOrders(userId) {
  const sessions = listUserPendingStmt.all(userId).map((o) => o.session_id);
  abandonUserPendingStmt.run(userId);
  return sessions;
}

// ── Lecture : commandes en attente (filet post-paiement) ──────────────────────
// Une commande reste 'pending' entre le paiement et l'arrivée du webhook. On
// l'expose au membre (bandeau « paiement en cours de traitement ») et à
// l'exploitant (réconciliation). On borne à 1 h : au-delà, un pending est
// probablement un paiement abandonné, pas une latence de webhook.
const myPendingStmt = db.prepare(
  `SELECT id, session_id, created_at, total_cents
     FROM reservation_orders
    WHERE user_id = ? AND status = 'pending'
      AND datetime(created_at) >= datetime('now', '-1 hour')
    ORDER BY created_at DESC`
);

// Délai pendant lequel une commande en attente est présumée « en cours » sans
// rien demander à Stripe : c'est la fenêtre de latence normale du webhook, qui
// se compte en secondes. Au-delà, on va vérifier.
const PENDING_GRACE_MS = 60 * 1000;

// `datetime('now')` écrit un horodatage UTC sans fuseau : sans le 'Z', le
// navigateur comme Node le liraient en heure locale.
const parsedAt = (sqlDate) => new Date(`${String(sqlDate).replace(' ', 'T')}Z`).getTime();

/**
 * Commandes réellement en attente d'être transformées en réservations.
 *
 * Une commande en attente ne prouve pas qu'un paiement a eu lieu : elle est
 * créée AVANT la redirection vers Stripe. Un client qui renonce sur la page de
 * paiement en laissait donc une derrière lui, et le bandeau « paiement en cours
 * de traitement » s'affichait une heure durant alors que rien n'avait été payé.
 * Passé le délai de latence normal du webhook, on demande son état à Stripe et
 * on n'annonce un paiement en cours que s'il a bien été réglé.
 *
 * @param {number} userId
 * @returns {Promise<object[]>}
 */
export async function listMyPendingOrders(userId) {
  const rows = myPendingStmt.all(userId);
  const out = [];
  for (const order of rows) {
    if (Date.now() - parsedAt(order.created_at) < PENDING_GRACE_MS) { out.push(order); continue; }
    const session = await retrieveCheckoutSession(order.session_id);
    // Stripe injoignable ou session inconnue : dans le doute, on continue de
    // l'annoncer plutôt que de laisser croire à une réservation perdue.
    if (!session) { out.push(order); continue; }
    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
      out.push(order);
      continue;
    }
    // Session expirée : la tentative est close pour de bon.
    if (session.status === 'expired') abandonOneStmt.run(order.id);
    // Session encore ouverte et impayée : le client n'a rien réglé, donc aucun
    // paiement n'est « en cours ». On la laisse en attente, il peut revenir.
  }
  return out;
}

// Commandes 'pending' anciennes, tous membres : candidates à la réconciliation admin.
const stalePendingStmt = db.prepare(
  `SELECT o.id, o.session_id, o.user_id, o.created_at, o.total_cents, u.display_name AS member_name, u.email AS member_email
     FROM reservation_orders o JOIN users u ON u.id = o.user_id
    WHERE o.status = 'pending' AND datetime(o.created_at) <= datetime('now', '-15 minutes')
    ORDER BY o.created_at ASC`
);
export function listStalePendingOrders() {
  return stalePendingStmt.all();
}
const getOrderById = db.prepare(`SELECT * FROM reservation_orders WHERE id = ?`);
export function getPendingOrder(id) {
  const o = getOrderById.get(id);
  return o && o.status === 'pending' ? o : null;
}
