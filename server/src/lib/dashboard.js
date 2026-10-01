import { db } from '../db.js';

const PARIS = 'Europe/Paris';
const OPEN_HOURS = 12; // fenêtre d'ouverture retenue pour le taux d'occupation (07h–19h)

const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: PARIS });
const weekdayFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, weekday: 'narrow' });

const parisDayKey = (d) => dayKeyFmt.format(d);
const weekdayNarrow = (dateStr) => weekdayFmt.format(new Date(`${dateStr}T12:00:00Z`));

/**
 * Instant UTC correspondant au début d'un jour donné, en heure de Paris.
 * Technique dite « guess » : on compare l'interprétation de la même date dans
 * les deux fuseaux pour en déduire le décalage réel — donc correcte au passage
 * à l'heure d'été, contrairement à un décalage fixe.
 *
 * @param {string} dateStr Date au format `YYYY-MM-DD`.
 * @param {string} [timeStr] Heure locale `HH:MM`.
 * @returns {string} Instant ISO/UTC.
 */
function parisToUtc(dateStr, timeStr = '00:00') {
  const guess = new Date(`${dateStr}T${timeStr}:00Z`);
  const asParis = new Date(guess.toLocaleString('en-US', { timeZone: PARIS }));
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (asParis.getTime() - asUtc.getTime())).toISOString();
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const hoursBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;

/**
 * Taux d'occupation sur une fenêtre : heures réservées / heures-capacité.
 * L'assiette de capacité retient `OPEN_HOURS` heures d'ouverture par jour et par
 * espace ; le taux n'a donc de sens que rapporté à cette convention.
 *
 * @param {object[]} reservations Réservations confirmées de la période.
 * @param {object[]} spaces Espaces actifs.
 * @param {string} startKey Premier jour inclus (`YYYY-MM-DD`, heure de Paris).
 * @param {string} endKeyExcl Jour de fin, exclu.
 * @param {number} days Nombre de jours de la fenêtre.
 * @returns {{rate: number, per: object[]}} Taux global et détail par espace.
 */
function occupancy(reservations, spaces, startKey, endKeyExcl, days) {
  const startUtc = parisToUtc(startKey);
  const endUtc = parisToUtc(endKeyExcl);
  const booked = {};
  for (const r of reservations) {
    if (r.start_at >= startUtc && r.start_at < endUtc) {
      booked[r.space_id] = (booked[r.space_id] || 0) + hoursBetween(r.start_at, r.end_at);
    }
  }
  let bookedTotal = 0;
  let capTotal = 0;
  const per = [];
  for (const s of spaces) {
    const b = booked[s.id] || 0;
    const cap = s.capacity * OPEN_HOURS * days;
    bookedTotal += b;
    capTotal += cap;
    per.push({ id: s.id, name: s.name, color: s.color, kind: s.kind, pct: cap ? Math.round(Math.min(100, (b / cap) * 100)) : 0 });
  }
  return { overall: capTotal ? Math.round(Math.min(100, (bookedTotal / capTotal) * 100)) : 0, per };
}

/**
 * Agrège les indicateurs du tableau de bord administrateur.
 * Ne renvoie que des AGRÉGATS : aucune donnée nominative de membre n'y figure.
 *
 * @returns {object} Indicateurs (occupation, chiffre d'affaires, tendances).
 */
