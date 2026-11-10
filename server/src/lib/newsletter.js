// Synchronisation de la newsletter avec Brevo (liste de contacts).
//
// L'opt-in newsletter d'un membre est porté par `users.notify_marketing`. Cette
// couche reflète cet état (et les inscriptions publiques) dans une LISTE Brevo
// configurée en admin (`brevo.newsletter_list_id`) :
//   • opt-in  → crée/met à jour le contact et l'ajoute à la liste ;
//   • opt-out → retire le contact de la liste (le contact Brevo subsiste).
//
// Tout est BEST-EFFORT : une panne Brevo ne doit jamais faire échouer une
// mise à jour de profil ou une inscription. Les échecs sont journalisés.

import { db } from '../db.js';
import { getBrevo } from './settings.js';
import * as brevo from './brevo.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reflète l'état d'abonnement d'une adresse dans la liste Brevo.
 *
 * @param {object} p
 * @param {string} p.email Adresse du contact.
 * @param {boolean} p.subscribed `true` = ajouter à la liste ; `false` = retirer.
 * @param {string} [p.firstName] Prénom (attribut Brevo PRENOM).
 * @param {string} [p.lastName] Nom (attribut Brevo NOM).
 * @returns {Promise<{synced: boolean, reason?: string}>}
 */
export async function syncContact({ email, subscribed, firstName = '', lastName = '' }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(addr)) return { synced: false, reason: 'EMAIL_INVALIDE' };
  const { apiKey, newsletterListId, configured } = getBrevo();
  if (!configured || !newsletterListId) return { synced: false, reason: 'NEWSLETTER_NON_CONFIGUREE' };
  try {
    if (subscribed) {
      await brevo.upsertContact({
        apiKey, email: addr, listIds: [newsletterListId],
        attributes: { PRENOM: firstName || '', NOM: lastName || '' },
      });
    } else {
      await brevo.removeContactFromList({ apiKey, email: addr, listId: newsletterListId });
    }
    return { synced: true };
  } catch (err) {
    // Brevo renvoie 400 si l'on retire un contact qui n'est pas dans la liste
    // (ou inexistant) : ce n'est pas une anomalie pour une désinscription.
    if (!subscribed && (err.status === 400 || err.status === 404)) return { synced: true };
    console.warn(`[newsletter] sync échec (${addr}) : ${err.message}`);
    return { synced: false, reason: err.message };
  }
}

/**
 * Synchronise l'abonnement d'un membre d'après son profil courant.
 * Déclenché (sans bloquer) après une mise à jour de profil.
 *
 * @param {number} userId Membre concerné.
 * @returns {Promise<{synced: boolean, reason?: string}>}
 */
export async function syncUser(userId) {
  const u = db.prepare(
    `SELECT email, first_name, last_name, notify_marketing FROM users WHERE id = ?`
  ).get(userId);
  if (!u) return { synced: false, reason: 'UTILISATEUR_INTROUVABLE' };
  return syncContact({
    email: u.email, subscribed: !!u.notify_marketing,
    firstName: u.first_name, lastName: u.last_name,
  });
}

/**
 * Resynchronise TOUS les membres vers la liste Brevo (action admin ponctuelle) :
 * les opt-in sont ajoutés, les opt-out retirés. Séquentiel pour rester sous les
 * limites de l'API.
 *
 * @returns {Promise<{total: number, subscribed: number, ok: number, failed: number, reason?: string}>}
 */
export async function syncAllMembers() {
  const { configured, newsletterListId } = getBrevo();
  if (!configured || !newsletterListId) return { total: 0, subscribed: 0, ok: 0, failed: 0, reason: 'NEWSLETTER_NON_CONFIGUREE' };
  const rows = db.prepare(
    `SELECT email, first_name, last_name, notify_marketing FROM users WHERE role = 'member'`
  ).all();
  let ok = 0; let failed = 0; let subscribed = 0;
  for (const r of rows) {
    if (r.notify_marketing) subscribed += 1;
    // eslint-disable-next-line no-await-in-loop
    const res = await syncContact({
      email: r.email, subscribed: !!r.notify_marketing,
      firstName: r.first_name, lastName: r.last_name,
    });
    if (res.synced) ok += 1; else failed += 1;
  }
  return { total: rows.length, subscribed, ok, failed };
}
