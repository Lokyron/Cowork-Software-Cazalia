// Commandes de réservation payées en ligne (euros).
//
// Modèle : au moment du paiement, on fige le « panier » de créneaux dans une
// commande (`reservation_orders.payload`, JSON) rattachée à la session Checkout
// Stripe. La réservation réelle n'est créée qu'à la confirmation du paiement
// (webhook `checkout.session.completed`), jamais à la redirection de retour :
// seul le webhook signé fait foi. La conversion est IDEMPOTENTE (session_id
// unique + garde `status != 'paid'`) : Stripe pouvant rejouer un événement, un
// même paiement ne crée jamais deux fois les réservations.

import { db } from '../db.js';
import { insertReservation } from './booking.js';
import { recordRedemption } from './promos.js';

const insertOrder = db.prepare(
  `INSERT INTO reservation_orders (user_id, session_id, total_cents, payload, status, promo_id)
   VALUES (@user_id, @session_id, @total_cents, @payload, 'pending', @promo_id)`
);
const getOrderBySession = db.prepare(`SELECT * FROM reservation_orders WHERE session_id = ?`);
const markOrderPaid = db.prepare(
  `UPDATE reservation_orders SET status = 'paid', payment_intent = @pi, updated_at = datetime('now')
    WHERE id = @id AND status != 'paid'`
);
// Les verrous du panier ne servent plus une fois la commande transformée en résas.
const clearUserHolds = db.prepare(`DELETE FROM reservation_holds WHERE user_id = ?`);

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
 * Le paiement étant encaissé, les créneaux sont honorés (surbooking toléré : la
 * disponibilité a été vérifiée à la pose des verrous et au lancement du paiement).
 *
 * @param {string} sessionId Session Checkout Stripe.
 * @param {string|null} [paymentIntent] PaymentIntent associé.
 * @returns {{created:number[], alreadyProcessed:boolean, unknown?:boolean, userId?:number}}
 */
export const fulfillOrder = db.transaction((sessionId, paymentIntent = null) => {
  const order = getOrderBySession.get(sessionId);
  if (!order) return { created: [], alreadyProcessed: false, unknown: true };
  if (order.status === 'paid') return { created: [], alreadyProcessed: true, userId: order.user_id };

  const items = JSON.parse(order.payload);
  const created = [];
  for (const it of items) {
    const reservationId = insertReservation({
      userId: order.user_id, spaceId: it.space_id, startIso: it.start_at, endIso: it.end_at,
      seats: it.seats, priceCents: it.price_cents, tarifType: it.tarif_type,
      paymentStatus: 'paid', stripeSessionId: sessionId, paymentIntent,
    });
    created.push(reservationId);
  }
  markOrderPaid.run({ id: order.id, pi: paymentIntent });
  // Comptabilise l'utilisation du code promo (limite par personne / globale).
  // Dans la transaction idempotente : ne s'exécute qu'une fois par commande.
  if (order.promo_id) recordRedemption({ promoId: order.promo_id, userId: order.user_id, orderId: order.id });
  clearUserHolds.run(order.user_id); // vide le panier : les places sont désormais réservées
  return { created, alreadyProcessed: false, userId: order.user_id };
});
