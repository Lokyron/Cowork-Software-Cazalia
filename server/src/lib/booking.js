import { db } from '../db.js';
import { config } from '../config.js';
import { fail } from './errors.js';
import {
  billedHours, toUtcIso, isBeforeRefundWindow, parisWeekday, parisMinutes, parisDateKey, parisLocalToUtcIso,
} from './time.js';

/**
 * Indique si un créneau tient entièrement dans les horaires d'ouverture.
 * Le calcul se fait en heure de Paris : les créneaux sont stockés en UTC, mais
 * les horaires d'ouverture sont exprimés en heure locale (et suivent donc
 * l'heure d'été).
 *
 * @param {string} startIso Début du créneau (ISO/UTC).
 * @param {string} endIso Fin du créneau (ISO/UTC).
 * @returns {boolean} `true` si le créneau est intégralement dans une plage d'ouverture.
 */
export function withinOpeningHours(startIso, endIso) {
  const ranges = config.openingHours?.[parisWeekday(startIso)] || [];
  const s = parisMinutes(startIso);
  let e = parisMinutes(endIso);
  if (e === 0) e = 24 * 60; // fin à minuit
  return ranges.some(([a, b]) => s >= a && e <= b);
}

// ── Disponibilité ────────────────────────────────────────────────────────────
// Deux modèles :
//   • Exclusif (salle de réunion) : la réservation bloque toute la salle → libre
//     (1) tant qu'aucune réservation ne chevauche, sinon 0. `capacity` = occupants.
//   • Inventaire (open-space, salle focus) : places restantes = capacity − Σ places
//     déjà réservées sur le créneau. Chaque réservation consomme `seats` places.
// Chevauchement : existant.start_at < end AND existant.end_at > start.
const spaceStmt = db.prepare(`SELECT * FROM spaces WHERE id = ? AND active = 1`);
const overlapSumStmt = db.prepare(
  `SELECT COALESCE(SUM(seats), 0) AS taken FROM reservations
    WHERE space_id = ? AND status = 'confirmed'
      AND start_at < ? AND end_at > ?`
);
const overlapSumExclStmt = db.prepare(
  `SELECT COALESCE(SUM(seats), 0) AS taken FROM reservations
    WHERE space_id = ? AND status = 'confirmed' AND id <> ?
      AND start_at < ? AND end_at > ?`
);
// Places « bloquées » par des paniers en cours (verrous non expirés) sur le créneau.
// `excludeHoldId` permet d'ignorer un hold précis (le sien, au moment du checkout).
const holdSumStmt = db.prepare(
  `SELECT COALESCE(SUM(seats), 0) AS held FROM reservation_holds
    WHERE space_id = ? AND expires_at > ? AND id <> ?
      AND start_at < ? AND end_at > ?`
);
function heldSeats(spaceId, startIso, endIso, excludeHoldId = 0) {
  return holdSumStmt.get(spaceId, new Date().toISOString(), excludeHoldId || 0, endIso, startIso).held;
}

// Détail de disponibilité d'un espace sur un créneau (API + UI).
// opts.countHolds (défaut true) : décompte aussi les verrous panier actifs.
// opts.excludeHoldId : verrou à ignorer (le sien pendant le checkout).
/**
 * Calcule la disponibilité d'un espace sur un créneau.
 *
 * @param {number} spaceId Espace concerné (doit être actif).
 * @param {string} startIso Début (ISO/UTC).
 * @param {string} endIso Fin (ISO/UTC).
 * @param {{countHolds?: boolean, excludeHoldId?: number}} [opts]
 *        `countHolds` (défaut `true`) décompte les verrous panier actifs ;
 *        `excludeHoldId` ignore un verrou précis (le sien, au moment du paiement).
 * @returns {{exclusive: boolean, privatizable: boolean, capacity: number, seats_left: number} | null}
 *          `null` si l'espace est inconnu ou inactif.
 */
export function spaceAvailability(spaceId, startIso, endIso, opts = {}) {
  const space = spaceStmt.get(spaceId);
  if (!space) return null;
  const countHolds = opts.countHolds !== false;
  const { taken } = overlapSumStmt.get(spaceId, endIso, startIso);
  const held = countHolds ? heldSeats(spaceId, startIso, endIso, opts.excludeHoldId) : 0;
  const busy = taken + held;
  return {
    exclusive: !!space.exclusive,
    privatizable: space.exclusive ? false : !!space.privatizable,
    capacity: space.capacity,
    seats_left: seatsLeftFor(space, busy),
  };
}

// Règle de comptage commune (créneau unique et vue mensuelle) : exclusif → 1
// libre / 0 pris dès qu'une place l'est ; inventaire → capacité − places occupées.
function seatsLeftFor(space, busy) {
  if (space.exclusive) return busy > 0 ? 0 : 1;
  return Math.max(0, space.capacity - busy);
}

