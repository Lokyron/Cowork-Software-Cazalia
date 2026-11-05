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
import { getStripe, getSetting, setSetting } from './settings.js';

/**
 * Client Stripe construit avec la clé secrète courante, ou `null` si absente.
 * @returns {Stripe|null}
 */
function client() {
  const { secretKey } = getStripe();
  if (!secretKey) return null;
  return new Stripe(secretKey);
}

// Exposé pour les autres modules (lib/promos.js) : réutilise la même fabrique de
// client (clé lue à chaud) plutôt que d'en recréer une.
export { client as getClient };

// ── Produits « formule » persistants ─────────────────────────────────────────
// La restriction d'un coupon à une formule précise (ex. « Journée » uniquement)
// passe par `coupon.applies_to.products`, qui exige un Produit Stripe PERSISTANT.
// Le checkout paie des montants dynamiques (prix ad-hoc) : on garde `price_data`
// mais on le rattache à l'un de ces trois produits via `price_data.product`.
// Les ids sont créés une fois puis mémorisés en réglages (clé `stripe_formules`).
//
// ⚠️ En cas de bascule vers un autre compte Stripe (test → live, rotation), les
// ids mémorisés n'existeront plus : vider le réglage `stripe_formules` force leur
// recréation.
const FORMULE_NAMES = {
  heure: 'Formule Heure',
  demi_journee: 'Formule Demi-journée',
  journee: 'Formule Journée',
};

/**
 * Garantit l'existence des trois produits « formule » et renvoie leurs ids.
 * @param {Stripe} stripe Client Stripe.
 * @returns {Promise<{heure:string, demi_journee:string, journee:string}>}
 */
export async function ensureFormuleProducts(stripe) {
  const cached = getSetting('stripe_formules', null);
  if (cached && cached.heure && cached.demi_journee && cached.journee) return cached;
  const ids = {};
  for (const [key, name] of Object.entries(FORMULE_NAMES)) {
    const product = await stripe.products.create({
      name: `Cazalia — ${name}`,
      metadata: { formule: key },
    });
    ids[key] = product.id;
  }
  setSetting('stripe_formules', ids);
  return ids;
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
 * @param {Array<{price_cents:number,label:string,tarif_type:string}>} params.items Lignes à facturer.
 * @param {string} params.baseUrl Origine publique (URL de retour).
 * @param {string|null} [params.promotionCodeId] Promotion Code Stripe à appliquer
 *        (déjà validé côté serveur). La saisie libre de code sur la page Stripe
 *        est désactivée : seuls les codes validés par Cazalia sont appliqués, ce
 *        qui permet de faire respecter la limite « par personne ».
 * @returns {Promise<import('stripe').Stripe.Checkout.Session>}
 * @throws {Error} `STRIPE_NON_CONFIGURE`.
 */
export async function createBookingCheckoutSession({ userId, items, baseUrl, promotionCodeId = null }) {
  const stripe = client();
  if (!stripe) { const e = new Error('STRIPE_NON_CONFIGURE'); e.code = 'STRIPE_NON_CONFIGURE'; throw e; }
  const base = String(baseUrl || '').replace(/\/$/, '');
  // Chaque ligne est rattachée au produit « formule » correspondant (via
  // `price_data.product`) pour que les coupons restreints à une formule
  // (applies_to.products) ne s'appliquent qu'aux bonnes lignes. Repli sur un
  // libellé ad-hoc si le type de tarif est inconnu (ne devrait pas arriver).
  const formules = await ensureFormuleProducts(stripe);
  const line_items = items.map((it) => {
    const productId = formules[it.tarif_type];
    return {
      quantity: 1,
      price_data: {
        currency: 'eur',
        unit_amount: it.price_cents,
        ...(productId
          ? { product: productId }
          : { product_data: { name: it.label || 'Réservation Cazalia' } }),
      },
    };
  });
  return stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    client_reference_id: String(userId),
    metadata: { kind: 'booking', user_id: String(userId) },
    line_items,
    // Le code promo est saisi et VALIDÉ côté Cazalia (tunnel de réservation), puis
    // appliqué ici. On n'active pas `allow_promotion_codes` (saisie libre sur la
    // page Stripe) : c'est incompatible avec `discounts`, et cela contournerait la
    // limite « par personne » que Stripe ne sait pas gérer pour un code partagé.
    ...(promotionCodeId ? { discounts: [{ promotion_code: promotionCodeId }] } : {}),
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
