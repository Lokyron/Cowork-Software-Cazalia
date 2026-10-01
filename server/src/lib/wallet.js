import { db } from '../db.js';

// Solde = SUM(amount) du grand-livre. JAMAIS de colonne dénormalisée (brief §8).
const balanceStmt = db.prepare(
  `SELECT COALESCE(SUM(amount), 0) AS balance FROM credit_transactions WHERE user_id = ?`
);
/**
 * Solde d'un membre, calculé à la volée depuis le grand-livre.
 * Aucune colonne « solde » n'existe : le solde ne peut donc pas se désynchroniser
 * des écritures, et il n'y a rien à corrompre par une écriture partielle.
 *
 * @param {number} userId Membre concerné.
 * @returns {number} Solde en crédits (peut être 0).
 */
export function getBalance(userId) {
  return balanceStmt.get(userId).balance;
}

const historyStmt = db.prepare(
  `SELECT id, amount, reason, reservation_id, note, created_by, created_at
     FROM credit_transactions
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?`
);
/**
 * Historique récent des mouvements de crédits d'un membre.
 * @param {number} userId Membre concerné.
 * @param {number} [limit] Nombre maximal de lignes.
 * @returns {object[]} Mouvements, du plus récent au plus ancien.
 */
export function getHistory(userId, limit = 100) {
  return historyStmt.all(userId, limit);
}

// Historique enrichi (avec le créneau réservé) pour la fiche membre côté admin.
const ledgerStmt = db.prepare(
  `SELECT ct.id, ct.amount, ct.reason, ct.note, ct.created_at, ct.amount_eur_cents,
          ct.reservation_id,
          r.start_at, r.end_at, r.status AS res_status,
          s.name AS space_name, s.color AS space_color
     FROM credit_transactions ct
     LEFT JOIN reservations r ON r.id = ct.reservation_id
     LEFT JOIN spaces       s ON s.id = r.space_id
    WHERE ct.user_id = ?
    ORDER BY ct.created_at DESC, ct.id DESC`
);
/**
 * Grand-livre enrichi (créneau et espace associés) pour la fiche membre admin.
 * @param {number} userId Membre concerné.
 * @returns {object[]}
 */
export function getLedger(userId) {
  return ledgerStmt.all(userId);
}

// Grand-livre filtré sur une période [from, to[ (ISO UTC). datetime() normalise
// les formats (created_at naïf "YYYY-MM-DD HH:MM:SS" et ISO "…T…Z").
const ledgerBetweenStmt = db.prepare(
  `SELECT ct.id, ct.amount, ct.reason, ct.note, ct.created_at, ct.amount_eur_cents,
          ct.reservation_id, r.start_at, r.end_at, s.name AS space_name
     FROM credit_transactions ct
     LEFT JOIN reservations r ON r.id = ct.reservation_id
     LEFT JOIN spaces       s ON s.id = r.space_id
    WHERE ct.user_id = ?
      AND datetime(ct.created_at) >= datetime(?)
      AND datetime(ct.created_at) <  datetime(?)
    ORDER BY ct.created_at ASC, ct.id ASC`
);
/**
 * Grand-livre filtré sur une période `[from, to[`.
 * Les bornes sont passées en PARAMÈTRES liés et normalisées par `datetime()`
 * côté SQLite : aucune valeur ne rejoint la requête par concaténation.
 *
 * @param {number} userId Membre concerné.
 * @param {string} fromIso Début de période (ISO/UTC), inclus.
 * @param {string} toIso Fin de période (ISO/UTC), exclue.
 * @returns {object[]} Mouvements, du plus ancien au plus récent.
 */
export function getLedgerBetween(userId, fromIso, toIso) {
  return ledgerBetweenStmt.all(userId, fromIso, toIso);
}

const insertTxStmt = db.prepare(
  `INSERT INTO credit_transactions (user_id, amount, reason, reservation_id, note, created_by, amount_eur_cents)
   VALUES (@user_id, @amount, @reason, @reservation_id, @note, @created_by, @amount_eur_cents)`
);

/**
 * Crédite le portefeuille d'un membre (recharge manuelle admin ; en phase 2,
 * Stripe appellera cette même fonction).
 *
 * Le montant doit être un ENTIER strictement positif : sans ce contrôle, un
 * montant négatif transformerait une recharge en débit arbitraire, et un
 * flottant introduirait des soldes non entiers dans le grand-livre.
 *
 * @param {object} params
 * @param {number} params.userId Bénéficiaire.
 * @param {number} params.amount Crédits à ajouter (entier > 0).
 * @param {number} params.createdBy Auteur de l'écriture (admin, ou le membre).
 * @param {string | null} [params.note] Commentaire libre.
 * @param {number | null} [params.amountEurCents] Montant réellement payé, en centimes.
 * @returns {{transactionId: number|bigint, balance: number}}
 * @throws {Error} `MONTANT_INVALIDE`.
 */
export function topUp({ userId, amount, createdBy, note = null, amountEurCents = null }) {
  if (!Number.isInteger(amount) || amount <= 0) {
    const e = new Error('MONTANT_INVALIDE');
    e.code = 'MONTANT_INVALIDE';
    throw e;
  }
  const info = insertTxStmt.run({
    user_id: userId,
    amount,
    reason: 'topup',
    reservation_id: null,
    note,
    created_by: createdBy,
    amount_eur_cents: Number.isInteger(amountEurCents) && amountEurCents > 0 ? amountEurCents : null,
  });
  return { transactionId: info.lastInsertRowid, balance: getBalance(userId) };
}