// ── Disponibilité d'un mois (calendrier) ─────────────────────────────────────
// Deux requêtes pour TOUT le mois (réservations confirmées + verrous panier non
// expirés qui chevauchent le mois), puis calcul des statuts en mémoire. Le comptage
// est celui de `spaceAvailability` pour les formules « demi-journée » et « journée »
// (chevauchement strict, somme des places, `seatsLeftFor`) ; la formule « heure » s'en
// écarte VOLONTAIREMENT (voir `evaluate`). Aucune identité n'est lue : seuls start_at,
// end_at et seats.
//
// Verrous de panier : le calendrier les compte (`monthHoldStmt`), comme
// `spaceAvailability` / `addToCart`. `moveReservation`, lui, NE les compte PAS : il ne
// somme que les réservations confirmées (`overlapSumExclStmt`). Le calendrier de
// déplacement est donc PLUS STRICT que le déplacement lui-même : un jour tenu par un
// panier en cours y apparaît occupé alors que le déplacement l'accepterait. C'est le
// bon sens de l'écart (on n'annonce jamais « libre » là où l'action échouerait), mais
// ce n'est pas une équivalence.
const monthResaStmt = db.prepare(
  `SELECT start_at, end_at, seats FROM reservations
    WHERE space_id = ? AND status = 'confirmed' AND id <> ? AND start_at < ? AND end_at > ?`
);
const monthHoldStmt = db.prepare(
  `SELECT start_at, end_at, seats FROM reservation_holds
    WHERE space_id = ? AND expires_at > ? AND start_at < ? AND end_at > ?`
);

// Fenêtre de mois consultables, relative au mois courant (Paris) : le mois
// précédent (le calendrier peut reculer d'un cran, tout y est « passé ») jusqu'à
// +36 mois, soit l'horizon métier le plus lointain connu (3 ans, `office_start`).
// Au-delà, c'est du balayage sans usage commercial.
export const MONTH_MIN_OFFSET = -1;
export const MONTH_MAX_OFFSET = 36;
// Seuil du statut « partial » (« quelques places ») du calendrier, pour un espace en
// INVENTAIRE : part de la capacité occupée à partir de laquelle un jour cesse d'être
// « open ». 0.5 = la moitié. Valeur voulue par le client (open space de 7 postes :
// « quelques places » dès 4 postes réservés). C'est UN réglage d'affichage : il ne change ni
// ce qui est réservable ni ce qui est facturé (le refus `COMPLET` reste décidé ailleurs).
export const PARTIAL_OCCUPANCY_RATIO = 0.5;

/**
 * Nombre de places occupées à partir duquel un espace en inventaire passe de « open » à
 * « partial ». Capacité impaire : arrondi AU-DESSUS (7 places → 4), c'est le sens du
 * client (« la moitié occupée ») ; 3 occupées sur 7, c'est encore strictement moins que
 * la moitié. La capacité est supposée valide : `spaces.capacity` est `INTEGER NOT NULL
 * CHECK (capacity >= 1)` (schema.sql), donc la base interdit 0, un négatif et `null`. Le
 * `Math.max(1, …)` n'est qu'un plancher (si le ratio devenait très petit, le seuil ne
 * tomberait pas à 0, ce qui rendrait tout jour « partial ») : il ne protège PAS d'une
 * capacité `undefined` ou `NaN`, qui donnerait `NaN` (et donc jamais « partial »).
 * Non applicable aux espaces exclusifs (binaires : libre ou réservé).
 * @param {number} capacity Capacité de l'espace (entier >= 1).
 * @returns {number}
 */
export function partialThreshold(capacity) {
  return Math.max(1, Math.ceil(capacity * PARTIAL_OCCUPANCY_RATIO));
}

// Les demi-journées se distinguent par l'heure de début : avant midi = matin.
const NOON_MINUTES = 12 * 60;

/**
 * Analyse un mois `YYYY-MM`.
 * @param {unknown} raw Valeur brute.
 * @returns {{year: number, month: number}}
 * @throws {Error} `MOIS_INVALIDE` si le format n'est pas `YYYY-MM`.
 */
export function parseMonth(raw) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(typeof raw === 'string' ? raw : '');
  if (!m) throw fail('MOIS_INVALIDE');
  return { year: Number(m[1]), month: Number(m[2]) };
}

// Fenêtres [début, fin] (minutes) à tester pour un jour de semaine, selon la formule.
// Formule « heure » : UNE fenêtre par plage d'ouverture, jamais l'enveloppe min..max.
// Avec une coupure déjeuner (`[[510,780],[840,1170]]`), l'enveloppe engloberait la
// coupure, où l'occupation est toujours nulle : une journée pleine matin ET après-midi
// afficherait « libre ». Chaque plage est évaluée seule, puis `monthAvailability`
// les agrège (« full » seulement si TOUTES sont pleines).
// Avec UNE seule plage, la fenêtre est celle de l'ancienne enveloppe : c'est vrai de
// CETTE fonction uniquement, pas du `seats_left` qui en résulte (voir `evaluate`).
export function windowsFor(weekday, tarifType, slot) {
  const hours = config.openingHours?.[weekday] || [];
  if (!hours.length) return [];
  if (tarifType === 'heure') return hours.map(([a, b]) => [a, b]);
  const forfaits = config.forfaitSlots?.[weekday] || {};
  if (tarifType === 'journee' || slot === 'journee') return forfaits.journee || [];
  const halves = forfaits.demi_journee || [];
  if (slot === 'matin') return halves.filter(([a]) => a < NOON_MINUTES);
  if (slot === 'aprem') return halves.filter(([a]) => a >= NOON_MINUTES);
  return halves;
}

