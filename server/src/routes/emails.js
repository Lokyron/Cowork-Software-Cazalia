// Administration du module e-mail : choix du fournisseur (SMTP ou Brevo) et de
// ses secrets, plafond quotidien, webhook de délivrabilité, consignes, éditeur
// de templates, prévisualisation, envoi manuel (ciblé) et journal des envois.

import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, sendBusinessError } from '../middleware.js';
import {
  getSmtpPublic, setSmtp, getArrival, setArrival,
  getMail, setMail, getBrevo, getBrevoPublic, setBrevo, rotateBrevoWebhookToken,
} from '../lib/settings.js';
import { TEMPLATE_VARIABLES } from '../lib/emailTemplates.js';
import { renderTemplate, renderRaw, sendTest, sendToUser, sendMail, getQuota } from '../lib/mailer.js';
import { declareWebhook } from '../lib/brevo.js';

export const emailsRouter = Router();

// Routeur entièrement réservé aux administrateurs : il donne accès aux réglages
// SMTP et à l'envoi de masse. Le contrôle est posé au niveau du routeur pour
// qu'aucune route ajoutée ensuite ne puisse rester ouverte par oubli.
emailsRouter.use(requireAdmin);

const baseUrl = () => (config.publicBaseUrl || 'https://cowork.example.com').replace(/\/$/, '');

/**
 * Jeu de variables factices pour la prévisualisation d'un gabarit.
 * Aucune donnée réelle de membre n'est utilisée : prévisualiser un e-mail ne
 * doit pas exposer les coordonnées d'un client.
 *
 * @returns {Record<string, unknown>} Variables d'exemple.
 */
function sampleVars() {
  const a = getArrival();
  return {
    client_name: 'Marie Dupont', first_name: 'Marie', space_name: 'Salle Focus',
    booking_date: 'lun. 14 oct. 2026', booking_time: '09:00 – 12:00', credits_cost: 6,
    wifi_voucher: '12345-67890', wifi_ssid: a.wifi_ssid, arrival_instructions: a.instructions,
    refund_info: 'Vos 6 crédits ont été recrédités sur votre compte.',
    calendar_url: 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Cazalia',
    reset_link: `${baseUrl()}/reset-password?token=exemple`, dashboard_url: `${baseUrl()}/mon-espace`,
    site_name: 'Cazalia',
  };
}

// ── Réglages (fournisseur + consignes) ───────────────────────────────────────
/** Vue des réglages d'envoi, telle que renvoyée à l'interface (sans secret). */
function mailSettings() {
  const m = getMail();
  return { provider: m.provider, daily_limit: m.dailyLimit, marketing_reserve: m.marketingReserve };
}

/**
 * GET /api/admin/email/settings — fournisseur, secrets (présence seulement),
 * quota du jour, réglages SMTP et consignes d'arrivée.
 *
 * Aucun secret ne sort : ni le mot de passe SMTP ni la clé d'API Brevo ne sont
 * renvoyés — seuls des booléens `has_pass` / `has_api_key` en signalent
 * l'existence (CWE-200).
 *
 * @returns 200 `{mail, smtp, brevo, quota, arrival, variables}`
 */
emailsRouter.get('/settings', (_req, res) => {
  res.json({
    mail: mailSettings(),
    smtp: getSmtpPublic(),
    brevo: getBrevoPublic(),
    quota: getQuota(),
    arrival: getArrival(),
    variables: TEMPLATE_VARIABLES,
  });
});

/**
 * PUT /api/admin/email/settings — met à jour fournisseur, SMTP, Brevo et/ou
 * consignes d'arrivée.
 *
 * Les secrets soumis sont chiffrés au repos (AES-256-GCM) avant stockage ; un
 * champ vide conserve le secret existant (l'interface ne l'a jamais reçu, elle
 * ne peut donc pas le renvoyer).
 *
 * @returns 200 `{ok, mail, smtp, brevo, quota, arrival}`
 */
emailsRouter.put('/settings', (req, res) => {
  try {
    const b = req.body || {};
    if (b.mail) setMail(b.mail);
    if (b.smtp) setSmtp(b.smtp);
    if (b.brevo) setBrevo(b.brevo);
    if (b.arrival) setArrival(b.arrival);
    res.json({
      ok: true,
      mail: mailSettings(), smtp: getSmtpPublic(), brevo: getBrevoPublic(),
      quota: getQuota(), arrival: getArrival(),
    });
  } catch (err) { sendBusinessError(res, err); }
});

/**
 * POST /api/admin/email/test — envoie un message de test.
 * Le destinataire est FORCÉ à l'adresse de l'administrateur connecté : la route
 * ne peut pas servir de relais pour envoyer un message arbitraire à un tiers.
 *
 * @returns 200 `{ok, sent, reason?, to}`
 */
