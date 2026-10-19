// Module d'envoi d'e-mails : deux fournisseurs interchangeables (relais SMTP via
// nodemailer, ou API HTTP Brevo), moteur de templates {{variable}}, layout
// responsive, plafond d'envois quotidien, journalisation (email_log) et respect
// des préférences de notification.
//
// Le choix du fournisseur se fait dans /admin/emails ; TOUT passe par `sendMail`,
// unique point de sortie — c'est là que se branchent le quota et le journal.
//
// DÉGRADABLE : un échec d'envoi ne lève jamais vers l'appelant métier (réservation, etc.).

import nodemailer from 'nodemailer';
import { db } from '../db.js';
import { config } from '../config.js';
import { getSmtp, getArrival, getMail, getBrevo, getSender } from './settings.js';
import { wrapHtml, voucherBox } from './emailTemplates.js';
import { escapeHtml, headerSafe } from './html.js';
import { parisDayStartUtc } from './time.js';
import * as brevo from './brevo.js';

const PARIS = 'Europe/Paris';
const dateFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const hmFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = (iso) => dateFmt.format(new Date(iso));
const fmtTime = (iso) => hmFmt.format(new Date(iso));

const baseUrl = () => (config.publicBaseUrl || 'https://cowork.example.com').replace(/\/$/, '');
// Logo d'en-tête des e-mails : PNG transparent (SVG non supporté par la plupart des
// clients mail), servi en URL absolue depuis le front.
const logoUrl = () => `${baseUrl()}/images/logo-email.png`;

// ── Transport ────────────────────────────────────────────────────────────────
/**
 * Indique si le fournisseur sélectionné est exploitable.
 * @returns {boolean}
 */
export function isMailConfigured() {
  const { provider } = getMail();
  if (provider === 'brevo') return Boolean(getBrevo().configured && getSender().fromEmail);
  return getSmtp().configured;
}

function buildTransport() {
  const s = getSmtp();
  if (!s.configured) return null;
  const opts = { host: s.host, port: s.port };
  if (s.secureMode === 'ssl') opts.secure = true;            // 465
  else { opts.secure = false; if (s.secureMode === 'starttls') opts.requireTLS = true; }
  if (s.user || s.pass) opts.auth = { user: s.user, pass: s.pass };
  return nodemailer.createTransport(opts);
}

function fromHeader() {
  const s = getSender();
  return s.fromName ? `${s.fromName} <${s.fromEmail}>` : s.fromEmail;
}

// ── Interpolation & rendu ────────────────────────────────────────────────────

/**
 * Remplace les marqueurs `{{variable}}` d'un gabarit par leurs valeurs.
 *
 * @param {string} str Gabarit (le HTML du gabarit lui-même est de confiance :
 *        il n'est éditable que depuis le back-office administrateur).
 * @param {Record<string, unknown>} vars Valeurs à injecter — TOUJOURS échappées.
 * @param {{raw?: string[]}} [options] `raw` liste les variables dont la valeur est
 *        du HTML délibéré, construit par l'application (jamais par un utilisateur).
 * @returns {string} Gabarit rendu.
 */
export function interpolate(str, vars, options = {}) {
  const raw = new Set(options.raw || []);
  return String(str || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    if (vars[k] == null) return '';
    return raw.has(k) ? String(vars[k]) : escapeHtml(vars[k]);
  });
}

/**
 * Interpole un gabarit destiné à du TEXTE BRUT (sujet d'e-mail) : pas
 * d'échappement HTML — qui afficherait « &amp; » au lieu de « & » — mais
 * suppression des retours à la ligne, qui permettraient d'injecter des en-têtes
 * SMTP arbitraires.
 *
 * @param {string} str Gabarit.
 * @param {Record<string, unknown>} vars Valeurs à injecter.
 * @returns {string} Texte rendu, sur une seule ligne.
 */
export function interpolateText(str, vars) {
  return headerSafe(
    String(str || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? headerSafe(vars[k]) : ''))
  );
}

const getTemplateStmt = db.prepare(`SELECT * FROM email_templates WHERE code = ?`);

/**
 * Rend un gabarit enregistré (sujet + HTML complet avec la mise en page).
 *
 * `{{wifi_block}}` est substitué AVANT l'interpolation générale : c'est un
 * fragment HTML construit par l'application (encart voucher), pas une donnée
 * utilisateur — il est donc injecté tel quel, ses propres variables ayant été
 * échappées au passage.
 *
 * @param {string} code Code du gabarit (`booking_confirmation`, `password_reset`…).
 * @param {Record<string, unknown>} [vars] Variables du gabarit.
 * @returns {{subject: string, html: string} | null} `null` si le gabarit n'existe pas.
 */