/**
 * Statut de chaque jour d'un mois pour un espace, en une seule passe SQL.
 *
 * @param {number} spaceId Espace (doit être actif).
 * @param {string} monthRaw Mois `YYYY-MM`.
 * @param {{seats?: number, tarifType?: 'heure'|'demi_journee'|'journee', slot?: 'matin'|'aprem'|'journee'|null, now?: Date, excludeReservationId?: number}} [opts]
 *        `now` est injectable pour les tests. `excludeReservationId` retire une
 *        réservation du décompte (écran de déplacement : elle ne doit pas se
 *        compter elle-même, comme `overlapSumExclStmt` dans `moveReservation`, mais
 *        les verrous de panier restent comptés : voir le commentaire au-dessus de
 *        `monthResaStmt`).
 * @returns {{space_id: number, month: string, tarif_type: string, seats: number, timezone: string,
 *            capacity: number, exclusive: boolean, days: {date: string, status: string, seats_left: number|null}[]} | null}
 *          `seats_left` est `null` pour un jour fermé ou passé, ET quand le jour couvre
 *          plusieurs fenêtres qui n'ont pas le même nombre de places restantes (un seul
 *          chiffre mentirait sur au moins l'une d'elles ; `status` dit déjà « partial »).
 *          `null` si l'espace est inconnu ou inactif.
 * @throws {Error} `MOIS_INVALIDE` ou `MOIS_HORS_FENETRE`.
 */
