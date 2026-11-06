// Moteur de prix « modèle éco. hybride » (refonte).
//
// Le prix d'une réservation ne dépend plus seulement de l'espace : il dépend de
// la CATÉGORIE de l'espace (Open Space / Salle de réunion) ET de l'ABONNEMENT de
// l'utilisateur. Trois modes de couverture :
//   • STRIPE_ONE_OFF         : payé à l'acte (CB).
//   • SUBSCRIPTION_QUOTA     : couvert par le quota mensuel Essentiel (décompte).
//   • SUBSCRIPTION_UNLIMITED : inclus illimité (Confort/Premium selon l'espace).
//
// Règles (cf. grille config.pricing) :
//   Open Space      : demi-journée / journée UNIQUEMENT (pas d'horaire).
//     - sans abo / Essentiel hors quota → ponctuel (12 € / 20 €)
//     - Essentiel avec quota            → 0 € (décompte 0,5 / 1 jour sur 12)
//     - Confort / Premium               → 0 € illimité
//   Salle de réunion : heure / demi-journée / journée.
//     - sans abo / Essentiel            → plein tarif (20 / 35 / 50 €)
//     - Confort                         → −50 %
//     - Premium                         → 0 € illimité

import { db } from '../db.js';
import { config } from '../config.js';
import { fail } from './errors.js';
import { billedHours } from './time.js';
import { slotMatchesForfait } from './booking.js';

export const TIERS = ['NONE', 'ESSENTIEL', 'CONFORT', 'PREMIUM'];
export const CATEGORIES = ['OPEN_SPACE', 'MEETING_ROOM', 'CONFIDENTIAL', 'PRIVATE_OFFICE'];

// Un abonnement « past_due » (paiement de renouvellement en échec mais pas encore
// résilié par Stripe) conserve ses avantages pendant la période de relance :
// Stripe finira par résilier (customer.subscription.deleted) si l'échec persiste.
function entitled(user) {
  const st = user?.subscription_status;
  return st === 'active' || st === 'past_due';
}
function tierOf(user) {
  return entitled(user) && TIERS.includes(user?.subscription_tier) ? user.subscription_tier : 'NONE';
}

/** Jours de quota consommés par un type de tarif Open Space. */
export function quotaDaysForTarif(tarifType) {
  if (tarifType === 'demi_journee') return 0.5;
  if (tarifType === 'journee') return 1;
  return 0;
}

/** Catégorie métier d'un espace (null si non catégorisé). */
export function spaceCategory(space) {
  return space?.category || null;
}

/** Un espace est-il réservable en ligne ? (confidentiel/bureau privé : non). */
export function isOnlineBookable(space) {
  const cat = spaceCategory(space);
  return cat === 'OPEN_SPACE' || cat === 'MEETING_ROOM';
}

// Somme des jours de quota déjà ENGAGÉS par les verrous de panier actifs de
// l'utilisateur (non expirés) : évite de « sur-réserver » le quota entre
// l'ajout au panier et le paiement.
const committedQuotaStmt = db.prepare(
  `SELECT COALESCE(SUM(quota_days), 0) AS d FROM reservation_holds
    WHERE user_id = ? AND expires_at > ? AND payment_method = 'SUBSCRIPTION_QUOTA'`
);
export function committedQuotaDays(userId) {
  if (!userId) return 0;
  return committedQuotaStmt.get(userId, new Date().toISOString()).d || 0;
}

// Charge le profil de tarification d'un utilisateur (lecture autoritaire du
// quota/abonnement en base — ne jamais se fier au snapshot de session pour le
// décompte). Renvoie un objet minimal pour `effectivePricing`.
const pricingUserStmt = db.prepare(
  `SELECT id, role, subscription_tier, subscription_status, open_space_quota_used
     FROM users WHERE id = ?`
);
export function loadPricingUser(userId) {
  return pricingUserStmt.get(userId) || null;
}

