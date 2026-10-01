import { db } from '../db.js';
import { config } from '../config.js';
import { fail } from './errors.js';
import { getBalance } from './wallet.js';
import { billedHours, toUtcIso, isBeforeRefundWindow, parisWeekday, parisMinutes } from './time.js';

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
  if (space.exclusive) {
    return { exclusive: true, privatizable: false, capacity: space.capacity, seats_left: busy > 0 ? 0 : 1 };
  }
  return {
    exclusive: false,
    privatizable: !!space.privatizable,
    capacity: space.capacity,
    seats_left: Math.max(0, space.capacity - busy),
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

// Coût : exclusif = forfait salle × heures ; inventaire = tarif/place × heures × places.
/**
 * Calcule le coût en crédits d'un créneau.
 * Deux tarifications : espace exclusif = forfait salle × heures facturées ;
 * espace à inventaire = tarif par place × heures × nombre de places.
 * Les heures sont arrondies à l'heure supérieure, minimum 1 (cf. brief §5.3).
 *
 * @param {number} spaceId Espace concerné.
 * @param {string} startIso Début (ISO/UTC).
 * @param {string} endIso Fin (ISO/UTC).
 * @param {number|string} [seatsRaw] Nombre de places demandé (ignoré si exclusif).
 * @returns {number} Coût en crédits.
 * @throws {Error} `ESPACE_INTROUVABLE`.
 */
export function quoteCost(spaceId, startIso, endIso, seatsRaw = 1) {
  const space = spaceStmt.get(spaceId);
  if (!space) throw fail('ESPACE_INTROUVABLE');
  const hours = billedHours(startIso, endIso);
  if (space.exclusive) return space.credits_per_hour * hours;
  return space.credits_per_hour * hours * resolveSeats(space, seatsRaw);
}

const insertResStmt = db.prepare(
  `INSERT INTO reservations (user_id, space_id, start_at, end_at, credits_cost, seats)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const insertBookingTxStmt = db.prepare(
  `INSERT INTO credit_transactions (user_id, amount, reason, reservation_id, created_by)
   VALUES (?, ?, 'booking', ?, ?)`
);

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
  const cost = o.customCost != null ? Math.max(0, Math.round(o.customCost)) : quoteCost(spaceId, startIso, endIso, seats);
  if (getBalance(userId) < cost) throw fail('CREDITS_INSUFFISANTS');
  const res = insertResStmt.run(userId, spaceId, startIso, endIso, cost, seats);
  insertBookingTxStmt.run(userId, -cost, res.lastInsertRowid, o.createdBy ?? userId);
  return { reservationId: res.lastInsertRowid, cost, seats };
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
 *        transmettent jamais — c'est le point de contrôle de cette élévation.
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
  const slots = rawSlots.map((s, i) => ({ i, seatsRaw: s.seats, ...validateSlot(s.start_at, s.end_at, i) }));

  const tx = db.transaction(() => {
    for (const sl of slots) {
      if (!o.ignoreHours && !withinOpeningHours(sl.startIso, sl.endIso)) throw fail('HORS_HORAIRES', { slotIndex: sl.i });
      sl.seats = resolveSeats(space, sl.seatsRaw);
      sl.cost = quoteCost(spaceId, sl.startIso, sl.endIso, sl.seats);
    }
    const total = slots.reduce((sum, sl) => sum + sl.cost, 0);
    if (getBalance(userId) < total) throw fail('CREDITS_INSUFFISANTS');

    const created = [];
    for (const sl of slots) {
      // La dispo tient compte des créneaux déjà insérés dans CETTE transaction.
      if (!o.allowOverbooking && availableSeats(spaceId, sl.startIso, sl.endIso) < sl.seats) throw fail('COMPLET', { slotIndex: sl.i });
      const r = insertResStmt.run(userId, spaceId, sl.startIso, sl.endIso, sl.cost, sl.seats);
      insertBookingTxStmt.run(userId, -sl.cost, r.lastInsertRowid, o.createdBy ?? userId);
      created.push({ reservationId: r.lastInsertRowid, cost: sl.cost, seats: sl.seats, start_at: sl.startIso, end_at: sl.endIso });
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
const insertRefundStmt = db.prepare(
  `INSERT INTO credit_transactions (user_id, amount, reason, reservation_id, note, created_by)
   VALUES (?, ?, 'refund', ?, ?, ?)`
);

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

  // Remboursement total si annulée avant la fenêtre configurable, sinon rien.
  const refunded = isBeforeRefundWindow(res.start_at, config.refundWindowHours);
  if (refunded && res.credits_cost > 0) {
    insertRefundStmt.run(
      res.user_id,
      res.credits_cost,
      reservationId,
      `Remboursement annulation (> ${config.refundWindowHours}h avant)`,
      actor.id
    );
  }
  return { cancelled: true, refunded, amount: refunded ? res.credits_cost : 0 };
});

/**
 * Annule une réservation, avec remboursement si l'annulation intervient avant
 * la fenêtre configurée (`REFUND_WINDOW_HOURS`).
 *
 * CONTRÔLE D'ACCÈS : la propriété de la réservation est vérifiée DANS la
 * transaction (`res.user_id !== actor.id` → `INTERDIT`), et non par la route.
 * Un membre ne peut donc pas annuler — ni faire rembourser — la réservation
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
const adminCancelTx = db.transaction((id, actorId) => {
  const res = getConfirmed(id);
  cancelResStmt.run(id);
  if (res.credits_cost > 0) {
    insertRefundStmt.run(res.user_id, res.credits_cost, id, 'Remboursement (annulation admin)', actorId);
  }
  return { cancelled: true, refunded: res.credits_cost > 0, amount: res.credits_cost };
});
export function adminCancelReservation(id, actorId) {
  return adminCancelTx(id, actorId);
}