export function monthAvailability(spaceId, monthRaw, opts = {}) {
  const { year, month } = parseMonth(monthRaw);
  const now = opts.now || new Date();
  const tarifType = opts.tarifType || 'heure';
  const slot = opts.slot || null;
  const [cy, cm] = parisDateKey(now).split('-').map(Number);
  const offset = (year * 12 + month) - (cy * 12 + cm);
  if (offset < MONTH_MIN_OFFSET || offset > MONTH_MAX_OFFSET) throw fail('MOIS_HORS_FENETRE');

  const space = spaceStmt.get(spaceId);
  if (!space) return null;
  const seats = resolveSeats(space, opts.seats);

  const monthStart = parisLocalToUtcIso(year, month, 1, 0);
  const monthEnd = parisLocalToUtcIso(year, month + 1, 1, 0);
  const items = [
    ...monthResaStmt.all(spaceId, Number(opts.excludeReservationId) || 0, monthEnd, monthStart),
    ...monthHoldStmt.all(spaceId, now.toISOString(), monthEnd, monthStart),
  ].map((r) => ({ s: Date.parse(r.start_at), e: Date.parse(r.end_at), seats: r.seats }));

  const occupied = (from, to) => items.reduce((n, i) => (i.s < to && i.e > from ? n + i.seats : n), 0);
  // Évalue UNE fenêtre.
  //  • Forfaits (demi-journée, journée) : somme des places des réservations qui la
  //    chevauchent, exactement la règle de `spaceAvailability` sur ce créneau.
  //  • Formule « heure » : DIVERGENCE VOULUE avec `spaceAvailability`, qui SOMMERAIT
  //    sur toute la plage. Ici on retient le MEILLEUR moment (l'instant le moins
  //    occupé), car on ne sait pas encore quelles heures le visiteur voudra : deux
  //    demi-journées pleines à 60 % chacune afficheraient sinon une journée pleine
  //    alors qu'il reste des heures libres. Exemple : 3 places prises pendant deux
  //    heures sur un open space de 10 donnent `seats_left: 10` ici (à l'instant le
  //    plus creux) mais 7 chez `spaceAvailability` sur la plage entière. « touched »
  //    signale qu'une réservation touche la fenêtre (exclusif : jour « partial »).
  //    Ce n'est donc PAS « identique à avant » : seul `windowsFor` l'est avec une
  //    plage unique. La divergence est figée par les tests.
  //  « peak » = places occupées au plus fort de la fenêtre : c'est lui que compare le
  //  seuil `partialThreshold` (la somme des chevauchements pour un forfait, le pic
  //  instantané à l'heure). `touched` ne sert plus qu'aux espaces exclusifs.
  const evaluate = (from, to) => {
    if (tarifType !== 'heure') {
      const busy = occupied(from, to);
      return { left: seatsLeftFor(space, busy), touched: busy > 0, peak: busy };
    }
    const points = [from, ...items.flatMap((i) => [i.s, i.e])].filter((t) => t >= from && t < to);
    const busyAt = points.map((t) => occupied(t, t + 1));
    return { left: seatsLeftFor(space, Math.min(...busyAt)), touched: occupied(from, to) > 0, peak: Math.max(...busyAt) };
  };
  // « partial » : exclusif = binaire (la moindre réservation touche la fenêtre) ;
  // inventaire = au moins `partialThreshold(capacity)` places occupées.
  const threshold = partialThreshold(space.capacity);
  const isPartial = (r) => (space.exclusive ? r.touched : r.peak >= threshold);

  const todayKey = parisDateKey(now);
  const mm = String(month).padStart(2, '0');
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    const date = `${year}-${mm}-${String(d).padStart(2, '0')}`;
    if (date < todayKey) { days.push({ date, status: 'past', seats_left: null }); continue; }
    const weekday = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    const results = windowsFor(weekday, tarifType, slot).map(([a, b]) =>
      evaluate(Date.parse(parisLocalToUtcIso(year, month, d, a)), Date.parse(parisLocalToUtcIso(year, month, d, b))));
    if (!results.length) { days.push({ date, status: 'closed', seats_left: null }); continue; }
    // Un seul chiffre n'est honnête que si toutes les fenêtres du jour sont d'accord.
    // `status` suit la convention « meilleure fenêtre » (assumée) ; afficher à côté
    // « 10 places » sur un jour dont une demi-journée est pleine serait faux : dès que
    // les fenêtres divergent, `seats_left` vaut `null` (le front écrit « quelques places »).
    let left = results.every((r) => r.left === results[0].left) ? results[0].left : null;
    const statuses = results.map((r) => (r.left < seats ? 'full' : isPartial(r) ? 'partial' : 'open'));
    const status = statuses.every((x) => x === 'open') ? 'open' : statuses.every((x) => x === 'full') ? 'full' : 'partial';
    // Convention « le calendrier qualifie la journée, le badge chiffre le créneau » :
    // `status` suit le PIC d'occupation (`peak`), alors qu'à l'heure `left` suit le MEILLEUR
    // instant (souvent l'ouverture, où personne n'est là). Sans garde, un open space de 7
    // avec 4 postes pris de 09:00 à 10:00 afficherait « quelques places » ET « 7 places
    // restantes ». On ne garde donc le chiffre sur un jour « partial » que s'il est cohérent
    // avec le seuil (`left <= capacité - seuil`), sinon `null` (le front écrit « quelques
    // places »). On ne remplace pas `peak` par `capacité - left` : à l'heure, `partial`
    // deviendrait inerte et un jour saturé de 09:00 à 18:00 s'afficherait « libre ».
    // Forfaits : `peak === capacité - left`, la garde ne change rien. Exclusif : binaire,
    // le chiffre (0/1) n'est pas une jauge, on n'y touche pas.
    if (status === 'partial' && left !== null && !space.exclusive && left > space.capacity - threshold) left = null;
    days.push({ date, status, seats_left: left });
  }
  return {
    space_id: spaceId, month: `${year}-${mm}`, tarif_type: tarifType, seats, timezone: 'Europe/Paris',
    capacity: space.capacity, exclusive: !!space.exclusive, days,
  };
}

// Places disponibles (inventaire) ou 1/0 (exclusif).
export function availableSeats(spaceId, startIso, endIso, opts = {}) {
  const a = spaceAvailability(spaceId, startIso, endIso, opts);
  return a ? a.seats_left : 0;
}

// Normalise le nb de places demandé : exclusif → 1 (l'unité = la salle) ;
// inventaire → borné entre 1 et la capacité.
export function getActiveSpace(spaceId) { return spaceStmt.get(spaceId); }

export function resolveSeats(space, seatsRaw) {
  if (space.exclusive) return 1;
  const n = Math.floor(Number(seatsRaw) || 1);
  return Math.min(space.capacity, Math.max(1, n));
}

// ── Tarification en EUROS (centimes) ─────────────────────────────────────────
// Trois types de tarif : 'heure' (tarif horaire × heures facturées × places),
// 'demi_journee' et 'journee' (forfaits à prix fixe). Les forfaits exigent que le
// créneau corresponde EXACTEMENT à une fenêtre forfaitaire du jour (config.forfaitSlots).

/**
 * Vrai si le créneau correspond exactement à l'une des fenêtres forfaitaires du
 * jour pour le type demandé. Calcul en heure de Paris (créneaux stockés en UTC).
 * @param {string} startIso Début (ISO/UTC).
 * @param {string} endIso Fin (ISO/UTC).
 * @param {'demi_journee'|'journee'} tarifType Type de forfait.
 * @returns {boolean}
 */
export function slotMatchesForfait(startIso, endIso, tarifType) {
  const windows = config.forfaitSlots?.[parisWeekday(startIso)]?.[tarifType] || [];
  const s = parisMinutes(startIso);
  let e = parisMinutes(endIso);
  if (e === 0) e = 24 * 60;
  return windows.some(([a, b]) => a === s && b === e);
}

