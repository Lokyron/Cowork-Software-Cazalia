// Helpers de temps. Règle du brief §8 : on STOCKE en UTC (ISO 8601),
// on n'affiche en Europe/Paris que côté front. Ici tout est UTC.

/**
 * Normalise une entrée en chaîne UTC canonique (suffixe `Z`).
 *
 * @param {string|number|Date} value Valeur de date.
 * @returns {string} Date ISO 8601 en UTC.
 * @throws {Error} `DATE_INVALIDE` si la valeur n'est pas une date exploitable.
 */
export function toUtcIso(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const e = new Error('DATE_INVALIDE');
    e.code = 'DATE_INVALIDE';
    throw e;
  }
  return d.toISOString();
}

/**
 * Durée décimale, en heures, entre deux instants.
 * @param {string} startIso Début (ISO).
 * @param {string} endIso Fin (ISO).
 * @returns {number} Durée en heures.
 */
export function durationHours(startIso, endIso) {
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 3_600_000;
}

/**
 * Heures facturables : arrondi à l'heure supérieure, minimum 1 (brief §5.3).
 * @param {string} startIso Début (ISO).
 * @param {string} endIso Fin (ISO).
 * @returns {number} Nombre d'heures facturées.
 */
export function billedHours(startIso, endIso) {
  return Math.max(1, Math.ceil(durationHours(startIso, endIso)));
}

export function nowIso() {
  return new Date().toISOString();
}

// ── Heure locale de Paris (pour les horaires d'ouverture) ─────────────────────
const PARIS = 'Europe/Paris';
const _wdFmt = new Intl.DateTimeFormat('en-US', { timeZone: PARIS, weekday: 'short' });
const _hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: PARIS, hour: '2-digit', minute: '2-digit', hour12: false });
const _WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Jour de semaine (0=dim … 6=sam) d'un ISO, en heure de Paris.
export function parisWeekday(iso) {
  return _WD[_wdFmt.format(new Date(iso))];
}

// Minutes depuis minuit (heure de Paris) d'un ISO.
export function parisMinutes(iso) {
  const [h, m] = _hmFmt.format(new Date(iso)).split(':').map(Number);
  return h * 60 + m;
}

const _dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: PARIS, year: 'numeric', month: '2-digit', day: '2-digit' });
const _utcPartsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: PARIS, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/**
 * Début du jour civil de Paris (minuit local), exprimé en UTC.
 *
 * Sert à compter les envois « du jour » : les horodatages du journal sont en
 * UTC, les comparer à `date('now')` compterait le jour UTC — décalé d'une à deux
 * heures, donc faux en soirée (un envoi de 23 h 30 serait compté le lendemain).
 *
 * @param {Date} [ref] Instant de référence (injectable pour les tests).
 * @returns {string} Horodatage SQLite UTC `YYYY-MM-DD HH:MM:SS`.
 */
export function parisDayStartUtc(ref = new Date()) {
  // Décalage de Paris à cet instant (gère l'heure d'été sans table de fuseaux).
  const p = Object.fromEntries(
    _utcPartsFmt.formatToParts(ref).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)])
  );
  const offsetMs = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - ref.getTime();
  const [y, m, d] = _dayFmt.format(ref).split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d) - offsetMs);
  return start.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Indique si une annulation ouvre droit à remboursement, c'est-à-dire si elle
 * intervient plus de `windowHours` avant le début du créneau.
 *
 * @param {string} startIso Début du créneau (ISO).
 * @param {number} windowHours Fenêtre de remboursement, en heures.
 * @param {Date} [ref] Instant de référence (injectable pour les tests).
 * @returns {boolean}
 */
export function isBeforeRefundWindow(startIso, windowHours, ref = new Date()) {
  const limit = new Date(startIso).getTime() - windowHours * 3_600_000;
  return ref.getTime() <= limit;
}

// Bornes d'une période de relevé : au-delà, le PDF n'a plus de sens et le
// calcul devient coûteux (parcours complet du grand-livre).
const MAX_PERIOD_DAYS = 800;

/**
 * Valide et normalise une période de relevé fournie en paramètres de requête.
 *
 * Sans ce contrôle, une date malformée provoquait une `RangeError` DANS la
 * génération du PDF, donc APRÈS l'envoi des en-têtes HTTP : le client recevait
 * un fichier tronqué au lieu d'une erreur exploitable (CWE-20).
 *
 * @param {unknown} fromRaw Début de période.
 * @param {unknown} toRaw Fin de période (exclue).
 * @returns {{fromIso: string, toIso: string}} Période normalisée en UTC.
 * @throws {Error} `PERIODE_INVALIDE` si une borne est absente, illisible,
 *         inversée, ou si l'intervalle dépasse la durée maximale.
 */
export function parsePeriod(fromRaw, toRaw) {
  if (typeof fromRaw !== 'string' || typeof toRaw !== 'string' || !fromRaw || !toRaw) {
    const e = new Error('PERIODE_INVALIDE');
    e.code = 'PERIODE_INVALIDE';
    throw e;
  }
  const from = new Date(fromRaw);
  const to = new Date(toRaw);
  const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || spanDays <= 0 || spanDays > MAX_PERIOD_DAYS) {
    const e = new Error('PERIODE_INVALIDE');
    e.code = 'PERIODE_INVALIDE';
    throw e;
  }
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}
