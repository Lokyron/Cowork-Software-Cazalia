// Abonnements mensuels récurrents (orchestration BDD + Stripe).
//
// Stripe reste la source de vérité de l'état de l'abonnement (statut, période,
// formule) ; cette couche met la base en phase à la souscription et à chaque
// événement de webhook. Le quota Open Space (Essentiel) est RÉINITIALISÉ à chaque
// renouvellement facturé (`invoice.paid`).

import { db } from '../db.js';
import { config } from '../config.js';
import { fail } from './errors.js';
import { getStripe } from './settings.js';
import {
  createCustomer, createSubscriptionCheckoutSession, createBillingPortalSession, retrieveSubscription,
} from './stripe.js';

export const SUB_TIERS = ['ESSENTIEL', 'CONFORT', 'PREMIUM'];

const getUser = db.prepare(`SELECT * FROM users WHERE id = ?`);
const setCustomerId = db.prepare(`UPDATE users SET stripe_customer_id = ? WHERE id = ?`);
const getUserByCustomer = db.prepare(`SELECT * FROM users WHERE stripe_customer_id = ?`);
const getUserBySubscription = db.prepare(`SELECT * FROM users WHERE stripe_subscription_id = ?`);

const applyStmt = db.prepare(
  `UPDATE users SET
      stripe_customer_id = @customer, stripe_subscription_id = @subscription,
      subscription_tier = @tier, subscription_status = @status,
      current_period_start = @start, current_period_end = @end
    WHERE id = @id`
);
const resetQuotaStmt = db.prepare(
  `UPDATE users SET open_space_quota_used = 0, current_period_start = @start, current_period_end = @end
    WHERE id = @id`
);
const clearSubStmt = db.prepare(
  `UPDATE users SET stripe_subscription_id = NULL, subscription_tier = 'NONE',
      subscription_status = 'canceled' WHERE id = @id`
);

// ── Utilitaires de mapping Stripe ─────────────────────────────────────────────
/** Formule correspondant à un Price ID d'abonnement, ou null. */
export function tierForPriceId(priceId) {
  if (!priceId) return null;
  const prices = getStripe().subscriptionPrices || {};
  for (const tier of SUB_TIERS) if (prices[tier] && prices[tier] === priceId) return tier;
  return null;
}

// Statut applicatif à partir du statut Stripe.
function mapStatus(stripeStatus) {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'active';
  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') return 'past_due';
  return 'canceled';
}

// ISO/UTC depuis un timestamp Stripe (secondes). Lit la période au niveau de
// l'abonnement, avec repli sur le premier item (API récentes).
function periodFromSubscription(sub) {
  const item = sub?.items?.data?.[0];
  const start = sub?.current_period_start ?? item?.current_period_start ?? null;
  const end = sub?.current_period_end ?? item?.current_period_end ?? null;
  return {
    start: start ? new Date(start * 1000).toISOString() : null,
    end: end ? new Date(end * 1000).toISOString() : null,
  };
}
function priceIdOf(sub) { return sub?.items?.data?.[0]?.price?.id || null; }
function tierOfSubscription(sub) {
  // Priorité aux métadonnées posées à la souscription, repli sur le mapping prix.
  const metaTier = sub?.metadata?.tier;
  if (SUB_TIERS.includes(metaTier)) return metaTier;
  return tierForPriceId(priceIdOf(sub));
}

// ── Souscription (parcours membre) ───────────────────────────────────────────
async function ensureCustomerId(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customer = await createCustomer({ email: user.email, name: user.display_name, userId: user.id });
  setCustomerId.run(customer.id, user.id);
  return customer.id;
}

/**
 * Démarre la souscription d'une formule : crée (ou réutilise) le client Stripe
 * puis une session Checkout `mode:subscription`. L'activation se fait au webhook.
 *
 * @param {number} userId Membre abonné.
 * @param {string} tier 'ESSENTIEL'|'CONFORT'|'PREMIUM'.
 * @param {string} baseUrl Origine publique.
 * @returns {Promise<{url:string}>}
 * @throws {Error} `TIER_INVALIDE`, `ABONNEMENT_INDISPONIBLE`, `DEJA_ABONNE`, `UTILISATEUR_INTROUVABLE`.
 */
export async function startSubscriptionCheckout(userId, tier, baseUrl) {
  if (!SUB_TIERS.includes(tier)) throw fail('TIER_INVALIDE');
  const cfg = getStripe();
  const priceId = cfg.subscriptionPrices?.[tier];
  if (!cfg.enabled || !priceId) throw fail('ABONNEMENT_INDISPONIBLE');
  const user = getUser.get(userId);
  if (!user) throw fail('UTILISATEUR_INTROUVABLE');
  // Déjà abonné (actif) : la gestion (upgrade/downgrade/résiliation) passe par le
  // Customer Portal, pas par un second Checkout.
  if (user.stripe_subscription_id && (user.subscription_status === 'active' || user.subscription_status === 'past_due')) {
    throw fail('DEJA_ABONNE');
  }
  const customerId = await ensureCustomerId(user);
  const session = await createSubscriptionCheckoutSession({ customerId, priceId, userId, tier, baseUrl });
  return { url: session.url };
}

/**
 * Ouvre le Customer Portal Stripe pour l'abonné (gestion CB/factures/résiliation).
 * @param {number} userId
 * @param {string} baseUrl
 * @returns {Promise<{url:string}>}
 * @throws {Error} `AUCUN_ABONNEMENT`, `ABONNEMENT_INDISPONIBLE`.
 */