/**
 * Calcule le prix d'un créneau EN CENTIMES d'euro, selon le type de tarif.
 * Inventaire : prix × places ; exclusif : prix forfaitaire salle (places = 1).
 *
 * @param {object} space Ligne d'espace (doit porter les colonnes price_*_cents).
 * @param {string} startIso Début (ISO/UTC).
 * @param {string} endIso Fin (ISO/UTC).
 * @param {number} seats Places (ignoré si exclusif).
 * @param {'heure'|'demi_journee'|'journee'} [tarifType] Type de tarif (défaut 'heure').
 * @returns {number} Prix en centimes.
 * @throws {Error} `TARIF_INDISPONIBLE`, `CRENEAU_FORFAIT_INVALIDE`.
 */
export function priceCents(space, startIso, endIso, seats, tarifType = 'heure') {
  const units = space.exclusive ? 1 : Math.max(1, seats);
  if (tarifType === 'demi_journee' || tarifType === 'journee') {
    const unit = tarifType === 'demi_journee' ? space.price_half_day_cents : space.price_day_cents;
    if (unit == null) throw fail('TARIF_INDISPONIBLE');
    if (!slotMatchesForfait(startIso, endIso, tarifType)) throw fail('CRENEAU_FORFAIT_INVALIDE');
    return unit * units;
  }
  const rate = space.price_per_hour_cents ?? 0;
  return rate * billedHours(startIso, endIso) * units;
}

/**
 * Prix d'un créneau en centimes (résout l'espace par son id).
 * @param {number} spaceId Espace concerné.
 * @param {string} startIso Début (ISO/UTC).
 * @param {string} endIso Fin (ISO/UTC).
 * @param {number|string} [seatsRaw] Places demandées (ignoré si exclusif).
 * @param {'heure'|'demi_journee'|'journee'} [tarifType] Type de tarif.
 * @returns {number} Prix en centimes.
 * @throws {Error} `ESPACE_INTROUVABLE`, `TARIF_INDISPONIBLE`, `CRENEAU_FORFAIT_INVALIDE`.
 */
export function quoteCost(spaceId, startIso, endIso, seatsRaw = 1, tarifType = 'heure') {
  const space = spaceStmt.get(spaceId);
  if (!space) throw fail('ESPACE_INTROUVABLE');
  return priceCents(space, startIso, endIso, resolveSeats(space, seatsRaw), tarifType);
}

// Création d'une réservation (euros). `credits_cost` reste à 0 (colonne héritée).
const insertResStmt = db.prepare(
  `INSERT INTO reservations
     (user_id, space_id, start_at, end_at, credits_cost, seats,
      price_cents, paid_cents, tarif_type, payment_status, payment_method, quota_days,
      stripe_session_id, payment_intent)
   VALUES (@user_id, @space_id, @start_at, @end_at, 0, @seats,
           @price_cents, @paid_cents, @tarif_type, @payment_status, @payment_method, @quota_days,
           @stripe_session_id, @payment_intent)`
);

/**
 * Insère une réservation confirmée. Utilisé par le back-office (résa gratuite,
 * paiement hors ligne) ET par la confirmation de paiement Stripe (webhook).
 * N'effectue AUCun mouvement financier : le paiement est géré en amont (Stripe)
 * ou hors ligne (admin).
 *
 * @param {object} p
 * @returns {number|bigint} id de la réservation créée.
 */
function insertReservation(p) {
  const info = insertResStmt.run({
    user_id: p.userId,
    space_id: p.spaceId,
    start_at: p.startIso,
    end_at: p.endIso,
    seats: p.seats,
    price_cents: p.priceCents ?? 0,
    paid_cents: p.paidCents ?? null,
    tarif_type: p.tarifType ?? null,
    payment_status: p.paymentStatus ?? 'free',
    payment_method: p.paymentMethod ?? null,
    quota_days: p.quotaDays ?? 0,
    stripe_session_id: p.stripeSessionId ?? null,
    payment_intent: p.paymentIntent ?? null,
  });
  return info.lastInsertRowid;
}
export { insertReservation };

// Normalise + valide un créneau brut. `slotIndex` (optionnel) est attaché à
// l'erreur pour permettre au client de pointer le créneau fautif dans un lot.
/**
 * Normalise et valide un créneau brut reçu du client.
 *
 * Contrôle serveur systématique : le front borne déjà les saisies, mais rien
 * n'empêche un appel direct à l'API avec des dates arbitraires ou passées.
 *
 * @param {string} startRaw Début, format libre acceptable par `Date`.
 * @param {string} endRaw Fin.
 * @param {number} [slotIndex] Index du créneau dans un lot, attaché à l'erreur
 *        pour que le client puisse pointer la ligne fautive.
 * @returns {{startIso: string, endIso: string}} Créneau normalisé en UTC.
 * @throws {Error} `DATE_INVALIDE`, `CRENEAU_INVALIDE`, `CRENEAU_PASSE`.
 */
