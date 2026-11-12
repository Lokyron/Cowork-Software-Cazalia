// Intégration Stripe - paiement des réservations et abonnements par Checkout hébergé.
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
// Les ids mémorisés sont vérifiés UNE FOIS par démarrage : un produit supprimé
// ou archivé dans le tableau de bord Stripe ne se voit pas autrement, et c'est
// la création de la session Checkout qui échouerait, avec un code Stripe brut.
let formulesVerifiees = false;

export async function ensureFormuleProducts(stripe) {
  const cached = getSetting('stripe_formules', null) || {};
  if (formulesVerifiees && cached.heure && cached.demi_journee && cached.journee) return cached;

  const ids = {};
  for (const [key, name] of Object.entries(FORMULE_NAMES)) {
    const id = cached[key];
    if (id) {
      try {
        const existing = await stripe.products.retrieve(id);
        // Un produit archivé n'accepte plus de nouveau prix : il faut le recréer.
        if (existing && !existing.deleted && existing.active !== false) { ids[key] = id; continue; }
      } catch {
        /* supprimé, ou appartenant à un autre compte : on le recrée ci-dessous. */
      }
    }
    const product = await stripe.products.create({
      name: `Cazalia - ${name}`,
      metadata: { formule: key },
    });
    ids[key] = product.id;
  }

  if (ids.heure !== cached.heure || ids.demi_journee !== cached.demi_journee || ids.journee !== cached.journee) {
    setSetting('stripe_formules', ids);
  }
  formulesVerifiees = true;
  return ids;
}

/**
 * Crée une session Checkout pour PAYER une réservation (ou un panier de créneaux).
 * Une ligne par créneau ; le crédit du portefeuille n'existe plus - on paie le
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
  // Les lignes couvertes par l'abonnement (0 €) ne sont PAS facturées : on les
  // exclut de la session Stripe (Checkout refuse un montant nul). Elles restent
  // dans le payload de la commande et deviennent des réservations au webhook.
  const line_items = items.filter((it) => it.price_cents > 0).map((it) => {
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
    // Pas de `payment_method_collection` ici : Stripe le refuse hors abonnement
    // (« You can only set `payment_method_collection` if there are recurring
    // prices »), ce qui faisait échouer tout le tunnel de réservation. Le
    // comportement voulu est de toute façon celui par défaut en mode 'payment' :
    // un total de 0 € (code promo à 100 %) se règle sans saisie de carte, avec
    // payment_status = 'no_payment_required', que le webhook traite comme une
    // réservation gratuite.
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

// ── Abonnements mensuels récurrents (Stripe Subscriptions) ───────────────────

/**
 * Crée un client Stripe (réutilisé pour les futures factures d'abonnement).
 * @param {{email:string, name?:string, userId:number}} p
 * @returns {Promise<import('stripe').Stripe.Customer>}
 * @throws {Error} `STRIPE_NON_CONFIGURE`.
 */
export async function createCustomer({ email, name, userId }) {
  const stripe = client();
  if (!stripe) { const e = new Error('STRIPE_NON_CONFIGURE'); e.code = 'STRIPE_NON_CONFIGURE'; throw e; }
  return stripe.customers.create({ email, name: name || undefined, metadata: { user_id: String(userId) } });
}

/**
 * Crée une session Checkout d'ABONNEMENT (mode `subscription`). Le paiement
 * récurrent mensuel est ensuite prélevé automatiquement par Stripe ; chaque
 * renouvellement émet `invoice.paid` (→ réinitialisation du quota).
 *
 * @param {object} p
 * @param {string} p.customerId Client Stripe (créé/réutilisé en amont).
 * @param {string} p.priceId Price récurrent Stripe de la formule.
 * @param {number} p.userId Membre abonné.
 * @param {string} p.tier 'ESSENTIEL'|'CONFORT'|'PREMIUM'.
 * @param {string} p.baseUrl Origine publique (URL de retour).
 * @returns {Promise<import('stripe').Stripe.Checkout.Session>}
 * @throws {Error} `STRIPE_NON_CONFIGURE`.
 */
