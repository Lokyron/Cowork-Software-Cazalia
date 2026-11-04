// Intégration Stripe — recharge de crédits par Checkout hébergé.
//
// Choix d'architecture :
//   - Checkout HÉBERGÉ : la page de paiement est servie par Stripe, aucune donnée
//     de carte ne transite par nos serveurs (conforme aux CGV/CGU).
//   - Le crédit du portefeuille est déclenché par le WEBHOOK `checkout.session.
//     completed`, jamais par la redirection de retour : seul le webhook (signé)
//     fait foi (le client peut fermer l'onglet avant la redirection).
//   - Clés lues à CHAUD depuis les réglages : une rotation de clé en base prend
//     effet sans redémarrage.

import Stripe from 'stripe';
import { getStripe } from './settings.js';

/**
 * Client Stripe construit avec la clé secrète courante, ou `null` si absente.
 * @returns {Stripe|null}
 */
function client() {
  const { secretKey } = getStripe();
  if (!secretKey) return null;
  return new Stripe(secretKey);
}

/**
 * Formule d'achat correspondant à un identifiant, ou `null`.
 * @param {string} packId
 * @returns {{id:string,credits:number,eur_cents:number,label:string}|null}
 */
export function findPack(packId) {
  const { packs } = getStripe();
  return packs.find((p) => p.id === packId) || null;
}

/**
 * Crée une session Checkout pour l'achat d'une formule de crédits.
 *
 * @param {object} params
 * @param {number} params.userId Membre bénéficiaire (crédité au paiement).
 * @param {{id:string,credits:number,eur_cents:number,label:string}} params.pack Formule.
 * @param {string} params.baseUrl Origine publique (pour les URL de retour).
 * @returns {Promise<import('stripe').Stripe.Checkout.Session>}
 * @throws {Error} `STRIPE_NON_CONFIGURE`.
 */
export async function createCheckoutSession({ userId, pack, baseUrl }) {
  const stripe = client();
  if (!stripe) { const e = new Error('STRIPE_NON_CONFIGURE'); e.code = 'STRIPE_NON_CONFIGURE'; throw e; }
  const base = String(baseUrl || '').replace(/\/$/, '');
  return stripe.checkout.sessions.create({
    mode: 'payment',
    // Restreint aux cartes : simple et universel. (Ajouter d'autres moyens plus tard si besoin.)
    payment_method_types: ['card'],
    client_reference_id: String(userId),
    metadata: { user_id: String(userId), credits: String(pack.credits), pack_id: pack.id },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'eur',
        unit_amount: pack.eur_cents,
        product_data: { name: `CAZALIA — ${pack.label}`, description: `${pack.credits} crédits de réservation` },
      },
    }],
    success_url: `${base}/mon-espace?recharge=success`,
    cancel_url: `${base}/mon-espace?recharge=cancel`,
  });
}

/**
 * Crée une session Checkout pour PAYER une réservation (ou un panier de créneaux).
 * Une ligne par créneau ; le crédit du portefeuille n'existe plus — on paie le
 * montant réel en euros. La réservation est créée au webhook (cf. lib/orders.js).
 *
 * @param {object} params
 * @param {number} params.userId Membre qui réserve.
 * @param {Array<{price_cents:number,label:string}>} params.items Lignes à facturer.
 * @param {string} params.baseUrl Origine publique (URL de retour).
 * @returns {Promise<import('stripe').Stripe.Checkout.Session>}
 * @throws {Error} `STRIPE_NON_CONFIGURE`.
 */
export async function createBookingCheckoutSession({ userId, items, baseUrl }) {
  const stripe = client();
  if (!stripe) { const e = new Error('STRIPE_NON_CONFIGURE'); e.code = 'STRIPE_NON_CONFIGURE'; throw e; }
  const base = String(baseUrl || '').replace(/\/$/, '');
  const line_items = items.map((it) => ({
    quantity: 1,
    price_data: {
      currency: 'eur',
      unit_amount: it.price_cents,
      product_data: { name: it.label || 'Réservation Cazalia' },
    },
  }));
  return stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    client_reference_id: String(userId),
    metadata: { kind: 'booking', user_id: String(userId) },
    line_items,
    success_url: `${base}/mon-espace?reservation=success`,
    cancel_url: `${base}/mon-espace?reservation=cancel`,
  });
}

/**
 * Vérifie et décode un événement de webhook Stripe à partir du CORPS BRUT.
 * La signature garantit que l'appel provient bien de Stripe (et non d'un POST forgé).
 *
 * @param {Buffer|string} rawBody Corps brut de la requête (non parsé en JSON).
 * @param {string} signature En-tête `Stripe-Signature`.
 * @returns {import('stripe').Stripe.Event}
 * @throws {Error} Si la signature est invalide ou Stripe non configuré.
 */
export function constructEvent(rawBody, signature) {
  const stripe = client();
  const { webhookSecret } = getStripe();
  if (!stripe || !webhookSecret) throw new Error('STRIPE_NON_CONFIGURE');
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}