export function getDashboardStats() {
  const now = new Date();
  const nowIso = now.toISOString();
  const today = parisDayKey(now);
  const todayStart = parisToUtc(today);
  const tomorrowStart = parisToUtc(addDays(today, 1));
  const yesterdayStart = parisToUtc(addDays(today, -1));
  const monthStart = parisToUtc(today.slice(0, 8) + '01');
  const win14Start = parisToUtc(addDays(today, -13));
  const days30Ago = parisToUtc(addDays(today, -30));

  const spaces = db
    .prepare(`SELECT id, name, color, kind, capacity FROM spaces WHERE active = 1 ORDER BY kind, name`)
    .all();

  // Réservations confirmées des 14 derniers jours (couvre KPIs jour, occupation, histogramme, à-venir).
  const res = db
    .prepare(
      `SELECT r.id, r.user_id, r.space_id, r.start_at, r.end_at,
              s.name AS space_name, s.color AS space_color, u.display_name AS member_name
         FROM reservations r
         JOIN spaces s ON s.id = r.space_id
         JOIN users  u ON u.id = r.user_id
        WHERE r.status = 'confirmed' AND r.start_at >= ? AND r.start_at < ?`
    )
    .all(win14Start, tomorrowStart);

  const inRange = (r, a, b) => r.start_at >= a && r.start_at < b;
  const reservationsToday = res.filter((r) => inRange(r, todayStart, tomorrowStart)).length;
  const reservationsYesterday = res.filter((r) => inRange(r, yesterdayStart, todayStart)).length;

  // Histogramme 14 jours.
  const counts = {};
  for (const r of res) counts[parisDayKey(new Date(r.start_at))] = (counts[parisDayKey(new Date(r.start_at))] || 0) + 1;
  const bookings14 = [];
  for (let k = -13; k <= 0; k++) {
    const day = addDays(today, k);
    bookings14.push({ day, label: weekdayNarrow(day), count: counts[day] || 0 });
  }

  const occ7 = occupancy(res, spaces, addDays(today, -6), addDays(today, 1), 7);
  const occPrev7 = occupancy(res, spaces, addDays(today, -13), addDays(today, -6), 7);

  // À venir aujourd'hui.
  const upcoming = res
    .filter((r) => inRange(r, todayStart, tomorrowStart) && r.end_at > nowIso)
    .sort((a, b) => a.start_at.localeCompare(b.start_at))
    .slice(0, 6)
    .map((r) => ({ id: r.id, start_at: r.start_at, end_at: r.end_at, space_name: r.space_name, space_color: r.space_color, member_name: r.member_name }));

  // Membres + soldes.
  const members = db
    .prepare(
      `SELECT u.id, u.display_name, u.created_at, COALESCE(SUM(ct.amount), 0) AS balance
         FROM users u LEFT JOIN credit_transactions ct ON ct.user_id = u.id
        WHERE u.role = 'member'
        GROUP BY u.id, u.display_name, u.created_at`
    )
    .all();
  const monthStartDate = new Date(monthStart);
  const newMembersMonth = members.filter((m) => new Date(m.created_at.replace(' ', 'T') + 'Z') >= monthStartDate).length;
  const recentMembers = [...members]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5)
    .map((m) => ({ id: m.id, display_name: m.display_name, created_at: m.created_at, balance: m.balance }));
  const lowCreditMembers = members
    .filter((m) => m.balance < 5)
    .sort((a, b) => a.balance - b.balance)
    .slice(0, 5)
    .map((m) => ({ id: m.id, display_name: m.display_name, balance: m.balance }));

  const activeMembers = db
    .prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM reservations WHERE status = 'confirmed' AND start_at >= ?`)
    .get(days30Ago).n;

  const month = db
    .prepare(
      `SELECT COALESCE(SUM(amount_eur_cents), 0) AS cents, COALESCE(SUM(amount), 0) AS credits
         FROM credit_transactions
        WHERE reason = 'topup' AND datetime(created_at) >= datetime(?)`
    )
    .get(monthStart);
  const creditsOutstanding = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM credit_transactions`).get().n;

  return {
    today,
    kpis: {
      reservations_today: reservationsToday,
      reservations_yesterday: reservationsYesterday,
      occupancy7: occ7.overall,
      occupancy_prev7: occPrev7.overall,
      active_members: activeMembers,
      total_members: members.length,
      new_members_month: newMembersMonth,
      revenue_month_eur: month.cents / 100,
      credits_sold_month: month.credits,
      credits_outstanding: creditsOutstanding,
    },
    bookings14,
    occupancy_by_space: occ7.per,
    upcoming_today: upcoming,
    recent_members: recentMembers,
    low_credit_members: lowCreditMembers,
  };
}