emailsRouter.post('/test', async (req, res) => {
  const r = await sendTest(req.user.email);
  res.json({ ok: r.sent, ...r, to: req.user.email });
});

/**
 * POST /api/admin/email/brevo/webhook — (re)génère le jeton du webhook de
 * délivrabilité et tente de le déclarer chez Brevo.
 *
 * L'URL complète, jeton inclus, n'est renvoyée QU'ICI et une seule fois :
 * ensuite, seule l'existence du jeton est consultable. Régénérer invalide
 * immédiatement l'URL précédente.
 *
 * La déclaration automatique échoue si l'URL publique n'est pas joignable
 * depuis Internet (déploiement local, `PUBLIC_BASE_URL` non défini) : l'URL est
 * alors renvoyée avec un avertissement, à recopier à la main dans Brevo.
 *
 * @returns 200 `{ok, url, declared, warning?}` · 400 `BREVO_NON_CONFIGURE`
 */
emailsRouter.post('/brevo/webhook', async (req, res) => {
  try {
    const { apiKey } = getBrevo();
    if (!apiKey) return res.status(400).json({ error: 'BREVO_NON_CONFIGURE' });

    const token = rotateBrevoWebhookToken();
    const url = `${baseUrl()}/api/webhooks/brevo/${token}`;
    // Une URL locale ou laissée au gabarit d'exemple ne sera jamais appelée par
    // Brevo : on le dit tout de suite plutôt que de laisser croire au succès.
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    const unreachable = !host || host === 'localhost' || host.endsWith('.local')
      || host.endsWith('example.com') || /^\d+\.\d+\.\d+\.\d+$/.test(host);

    if (unreachable) {
      return res.json({ ok: true, url, declared: false, warning: 'URL_NON_PUBLIQUE' });
    }
    try {
      const r = await declareWebhook({ apiKey, url });
      return res.json({ ok: true, url, declared: true, webhook_id: r.id });
    } catch (err) {
      return res.json({ ok: true, url, declared: false, warning: 'DECLARATION_ECHOUEE', error: err.message });
    }
  } catch (err) { sendBusinessError(res, err); }
});

// ── Templates ────────────────────────────────────────────────────────────────
/**
 * GET /api/admin/email/templates — liste des gabarits (sans le corps HTML).
 * @returns 200 `{templates}`
 */
emailsRouter.get('/templates', (_req, res) => {
  res.json({ templates: db.prepare(`SELECT code, label, subject, updated_at FROM email_templates ORDER BY label`).all() });
});

/**
 * GET /api/admin/email/templates/:code — gabarit complet.
 * @returns 200 `{template}` · 404 `TEMPLATE_INTROUVABLE`
 */
emailsRouter.get('/templates/:code', (req, res) => {
  const t = db.prepare(`SELECT * FROM email_templates WHERE code = ?`).get(req.params.code);
  if (!t) return res.status(404).json({ error: 'TEMPLATE_INTROUVABLE' });
  res.json({ template: t });
});

/**
 * PUT /api/admin/email/templates/:code — met à jour un gabarit existant.
 *
 * Le corps HTML est enregistré tel quel : le gabarit est un contenu de
 * CONFIANCE, rédigé par l'administrateur. Les variables qui y sont interpolées,
 * elles, sont systématiquement échappées à l'envoi (`lib/mailer.js`). Seuls les
 * codes déjà existants sont acceptés : on ne peut pas créer de gabarit arbitraire.
 *
 * @returns 200 `{ok:true}` · 400 `CHAMPS_INVALIDES` · 404 `TEMPLATE_INTROUVABLE`
 */
emailsRouter.put('/templates/:code', (req, res) => {
  const t = db.prepare(`SELECT code FROM email_templates WHERE code = ?`).get(req.params.code);
  if (!t) return res.status(404).json({ error: 'TEMPLATE_INTROUVABLE' });
  const subject = String(req.body?.subject ?? '').trim();
  const bodyHtml = String(req.body?.body_html ?? '');
  if (!subject || !bodyHtml) return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
  db.prepare(`UPDATE email_templates SET subject = ?, body_html = ?, updated_at = datetime('now') WHERE code = ?`)
    .run(subject, bodyHtml, req.params.code);
  res.json({ ok: true });
});

/**
 * POST /api/admin/email/preview — rend un gabarit avec des variables factices.
 * Aucun envoi n'est déclenché.
 *
 * @returns 200 `{subject, html}` · 404 `TEMPLATE_INTROUVABLE`
 */
emailsRouter.post('/preview', (req, res) => {
  const vars = sampleVars();
  const rendered = req.body?.code
    ? renderTemplate(req.body.code, vars)
    : renderRaw(req.body?.subject || '', req.body?.body_html || '', vars);
  if (!rendered) return res.status(404).json({ error: 'TEMPLATE_INTROUVABLE' });
  res.json(rendered);
});