export function validateSlot(startRaw, endRaw, slotIndex) {
  const startIso = toUtcIso(startRaw);
  const endIso = toUtcIso(endRaw);
  const extra = slotIndex != null ? { slotIndex } : undefined;
  if (endIso <= startIso) throw fail('CRENEAU_INVALIDE', extra);
  if (new Date(startIso).getTime() < Date.now()) throw fail('CRENEAU_PASSE', extra);
  return { startIso, endIso };
}

// ── Réservation ATOMIQUE (brief §5.2) ────────────────────────────────────────
// Dispo + solde + création résa + débit wallet dans UNE transaction.
// WAL sérialise : deux clics simultanés sur la dernière place => un seul passe.
// opts (réservés à l'admin) : { ignoreHours, allowOverbooking, customCost, createdBy }.
const reserveTx = db.transaction((userId, spaceId, startIso, endIso, seatsRaw, opts) => {
  const space = spaceStmt.get(spaceId);
  if (!space) throw fail('ESPACE_INTROUVABLE');
  const o = opts || {};
  if (!o.ignoreHours && !withinOpeningHours(startIso, endIso)) throw fail('HORS_HORAIRES');
  const seats = resolveSeats(space, seatsRaw);
  if (!o.allowOverbooking && availableSeats(spaceId, startIso, endIso) < seats) throw fail('COMPLET');
  const tarifType = o.tarifType || 'heure';
  const price = o.customCostCents != null
    ? Math.max(0, Math.round(o.customCostCents))
    : priceCents(space, startIso, endIso, seats, tarifType);
  const reservationId = insertReservation({
    userId, spaceId, startIso, endIso, seats,
    priceCents: price, tarifType,
    paymentStatus: o.paymentStatus || 'free',
    paidCents: o.paidCents ?? null,
    paymentMethod: o.paymentMethod || 'FREE_ADMIN',
    stripeSessionId: o.stripeSessionId, paymentIntent: o.paymentIntent,
  });
  return { reservationId, cost: price, seats };
});

/**
 * Réserve un créneau de façon ATOMIQUE : contrôle de disponibilité, contrôle de
 * solde, création de la réservation et débit du portefeuille se font dans une
 * seule transaction SQLite. Deux clics simultanés sur la dernière place ne
 * peuvent pas passer tous les deux.
 *
 * @param {number} userId Bénéficiaire de la réservation.
 * @param {number} spaceId Espace réservé.
 * @param {string} startRaw Début.
 * @param {string} endRaw Fin.
 * @param {number} [seats] Places demandées (borné à la capacité ; 1 si exclusif).
 * @param {{ignoreHours?: boolean, allowOverbooking?: boolean, customCost?: number, createdBy?: number}} [opts]
 *        Options RÉSERVÉES À L'ADMINISTRATEUR : elles permettent de passer outre
 *        les horaires, la capacité et le tarif. Les routes membres ne les
 *        transmettent jamais - c'est le point de contrôle de cette élévation.
 * @returns {{reservationId: number|bigint, cost: number, seats: number}}
 * @throws {Error} `ESPACE_INTROUVABLE`, `HORS_HORAIRES`, `COMPLET`, `CREDITS_INSUFFISANTS`,
 *         `CRENEAU_INVALIDE`, `CRENEAU_PASSE`.
 */
export function reserve(userId, spaceId, startRaw, endRaw, seats = 1, opts = {}) {
  const { startIso, endIso } = validateSlot(startRaw, endRaw);
  return reserveTx(userId, spaceId, startIso, endIso, seats, opts);
}

// ── Réservation MULTIPLE atomique (plusieurs créneaux, même espace, tout ou rien) ──
// Le solde total est vérifié une fois ; la disponibilité de chaque créneau tient
// compte des créneaux déjà insérés DANS la même transaction (anti double-booking).
/**
 * Réserve PLUSIEURS créneaux d'un même espace, en tout ou rien.
 *
 * Le nombre de créneaux est PLAFONNÉ : `better-sqlite3` est synchrone et la
 * transaction bloque l'unique thread du process. Sans plafond, un lot de
 * plusieurs milliers de créneaux gèlerait l'application pour tous les
 * utilisateurs (déni de service applicatif, CWE-770).
 *
 * @param {number} userId Bénéficiaire.
 * @param {number} spaceId Espace réservé (le même pour tout le lot).
 * @param {Array<{start_at: string, end_at: string, seats?: number}>} rawSlots Créneaux demandés.
 * @param {{ignoreHours?: boolean, allowOverbooking?: boolean, createdBy?: number}} [opts]
 *        Options réservées à l'administrateur (cf. `reserve`).
 * @returns {{reservations: object[], total: number, count: number}}
 * @throws {Error} `AUCUN_CRENEAU`, `TROP_DE_CRENEAUX`, `ESPACE_INTROUVABLE`,
 *         `HORS_HORAIRES`, `COMPLET`, `CREDITS_INSUFFISANTS`.
 */
