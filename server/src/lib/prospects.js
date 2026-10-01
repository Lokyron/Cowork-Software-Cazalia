import { db } from '../db.js';

// Erreur métier normalisée (même convention que le reste : e.code -> statut HTTP).
function bizErr(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

export const PROSPECT_STATUSES = ['nouveau', 'contacte', 'journee_offerte', 'converti', 'pas_interesse'];
export const PROSPECT_ACTIVITIES = ['independant', 'salarie_teletravail', 'etudiant', 'entreprise', 'autre'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Nettoie et valide une pré-inscription publique.
 * Toutes les longueurs sont bornées : le formulaire est accessible sans compte,
 * il constitue une surface d'insertion directe en base.
 *
 * @param {Record<string, unknown>} [input] Corps de la requête publique.
 * @returns {{first_name: string, last_name: string, email: string, phone: string,
 *            activity: string | null, consent: 1}} Enregistrement prêt à insérer.
 * @throws {Error} `CHAMPS_INVALIDES`, `EMAIL_INVALIDE`, `TELEPHONE_INVALIDE`, `CONSENTEMENT_REQUIS`.
 */
function sanitize(input = {}) {
  const first_name = String(input.first_name ?? '').trim();
  const last_name = String(input.last_name ?? '').trim();
  const email = String(input.email ?? '').trim().toLowerCase();
  const phone = String(input.phone ?? '').trim();
  let activity = input.activity == null ? null : String(input.activity).trim();
  const consent = input.consent === true || input.consent === 1 || input.consent === 'on';

  if (!first_name || !last_name || first_name.length > 80 || last_name.length > 80) throw bizErr('CHAMPS_INVALIDES');
  if (!EMAIL_RE.test(email) || email.length > 160) throw bizErr('EMAIL_INVALIDE');
  // Téléphone : 6 à 20 caractères, chiffres + séparateurs usuels.
  const phoneDigits = phone.replace(/[^\d]/g, '');
  if (phoneDigits.length < 6 || phoneDigits.length > 15 || !/^[\d\s+().-]{6,20}$/.test(phone)) {
    throw bizErr('TELEPHONE_INVALIDE');
  }
  if (activity) {
    if (!PROSPECT_ACTIVITIES.includes(activity)) activity = 'autre';
  } else {
    activity = null;
  }
  if (!consent) throw bizErr('CONSENTEMENT_REQUIS');

  return { first_name, last_name, email, phone, activity, consent: 1 };
}

const insertStmt = db.prepare(
  `INSERT INTO prospects (first_name, last_name, email, phone, activity, consent, source)
   VALUES (@first_name, @last_name, @email, @phone, @activity, @consent, @source)`
);

/**
 * Enregistre une pré-inscription publique.
 *
 * @param {Record<string, unknown>} input Champs du formulaire.
 * @param {string | null} [source] Origine de la saisie (page, campagne), tronquée à 120 caractères.
 * @returns {{id: number | bigint}} Identifiant du prospect créé.
 * @throws {Error} Erreur métier de validation (cf. `sanitize`).
 */
export function createProspect(input, source = null) {
  const data = sanitize(input);
  data.source = source ? String(source).slice(0, 120) : null;
  const info = insertStmt.run(data);
  return { id: info.lastInsertRowid };
}

/**
 * Liste les prospects, filtrés pour le back-office.
 * La recherche libre est passée en PARAMÈTRE nommé (`@q`) et le statut est
 * validé contre une liste blanche : aucune concaténation de valeur dans le SQL.
 *
 * @param {{q?: string, status?: string}} [filters]
 * @returns {object[]} Prospects, du plus récent au plus ancien.
 */
export function listProspects({ q, status } = {}) {
  const where = [];
  const params = {};
  if (status && PROSPECT_STATUSES.includes(status)) {
    where.push('status = @status');
    params.status = status;
  }
  if (q && q.trim()) {
    where.push('(first_name LIKE @q OR last_name LIKE @q OR email LIKE @q OR phone LIKE @q)');
    params.q = `%${q.trim()}%`;
  }
  const sql =
    `SELECT id, first_name, last_name, email, phone, activity, consent, status, note, source, created_at
     FROM prospects ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC`;
  return db.prepare(sql).all(params);
}

/**
 * Compteurs par statut pour les indicateurs du back-office.
 * @returns {Record<string, number>} Un compteur par statut, plus `total`.
 */
export function countsByStatus() {
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM prospects GROUP BY status`).all();
  const counts = { total: 0 };
  for (const s of PROSPECT_STATUSES) counts[s] = 0;
  for (const r of rows) {
    counts[r.status] = r.n;
    counts.total += r.n;
  }
  return counts;
}

/**
 * Change le statut de suivi d'un prospect.
 * @param {number} id Prospect visé.
 * @param {string} status Statut, obligatoirement dans `PROSPECT_STATUSES`.
 * @returns {void}
 * @throws {Error} `STATUT_INVALIDE`, `PROSPECT_INTROUVABLE`.
 */
export function setProspectStatus(id, status) {
  if (!PROSPECT_STATUSES.includes(status)) throw bizErr('STATUT_INVALIDE');
  const info = db.prepare(`UPDATE prospects SET status = ? WHERE id = ?`).run(status, id);
  if (info.changes === 0) throw bizErr('PROSPECT_INTROUVABLE');
}

/**
 * Enregistre la note de suivi d'un prospect (tronquée à 2000 caractères).
 * @param {number} id Prospect visé.
 * @param {string | null} note Note libre, ou `null` pour l'effacer.
 * @returns {void}
 * @throws {Error} `PROSPECT_INTROUVABLE`.
 */
export function setProspectNote(id, note) {
  const clean = note == null ? null : String(note).slice(0, 2000);
  const info = db.prepare(`UPDATE prospects SET note = ? WHERE id = ?`).run(clean, id);
  if (info.changes === 0) throw bizErr('PROSPECT_INTROUVABLE');
}

/**
 * Supprime définitivement un prospect.
 * @param {number} id Prospect visé.
 * @returns {void}
 * @throws {Error} `PROSPECT_INTROUVABLE`.
 */
export function deleteProspect(id) {
  const info = db.prepare(`DELETE FROM prospects WHERE id = ?`).run(id);
  if (info.changes === 0) throw bizErr('PROSPECT_INTROUVABLE');
}

/**
 * Neutralise une cellule susceptible d'être interprétée comme une FORMULE par
 * un tableur (injection de formule CSV, CWE-1236).
 *
 * Les prospects sont saisis publiquement, sans authentification : un prénom
 * valant `=cmd|'/c calc'!A1` s'exécuterait à l'ouverture du fichier sur le poste
 * de l'administrateur. On préfixe donc d'une apostrophe toute cellule commençant
 * par un caractère déclencheur — Excel, LibreOffice et Google Sheets affichent
 * alors le texte tel quel, sans l'évaluer.
 *
 * @param {string} value Contenu brut de la cellule.
 * @returns {string} Contenu neutralisé.
 */
function defuseFormula(value) {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * Génère l'export CSV de toutes les pré-inscriptions.
 * Séparateur `;` et BOM UTF-8 : réglages attendus par Excel en configuration française.
 *
 * @returns {string} Contenu du fichier CSV.
 */
export function exportCsv() {
  const rows = db
    .prepare(`SELECT first_name, last_name, email, phone, activity, status, note, source, created_at
              FROM prospects ORDER BY created_at DESC`)
    .all();
  const headers = ['Prénom', 'Nom', 'Email', 'Téléphone', 'Activité', 'Statut', 'Note', 'Source', 'Reçu le'];
  const esc = (v) => {
    const s = defuseFormula(v == null ? '' : String(v));
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(';')];
  for (const r of rows) {
    lines.push(
      [r.first_name, r.last_name, r.email, r.phone, r.activity || '', r.status, r.note || '', r.source || '', r.created_at]
        .map(esc)
        .join(';')
    );
  }
  // BOM UTF-8 pour qu'Excel affiche correctement les accents.
  return '﻿' + lines.join('\r\n');
}