export async function createSubscriptionCheckoutSession({ customerId, priceId, userId, tier, baseUrl }) {
  const stripe = client();
  if (!stripe) { const e = new Error('STRIPE_NON_CONFIGURE'); e.code = 'STRIPE_NON_CONFIGURE'; throw e; }
  const base = String(baseUrl || '').replace(/\/$/, '');
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: String(userId),
    metadata: { kind: 'subscription', user_id: String(userId), tier },
    // Reporte les métadonnées sur l'abonnement lui-même : utile au webhook
    // (customer.subscription.updated/deleted ne portent pas le contexte Checkout).
    subscription_data: { metadata: { user_id: String(userId), tier } },
    line_items: [{ price: priceId, quantity: 1 }],
    // Champ « Ajouter un code promotionnel » sur la page Stripe. Contrairement au
    // tunnel de réservation, le code n'est pas pré-validé par Cazalia : la limite
    // « par personne » (métadonnée max_per_user) ne s'applique donc PAS ici, Stripe
    // ne sachant pas la gérer. Réserver les codes d'abonnement à des Promotion
    // Codes dédiés, restreints au produit de la formule.
    allow_promotion_codes: true,
    success_url: `${base}/mon-espace?abonnement=success`,
    cancel_url: `${base}/tarifs?abonnement=cancel`,
  });
}

/**
 * Programme (ou annule) la résiliation d'un abonnement en FIN DE PÉRIODE payée.
 * Aucun remboursement au prorata : l'accès court jusqu'au terme déjà réglé.
 *
 * @param {string} subscriptionId Abonnement Stripe.
 * @param {boolean} cancel true = résilier au terme, false = reprendre.
 * @returns {Promise<import('stripe').Stripe.Subscription>}
 * @throws {Error} `STRIPE_NON_CONFIGURE`.
 */
export async function setSubscriptionCancelAtPeriodEnd(subscriptionId, cancel) {
  const stripe = client();
  if (!stripe) { const e = new Error('STRIPE_NON_CONFIGURE'); e.code = 'STRIPE_NON_CONFIGURE'; throw e; }
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: !!cancel });
}

/**
 * Crée une session de Customer Portal (gestion CB, factures, résiliation).
 * @param {{customerId:string, baseUrl:string}} p
 * @returns {Promise<import('stripe').Stripe.BillingPortal.Session>}
 * @throws {Error} `STRIPE_NON_CONFIGURE`.
 */
export async function createBillingPortalSession({ customerId, baseUrl }) {
  const stripe = client();
  if (!stripe) { const e = new Error('STRIPE_NON_CONFIGURE'); e.code = 'STRIPE_NON_CONFIGURE'; throw e; }
  const base = String(baseUrl || '').replace(/\/$/, '');
  return stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${base}/mon-espace` });
}

/**
 * Récupère un abonnement Stripe (lecture de l'état réel : statut, période, prix).
 * @param {string} subscriptionId
 * @returns {Promise<import('stripe').Stripe.Subscription|null>}
 */
export async function retrieveSubscription(subscriptionId) {
  const stripe = client();
  if (!stripe || !subscriptionId) return null;
  try { return await stripe.subscriptions.retrieve(subscriptionId); } catch { return null; }
}

/**
 * Récupère l'URL du reçu Stripe (hosted receipt) associé à un PaymentIntent.
 * Best-effort : renvoie `null` si Stripe n'est pas configuré, si le PI est absent
 * ou si l'appel échoue - la capture du reçu ne doit JAMAIS faire échouer le flux
 * de confirmation de réservation.
 *
 * @param {string|null} paymentIntentId Identifiant du PaymentIntent.
 * @returns {Promise<string|null>} URL du reçu, ou `null`.
 */
export async function getReceiptUrl(paymentIntentId) {
  if (!paymentIntentId) return null;
  const stripe = client();
  if (!stripe) return null;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const charge = pi?.latest_charge;
    return (charge && typeof charge === 'object' ? charge.receipt_url : null) || null;
  } catch {
    return null;
  }
}

/**
 * Clôt une session Checkout encore ouverte (tentative de paiement caduque).
 * Sans effet si la session est déjà expirée ou payée - l'appelant ignore l'échec.
 *
 * @param {string} sessionId Session Checkout Stripe.
 * @returns {Promise<import('stripe').Stripe.Checkout.Session|null>}
 */
export async function expireCheckoutSession(sessionId) {
  const stripe = client();
  if (!stripe || !sessionId) return null;
  return stripe.checkout.sessions.expire(sessionId);
}

/**
 * Récupère une session Checkout (pour la réconciliation d'une commande restée
 * `pending` : vérifier a posteriori si le paiement a finalement abouti).
 *
 * @param {string} sessionId Session Checkout Stripe.
 * @returns {Promise<import('stripe').Stripe.Checkout.Session|null>}
 */
export async function retrieveCheckoutSession(sessionId) {
  const stripe = client();
  if (!stripe) return null;
  try {
    return await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    return null;
  }
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
