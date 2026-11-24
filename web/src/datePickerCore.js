// Logique PURE du sélecteur de jour (aucune dépendance React ni navigateur) :
// calendrier sur chaînes `YYYY-MM-DD` et état d'un jour. Extraite de
// `components/DatePicker.jsx` pour être testée directement sous `node --test`.
//
// Jamais de fuseau ici : un jour civil est une chaîne ; `Date.UTC` ne sert qu'à
// connaître la longueur d'un mois ou le jour de la semaine. Seule exception, `formuleOf`,
// qui lit l'heure de début d'une réservation en heure de Paris (`time.js`).

import { parisMinutes } from './time.js';

export const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

export const pad = (n) => String(n).padStart(2, '0');
export const mkIso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`; // m : 0..11
export const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m: m - 1, d }; };
export const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
export const weekday = (s) => { const p = parseIso(s); return new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay(); }; // 0 = dimanche
export const fmtFR = (s) => { const p = parseIso(s); return `${pad(p.d)}/${pad(p.m + 1)}/${p.y}`; };

/** `jj/mm/aaaa` -> `YYYY-MM-DD`, ou `null` si ce n'est pas une date qui existe. */
export function parseFR(t) {
  const r = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(t).trim());
  if (!r) return null;
  const d = Number(r[1]); const m = Number(r[2]); const y = Number(r[3]);
  if (m < 1 || m > 12 || y < 1900 || d < 1 || d > daysIn(y, m - 1)) return null;
  return mkIso(y, m - 1, d);
}

export const longLabel = (s) => {
  const p = parseIso(s);
  return `${WEEKDAYS[weekday(s)]} ${p.d === 1 ? '1er' : p.d} ${MONTHS[p.m]} ${p.y}`;
};

/**
 * État d'un jour du calendrier.
 *
 * @param {string} s Jour `YYYY-MM-DD`.
 * @param {object} ctx
 * @param {string} [ctx.lo] Borne basse incluse (`''` = aucune).
 * @param {string} [ctx.hi] Borne haute incluse (`''` = aucune).
 * @param {boolean} [ctx.permissive] Écrans admin : fermé / complet / passé restent sélectionnables.
 * @param {'neutral'|'loading'|'unknown'|'ready'} [ctx.state] Connaissance des disponibilités :
 *   - `neutral` : aucune disponibilité demandée (ou espace sans disponibilités publiques).
 *     Seules `lo` / `hi` limitent le choix. La règle « dimanche fermé » est une règle de
 *     CRÉNEAU : elle vient du serveur (`status: 'closed'`), jamais déduite du jour de la
 *     semaine ici. Une date de début de location (devis) peut tomber un dimanche ;
 *   - `loading` : réponse attendue, aucune promesse de disponibilité, pas de choix ;
 *   - `unknown` : la réponse n'est pas venue (erreur, limiteur) : on ne SAIT pas, le jour
 *     n'est pas présenté comme libre, mais il reste choisissable (le serveur revalide
 *     à la réservation) ;
 *   - `ready` : `rec` = `{status, left}` du serveur.
 * @param {{status: string, left: number|null}} [ctx.rec] Enregistrement du serveur.
 * @param {boolean} [ctx.exclusive] Espace exclusif (salle) : « réservé », pas « complet ».
 * @returns {{k: string, sel: boolean, why?: string, rec?: object, left?: number|null}}
 */
export function dayInfo(s, ctx = {}) {
  const { lo = '', hi = '', permissive = false, state = 'neutral', rec, exclusive = false } = ctx;
  if (lo && s < lo) return { k: 'disabled', sel: false, why: 'Cette date est passée.' };
  if (hi && s > hi) return { k: 'disabled', sel: false, why: `Trop lointain : dernière date possible le ${fmtFR(hi)}.` };
  if (state === 'ready' && rec) {
    if (rec.status === 'past') return { k: 'disabled', sel: permissive, why: 'Cette date est passée.', rec };
    if (rec.status === 'closed') return { k: 'closed', sel: permissive, why: 'Fermé ce jour-là.', rec };
    if (rec.status === 'full') return { k: 'full', sel: permissive, why: exclusive ? 'Ce jour est réservé.' : 'Ce jour est complet.', rec };
    if (rec.status === 'partial') return { k: 'partial', sel: true, rec, left: rec.left };
    return { k: 'open', sel: true, rec };
  }
  if (state === 'loading') return { k: 'pending', sel: permissive, why: 'Disponibilités en cours de chargement.' };
  if (state === 'unknown') return { k: 'unknown', sel: true };
  return { k: 'neutral', sel: true };
}

// Formule de la réservation déplacée, pour le calendrier de déplacement : le calendrier
// doit évaluer la MÊME formule que la réservation (un forfait journée s'évalue sur la
// fenêtre du forfait, pas sur « le meilleur instant de la journée »).
//   • `tarif_type` vient de la ligne `reservations` (colonne nullable : NULL = héritage ou
//     tarif horaire → 'heure').
//   • La demi-journée ne porte pas son créneau en base : on le déduit de l'heure de début
//     (avant midi = matin), comme `windowsFor` côté serveur. Fiable tant que la réservation
//     est restée sur sa fenêtre forfaitaire ; un déplacement manuel antérieur à une heure
//     libre peut fausser le couple (le calendrier reste alors indicatif : le serveur
//     revalide le déplacement).
export function formuleOf(r) {
  const tarifType = r.tarif_type === 'journee' || r.tarif_type === 'demi_journee' ? r.tarif_type : 'heure';
  const slot = tarifType === 'demi_journee' && r.start_at ? (parisMinutes(r.start_at) < 12 * 60 ? 'matin' : 'aprem') : undefined;
  return { tarifType, slot };
}