/** Quota Open Space restant pour un utilisateur Essentiel (jours). */
export function remainingQuota(user) {
  const total = config.pricing.ESSENTIEL_QUOTA_DAYS;
  const used = Number(user?.open_space_quota_used) || 0;
  return Math.max(0, total - used - committedQuotaDays(user?.id));
}

/**
 * Calcule le prix effectif d'un créneau selon l'espace et l'abonnement.
 *
 * @param {object} p
 * @param {object} p.user Utilisateur (subscription_tier/status, open_space_quota_used, id).
 * @param {object} p.space Ligne d'espace (doit porter `category`, `exclusive`, `capacity`).
 * @param {string} p.startIso Début (ISO/UTC).
 * @param {string} p.endIso Fin (ISO/UTC).
 * @param {number} [p.seats] Places demandées (inventaire).
 * @param {'heure'|'demi_journee'|'journee'} p.tarifType Type de tarif.
 * @returns {{cents:number, method:string, quotaDays:number, baseCents:number, discountLabel:string|null}}
 * @throws {Error} `ESPACE_NON_RESERVABLE`, `TARIF_INDISPONIBLE`, `CRENEAU_FORFAIT_INVALIDE`.
 */
export function effectivePricing({ user, space, startIso, endIso, seats = 1, tarifType = 'heure' }) {
  const cat = spaceCategory(space);
  if (!isOnlineBookable(space)) throw fail('ESPACE_NON_RESERVABLE');

  const units = space.exclusive ? 1 : Math.max(1, Number(seats) || 1);
  const tier = tierOf(user);

  // Validation du créneau forfaitaire pour demi-journée / journée (cohérent avec
  // config.forfaitSlots, exactement comme l'ancien priceCents).
  if (tarifType === 'demi_journee' || tarifType === 'journee') {
    if (!slotMatchesForfait(startIso, endIso, tarifType)) throw fail('CRENEAU_FORFAIT_INVALIDE');
  }

  if (cat === 'OPEN_SPACE') {
    if (tarifType !== 'demi_journee' && tarifType !== 'journee') throw fail('TARIF_INDISPONIBLE');
    const base = config.pricing.OPEN_SPACE[tarifType];
    if (base == null) throw fail('TARIF_INDISPONIBLE');
    const baseCents = base * units;
    if (tier === 'CONFORT' || tier === 'PREMIUM') {
      return { cents: 0, method: 'SUBSCRIPTION_UNLIMITED', quotaDays: 0, baseCents, discountLabel: 'Inclus' };
    }
    if (tier === 'ESSENTIEL') {
      const need = quotaDaysForTarif(tarifType);
      if (remainingQuota(user) >= need) {
        return { cents: 0, method: 'SUBSCRIPTION_QUOTA', quotaDays: need, baseCents, discountLabel: 'Inclus (quota)' };
      }
    }
    return { cents: baseCents, method: 'STRIPE_ONE_OFF', quotaDays: 0, baseCents, discountLabel: null };
  }

  // MEETING_ROOM
  let base;
  if (tarifType === 'heure') base = config.pricing.MEETING_ROOM.heure * billedHours(startIso, endIso);
  else base = config.pricing.MEETING_ROOM[tarifType];
  if (base == null) throw fail('TARIF_INDISPONIBLE');
  const baseCents = base * units;

  if (tier === 'PREMIUM') {
    return { cents: 0, method: 'SUBSCRIPTION_UNLIMITED', quotaDays: 0, baseCents, discountLabel: 'Inclus' };
  }
  if (tier === 'CONFORT') {
    const cents = Math.round(baseCents * config.pricing.CONFORT_MEETING_DISCOUNT);
    return { cents, method: 'STRIPE_ONE_OFF', quotaDays: 0, baseCents, discountLabel: '−50 % Confort' };
  }
  return { cents: baseCents, method: 'STRIPE_ONE_OFF', quotaDays: 0, baseCents, discountLabel: null };
}
