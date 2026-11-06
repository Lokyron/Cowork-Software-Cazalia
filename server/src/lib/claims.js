import { db } from '../db.js';

// Réclamations consommateur : validation + insertion. Le formulaire est public
// (un consommateur peut réclamer sans compte), donc toutes les longueurs sont
// bornées - surface d'insertion directe en base, comme la pré-inscription.

function bizErr(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

export const CLAIM_KINDS = ['annulation', 'remboursement', 'autre'];
export const CLAIM_STATUSES = ['nouveau', 'en_cours', 'resolu'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Téléphone : chiffres, espaces et séparateurs courants (FR/international).
const PHONE_RE = /^[+()\d][\d\s().-]{5,25}$/;

/**
 * Nettoie et valide une réclamation.
 *
 * @param {Record<string, unknown>} [input] Corps de la requête.
 * @returns {{first_name:string,last_name:string,email:string,reservation_ref:string|null,
 *            kind:string,message:string}}
 * @throws {Error} `CHAMPS_INVALIDES`, `EMAIL_INVALIDE`.
 */
function sanitize(input = {}) {
  const first_name = String(input.first_name ?? '').trim();
  const last_name = String(input.last_name ?? '').trim();
  const email = String(input.email ?? '').trim().toLowerCase();
  const phone = String(input.phone ?? '').trim();
  const reservation_ref_raw = String(input.reservation_ref ?? '').trim();
  let kind = String(input.kind ?? '').trim();
  const message = String(input.message ?? '').trim();

  if (!first_name || !last_name || first_name.length > 80 || last_name.length > 80) throw bizErr('CHAMPS_INVALIDES');
  if (!EMAIL_RE.test(email) || email.length > 160) throw bizErr('EMAIL_INVALIDE');
  if (!PHONE_RE.test(phone)) throw bizErr('TELEPHONE_INVALIDE');
  if (!CLAIM_KINDS.includes(kind)) kind = 'autre';
  if (!message || message.length < 10) throw bizErr('CHAMPS_INVALIDES');

  return {
    first_name,
    last_name,
    email,
    phone: phone.slice(0, 30),
    reservation_ref: reservation_ref_raw ? reservation_ref_raw.slice(0, 40) : null,
    kind,
    message: message.slice(0, 4000),
  };
}

const insertStmt = db.prepare(
  `INSERT INTO claims (user_id, first_name, last_name, email, phone, reservation_ref, kind, message)
   VALUES (@user_id, @first_name, @last_name, @email, @phone, @reservation_ref, @kind, @message)`
);

/**
 * Enregistre une réclamation.
 *
 * @param {Record<string, unknown>} input Champs du formulaire.
 * @param {number | null} [userId] Auteur connecté, ou `null`.
 * @returns {{id:number|bigint, data:object}} Identifiant + données nettoyées (pour l'e-mail).
 * @throws {Error} Erreur métier de validation (cf. `sanitize`).
 */
export function createClaim(input, userId = null) {
  const data = sanitize(input);
  const info = insertStmt.run({ ...data, user_id: userId ?? null });
  return { id: info.lastInsertRowid, data };
}

/**
 * Liste les réclamations pour le back-office (plus récentes d'abord).
 * @param {{status?: string}} [filters]
 * @returns {object[]}
 */
export function listClaims({ status } = {}) {
  if (status && CLAIM_STATUSES.includes(status)) {
    return db.prepare(`SELECT * FROM claims WHERE status = ? ORDER BY created_at DESC`).all(status);
  }
  return db.prepare(`SELECT * FROM claims ORDER BY created_at DESC`).all();
}
