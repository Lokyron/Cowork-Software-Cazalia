// Module d'envoi d'e-mails : deux fournisseurs interchangeables (relais SMTP via
// nodemailer, ou API HTTP Brevo), moteur de templates {{variable}}, layout
// responsive, plafond d'envois quotidien, journalisation (email_log) et respect
// des préférences de notification.
//
// Le choix du fournisseur se fait dans /admin/emails ; TOUT passe par `sendMail`,
// unique point de sortie - c'est là que se branchent le quota et le journal.
//
// DÉGRADABLE : un échec d'envoi ne lève jamais vers l'appelant métier (réservation, etc.).

import nodemailer from 'nodemailer';
import { db } from '../db.js';
import { config } from '../config.js';
import { getSmtp, getArrival, getMail, getBrevo, getSender } from './settings.js';
import { wrapHtml, voucherBox, accessBox, PREHEADERS, INTERNAL_TEMPLATES } from './emailTemplates.js';
import { escapeHtml, headerSafe, htmlToText } from './html.js';
import { parisDayStartUtc } from './time.js';
import * as brevo from './brevo.js';

const PARIS = 'Europe/Paris';
const dateFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const hmFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = (iso) => dateFmt.format(new Date(iso));
const fmtTime = (iso) => hmFmt.format(new Date(iso));

const baseUrl = () => (config.publicBaseUrl || 'https://cazalia.fr').replace(/\/$/, '');
// Logo d'en-tête des e-mails : PNG transparent (SVG non supporté par la plupart des
// clients mail), servi en URL absolue depuis le front.
const logoUrl = () => `${baseUrl()}/images/logo-email.png`;
// Adresse de contact de la plateforme (même boîte que `LEADS_RECIPIENT` dans routes/leads.js).
const CONTACT_EMAIL = 'contact@cazalia.fr';

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
  // Délais de garde : par défaut nodemailer attend très longtemps (jusqu'à ~2 min)
  // sur une connexion/handshake qui traîne, ce qui retarderait d'autant l'e-mail.
  const opts = {
    host: s.host, port: s.port,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  };
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
 * @param {Record<string, unknown>} vars Valeurs à injecter - TOUJOURS échappées.
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
 * d'échappement HTML - qui afficherait « &amp; » au lieu de « & » - mais
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

// Retire le bouton « Ajouter à mon agenda » quand `calendar_url` est vide : ligne
// balisée `<!--cal-->…<!--/cal-->` des gabarits courants, ou ancien lien en ligne
// (gabarits migrés avant l'introduction du balisage). Sinon le bouton aurait un `href` vide.
function dropEmptyCalendar(bodyHtml, full) {
  const s = String(bodyHtml);
  if (full.calendar_url) return s;
  return s
    .replace(/<!--cal-->[\s\S]*?<!--\/cal-->/g, '')
    .replace(/<a\b[^>]*href="\{\{\s*calendar_url\s*\}\}"[^>]*>[\s\S]*?<\/a>/g, '');
}

// Remplace les blocs conditionnels `{{wifi_block}}` et `{{access_block}}` : fragments HTML
// construits par l'application, rendus seulement quand la variable correspondante est fournie.
function fillBlocks(bodyHtml, full) {
  const wifiBlock = full.wifi_voucher ? interpolate(voucherBox, full) : '';
  const accessBlock = full.access_pin ? interpolate(accessBox, full) : '';
  return dropEmptyCalendar(bodyHtml, full)
    .replace(/\{\{\s*wifi_block\s*\}\}/g, wifiBlock)
    .replace(/\{\{\s*access_block\s*\}\}/g, accessBlock);
}

const getTemplateStmt = db.prepare(`SELECT * FROM email_templates WHERE code = ?`);

/**
 * Le gabarit existe-t-il ? (lecture seule, sans rendu ni journal)
 *
 * @param {string} code Code du gabarit.
 * @returns {boolean}
 */