export function reserveBatch(userId, spaceId, rawSlots, opts = {}) {
  if (!Array.isArray(rawSlots) || rawSlots.length === 0) throw fail('AUCUN_CRENEAU');
  if (rawSlots.length > config.maxSlotsPerBatch) throw fail('TROP_DE_CRENEAUX');
  const space = spaceStmt.get(spaceId);
  if (!space) throw fail('ESPACE_INTROUVABLE');
  const o = opts || {};
  const slots = rawSlots.map((s, i) => ({ i, seatsRaw: s.seats, tarifType: s.tarif_type || 'heure', ...validateSlot(s.start_at, s.end_at, i) }));

  const tx = db.transaction(() => {
    for (const sl of slots) {
      if (!o.ignoreHours && !withinOpeningHours(sl.startIso, sl.endIso)) throw fail('HORS_HORAIRES', { slotIndex: sl.i });
      sl.seats = resolveSeats(space, sl.seatsRaw);
      sl.cost = priceCents(space, sl.startIso, sl.endIso, sl.seats, sl.tarifType);
    }
    const total = slots.reduce((sum, sl) => sum + sl.cost, 0);

    const created = [];
    for (const sl of slots) {
      // La dispo tient compte des créneaux déjà insérés dans CETTE transaction.
      if (!o.allowOverbooking && availableSeats(spaceId, sl.startIso, sl.endIso) < sl.seats) throw fail('COMPLET', { slotIndex: sl.i });
      const reservationId = insertReservation({
        userId, spaceId, startIso: sl.startIso, endIso: sl.endIso, seats: sl.seats,
        priceCents: sl.cost, tarifType: sl.tarifType,
        paymentStatus: o.paymentStatus || 'free',
        paidCents: o.paidCents ?? null,
        paymentMethod: o.paymentMethod || 'FREE_ADMIN',
        stripeSessionId: o.stripeSessionId, paymentIntent: o.paymentIntent,
      });
      created.push({ reservationId, cost: sl.cost, seats: sl.seats, start_at: sl.startIso, end_at: sl.endIso });
    }
    return { reservations: created, total, count: created.length };
  });
  return tx();
}

// ── Annulation (+ remboursement éventuel) (brief §5.3) ────────────────────────
const getResStmt = db.prepare(`SELECT * FROM reservations WHERE id = ?`);
const cancelResStmt = db.prepare(
  `UPDATE reservations SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'`
);
// Recrédite le quota Open Space d'un abonné Essentiel à l'annulation d'une
// réservation À VENIR couverte par le quota (brief §5.3 - règles d'annulation).
const recreditQuotaStmt = db.prepare(
  `UPDATE users SET open_space_quota_used = MAX(0, open_space_quota_used - ?) WHERE id = ?`
);
function recreditQuotaIfDue(res) {
  if (res.payment_method === 'SUBSCRIPTION_QUOTA' && res.quota_days > 0
      && new Date(res.start_at).getTime() > Date.now()) {
    recreditQuotaStmt.run(res.quota_days, res.user_id);
  }
}
// Charge une réservation confirmée ou lève (RESA_INTROUVABLE / DEJA_ANNULEE).
function getConfirmed(id) {
  const res = getResStmt.get(id);
  if (!res) throw fail('RESA_INTROUVABLE');
  if (res.status !== 'confirmed') throw fail('DEJA_ANNULEE');
  return res;
}

// `actor` = utilisateur qui annule (le membre lui-même, ou un admin).
const cancelTx = db.transaction((reservationId, actor) => {
  const res = getResStmt.get(reservationId);
  if (!res) throw fail('RESA_INTROUVABLE');
  if (actor.role !== 'admin' && res.user_id !== actor.id) throw fail('INTERDIT');
  if (res.status !== 'confirmed') throw fail('DEJA_ANNULEE');
  cancelResStmt.run(reservationId);
  recreditQuotaIfDue(res);

  // Remboursement DÛ (à effectuer manuellement dans Stripe par l'admin) si
  // l'annulation intervient avant la fenêtre ET que la résa a été payée en ligne.
  const inWindow = isBeforeRefundWindow(res.start_at, config.refundWindowHours);
  const encaisse = res.paid_cents ?? res.price_cents;
  const refundDue = inWindow && res.payment_status === 'paid' && encaisse > 0;
  return { cancelled: true, refunded: refundDue, amount: refundDue ? encaisse : 0, inWindow };
});

/**
 * Annule une réservation, avec remboursement si l'annulation intervient avant
 * la fenêtre configurée (`REFUND_WINDOW_HOURS`).
 *
 * CONTRÔLE D'ACCÈS : la propriété de la réservation est vérifiée DANS la
 * transaction (`res.user_id !== actor.id` → `INTERDIT`), et non par la route.
 * Un membre ne peut donc pas annuler - ni faire rembourser - la réservation
 * d'un autre en devinant son identifiant (IDOR/BOLA, OWASP A01).
 *
 * @param {number} reservationId Réservation visée.
 * @param {{id: number, role: string}} actor Utilisateur à l'origine de l'annulation.
 * @returns {{cancelled: true, refunded: boolean, amount: number}}
 * @throws {Error} `RESA_INTROUVABLE`, `DEJA_ANNULEE`, `INTERDIT`.
 */