export function renderTemplate(code, vars = {}) {
  const t = getTemplateStmt.get(code);
  if (!t) return null;
  const full = { site_name: 'Cazalia', wifi_ssid: getArrival().wifi_ssid, ...vars };
  const wifiBlock = full.wifi_voucher ? interpolate(voucherBox, full) : '';
  const bodyRaw = interpolate(t.body_html.replace(/\{\{\s*wifi_block\s*\}\}/g, wifiBlock), full);
  const subject = interpolateText(t.subject, full);
  const html = wrapHtml({ title: subject, content: bodyRaw, siteName: full.site_name, logoUrl: logoUrl() });
  return { subject, html };
}

/**
 * Rend un couple sujet/corps fourni à la volée (prévisualisation, envoi manuel).
 * Le corps HTML provient du back-office administrateur ; les variables, elles,
 * restent échappées.
 *
 * @param {string} subject Sujet, avec marqueurs `{{variable}}`.
 * @param {string} bodyHtml Corps HTML, avec marqueurs `{{variable}}`.
 * @param {Record<string, unknown>} [vars] Variables du gabarit.
 * @returns {{subject: string, html: string}}
 */
export function renderRaw(subject, bodyHtml, vars = {}) {
  const full = { site_name: 'Cazalia', wifi_ssid: getArrival().wifi_ssid, ...vars };
  const wifiBlock = full.wifi_voucher ? interpolate(voucherBox, full) : '';
  const body = interpolate(String(bodyHtml).replace(/\{\{\s*wifi_block\s*\}\}/g, wifiBlock), full);
  const renderedSubject = interpolateText(subject, full);
  return {
    subject: renderedSubject,
    html: wrapHtml({ title: renderedSubject, content: body, siteName: full.site_name, logoUrl: logoUrl() }),
  };
}

// ── Journalisation ───────────────────────────────────────────────────────────
const logStmt = db.prepare(
  `INSERT INTO email_log (to_email, to_user_id, template_code, subject, status, error, provider, message_id)
   VALUES (@to_email, @to_user_id, @template_code, @subject, @status, @error, @provider, @message_id)`
);
const logEmail = (row) => {
  try {
    logStmt.run({ to_user_id: null, template_code: null, subject: null, error: null, provider: null, message_id: null, ...row });
  } catch { /* ignore */ }
};

// ── Plafond d'envois quotidien ───────────────────────────────────────────────
// Motivation : l'offre gratuite Brevo plafonne à 300 e-mails par jour. Sans
// garde-fou, une campagne de 300 messages épuiserait le quota et le PREMIER
// client à demander une réinitialisation de mot de passe se retrouverait bloqué
// dehors, sans trace visible. On réserve donc une part du plafond aux messages
// non commerciaux, et on refuse les envois de masse avant d'atteindre le mur.
const countSentTodayStmt = db.prepare(
  // 'skipped' n'a jamais quitté l'application ; 'failed' n'a pas été accepté par
  // le fournisseur : ni l'un ni l'autre ne consomme le quota.
  `SELECT COUNT(*) AS n FROM email_log WHERE created_at >= ? AND status NOT IN ('skipped', 'failed')`
);

/**
 * Classe un message pour l'application du plafond.
 * `password_reset` est « critique » : il doit partir même quand le quota du jour
 * est entamé, sous peine de verrouiller un client hors de son compte.
 *
 * @param {string | null} templateCode Code du gabarit.
 * @param {boolean} marketing Envoi commercial (campagne, envoi manuel de masse).
 * @returns {'critical' | 'marketing' | 'transactional'}
 */
function mailKind(templateCode, marketing) {
  if (templateCode === 'password_reset') return 'critical';
  if (marketing || templateCode === 'manual') return 'marketing';
  return 'transactional';
}

/**
 * État du quota du jour (jour civil de Paris).
 *
 * @returns {{provider: string, dailyLimit: number, marketingReserve: number,
 *            sentToday: number, remaining: number | null, marketingRemaining: number | null}}
 *          `remaining` vaut `null` quand aucun plafond n'est fixé.
 */
export function getQuota() {
  const { provider, dailyLimit, marketingReserve } = getMail();
  const sentToday = countSentTodayStmt.get(parisDayStartUtc()).n;
  return {
    provider, dailyLimit, marketingReserve, sentToday,
    remaining: dailyLimit ? Math.max(0, dailyLimit - sentToday) : null,
    marketingRemaining: dailyLimit ? Math.max(0, dailyLimit - marketingReserve - sentToday) : null,
  };
}

/**
 * Vérifie le plafond avant un envoi.
 *
 * @param {'critical' | 'marketing' | 'transactional'} kind Nature du message.
 * @returns {string | null} Code de refus, ou `null` si l'envoi est autorisé.
 */
