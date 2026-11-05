// Webhook entrant Stripe. Monté AVANT express.json() (cf. index.js) car la
// vérification de signature exige le CORPS BRUT (Buffer) : un corps déjà parsé
// en JSON invaliderait la signature.
//
// Authentification : signature `Stripe-Signature` vérifiée dans lib/stripe.js
// avec le secret de webhook. Aucune session, aucun cookie — cet appel vient des
// serveurs de Stripe. Un POST forgé sans signature valide est rejeté en 400.

import { constructEvent, getReceiptUrl } from '../lib/stripe.js';
import { fulfillOrder, attachReceipt, applyRefund } from '../lib/orders.js';
import { ensureVoucherForReservation } from '../lib/unifi.js';
import { ensureAccessPinForReservation } from '../lib/unifiAccess.js';
import { sendBookingConfirmation } from '../lib/mailer.js';
import { securityEvent } from '../lib/audit.js';

// Post-traitement (hors réponse webhook) : voucher Wi-Fi + PIN de porte d'abord
// (pour qu'ils figurent dans l'e-mail), puis e-mail de confirmation. Best-effort.
//
// Le voucher et le PIN sont générés EN PARALLÈLE (deux services distincts, l'un
// via le cloud UniFi, l'autre en local) : l'e-mail n'attend donc que le plus lent
// des deux, et non leur somme. Chaque réservation est traitée en parallèle aussi.
async function finalizeReservations(ids) {
  await Promise.all(ids.map(async (id) => {
    await Promise.allSettled([
      ensureVoucherForReservation(id),
      ensureAccessPinForReservation(id),
    ]);
    sendBookingConfirmation(id).catch(() => {});
  }));
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
      // On crée les réservations une fois le paiement réglé. `no_payment_required`
      // couvre le cas d'un code promo à 100 % (total 0 €) : Stripe valide la
      // session sans encaissement, la réservation gratuite doit tout de même être créée.
      const settled = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
      if (settled && s.metadata?.kind === 'booking') {
        const paymentIntent = typeof s.payment_intent === 'string' ? s.payment_intent : null;
        // `amount_total` = montant réellement encaissé (en centimes, APRÈS remise).
        const amountPaidCents = Number.isInteger(s.amount_total) ? s.amount_total : null;
        const r = fulfillOrder(s.id, paymentIntent, amountPaidCents);
        securityEvent('stripe_reservation_payee', {
          session: s.id, created: r.created?.length || 0, deja: r.alreadyProcessed,
          inconnu: r.unknown, conflits: r.conflicts?.length || 0,
        });
        // Conflit de capacité (paiement abouti après expiration du verrou, cf.
        // audit M4) : réservation honorée mais signalée pour arbitrage exploitant.
        if (r.conflicts?.length) {
          securityEvent('stripe_reservation_conflit', { session: s.id, conflits: r.conflicts });
        }
        // Hors transaction et hors réponse : voucher Wi-Fi + PIN porte + e-mail,
        // puis capture du reçu Stripe (appel réseau, best-effort).
        if (r.created?.length) {
          finalizeReservations(r.created);
          getReceiptUrl(paymentIntent).then((url) => attachReceipt(s.id, url)).catch(() => {});
        }
      }
    } else if (event.type === 'charge.refunded') {
      // Remboursement (total ou partiel) effectué dans Stripe : on met à jour la
      // trace locale pour que l'espace client affiche le statut « remboursée ».
      const c = event.data.object;
      const paymentIntent = typeof c.payment_intent === 'string' ? c.payment_intent : null;
      const r = applyRefund({
        paymentIntent,
        amountRefundedCents: Number.isInteger(c.amount_refunded) ? c.amount_refunded : 0,
        amountCents: Number.isInteger(c.amount) ? c.amount : 0,
      });
      securityEvent('stripe_remboursement', { pi: paymentIntent, resas: r.matched, total: r.fully });
    } else if (event.type === 'payment_intent.payment_failed') {
      // Échec de paiement : la session n'est pas complétée (aucune réservation).
      // On journalise pour le diagnostic (le client reste sur la page Stripe).
      const pi = event.data.object;
      securityEvent('stripe_paiement_echoue', {
        pi: pi?.id, raison: pi?.last_payment_error?.message || null,
      });
    }
    // Les événements non traités sont acquittés (Stripe cesse de les renvoyer).
    return res.json({ received: true });
  } catch (err) {
    // Échec de traitement : 500 pour que Stripe RÉESSAIE la livraison.
    console.error('[stripe:webhook]', event?.type, err);
    return res.status(500).json({ error: 'TRAITEMENT_ECHOUE' });
  }
}
