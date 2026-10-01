// Affichage en Europe/Paris (brief §8). Les valeurs en base sont en UTC.
const PARIS = 'Europe/Paris';

// Normalise une valeur date en Date. Les colonnes `created_at` (SQLite
// datetime('now')) arrivent au format UTC naïf "YYYY-MM-DD HH:MM:SS" SANS
// indicateur de fuseau : JS les parserait comme heure LOCALE → décalage.
// On force l'interprétation UTC en ajoutant 'Z'. Les ISO déjà suffixés (…Z /
// +00:00) ou les Date passent inchangés.
export function toDate(value) {
  if (value instanceof Date) return value;
  let s = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  return new Date(s);
}

const dtf = new Intl.DateTimeFormat('fr-FR', {
  timeZone: PARIS,
  dateStyle: 'medium',
  timeStyle: 'short',
});
const tf = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, dateStyle: 'full' });

export const fmtDateTime = (iso) => dtf.format(toDate(iso));
export const fmtTime = (iso) => tf.format(toDate(iso));
export const fmtDate = (iso) => df.format(toDate(iso));

// Construit un ISO UTC à partir d'une date (yyyy-mm-dd) et heure locale Paris (HH:mm).
// Technique « guess » : indépendante du fuseau de la machine, correcte été/hiver.
export function parisLocalToUtcIso(dateStr, timeStr) {
  // On lit d'abord la wall-clock comme si elle était en UTC.
  const guess = new Date(`${dateStr}T${timeStr}:00Z`);
  // Décalage réel de Paris à cet instant (asParis et asUtc sont lus dans le MÊME
  // fuseau machine, donc l'offset machine s'annule à la soustraction).
  const asParis = new Date(guess.toLocaleString('en-US', { timeZone: PARIS }));
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  const parisOffsetMs = asParis.getTime() - asUtc.getTime();
  return new Date(guess.getTime() - parisOffsetMs).toISOString();
}

export const todayStr = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: PARIS }).format(new Date());
  return parts; // yyyy-mm-dd
};

// ── Helpers calendrier (tout en Europe/Paris) ────────────────────────────────
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: PARIS }); // yyyy-mm-dd
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: PARIS, hour: '2-digit', minute: '2-digit', hour12: false });
const weekdayFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, weekday: 'short' });
const dayNumFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, day: 'numeric', month: 'short' });

// Clé jour (yyyy-mm-dd) d'un instant ISO, en heure de Paris.
export const parisDateKey = (iso) => dayKeyFmt.format(toDate(iso));

// Minutes depuis minuit (heure de Paris) d'un instant ISO.
export function parisMinutes(iso) {
  const [h, m] = hmFmt.format(toDate(iso)).split(':');
  return Number(h) * 60 + Number(m);
}

// 'HH:MM' (heure de Paris) — pour pré-remplir un <input type="time">.
export const parisTimeHM = (iso) => hmFmt.format(toDate(iso));

export const weekdayLabel = (dateStr) => weekdayFmt.format(new Date(`${dateStr}T12:00:00Z`));
export const dayNumLabel = (dateStr) => dayNumFmt.format(new Date(`${dateStr}T12:00:00Z`));

// Arithmétique sur chaînes yyyy-mm-dd (midi UTC pour éviter les bords DST).
export function addDaysStr(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Lundi de la semaine contenant dateStr.
export function startOfWeekStr(dateStr) {
  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0=dim..6=sam
  const offset = (dow + 6) % 7; // jours depuis lundi
  return addDaysStr(dateStr, -offset);
}