function quotaRefusal(kind) {
  const { dailyLimit, marketingReserve, sentToday } = getQuota();
  if (!dailyLimit) return null;
  if (sentToday >= dailyLimit) return 'QUOTA_JOURNALIER_ATTEINT';
  if (kind === 'marketing' && sentToday >= dailyLimit - marketingReserve) return 'QUOTA_RESERVE_TRANSACTIONNEL';
  return null;
}

/**
 * Envoi bas niveau d'un message déjà rendu, avec journalisation systématique.
 *
 * Unique point de sortie des e-mails : le plafond quotidien, le choix du
 * fournisseur et le journal sont appliqués ici, pour tous les appelants.
 * Ne lève jamais : un incident d'envoi ne doit pas faire échouer une réservation.
 *
 * @param {object} params
 * @param {string} params.to Destinataire.
 * @param {number | null} [params.toUserId] Utilisateur associé (journal).
 * @param {string} params.subject Sujet rendu.
 * @param {string} params.html Corps HTML rendu.
 * @param {string | null} [params.templateCode] Code du gabarit (journal, étiquette Brevo).
 * @param {boolean} [params.marketing] Envoi commercial : soumis à la réserve de quota.
 * @returns {Promise<{sent: boolean, reason?: string, error?: string, messageId?: string | null}>}
 */
export async function sendMail({ to, toUserId = null, subject, html, templateCode = null, marketing = false }) {
  const { provider } = getMail();
  const base = { to_email: to, to_user_id: toUserId, template_code: templateCode, subject, provider };

  if (!isMailConfigured()) {
    const reason = provider === 'brevo' ? 'BREVO_NON_CONFIGURE' : 'SMTP_NON_CONFIGURE';
    console.log(`[mailer:STUB] ${provider} non configuré — « ${subject} » NON envoyé à ${to}`);
    logEmail({ ...base, status: 'skipped', error: reason });
    return { sent: false, reason };
  }

  const refusal = quotaRefusal(mailKind(templateCode, marketing));
  if (refusal) {
    console.warn(`[mailer] plafond du jour — « ${subject} » NON envoyé à ${to} (${refusal})`);
    logEmail({ ...base, status: 'skipped', error: refusal });
    return { sent: false, reason: refusal };
  }

  try {
    let messageId = null;
    if (provider === 'brevo') {
      const sender = getSender();
      const out = await brevo.sendEmail({
        apiKey: getBrevo().apiKey,
        sender: { name: sender.fromName, email: sender.fromEmail },
        to, subject, html, tag: templateCode,
      });
      messageId = out.messageId;
    } else {
      const info = await buildTransport().sendMail({ from: fromHeader(), to, subject, html });
      messageId = info?.messageId ? String(info.messageId).replace(/^<|>$/g, '') : null;
    }
    logEmail({ ...base, status: 'sent', message_id: messageId });
    return { sent: true, messageId };
  } catch (err) {
    console.warn(`[mailer] échec envoi à ${to} via ${provider} : ${err.message}`);
    logEmail({ ...base, status: 'failed', error: err.message });
    return { sent: false, reason: 'ENVOI_ECHOUE', error: err.message };
  }
}

/**
 * Test de configuration : vérifie l'accès au fournisseur, puis envoie un e-mail
 * à l'administrateur. La vérification précède l'envoi pour distinguer « mauvais
 * identifiants » (diagnostic immédiat) de « message refusé » (domaine non
 * authentifié, destinataire invalide).
 *
 * @param {string} toEmail Adresse de l'administrateur connecté.
 * @returns {Promise<{sent: boolean, reason?: string, error?: string, account?: string}>}
 */
export async function sendTest(toEmail) {
  const { provider } = getMail();
  if (!isMailConfigured()) {
    return { sent: false, reason: provider === 'brevo' ? 'BREVO_NON_CONFIGURE' : 'SMTP_NON_CONFIGURE' };
  }
  const label = provider === 'brevo' ? 'Brevo' : 'SMTP';
  const { subject, html } = renderRaw(`Test ${label} Cazalia ✅`,
    `<h1 style="font-size:20px;margin:0 0 12px;">Envoi ${label} opérationnel</h1>
     <p style="line-height:1.6;margin:0;">Cet e-mail confirme que l'envoi depuis {{site_name}} fonctionne.</p>`, {});
  let account = null;
  try {
    if (provider === 'brevo') {
      // Appel de lecture : il valide la clé sans entamer le quota du jour.
      const info = await brevo.getAccount(getBrevo().apiKey);
      account = info?.email || null;
    } else {
      await buildTransport().verify();
    }
  } catch (err) {
    logEmail({ to_email: toEmail, subject, status: 'failed', error: err.message, template_code: 'mail_test', provider });
    return { sent: false, reason: 'CONNEXION_ECHOUEE', error: err.message };
  }
  const r = await sendMail({ to: toEmail, subject, html, templateCode: 'mail_test' });
  return { ...r, account };
}