export async function startBillingPortal(userId, baseUrl) {
  const user = getUser.get(userId);
  if (!user) throw fail('UTILISATEUR_INTROUVABLE');
  if (!getStripe().enabled) throw fail('ABONNEMENT_INDISPONIBLE');
  if (!user.stripe_customer_id) throw fail('AUCUN_ABONNEMENT');
  const session = await createBillingPortalSession({ customerId: user.stripe_customer_id, baseUrl });
  return { url: session.url };
}

/**
 * Résumé d'abonnement pour l'espace client (jauge de quota, statut, période).
 * @param {number} userId
 * @returns {{tier:string, status:string, current_period_end:string|null, quota_used:number, quota_total:number}}
 */
export function getSubscriptionSummary(userId) {
  const u = getUser.get(userId);
  if (!u) throw fail('UTILISATEUR_INTROUVABLE');
  return {
    tier: u.subscription_tier || 'NONE',
    status: u.subscription_status || 'none',
    current_period_end: u.current_period_end || null,
    quota_used: Number(u.open_space_quota_used) || 0,
    quota_total: config.pricing.ESSENTIEL_QUOTA_DAYS,
  };
}

// ── Écritures déclenchées par le webhook ─────────────────────────────────────
function resolveUserForSub(sub) {
  const metaUserId = Number(sub?.metadata?.user_id);
  if (metaUserId) return getUser.get(metaUserId) || null;
  if (sub?.customer) return getUserByCustomer.get(String(sub.customer)) || null;
  return null;
}

/**
 * Active (ou réactive) l'abonnement d'un membre à partir d'un abonnement Stripe.
 * Remise à zéro du quota : une nouvelle souscription repart de 12 jours.
 */
export function applySubscriptionActive(sub) {
  const user = resolveUserForSub(sub);
  if (!user) return { matched: false };
  const { start, end } = periodFromSubscription(sub);
  const tier = tierOfSubscription(sub) || 'NONE';
  const status = mapStatus(sub.status);
  const tx = db.transaction(() => {
    applyStmt.run({
      id: user.id, customer: String(sub.customer) || user.stripe_customer_id,
      subscription: sub.id, tier, status, start, end,
    });
    // Nouvelle période / nouvelle souscription : quota remis à zéro.
    db.prepare(`UPDATE users SET open_space_quota_used = 0 WHERE id = ?`).run(user.id);
  });
  tx();
  return { matched: true, userId: user.id, tier, status };
}

/** Met l'abonnement à jour (upgrade/downgrade, past_due) sans toucher au quota. */
export function applySubscriptionUpdate(sub) {
  const user = resolveUserForSub(sub) || getUserBySubscription.get(sub.id);
  if (!user) return { matched: false };
  const { start, end } = periodFromSubscription(sub);
  const tier = tierOfSubscription(sub) || user.subscription_tier || 'NONE';
  const status = mapStatus(sub.status);
  applyStmt.run({
    id: user.id, customer: String(sub.customer) || user.stripe_customer_id,
    subscription: sub.id, tier, status, start, end,
  });
  return { matched: true, userId: user.id, tier, status };
}

/** Renouvellement facturé : réinitialise le quota + met à jour la période. */
export function applyInvoicePaid(invoice) {
  const subId = typeof invoice?.subscription === 'string' ? invoice.subscription
    : invoice?.subscription?.id || invoice?.parent?.subscription_details?.subscription || null;
  let user = subId ? getUserBySubscription.get(subId) : null;
  if (!user && invoice?.customer) user = getUserByCustomer.get(String(invoice.customer));
  if (!user) return { matched: false };
  // Période depuis les lignes de facture (abonnement). Repli : conserve l'existant.
  const line = invoice?.lines?.data?.[0];
  const start = line?.period?.start ? new Date(line.period.start * 1000).toISOString() : user.current_period_start;
  const end = line?.period?.end ? new Date(line.period.end * 1000).toISOString() : user.current_period_end;
  resetQuotaStmt.run({ id: user.id, start, end });
  return { matched: true, userId: user.id };
}

/** Fin d'abonnement : repasse le membre en NONE. */
export function applySubscriptionDeleted(sub) {
  const user = resolveUserForSub(sub) || getUserBySubscription.get(sub.id);
  if (!user) return { matched: false };
  clearSubStmt.run({ id: user.id });
  return { matched: true, userId: user.id };
}

/**
 * Active l'abonnement à partir d'une session Checkout complétée (mode subscription).
 * Lit l'abonnement réel chez Stripe pour disposer du statut/période/prix exacts.
 */
export async function activateFromCheckoutSession(session) {
  const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  if (!subId) return { matched: false };
  const sub = await retrieveSubscription(subId);
  if (!sub) return { matched: false };
  // Propage le contexte de la session si l'abonnement n'a pas de métadonnées.
  if (!sub.metadata) sub.metadata = {};
  if (!sub.metadata.user_id && session.metadata?.user_id) sub.metadata.user_id = session.metadata.user_id;
  if (!sub.metadata.tier && session.metadata?.tier) sub.metadata.tier = session.metadata.tier;
  if (!sub.customer && session.customer) sub.customer = session.customer;
  return applySubscriptionActive(sub);
}