/**
 * POST /api/admin/email/send — envoi manuel à un membre, une sélection ou tous.
 *
 * Corps attendu : `{code?, subject?, body_html?, target: {type:'user'|'users'|'all',
 * user_id?, user_ids?}}`. Les destinataires sont résolus DEPUIS LA BASE à partir
 * d'identifiants : aucune adresse arbitraire ne peut être injectée, l'API ne
 * peut donc pas être détournée en relais de messagerie. L'opt-out marketing de
 * chaque membre est respecté.
 *
 * @returns 200 `{ok, total, sent, skipped, failed}` · 400 `AUCUN_DESTINATAIRE` · 400 `CONTENU_REQUIS`
 */
emailsRouter.post('/send', async (req, res) => {
  try {
    const b = req.body || {};
    const target = b.target || {};
    let ids = [];
    if (target.type === 'all') {
      ids = db.prepare(`SELECT id FROM users WHERE role = 'member'`).all().map((u) => u.id);
    } else if (target.type === 'users' && Array.isArray(target.user_ids)) {
      ids = target.user_ids.map(Number).filter(Boolean);
    } else if (target.type === 'user' && target.user_id) {
      ids = [Number(target.user_id)];
    }
    if (!ids.length) return res.status(400).json({ error: 'AUCUN_DESTINATAIRE' });
    if (!b.code && !(b.subject && b.body_html)) return res.status(400).json({ error: 'CONTENU_REQUIS' });

    // Rendu par utilisateur (vars personnalisées : prénom, lien espace) via sendToUser.
    let sent = 0, skipped = 0, failed = 0, blocked = 0;
    for (const userId of ids) {
      let r;
      if (b.code) {
        r = await sendToUser({ userId, code: b.code, marketing: true });
      } else {
        // Sujet/corps ad hoc : on les enregistre temporairement ? Non → rendu direct.
        r = await sendCustomToUser(userId, b.subject, b.body_html);
      }
      if (r.sent) sent++;
      else if (r.reason === 'OPT_OUT') skipped++;
      else if (QUOTA_REASONS.has(r.reason)) {
        // Plafond du jour atteint : les destinataires suivants seraient refusés
        // de la même façon. On arrête et on rend compte du reste à envoyer.
        blocked = ids.length - sent - skipped - failed;
        break;
      } else failed++;
    }
    res.json({ ok: true, total: ids.length, sent, skipped, failed, blocked, quota: getQuota() });
  } catch (err) { sendBusinessError(res, err); }
});

// Refus liés au plafond quotidien : ils interrompent un envoi de masse au lieu
// d'être comptés en échecs individuels (cf. POST /send).
const QUOTA_REASONS = new Set(['QUOTA_JOURNALIER_ATTEINT', 'QUOTA_RESERVE_TRANSACTIONNEL']);

const getUser = db.prepare(`SELECT id, email, display_name, first_name, notify_marketing FROM users WHERE id = ?`);
/**
 * Envoie un sujet/corps ad hoc à un utilisateur, en respectant son opt-out marketing.
 *
 * @param {number} userId Destinataire (résolu en base).
 * @param {string} subject Sujet, avec marqueurs `{{variable}}`.
 * @param {string} bodyHtml Corps HTML, avec marqueurs `{{variable}}`.
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendCustomToUser(userId, subject, bodyHtml) {
  const u = getUser.get(userId);
  if (!u) return { sent: false, reason: 'UTILISATEUR_INTROUVABLE' };
  if (!u.notify_marketing) return { sent: false, reason: 'OPT_OUT' };
  const vars = { client_name: u.display_name, first_name: u.first_name || u.display_name, dashboard_url: `${baseUrl()}/mon-espace`, site_name: 'Cazalia' };
  const rendered = renderRaw(subject, bodyHtml, vars);
  return sendMail({ to: u.email, toUserId: u.id, subject: rendered.subject, html: rendered.html, templateCode: 'manual', marketing: true });
}

// ── Journal ──────────────────────────────────────────────────────────────────
/**
 * GET /api/admin/email/log — 100 derniers envois.
 * Le journal ne contient ni corps de message ni pièce jointe : uniquement le
 * destinataire, le gabarit, le sujet, le fournisseur et le statut — ce dernier
 * étant enrichi par les webhooks de délivrabilité (remis, rejeté, spam…).
 *
 * L'identifiant de message du fournisseur n'est PAS exposé : il ne sert qu'au
 * recollage interne des événements.
 *
 * @returns 200 `{log, quota}`
 */
emailsRouter.get('/log', (_req, res) => {
  res.json({
    log: db.prepare(
      `SELECT id, to_email, template_code, subject, status, error, provider, updated_at, created_at
         FROM email_log ORDER BY id DESC LIMIT 100`
    ).all(),
    quota: getQuota(),
  });
});
