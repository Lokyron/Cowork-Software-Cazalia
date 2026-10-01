import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, destroyUserSessions } from '../auth.js';
import { fail } from './errors.js';

// Mots de passe notoirement compromis, sous la forme où ils apparaissent le plus
// souvent dans les fuites. La comparaison est faite en minuscules et sans les
// chiffres de fin usuels (« Azerty2024 » ≡ « azerty »).
const COMMON_PASSWORDS = new Set([
  'password', 'motdepasse', 'azerty', 'azertyuiop', 'qwerty', 'qwertyuiop',
  'motdepasse!', 'bonjour', 'coworking', 'cazalia', 'soleil',
  'admin', 'administrateur', 'welcome', 'bienvenue', 'iloveyou', 'abcdef',
]);

/**
 * Valide un mot de passe candidat au regard de la politique de l'application.
 *
 * Règles (CWE-521) :
 *  - longueur comprise entre `config.password.minLength` et `maxLength` ;
 *  - au moins trois familles de caractères sur quatre (minuscule, majuscule,
 *    chiffre, autre) — un critère de diversité, pas une contrainte de
 *    composition rigide, qui pousse aux mots de passe mémorisables longs ;
 *  - refus des séquences répétitives et des mots de passe notoirement fuités.
 *
 * @param {unknown} pw Mot de passe candidat.
 * @returns {void}
 * @throws {Error} `MOT_DE_PASSE_FAIBLE` si la politique n'est pas respectée.
 */
export function assertStrongPassword(pw) {
  if (typeof pw !== 'string') throw fail('MOT_DE_PASSE_FAIBLE');
  if (pw.length < config.password.minLength || pw.length > config.password.maxLength) {
    throw fail('MOT_DE_PASSE_FAIBLE');
  }
  const families =
    Number(/[a-z]/.test(pw)) + Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) + Number(/[^A-Za-z0-9]/.test(pw));
  if (families < 3) throw fail('MOT_DE_PASSE_FAIBLE');
  // Un seul caractère répété, ou une base triviale suffixée de chiffres.
  if (/^(.)\1+$/.test(pw)) throw fail('MOT_DE_PASSE_FAIBLE');
  const base = pw.toLowerCase().replace(/[^a-z]/g, '');
  if (COMMON_PASSWORDS.has(base)) throw fail('MOT_DE_PASSE_FAIBLE');
}

const getUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);
// Tout changement de mot de passe lève l'obligation de changement forcé.
const setHash = db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`);

/**
 * Change le mot de passe de l'utilisateur après vérification du mot de passe actuel.
 *
 * @param {number} userId Utilisateur authentifié.
 * @param {string} currentPassword Mot de passe actuel (preuve de possession).
 * @param {string} newPassword Nouveau mot de passe (soumis à la politique).
 * @returns {void}
 * @throws {Error} `MOT_DE_PASSE_FAIBLE`, `UTILISATEUR_INTROUVABLE`, `MOT_DE_PASSE_ACTUEL_INVALIDE`.
 */
// ── Changement par l'utilisateur lui-même (vérifie le mot de passe actuel) ────
export function changeOwnPassword(userId, currentPassword, newPassword) {
  assertStrongPassword(newPassword);
  const user = getUserById.get(userId);
  if (!user) throw fail('UTILISATEUR_INTROUVABLE');
  if (!verifyPassword(currentPassword, user.password_hash)) throw fail('MOT_DE_PASSE_ACTUEL_INVALIDE');
  setHash.run(hashPassword(newPassword), userId);
  // Déconnecte toutes les sessions ; l'appelant en recrée une pour l'appareil courant.
  destroyUserSessions(userId);
}

/**
 * Définit le mot de passe d'un membre depuis le back-office.
 * Toutes ses sessions sont invalidées : un accès déjà ouvert (légitime ou non)
 * est immédiatement coupé.
 *
 * @param {number} targetUserId Membre visé.
 * @param {string} newPassword Nouveau mot de passe (soumis à la politique).
 * @returns {{email: string, display_name: string}}
 * @throws {Error} `MOT_DE_PASSE_FAIBLE`, `UTILISATEUR_INTROUVABLE`.
 */
// ── Définition directe par un admin (à la volée) ──────────────────────────────
export function adminSetPassword(targetUserId, newPassword) {
  assertStrongPassword(newPassword);
  const user = getUserById.get(targetUserId);
  if (!user) throw fail('UTILISATEUR_INTROUVABLE');
  setHash.run(hashPassword(newPassword), targetUserId);
  destroyUserSessions(targetUserId); // force la reconnexion du membre
  return { email: user.email, display_name: user.display_name };
}

// ── Jetons de réinitialisation ────────────────────────────────────────────────
// Le jeton envoyé par e-mail est un secret équivalent à un mot de passe : il est
// donc stocké HACHÉ (SHA-256). Une lecture de la base — sauvegarde égarée, accès
// au fichier SQLite — ne permet plus de fabriquer un lien de réinitialisation
// valide (CWE-522). SHA-256 non salé est suffisant ici : le jeton porte déjà
// 256 bits d'entropie, il n'est pas exposé au dictionnaire.
const insertReset = db.prepare(
  `INSERT INTO password_resets (token, user_id, expires_at, created_by) VALUES (?, ?, ?, ?)`
);
const getReset = db.prepare(`SELECT * FROM password_resets WHERE token = ?`);
const markUsed = db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE token = ?`);
const invalidatePending = db.prepare(
  `UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`
);

