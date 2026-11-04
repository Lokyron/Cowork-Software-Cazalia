// Webhook entrant Stripe. Monté AVANT express.json() (cf. index.js) car la
// vérification de signature exige le CORPS BRUT (Buffer) : un corps déjà parsé
// en JSON invaliderait la signature.
//
// Authentification : signature `Stripe-Signature` vérifiée dans lib/stripe.js
// avec le secret de webhook. Aucune session, aucun cookie — cet appel vient des
// serveurs de Stripe. Un POST forgé sans signature valide est rejeté en 400.

import { constructEvent } from '../lib/stripe.js';
import { fulfillPurchase } from '../lib/purchases.js';
import { securityEvent } from '../lib/audit.js';

/**
 * Handler Express brut pour POST /api/webhooks/stripe.
 * @param {import('express').Request} req `req.body` est un Buffer (express.raw).
 * @param {import('express').Response} res
 */
export function stripeWebhookHandler(req, res) {
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = constructEvent(req.body, signature);
  } catch (err) {
    // Signature invalide / Stripe non configuré : on refuse sans rien traiter.
    securityEvent('stripe_webhook_rejet', { raison: err.message });
    return res.status(400).json({ error: 'SIGNATURE_INVALIDE' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      // On ne crédite que si le paiement est effectivement encaissé.
      if (s.payment_status === 'paid') {
        const userId = Number(s.metadata?.user_id);
        const credits = Number(s.metadata?.credits);
        const amountEurCents = Number(s.amount_total);
        if (Number.isInteger(userId) && Number.isInteger(credits) && credits > 0) {
          const r = fulfillPurchase({
            sessionId: s.id,
            paymentIntent: typeof s.payment_intent === 'string' ? s.payment_intent : null,
            userId,
            credits,
            amountEurCents,
          });
          securityEvent('stripe_recharge', { session: s.id, credited: r.credited, deja: r.alreadyProcessed });
        } else {
          securityEvent('stripe_webhook_metadonnees', { session: s.id });
        }
      }
    }
    // Les événements non traités sont acquittés (Stripe cesse de les renvoyer).
    return res.json({ received: true });
  } catch (err) {
    // Échec de traitement : on renvoie 500 pour que Stripe RÉESSAIE la livraison.
    console.error('[stripe:webhook]', event?.type, err);
    return res.status(500).json({ error: 'TRAITEMENT_ECHOUE' });
  }
}