// ── Envois orientés utilisateur (préférences + vars) ─────────────────────────
const getUserStmt = db.prepare(`SELECT id, email, display_name, first_name, notify_booking, notify_marketing FROM users WHERE id = ?`);

// Détermine si l'utilisateur accepte cette catégorie. Le reset part toujours.
function allowed(user, code, marketing) {
  if (code === 'password_reset') return true;
  if (marketing || code === 'manual') return !!user.notify_marketing;
  return !!user.notify_booking; // transactionnels réservation
}

export async function sendToUser({ userId, code, vars = {}, marketing = false }) {
  const user = getUserStmt.get(userId);
  if (!user) return { sent: false, reason: 'UTILISATEUR_INTROUVABLE' };
  if (!allowed(user, code, marketing)) {
    logEmail({ to_email: user.email, to_user_id: user.id, template_code: code, subject: null, status: 'skipped', error: 'OPT_OUT' });
    return { sent: false, reason: 'OPT_OUT' };
  }
  const merged = { client_name: user.display_name, first_name: user.first_name || user.display_name, dashboard_url: `${baseUrl()}/mon-espace`, ...vars };
  const rendered = renderTemplate(code, merged);
  if (!rendered) return { sent: false, reason: 'TEMPLATE_INTROUVABLE' };
  return sendMail({ to: user.email, toUserId: user.id, subject: rendered.subject, html: rendered.html, templateCode: code, marketing });
}

// ── Helpers réservation (chargent la résa + composent les variables) ─────────
const getResStmt = db.prepare(
  `SELECT r.*, s.name AS space_name FROM reservations r JOIN spaces s ON s.id = r.space_id WHERE r.id = ?`
);

// Lien « Ajouter à Google Agenda » (même format que le front GoogleCalendarLink).
const toGCalDate = (iso) => new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, '');
function googleCalendarUrl(r) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Cazalia — ${r.space_name}`,
    dates: `${toGCalDate(r.start_at)}/${toGCalDate(r.end_at)}`,
    details: `Réservation — ${r.space_name} (${r.credits_cost} crédits) chez Cazalia.`,
    location: 'Cazalia',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function reservationVars(r) {
  return {
    space_name: r.space_name,
    booking_date: fmtDate(r.start_at),
    booking_time: `${fmtTime(r.start_at)} – ${fmtTime(r.end_at)}`,
    credits_cost: r.credits_cost,
    wifi_voucher: r.voucher_code || '',
    arrival_instructions: getArrival().instructions,
    calendar_url: googleCalendarUrl(r),
  };
}

export async function sendBookingConfirmation(reservationId) {
  const r = getResStmt.get(reservationId);
  if (!r) return { sent: false, reason: 'RESA_INTROUVABLE' };
  return sendToUser({ userId: r.user_id, code: 'booking_confirmation', vars: reservationVars(r) });
}

export async function sendBookingModified(reservationId) {
  const r = getResStmt.get(reservationId);
  if (!r) return { sent: false, reason: 'RESA_INTROUVABLE' };
  return sendToUser({ userId: r.user_id, code: 'booking_modified', vars: reservationVars(r) });
}

export async function sendBookingCancelled(reservationId, { refunded, amount } = {}) {
  const r = getResStmt.get(reservationId);
  if (!r) return { sent: false, reason: 'RESA_INTROUVABLE' };
  const refund_info = refunded ? `Vos ${amount} crédits ont été recrédités sur votre compte.` : "Cette annulation n'ouvre pas droit à remboursement (hors délai).";
  return sendToUser({ userId: r.user_id, code: 'booking_cancelled', vars: { ...reservationVars(r), refund_info } });
}

// ── Compat / réutilisés par les routes existantes ────────────────────────────
export async function sendPasswordResetEmail({ to, displayName, resetUrl, userId }) {
  const vars = { first_name: (displayName || '').split(' ')[0] || displayName, reset_link: resetUrl, client_name: displayName };
  if (userId) return sendToUser({ userId, code: 'password_reset', vars });
  const rendered = renderTemplate('password_reset', vars);
  return sendMail({ to, subject: rendered.subject, html: rendered.html, templateCode: 'password_reset' });
}

// Notification admin sur une réservation (modif/annulation). Route vers les templates.
export async function sendReservationNotification({ to, displayName, action, reservation, refund }) {
  if (!reservation?.id) return { sent: false, reason: 'RESA_INTROUVABLE' };
  if (action === 'annulation') return sendBookingCancelled(reservation.id, refund || {});
  if (action === 'modification') return sendBookingModified(reservation.id);
  return { sent: false, reason: 'ACTION_NON_EMAIL' }; // 'note' : pas d'e-mail
}