// Marqueur de format. Il rend une valeur stockée distinguable d'un jeton en
// clair — indispensable, les deux étant sinon 64 caractères hexadécimaux.
const DIGEST_PREFIX = 'sha256:';

/**
 * Empreinte de stockage d'un jeton de réinitialisation.
 *
 * @param {string} token Jeton en clair (celui qui circule dans le lien).
 * @returns {string} Empreinte préfixée, telle qu'enregistrée en base.
 */
function tokenDigest(token) {
  return DIGEST_PREFIX + crypto.createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

/**
 * Retrouve la ligne correspondant à un jeton présenté par un client.
 *
 * Recherche d'abord l'empreinte (format courant). À défaut, une recherche sur
 * la valeur brute permet aux jetons émis AVANT ce durcissement de rester
 * utilisables jusqu'à leur expiration (2 h) — mais uniquement si la ligne
 * trouvée est elle-même au format historique. Sans cette dernière condition, la
 * valeur lue en base servirait directement de jeton, ce qui annulerait tout
 * l'intérêt du hachage.
 *
 * @param {string} token Jeton en clair.
 * @returns {{token: string, user_id: number, expires_at: string, used_at: string | null} | undefined}
 */
function findReset(token) {
  const hashed = getReset.get(tokenDigest(token));
  if (hashed) return hashed;
  const legacy = getReset.get(String(token ?? ''));
  return legacy && !String(legacy.token).startsWith(DIGEST_PREFIX) ? legacy : undefined;
}

/**
 * Émet un jeton de réinitialisation à usage unique.
 * Tout jeton encore en attente pour cet utilisateur est invalidé au passage :
 * un seul lien est actif à la fois.
 *
 * @param {number} userId Utilisateur concerné.
 * @param {number | null} [createdBy] Admin à l'origine de la demande, ou `null` (self-service).
 * @returns {{token: string, expiresAt: string, user: object}} `token` est le secret EN CLAIR,
 *          à insérer dans le lien : il n'est plus récupérable ensuite.
 * @throws {Error} `UTILISATEUR_INTROUVABLE`.
 */
export function createResetToken(userId, createdBy = null) {
  const user = getUserById.get(userId);
  if (!user) throw fail('UTILISATEUR_INTROUVABLE');
  invalidatePending.run(userId);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.resetTokenTtlMs).toISOString();
  insertReset.run(tokenDigest(token), userId, expiresAt, createdBy);
  return { token, expiresAt, user };
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
 * Renvoie les informations d'affichage associées à un jeton valide.
 *
 * @param {string} token Jeton en clair reçu du client.
 * @returns {{email: string, display_name: string} | null} `null` si le jeton est invalide,
 *          expiré ou déjà consommé (aucune distinction : pas d'oracle).
 */
export function getResetTokenInfo(token) {
  const row = findReset(token);
  if (!isUsable(row)) return null;
  const user = getUserById.get(row.user_id);
  return user ? { email: user.email, display_name: user.display_name } : null;
}

/**
 * Consomme un jeton de réinitialisation et applique le nouveau mot de passe.
 *
 * Le jeton est marqué consommé et toutes les sessions de l'utilisateur sont
 * détruites : si un attaquant détenait une session, il la perd ici.
 *
 * @param {string} token Jeton en clair reçu du client.
 * @param {string} newPassword Nouveau mot de passe (soumis à la politique).
 * @returns {{userId: number}}
 * @throws {Error} `MOT_DE_PASSE_FAIBLE`, `TOKEN_INVALIDE`.
 */
export function consumeResetToken(token, newPassword) {
  assertStrongPassword(newPassword);
  const row = findReset(token);
  if (!isUsable(row)) throw fail('TOKEN_INVALIDE');
  setHash.run(hashPassword(newPassword), row.user_id);
  markUsed.run(row.token); // `row.token` = valeur réellement stockée (empreinte ou legacy)
  destroyUserSessions(row.user_id);
  return { userId: row.user_id };
}
