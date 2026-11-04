// Webhook entrant Stripe. Monté AVANT express.json() (cf. index.js) car la
// vérification de signature exige le CORPS BRUT (Buffer) : un corps déjà parsé
// en JSON invaliderait la signature.
//
// Authentification : signature `Stripe-Signature` vérifiée dans lib/stripe.js
// avec le secret de webhook. Aucune session, aucun cookie — cet appel vient des
// serveurs de Stripe. Un POST forgé sans signature valide est rejeté en 400.

import { constructEvent } from '../lib/stripe.js';
import { fulfillOrder } from '../lib/orders.js';
import { ensureVoucherForReservation } from '../lib/unifi.js';
import { ensureAccessPinForReservation } from '../lib/unifiAccess.js';
import { sendBookingConfirmation } from '../lib/mailer.js';
import { securityEvent } from '../lib/audit.js';

// Post-traitement (hors réponse webhook) : voucher Wi-Fi + PIN de porte d'abord
// (pour qu'ils figurent dans l'e-mail), puis e-mail de confirmation. Best-effort.
async function finalizeReservations(ids) {
  for (const id of ids) {
    await ensureVoucherForReservation(id).catch(() => {});
    await ensureAccessPinForReservation(id).catch(() => {});
    sendBookingConfirmation(id).catch(() => {});
  }
}

/**
 * Handler Express brut pour POST /api/webhooks/stripe.
 * À la confirmation d'un paiement de réservation, convertit la commande en
 * réservations (idempotent) puis déclenche voucher Wi-Fi + e-mail de confirmation.
 *
 * @param {import('express').Request} req `req.body` est un Buffer (express.raw).
 * @param {import('express').Response} res
 */
export function stripeWebhookHandler(req, res) {
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = constructEvent(req.body, signature);
  } catch (err) {
    securityEvent('stripe_webhook_rejet', { raison: err.message });
    return res.status(400).json({ error: 'SIGNATURE_INVALIDE' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      // On ne crée les réservations que si le paiement est réellement encaissé.
      if (s.payment_status === 'paid' && s.metadata?.kind === 'booking') {
        const paymentIntent = typeof s.payment_intent === 'string' ? s.payment_intent : null;
        const r = fulfillOrder(s.id, paymentIntent);
        securityEvent('stripe_reservation_payee', {
          session: s.id, created: r.created?.length || 0, deja: r.alreadyProcessed, inconnu: r.unknown,
        });
        // Hors transaction et hors réponse : voucher Wi-Fi + PIN porte + e-mail.
        if (r.created?.length) finalizeReservations(r.created);
      }
    }
    // Les événements non traités sont acquittés (Stripe cesse de les renvoyer).
    return res.json({ received: true });
  } catch (err) {
    // Échec de traitement : 500 pour que Stripe RÉESSAIE la livraison.
    console.error('[stripe:webhook]', event?.type, err);
    return res.status(500).json({ error: 'TRAITEMENT_ECHOUE' });
  }
}