export function cancelReservation(reservationId, actor) {
  return cancelTx(reservationId, actor);
}

// ── Lectures ──────────────────────────────────────────────────────────────────
/**
 * Liste les réservations d'un membre (le filtre `user_id` est appliqué en SQL :
 * aucun identifiant de réservation ne transite depuis le client).
 *
 * @param {number} userId Membre concerné.
 * @returns {object[]} Réservations, de la plus récente à la plus ancienne.
 */
export function listMyReservations(userId) {
  return db
    .prepare(
      `SELECT r.*, s.name AS space_name, s.kind AS space_kind, s.color AS space_color
         FROM reservations r
         JOIN spaces s ON s.id = r.space_id
        WHERE r.user_id = ?
        ORDER BY r.start_at DESC`
    )
    .all(userId);
}

export function listPlanning({ from, to }) {
  return db
    .prepare(
      `SELECT r.*, s.name AS space_name, s.kind AS space_kind, s.color AS space_color,
              u.display_name AS member_name, u.email AS member_email
         FROM reservations r
         JOIN spaces s ON s.id = r.space_id
         JOIN users  u ON u.id = r.user_id
        WHERE r.status = 'confirmed' AND r.end_at > ? AND r.start_at < ?
        ORDER BY r.start_at ASC`
    )
    .all(from, to);
}

// Détail d'une réservation (avec espace + membre), pour le panneau admin.
const detailStmt = db.prepare(
  `SELECT r.*, s.name AS space_name, s.kind AS space_kind, s.color AS space_color,
          s.capacity AS space_capacity,
          u.display_name AS member_name, u.email AS member_email
     FROM reservations r
     JOIN spaces s ON s.id = r.space_id
     JOIN users  u ON u.id = r.user_id
    WHERE r.id = ?`
);
export function getReservationDetail(id) {
  return detailStmt.get(id) || null;
}

// ── Actions admin sur une réservation (note, déplacement, suppression) ────────
const setNoteStmt = db.prepare(`UPDATE reservations SET note = ? WHERE id = ?`);
export function setReservationNote(id, note) {
  if (!getResStmt.get(id)) throw fail('RESA_INTROUVABLE');
  setNoteStmt.run(note == null || note === '' ? null : String(note), id);
  return getReservationDetail(id);
}

const moveStmt = db.prepare(`UPDATE reservations SET start_at = ?, end_at = ? WHERE id = ?`);

// Déplace une réservation (même espace, mêmes places, même coût) après contrôle
// de disponibilité (en excluant la réservation elle-même du calcul).
/**
 * Déplace une réservation confirmée (même espace, mêmes places, même coût),
 * après contrôle de disponibilité excluant la réservation elle-même.
 * Action réservée au back-office (`requireAdmin` sur la route appelante).
 *
 * @param {number} id Réservation visée.
 * @param {string} startRaw Nouveau début.
 * @param {string} endRaw Nouvelle fin.
 * @returns {object|null} Détail de la réservation après déplacement.
 * @throws {Error} `CRENEAU_INVALIDE`, `RESA_INTROUVABLE`, `DEJA_ANNULEE`, `COMPLET`.
 */
export function moveReservation(id, startRaw, endRaw) {
  const startIso = toUtcIso(startRaw);
  const endIso = toUtcIso(endRaw);
  if (endIso <= startIso) throw fail('CRENEAU_INVALIDE');
  const tx = db.transaction(() => {
    const res = getConfirmed(id);
    const space = spaceStmt.get(res.space_id);
    if (!space) throw fail('ESPACE_INTROUVABLE');
    const { taken } = overlapSumExclStmt.get(res.space_id, id, endIso, startIso);
    if (space.exclusive ? taken > 0 : space.capacity - taken < res.seats) throw fail('COMPLET');
    moveStmt.run(startIso, endIso, id);
  });
  tx();
  return getReservationDetail(id);
}

// Annulation par l'admin : remboursement TOTAL systématique (geste commercial).
const adminCancelTx = db.transaction((id, _actorId) => {
  const res = getConfirmed(id);
  cancelResStmt.run(id);
  recreditQuotaIfDue(res);
  // Remboursement dû si la résa avait été payée en ligne (à faire dans Stripe).
  const encaisse = res.paid_cents ?? res.price_cents;
  const refundDue = res.payment_status === 'paid' && encaisse > 0;
  return { cancelled: true, refunded: refundDue, amount: refundDue ? encaisse : 0 };
});
export function adminCancelReservation(id, actorId) {
  return adminCancelTx(id, actorId);
}
