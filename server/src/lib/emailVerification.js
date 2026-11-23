import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { fail } from './errors.js';

// ── Vérification d'adresse e-mail ────────────────────────────────────────────
// Même mécanisme que les jetons de réinitialisation (cf. lib/passwords.js), dans
// un module à part. Le jeton envoyé par e-mail est stocké HACHÉ (SHA-256) : une
// lecture de la base ne permet pas de fabriquer un lien valide (CWE-522). Le
// jeton porte 256 bits d'entropie, un SHA-256 non salé suffit.
//
// Règle métier : la vérification n'entrave PAS l'inscription ; elle bloque
// seulement les réservations des membres tant que l'adresse n'est pas confirmée
// (cf. `assertCanBook`, appelé en amont du paiement par lib/cart.js).

const getUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const insertVerification = db.prepare(
  `INSERT INTO email_verifications (token, user_id, expires_at) VALUES (?, ?, ?)`
);
const getVerification = db.prepare(`SELECT * FROM email_verifications WHERE token = ?`);
const markUsed = db.prepare(`UPDATE email_verifications SET used_at = datetime('now') WHERE token = ?`);
const invalidatePending = db.prepare(
  `UPDATE email_verifications SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`
);
const setVerified = db.prepare(`UPDATE users SET email_verified = 1 WHERE id = ?`);
const setUnverified = db.prepare(`UPDATE users SET email_verified = 0 WHERE id = ?`);
const getBookingState = db.prepare(`SELECT role, email_verified FROM users WHERE id = ?`);

// Marqueur de format : rend une valeur stockée distinguable d'un jeton en clair.
const DIGEST_PREFIX = 'sha256:';

/**
 * Empreinte de stockage d'un jeton de vérification.
 *
 * @param {string} token Jeton en clair (celui qui circule dans le lien).
 * @returns {string} Empreinte préfixée, telle qu'enregistrée en base.
 */
export function tokenDigest(token) {
  return DIGEST_PREFIX + crypto.createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

/**
 * Retrouve la ligne correspondant à un jeton présenté par un client.
 * Seule l'empreinte est cherchée : aucune valeur lue en base ne peut servir de jeton.
 *
 * @param {string} token Jeton en clair.
 * @returns {{token: string, user_id: number, expires_at: string, used_at: string | null} | undefined}
 */
function findVerification(token) {
  return getVerification.get(tokenDigest(token));
}

/**
 * Un jeton est utilisable s'il existe, n'a pas déjà servi et n'est pas expiré.
 *
 * @param {{used_at: string | null, expires_at: string} | undefined} row
 * @returns {boolean}
 */
function isUsable(row) {
  return Boolean(row) && !row.used_at && row.expires_at > new Date().toISOString();
}

/**
 * Émet un jeton de vérification à usage unique.
 * Tout jeton encore en attente pour cet utilisateur est invalidé au passage :
 * un seul lien est actif à la fois.
 *
 * @param {number} userId Utilisateur concerné.
 * @returns {{token: string, expiresAt: string, user: object}} `token` est le secret EN CLAIR,
 *          à insérer dans le lien : il n'est plus récupérable ensuite.
 * @throws {Error} `UTILISATEUR_INTROUVABLE`.
 */
export function createVerificationToken(userId) {
  const user = getUserById.get(userId);
  if (!user) throw fail('UTILISATEUR_INTROUVABLE');
  invalidatePending.run(userId);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.emailVerifyTokenTtlMs).toISOString();
  insertVerification.run(tokenDigest(token), userId, expiresAt);
  return { token, expiresAt, user };
}

/**
 * Indique si un jeton est valide, sans le consommer.
 *
 * @param {string} token Jeton en clair reçu du client.
 * @returns {{email: string} | null} `null` si le jeton est inconnu, expiré ou déjà
 *          consommé (aucune distinction : pas d'oracle).
 */
export function getVerificationInfo(token) {
  const row = findVerification(token);
  if (!isUsable(row)) return null;
  const user = getUserById.get(row.user_id);
  return user ? { email: user.email } : null;
}

/**
 * Consomme un jeton et marque l'adresse comme vérifiée.
 *
 * @param {string} token Jeton en clair reçu du client.
 * @returns {{userId: number}}
 * @throws {Error} `TOKEN_INVALIDE`.
 */
export function consumeVerificationToken(token) {
  const row = findVerification(token);
  if (!isUsable(row)) throw fail('TOKEN_INVALIDE');
  markUsed.run(row.token);
  setVerified.run(row.user_id);
  return { userId: row.user_id };
}

/**
 * Repasse un compte en « non vérifié » (changement d'adresse e-mail).
 * @param {number} userId
 * @returns {void}
 */
export function markUnverified(userId) {
  setUnverified.run(userId);
}

/**
 * Marque l'adresse d'un compte comme vérifiée (action de la gestionnaire quand
 * le courrier ne peut pas partir). Invalide les liens encore en attente.
 *
 * @param {number} userId Compte concerné.
 * @returns {{id: number, email: string, email_verified: true}}
 * @throws {Error} `UTILISATEUR_INTROUVABLE`.
 */
export function adminMarkVerified(userId) {
  const user = getUserById.get(userId);
  if (!user) throw fail('UTILISATEUR_INTROUVABLE');
  invalidatePending.run(userId);
  setVerified.run(userId);
  return { id: user.id, email: user.email, email_verified: true };
}

/**
 * Garde-fou des réservations : refuse un membre dont l'adresse n'est pas confirmée.
 *
 * L'état est relu EN BASE (pas depuis la session, potentiellement périmée). Un
 * compte de rôle `admin` n'est jamais bloqué : il n'est pas facturé et son
 * parcours de réservation est gratuit. Ce contrôle se place STRICTEMENT en amont
 * du paiement : il ne doit jamais être appelé après encaissement (webhook).
 *
 * @param {number} userId Bénéficiaire de la réservation.
 * @returns {void}
 * @throws {Error} `EMAIL_NON_VERIFIE`.
 */
export function assertCanBook(userId) {
  const u = getBookingState.get(userId);
  if (!u) throw fail('UTILISATEUR_INTROUVABLE');
  if (u.role !== 'admin' && !u.email_verified) throw fail('EMAIL_NON_VERIFIE');
}
