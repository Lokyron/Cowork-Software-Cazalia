import { db } from '../db.js';
import { config } from '../config.js';
import { hashPassword } from '../auth.js';
import { fail } from './errors.js';

const getById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const emailTaken = db.prepare(`SELECT id FROM users WHERE email = ? AND id <> ?`);
const countAdmins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`);
const emailExists = db.prepare(`SELECT id FROM users WHERE email = ?`);
const insertStmt = db.prepare(
  `INSERT INTO users (email, display_name, first_name, last_name, phone, password_hash, role, must_change_password)
   VALUES (@email, @display_name, @first_name, @last_name, @phone, @password_hash, @role, 1)`
);
const updateStmt = db.prepare(
  `UPDATE users SET
      first_name = @first_name,
      last_name  = @last_name,
      email      = @email,
      phone      = @phone,
      role       = @role,
      display_name = @display_name
    WHERE id = @id`
);

const updateProfileStmt = db.prepare(
  `UPDATE users SET
      first_name = @first_name, last_name = @last_name, email = @email, phone = @phone,
      display_name = @display_name, company_name = @company_name, vat_number = @vat_number,
      billing_address = @billing_address, notify_booking = @notify_booking, notify_marketing = @notify_marketing
    WHERE id = @id`
);

/**
 * Profil complet d'un utilisateur pour la page « Mon compte ».
 * L'empreinte de mot de passe et le secret TOTP ne sont jamais inclus.
 *
 * @param {number} userId Utilisateur concerné.
 * @returns {object} Champs de profil exposables au client.
 * @throws {Error} `UTILISATEUR_INTROUVABLE`.
 */
export function getProfile(userId) {
  const u = getById.get(userId);
  if (!u) throw fail('UTILISATEUR_INTROUVABLE');
  return {
    id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name, phone: u.phone,
    display_name: u.display_name, company_name: u.company_name, vat_number: u.vat_number,
    billing_address: u.billing_address,
    notify_booking: !!u.notify_booking, notify_marketing: !!u.notify_marketing,
    role: u.role, totp_enabled: !!u.totp_enabled,
  };
}

/**
 * Mise à jour du profil par l'utilisateur lui-même.
 *
 * Le champ `role` est délibérément ABSENT de la requête SQL : même si le client
 * envoie `{"role":"admin"}`, la valeur est ignorée. C'est le point de blocage
 * de l'élévation de privilèges verticale par assignation de masse (CWE-915).
 *
 * @param {number} userId Utilisateur authentifié (jamais issu du corps de requête).
 * @param {Record<string, unknown>} body Champs soumis.
 * @returns {object} Profil après mise à jour.
 * @throws {Error} `UTILISATEUR_INTROUVABLE`, `CHAMPS_INVALIDES`, `EMAIL_DEJA_PRIS`.
 */
export function updateOwnProfile(userId, body) {
  const u = getById.get(userId);
  if (!u) throw fail('UTILISATEUR_INTROUVABLE');
  const firstName = String(body?.first_name ?? u.first_name ?? '').trim();
  const lastName = String(body?.last_name ?? u.last_name ?? '').trim();
  const email = String(body?.email ?? u.email ?? '').trim().toLowerCase();
  const phone = String(body?.phone ?? u.phone ?? '').trim();
  if (!firstName || !lastName || !email || !phone) throw fail('CHAMPS_INVALIDES');
  if (emailTaken.get(email, userId)) throw fail('EMAIL_DEJA_PRIS');
  updateProfileStmt.run({
    id: userId, first_name: firstName, last_name: lastName, email, phone,
    display_name: `${firstName} ${lastName}`,
    company_name: body?.company_name != null ? String(body.company_name).trim() : (u.company_name ?? null),
    vat_number: body?.vat_number != null ? String(body.vat_number).trim() : (u.vat_number ?? null),
    billing_address: body?.billing_address != null ? String(body.billing_address).trim() : (u.billing_address ?? null),
    notify_booking: body?.notify_booking != null ? (body.notify_booking ? 1 : 0) : u.notify_booking,
    notify_marketing: body?.notify_marketing != null ? (body.notify_marketing ? 1 : 0) : u.notify_marketing,
  });
  return getProfile(userId);
}

/**
 * Projection d'un utilisateur destinée au back-office.
 * @param {object} u Ligne `users` complète.
 * @returns {object} Champs exposables (sans empreinte ni secret 2FA).
 */
export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    first_name: u.first_name,
    last_name: u.last_name,
    phone: u.phone,
    role: u.role,
    must_change_password: !!u.must_change_password,
  };
}

// Suppression définitive d'un compte et de toutes ses données liées.
// Les crédits non utilisés sont perdus (pas de remboursement). Irréversible.
const deleteTx = db.transaction((userId) => {
  // Détache les références "created_by" portées par cet utilisateur sur des
  // lignes appartenant à d'autres (sinon violation de clé étrangère).
  db.prepare(`UPDATE credit_transactions SET created_by = NULL WHERE created_by = ?`).run(userId);
  db.prepare(`UPDATE password_resets SET created_by = NULL WHERE created_by = ?`).run(userId);
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
  db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(userId);
  // Transactions avant réservations (credit_transactions.reservation_id -> reservations).
  db.prepare(`DELETE FROM credit_transactions WHERE user_id = ?`).run(userId);
  db.prepare(`DELETE FROM reservations WHERE user_id = ?`).run(userId);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
});

/**
 * Supprime définitivement un compte et toutes ses données liées.
 * Irréversible ; les crédits non consommés sont perdus.
 *
 * @param {number} userId Compte à supprimer.
 * @returns {void}
 * @throws {Error} `UTILISATEUR_INTROUVABLE`, `DERNIER_ADMIN` (garde anti-lock-out).
 */
export function deleteUserAccount(userId) {
  const user = getById.get(userId);
  if (!user) throw fail('UTILISATEUR_INTROUVABLE');
  // Garde-fou : ne pas supprimer le dernier administrateur (risque de lock-out).
  if (user.role === 'admin' && countAdmins.get().n <= 1) throw fail('DERNIER_ADMIN');
  deleteTx(userId);
}

/**
 * Crée un compte depuis le back-office.
 * Le compte reçoit le mot de passe par défaut du service et le drapeau
 * `must_change_password` : la valeur communiquée à l'utilisateur ne reste
 * jamais valable au-delà de sa première connexion.
 *
 * @param {Record<string, unknown>} body Champs du formulaire admin.
 * @returns {{user: object, default_password: string}}
 * @throws {Error} `CHAMPS_INVALIDES`, `EMAIL_DEJA_PRIS`.
 */
export function adminCreateUser(body) {
  const firstName = String(body?.first_name || '').trim();
  const lastName = String(body?.last_name || '').trim();
  const email = String(body?.email || '').trim().toLowerCase();
  const phone = String(body?.phone || '').trim();
  const role = body?.role === 'admin' ? 'admin' : 'member';

  if (!firstName || !lastName || !email || !phone) throw fail('CHAMPS_INVALIDES');
  if (emailExists.get(email)) throw fail('EMAIL_DEJA_PRIS');

  const displayName = `${firstName} ${lastName}`;
  const info = insertStmt.run({
    email,
    display_name: displayName,
    first_name: firstName,
    last_name: lastName,
    phone,
    password_hash: hashPassword(config.defaultUserPassword),
    role,
  });
  return {
    user: publicUser(getById.get(info.lastInsertRowid)),
    // Renvoyé pour que l'admin puisse le communiquer (l'utilisateur devra le changer).
    default_password: config.defaultUserPassword,
  };
}

/**
 * Édition complète d'un compte par un administrateur, rôle compris.
 *
 * @param {number} id Compte visé.
 * @param {Record<string, unknown>} body Champs soumis (les absents sont conservés).
 * @returns {object} Compte après mise à jour.
 * @throws {Error} `UTILISATEUR_INTROUVABLE`, `CHAMPS_INVALIDES`, `EMAIL_DEJA_PRIS`,
 *         `DERNIER_ADMIN` si l'opération retirerait le dernier administrateur.
 */
export function adminUpdateUser(id, body) {
  const user = getById.get(id);
  if (!user) throw fail('UTILISATEUR_INTROUVABLE');

  const firstName = String(body?.first_name ?? user.first_name ?? '').trim();
  const lastName = String(body?.last_name ?? user.last_name ?? '').trim();
  const email = String(body?.email ?? user.email ?? '').trim().toLowerCase();
  const phone = String(body?.phone ?? user.phone ?? '').trim();
  const role = body?.role === 'admin' ? 'admin' : body?.role === 'member' ? 'member' : user.role;

  if (!firstName || !lastName || !email || !phone) throw fail('CHAMPS_INVALIDES');
  if (emailTaken.get(email, id)) throw fail('EMAIL_DEJA_PRIS');
  // Même garde que pour la suppression : rétrograder le dernier administrateur
  // rendrait le back-office définitivement inaccessible (lock-out).
  if (user.role === 'admin' && role !== 'admin' && countAdmins.get().n <= 1) throw fail('DERNIER_ADMIN');

  const displayName = `${firstName} ${lastName}`;
  updateStmt.run({
    id,
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    role,
    display_name: displayName,
  });
  return publicUser(getById.get(id));
}