export function templateExists(code) {
  return Boolean(getTemplateStmt.get(code));
}

/**
 * Rend un gabarit enregistré (sujet + HTML complet avec la mise en page).
 *
 * `{{wifi_block}}` est substitué AVANT l'interpolation générale : c'est un
 * fragment HTML construit par l'application (encart voucher), pas une donnée
 * utilisateur - il est donc injecté tel quel, ses propres variables ayant été
 * échappées au passage.
 *
 * @param {string} code Code du gabarit (`booking_confirmation`, `password_reset`…).
 * @param {Record<string, unknown>} [vars] Variables du gabarit.
 * @param {{marketing?: boolean}} [options] `marketing` : envoi commercial (campagne). Le pied de
 *        page suit la MÊME règle que les en-têtes (`mailKind`) : jamais de `List-Unsubscribe` avec
 *        un pied « e-mail de service », ni l'inverse.
 * @returns {{subject: string, html: string} | null} `null` si le gabarit n'existe pas.
 */
export function renderTemplate(code, vars = {}, { marketing = false } = {}) {
  const t = getTemplateStmt.get(code);
  if (!t) return null;
  const full = { site_name: 'Cazalia', wifi_ssid: getArrival().wifi_ssid, ...vars };
  const bodyRaw = interpolate(fillBlocks(t.body_html, full), full);
  const subject = interpolateText(t.subject, full);
  // Mention de pied selon le destinataire : envoi commercial, accusé de contact sans
  // compte, sinon message de service lié au compte (cf. `footerVariant`).
  const footer = footerVariant(code, marketing);
  const html = wrapHtml({
    title: subject, content: bodyRaw, siteName: full.site_name, logoUrl: logoUrl(),
    footer, preheader: PREHEADERS[code] || '', baseUrl: baseUrl(),
  });
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
 * @param {{footer?: 'account' | 'contact' | 'marketing' | 'internal', preheader?: string}} [options]
 *        Variante de mention de pied de page (`account` par défaut) et texte d'aperçu.
 * @returns {{subject: string, html: string}}
 */
export function renderRaw(subject, bodyHtml, vars = {}, { footer = 'account', preheader = '' } = {}) {
  const full = { site_name: 'Cazalia', wifi_ssid: getArrival().wifi_ssid, ...vars };
  const body = interpolate(fillBlocks(bodyHtml, full), full);
  const renderedSubject = interpolateText(subject, full);
  return {
    subject: renderedSubject,
    html: wrapHtml({
      title: renderedSubject, content: body, siteName: full.site_name, logoUrl: logoUrl(),
      footer, preheader, baseUrl: baseUrl(),
    }),
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

/**
 * Journalise un envoi écarté AVANT d'atteindre `sendMail` (utilisateur, gabarit ou
 * réservation introuvable, aucun administrateur…). Sans cette ligne, le message
 * disparaîtrait sans la moindre trace dans le journal des envois.
 *
 * @param {object} p
 * @param {string} p.toEmail Destinataire, ou à défaut l'identifiant concerné (`to_email` est NOT NULL).
 * @param {string | null} p.templateCode Code du gabarit visé.
 * @param {string} p.reason Code de raison, écrit dans la colonne `error`.
 * @param {number | null} [p.toUserId] Utilisateur destinataire, quand il est connu.
 */
export function logSkipped({ toEmail, templateCode, reason, toUserId = null }) {
  logEmail({ to_email: toEmail ?? '', to_user_id: toUserId, template_code: templateCode, status: 'skipped', error: reason });
}

// ── Plafond d'envois quotidien ───────────────────────────────────────────────
// Motivation : l'offre gratuite Brevo plafonne à 300 e-mails par jour. Sans
// garde-fou, une campagne de 300 messages épuiserait le quota et le PREMIER
// client à demander une réinitialisation de mot de passe se retrouverait bloqué
// dehors, sans trace visible. On réserve donc une part du plafond aux messages
// non commerciaux, et on refuse les envois de masse avant d'atteindre le mur.
const countSentTodayStmt = db.prepare(
  // 'skipped' n'a jamais quitté l'application ; 'failed' n'a pas été accepté par
  // le fournisseur : ni l'un ni l'autre ne consomme le quota. 'error' (événement
  // Brevo APRÈS acceptation), 'bounced', 'blocked' et 'spam' l'ont consommé : comptés.
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
  if (templateCode === 'password_reset' || templateCode === 'email_verification') return 'critical';
  if (marketing || templateCode === 'manual') return 'marketing';
  return 'transactional';
}

/**
 * En-têtes de désinscription d'un envoi, selon sa nature.
 *
 * `marketing` : `List-Unsubscribe`. L'application n'expose AUCUNE URL de désinscription
 * en un clic (le choix se fait connecté, dans « Mon compte ») : on ne pose donc que
 * l'adresse `mailto:` de contact. `List-Unsubscribe-Post` (RFC 8058) exige une URL
 * HTTPS : il n'est volontairement pas émis. `critical` et `transactional` : aucun
 * en-tête (un message de service ne se « désinscrit » pas).
 *
 * @param {'critical' | 'marketing' | 'transactional'} kind Nature du message.
 * @returns {Record<string, string> | null}
 */
function mailHeaders(kind) {
  if (kind !== 'marketing') return null;
  return { 'List-Unsubscribe': `<mailto:${CONTACT_EMAIL}?subject=Desinscription>` };
}

/**
 * Variante de mention de pied de page d'un envoi. Dérive de `mailKind`, la même source de
 * vérité que les en-têtes (`mailHeaders`) : un message `marketing` porte le pied commercial,
 * quel que soit son code de gabarit. Hors commercial, l'accusé de réception d'une demande
 * de contact (destinataire sans compte) a son pied propre ; le reste est un message de service.
 *
 * @param {string | null} templateCode Code du gabarit.
 * @param {boolean} [marketing] Envoi commercial explicite (campagne).
 * @returns {'account' | 'contact' | 'marketing'}
 */
export function footerVariant(templateCode, marketing = false) {
  if (mailKind(templateCode, marketing) === 'marketing') return 'marketing';
  return templateCode === 'lead_ack' ? 'contact' : 'account';
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
 * Un envoi de cette nature serait-il accepté MAINTENANT par les garde-fous de `sendMail`
 * (fournisseur configuré, plafond du jour) ? Lecture seule : rien n'est envoyé ni journalisé.
 * Ne peut pas prévoir un échec du fournisseur lui-même, qui ne se connaît qu'après l'appel.
 *
 * @param {{templateCode?: string | null, marketing?: boolean}} [p]
 * @returns {boolean}
 */
export function wouldAcceptSend({ templateCode = null, marketing = false } = {}) {
  return isMailConfigured() && quotaRefusal(mailKind(templateCode, marketing)) === null;
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
 * @param {string | null} [params.text] Version texte brut explicite ; elle l'emporte sur
 *        la conversion automatique du HTML (`htmlToText`) quand elle n'est pas vide.
 * @param {string | null} [params.templateCode] Code du gabarit (journal, étiquette Brevo).
 * @param {boolean} [params.marketing] Envoi commercial : soumis à la réserve de quota.
 * @returns {Promise<{sent: boolean, reason?: string, error?: string, messageId?: string | null}>}
 */
export async function sendMail({ to, toUserId = null, subject, html, text = null, templateCode = null, marketing = false, fromEmail = null, fromName = null, replyTo = null }) {
  const { provider } = getMail();
  const base = { to_email: to, to_user_id: toUserId, template_code: templateCode, subject, provider };

  if (!isMailConfigured()) {
    const reason = provider === 'brevo' ? 'BREVO_NON_CONFIGURE' : 'SMTP_NON_CONFIGURE';
    console.log(`[mailer:STUB] ${provider} non configuré - « ${subject} » NON envoyé à ${to}`);
    logEmail({ ...base, status: 'skipped', error: reason });
    return { sent: false, reason };
  }

  const refusal = quotaRefusal(mailKind(templateCode, marketing));
  if (refusal) {
    console.warn(`[mailer] plafond du jour - « ${subject} » NON envoyé à ${to} (${refusal})`);
    logEmail({ ...base, status: 'skipped', error: refusal });
    return { sent: false, reason: refusal };
  }

  // Version texte : un message HTML seul déclenche MIME_HTML_ONLY (spam) et reste
  // illisible en aperçu de notification ou en lecteur d'écran simple.
  const textBody = (typeof text === 'string' && text.trim()) ? text : htmlToText(html);
  const headers = mailHeaders(mailKind(templateCode, marketing));

  try {
    let messageId = null;
    // Expéditeur : par défaut l'adresse configurée ; un appelant peut l'imposer
    // (ex. notifications internes envoyées depuis no-reply@ pour éviter l'envoi
    // « à soi-même » vers contact@, souvent filtré). `replyTo` permet de répondre
    // directement à la personne qui a rempli le formulaire.
    const replyToObj = replyTo ? { email: replyTo } : null;
    if (provider === 'brevo') {
      const sender = getSender();
      const out = await brevo.sendEmail({
        apiKey: getBrevo().apiKey,
        sender: { name: fromName || sender.fromName, email: fromEmail || sender.fromEmail },
        to, subject, html, text: textBody, headers, tag: templateCode, replyTo: replyToObj,
      });
      messageId = out.messageId;
    } else {
      const fromStr = fromEmail ? (fromName ? `${fromName} <${fromEmail}>` : fromEmail) : fromHeader();
      const info = await buildTransport().sendMail({
        from: fromStr, to, subject, html, text: textBody, ...(headers ? { headers } : {}), ...(replyTo ? { replyTo } : {}),
      });
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
     <p style="line-height:1.6;margin:0;">Cet e-mail confirme que l'envoi depuis {{site_name}} fonctionne.</p>`, {}, { footer: 'internal' });
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
  if (code === 'password_reset' || code === 'email_verification') return true;
  if (marketing || code === 'manual') return !!user.notify_marketing;
  return !!user.notify_booking; // transactionnels réservation
}

export async function sendToUser({ userId, code, vars = {}, marketing = false }) {
  const user = getUserStmt.get(userId);
  if (!user) {
    logSkipped({ toEmail: `utilisateur#${userId}`, templateCode: code, reason: 'UTILISATEUR_INTROUVABLE' });
    return { sent: false, reason: 'UTILISATEUR_INTROUVABLE' };
  }
  if (!allowed(user, code, marketing)) {
    logEmail({ to_email: user.email, to_user_id: user.id, template_code: code, subject: null, status: 'skipped', error: 'OPT_OUT' });
    return { sent: false, reason: 'OPT_OUT' };
  }
  const merged = { client_name: user.display_name, first_name: user.first_name || user.display_name, dashboard_url: `${baseUrl()}/mon-espace`, ...vars };
  const rendered = renderTemplate(code, merged, { marketing });
  if (!rendered) {
    logSkipped({ toEmail: user.email, toUserId: user.id, templateCode: code, reason: 'TEMPLATE_INTROUVABLE' });
    return { sent: false, reason: 'TEMPLATE_INTROUVABLE' };
  }
  return sendMail({ to: user.email, toUserId: user.id, subject: rendered.subject, html: rendered.html, templateCode: code, marketing });
}

// ── Helpers réservation (chargent la résa + composent les variables) ─────────
const getResStmt = db.prepare(
  `SELECT r.*, s.name AS space_name FROM reservations r JOIN spaces s ON s.id = r.space_id WHERE r.id = ?`
);
// Résa enrichie (membre) pour les notifications admin.
const getResFullStmt = db.prepare(
  `SELECT r.*, s.name AS space_name, u.display_name AS member_name, u.email AS member_email
     FROM reservations r JOIN spaces s ON s.id = r.space_id JOIN users u ON u.id = r.user_id
    WHERE r.id = ?`
);
const adminEmailsStmt = db.prepare(`SELECT email FROM users WHERE role = 'admin'`);

// Montant en centimes → chaîne « 12,00 € » (France).
const eurFromCents = (cents) =>
  ((Number(cents) || 0) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

// Lien « Ajouter à Google Agenda » (même format que le front GoogleCalendarLink).
const toGCalDate = (iso) => new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, '');
function googleCalendarUrl(r) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Cazalia - ${r.space_name}`,
    dates: `${toGCalDate(r.start_at)}/${toGCalDate(r.end_at)}`,
    details: `Réservation - ${r.space_name} (${eurFromCents(r.price_cents)}) chez Cazalia.`,
    location: 'Cazalia',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function reservationVars(r) {
  return {
    space_name: r.space_name,
    booking_date: fmtDate(r.start_at),
    booking_time: `${fmtTime(r.start_at)} - ${fmtTime(r.end_at)}`,
    price: eurFromCents(r.price_cents),
    credits_cost: eurFromCents(r.price_cents), // compat templates : affiche désormais des euros
    wifi_voucher: r.voucher_code || '',
    access_pin: r.access_pin || '',
    arrival_instructions: getArrival().instructions,
    calendar_url: googleCalendarUrl(r),
  };
}

export async function sendBookingConfirmation(reservationId) {
  const r = getResStmt.get(reservationId);
  if (!r) {
    logSkipped({ toEmail: `reservation#${reservationId}`, templateCode: 'booking_confirmation', reason: 'RESA_INTROUVABLE' });
    return { sent: false, reason: 'RESA_INTROUVABLE' };
  }
  return sendToUser({ userId: r.user_id, code: 'booking_confirmation', vars: reservationVars(r) });
}

/**
 * E-mail de déplacement d'une réservation. Met en évidence l'ancien créneau face
 * au nouveau : l'appelant transmet les anciens horaires (perdus après le move).
 *
 * @param {number} reservationId Réservation déplacée (déjà repositionnée).
 * @param {{previous?: {start_at: string, end_at: string}}} [opts] Ancien créneau.
 */
export async function sendBookingModified(reservationId, { previous } = {}) {
  const r = getResStmt.get(reservationId);
  if (!r) {
    logSkipped({ toEmail: `reservation#${reservationId}`, templateCode: 'booking_modified', reason: 'RESA_INTROUVABLE' });
    return { sent: false, reason: 'RESA_INTROUVABLE' };
  }
  const vars = reservationVars(r);
  if (previous?.start_at && previous?.end_at) {
    vars.previous_date = fmtDate(previous.start_at);
    vars.previous_time = `${fmtTime(previous.start_at)} - ${fmtTime(previous.end_at)}`;
  }
  return sendToUser({ userId: r.user_id, code: 'booking_modified', vars });
}

export async function sendBookingCancelled(reservationId, { refunded, amount } = {}) {
  const r = getResStmt.get(reservationId);
  if (!r) {
    logSkipped({ toEmail: `reservation#${reservationId}`, templateCode: 'booking_cancelled', reason: 'RESA_INTROUVABLE' });
    return { sent: false, reason: 'RESA_INTROUVABLE' };
  }
  const refund_info = refunded
    ? `Votre annulation est dans les délais : un remboursement de ${eurFromCents(amount)} vous sera effectué sous quelques jours.`
    : "Cette annulation n'ouvre pas droit à remboursement (hors délai).";
  return sendToUser({ userId: r.user_id, code: 'booking_cancelled', vars: { ...reservationVars(r), refund_info } });
}

/**
 * Notifie les administrateurs qu'un REMBOURSEMENT est à effectuer dans Stripe
 * (annulation d'une résa payée en ligne, dans les délais). Aucun remboursement
 * automatique : l'admin le réalise manuellement depuis le tableau de bord Stripe.
 *
 * @param {number} reservationId Réservation annulée.
 * @param {{amount:number}} [p] Montant à rembourser (centimes).
 * @returns {Promise<object>}
 */
export async function sendRefundRequestToAdmin(reservationId, { amount } = {}) {
  const r = getResFullStmt.get(reservationId);
  if (!r) {
    logSkipped({ toEmail: `reservation#${reservationId}`, templateCode: 'refund_request', reason: 'RESA_INTROUVABLE' });
    return { sent: false, reason: 'RESA_INTROUVABLE' };
  }
  const admins = adminEmailsStmt.all().map((a) => a.email).filter(Boolean);
  if (!admins.length) {
    logSkipped({ toEmail: '', templateCode: 'refund_request', reason: 'AUCUN_ADMIN' });
    return { sent: false, reason: 'AUCUN_ADMIN' };
  }
  // Valeurs issues de la base (nom du membre, espace…) : passées en marqueurs `{{…}}`
  // pour que `renderRaw` les échappe, comme `lead_notification` dans routes/leads.js.
  const tpl = INTERNAL_TEMPLATES.refund_request;
  const { subject: s, html } = renderRaw(
    tpl.subject,
    tpl.body({ hasPaymentIntent: Boolean(r.payment_intent) }),
    {
      amount: eurFromCents(amount ?? r.price_cents),
      member_name: r.member_name,
      member_email: r.member_email,
      space_name: r.space_name,
      slot: `${fmtDate(r.start_at)} ${fmtTime(r.start_at)} - ${fmtTime(r.end_at)}`,
      payment_intent: r.payment_intent,
    },
    { footer: 'internal' },
  );
  const results = [];
  for (const to of admins) {
    results.push(await sendMail({ to, subject: s, html, templateCode: 'refund_request' }));
  }
  return { sent: results.some((x) => x?.sent), results };
}

// ── Compat / réutilisés par les routes existantes ────────────────────────────
/**
 * Envoie le lien de vérification d'adresse e-mail. Message de service : exempté des
 * préférences de notification et du plafond quotidien (cf. `mailKind`, `allowed`).
 *
 * @param {{to: string, displayName: string, verifyUrl: string, userId: number}} p
 */
export async function sendEmailVerificationEmail({ to, displayName, verifyUrl, userId }) {
  const vars = { first_name: (displayName || '').split(' ')[0] || displayName, verify_link: verifyUrl, client_name: displayName };
  if (userId) return sendToUser({ userId, code: 'email_verification', vars });
  const rendered = renderTemplate('email_verification', vars);
  return sendMail({ to, subject: rendered.subject, html: rendered.html, templateCode: 'email_verification' });
}

export async function sendPasswordResetEmail({ to, displayName, resetUrl, userId }) {
  const vars = { first_name: (displayName || '').split(' ')[0] || displayName, reset_link: resetUrl, client_name: displayName };
  if (userId) return sendToUser({ userId, code: 'password_reset', vars });
  const rendered = renderTemplate('password_reset', vars);
  return sendMail({ to, subject: rendered.subject, html: rendered.html, templateCode: 'password_reset' });
}

// Notification admin sur une réservation (modif/annulation). Route vers les templates.
export async function sendReservationNotification({ to, displayName, action, reservation, refund, previous }) {
  if (!reservation?.id) return { sent: false, reason: 'RESA_INTROUVABLE' };
  if (action === 'annulation') return sendBookingCancelled(reservation.id, refund || {});
  if (action === 'modification') return sendBookingModified(reservation.id, { previous });
  return { sent: false, reason: 'ACTION_NON_EMAIL' }; // 'note' : pas d'e-mail
}
