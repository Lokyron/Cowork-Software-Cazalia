import { db } from '../db.js';

// Erreur métier normalisée (même convention que le reste : e.code -> statut HTTP).
function bizErr(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

export const PROSPECT_STATUSES = ['nouveau', 'contacte', 'journee_offerte', 'converti', 'pas_interesse'];
export const PROSPECT_ACTIVITIES = ['independant', 'salarie_teletravail', 'etudiant', 'entreprise', 'autre'];

// Sujets proposés dans le formulaire de contact / devis (liste fermée).
// ⚠ Cette liste est dupliquée côté front (`LEAD_SUBJECTS` dans
// web/src/components/ContactModal.jsx) : le dossier `web/` est construit à part et
// ne peut pas importer ce module. Les deux listes doivent rester synchronisées.
export const LEAD_SUBJECTS = [
  'Informations sur les espaces',
  'Tarifs et offres',
  'Réservation et disponibilités',
  'Location du bureau privatif (longue durée)',
  'Location de la salle de réunion',
  'Autre demande',
];

// Sujet qui déclenche le bloc « Votre besoin » (postes, durée, date de début).
export const OFFICE_SUBJECT = 'Location du bureau privatif (longue durée)';

// Durées de location proposées pour le bureau privatif (liste fermée).
// ⚠ Cette liste est dupliquée côté front (`OFFICE_DURATIONS` dans
// web/src/components/ContactModal.jsx) : le dossier `web/` est construit à part et
// ne peut pas importer ce module. Les deux listes doivent rester synchronisées.
export const OFFICE_DURATIONS = [
  '1 à 3 mois',
  '3 à 6 mois',
  '6 à 12 mois',
  '12 mois',
  "Plus d'un an",
  'Je ne sais pas encore',
];

// Valeur de `office_start` quand le visiteur veut commencer au plus tôt.
export const OFFICE_START_ASAP = 'DES_QUE_POSSIBLE';
const OFFICE_SEATS_MAX = 50;
// Date de début : au plus 3 ans dans le futur.
const OFFICE_START_MAX_YEARS = 3;

/** Date du jour à Paris au format AAAA-MM-JJ (le « aujourd'hui » du visiteur). */
function todayParis(ref = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(ref);
}

/**
 * Valide une date ISO AAAA-MM-JJ calendaire (refuse 2026-02-31) ; renvoie la chaîne ou null.
 * @param {unknown} v
 * @returns {string | null}
 */
function parseIsoDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Nettoie et valide une pré-inscription publique.
 * Toutes les longueurs sont bornées : le formulaire est accessible sans compte,
 * il constitue une surface d'insertion directe en base.
 *
 * @param {Record<string, unknown>} [input] Corps de la requête publique.
 * Pour le sujet « bureau privatif », `office_seats` (entier 1-50) et `office_duration`
 * (liste fermée) sont obligatoires, `office_start` facultatif. Pour tout autre sujet,
 * ces trois champs sont IGNORÉS et valent `null` : un appel direct à l'API ne doit pas
 * polluer la base.
 *
 * @param {Record<string, unknown>} [input] Corps de la requête publique.
 * @param {Date} [now] Instant de référence (tests de la date de début).
 * @returns {{first_name: string, last_name: string, email: string, phone: string,
 *            activity: string | null, subject: string, consent: 1,
 *            office_seats: number | null, office_duration: string | null,
 *            office_start: string | null}} Enregistrement prêt à insérer.
 * @throws {Error} `CHAMPS_INVALIDES`, `EMAIL_INVALIDE`, `TELEPHONE_INVALIDE`, `SUJET_INVALIDE`,
 *   `BESOIN_INVALIDE`, `CONSENTEMENT_REQUIS`.
 */
function sanitize(input = {}, now = new Date()) {
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
  // Sujet obligatoire, strictement dans la liste fermée (jamais de texte libre en base).
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  if (!LEAD_SUBJECTS.includes(subject)) throw bizErr('SUJET_INVALIDE');
  if (!consent) throw bizErr('CONSENTEMENT_REQUIS');

  // Bloc « Votre besoin » : uniquement pour le bureau privatif, sinon tout est ignoré.
  let office_seats = null;
  let office_duration = null;
  let office_start = null;
  if (subject === OFFICE_SUBJECT) {
    // Nombre de postes : entier strict (nombre ou chaîne de chiffres), 1 à 50.
    const rawSeats = input.office_seats;
    const seatsOk = (typeof rawSeats === 'number' && Number.isInteger(rawSeats))
      || (typeof rawSeats === 'string' && /^\d{1,3}$/.test(rawSeats.trim()));
    office_seats = seatsOk ? Number(rawSeats) : NaN;
    if (!(office_seats >= 1 && office_seats <= OFFICE_SEATS_MAX)) throw bizErr('BESOIN_INVALIDE');
    // Durée : strictement dans la liste fermée.
    office_duration = typeof input.office_duration === 'string' ? input.office_duration.trim() : '';
    if (!OFFICE_DURATIONS.includes(office_duration)) throw bizErr('BESOIN_INVALIDE');
    // Début : « dès que possible », une date AAAA-MM-JJ dans [hier, +3 ans], ou rien.
    // La veille est tolérée à dessein : le champ du formulaire borne son `min` sur
    // l'heure LOCALE du navigateur. Quelqu'un qui ouvre le formulaire à 23 h 55 et
    // valide à 00 h 02 enverrait sinon une date « d'hier » pour le serveur et se
    // verrait refuser sa demande. Une date de la veille est sans conséquence ici :
    // c'est une intention de début de location, pas une réservation de créneau.
    const rawStart = input.office_start;
    if (rawStart != null && rawStart !== '') {
      if (rawStart === OFFICE_START_ASAP) {
        office_start = OFFICE_START_ASAP;
      } else {
        const iso = parseIsoDate(rawStart);
        if (!iso) throw bizErr('BESOIN_INVALIDE');
        const today = todayParis(now);
        const floor = new Date(`${today}T00:00:00Z`);
        floor.setUTCDate(floor.getUTCDate() - 1); // tolérance d'un jour, cf. commentaire
        const limit = new Date(`${today}T00:00:00Z`);
        limit.setUTCFullYear(limit.getUTCFullYear() + OFFICE_START_MAX_YEARS);
        const min = floor.toISOString().slice(0, 10);
        if (iso < min || iso > limit.toISOString().slice(0, 10)) throw bizErr('BESOIN_INVALIDE');
        office_start = iso;
      }
    }
  }

  return { first_name, last_name, email, phone, activity, subject, consent: 1, office_seats, office_duration, office_start };
}

const insertStmt = db.prepare(
  `INSERT INTO prospects (first_name, last_name, email, phone, activity, subject, consent, source,
                          office_seats, office_duration, office_start)
   VALUES (@first_name, @last_name, @email, @phone, @activity, @subject, @consent, @source,
           @office_seats, @office_duration, @office_start)`
);

/**
 * Enregistre une pré-inscription publique.
 *
 * @param {Record<string, unknown>} input Champs du formulaire.
 * @param {string | null} [source] Origine de la saisie (page, campagne), tronquée à 120 caractères.
 * @param {Date} [now] Instant de référence (tests).
 * @returns {{id: number | bigint, data: object}} Identifiant + données nettoyées (pour l'e-mail).
 * @throws {Error} Erreur métier de validation (cf. `sanitize`).
 */
export function createProspect(input, source = null, now = new Date()) {
  const data = sanitize(input, now);
  data.source = source ? String(source).slice(0, 120) : null;
  const info = insertStmt.run(data);
  return { id: info.lastInsertRowid, data };
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
    `SELECT id, first_name, last_name, email, phone, activity, consent, status, note, source, subject, office_seats, office_duration, office_start, created_at
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
 * par un caractère déclencheur - Excel, LibreOffice et Google Sheets affichent
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
    .prepare(`SELECT first_name, last_name, email, phone, activity, status, note, source, subject,
                     office_seats, office_duration, office_start, created_at
              FROM prospects ORDER BY created_at DESC`)
    .all();
  const headers = ['Prénom', 'Nom', 'Email', 'Téléphone', 'Activité', 'Statut', 'Note', 'Source', 'Sujet', 'Postes', 'Durée', 'Début souhaité', 'Reçu le'];
  const esc = (v) => {
    const s = defuseFormula(v == null ? '' : String(v));
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(';')];
  for (const r of rows) {
    lines.push(
      [r.first_name, r.last_name, r.email, r.phone, r.activity || '', r.status, r.note || '', r.source || '', r.subject || '', r.office_seats ?? '', r.office_duration || '', r.office_start === OFFICE_START_ASAP ? 'Dès que possible' : r.office_start || '', r.created_at]
        .map(esc)
        .join(';')
    );
  }
  // BOM UTF-8 pour qu'Excel affiche correctement les accents.
  return '﻿' + lines.join('\r\n');
}
