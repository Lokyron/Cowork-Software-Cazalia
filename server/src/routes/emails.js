// Administration du module e-mail : configuration SMTP, consignes, éditeur de
// templates, prévisualisation, envoi manuel (ciblé) et journal des envois.

import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, sendBusinessError } from '../middleware.js';
import { getSmtpPublic, setSmtp, getArrival, setArrival } from '../lib/settings.js';
import { TEMPLATE_VARIABLES } from '../lib/emailTemplates.js';
import { renderTemplate, renderRaw, sendTest, sendToUser, sendMail } from '../lib/mailer.js';

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

// ── Réglages (SMTP + consignes) ──────────────────────────────────────────────
/**
 * GET /api/admin/email/settings — réglages SMTP et consignes d'arrivée.
 * Le mot de passe SMTP n'est JAMAIS renvoyé : seul un booléen `has_pass`
 * indique qu'un secret est enregistré (`getSmtpPublic`).
 *
 * @returns 200 `{smtp, arrival, variables}`
 */
emailsRouter.get('/settings', (_req, res) => {
  res.json({ smtp: getSmtpPublic(), arrival: getArrival(), variables: TEMPLATE_VARIABLES });
});

/**
 * PUT /api/admin/email/settings — met à jour SMTP et/ou consignes d'arrivée.
 * Un mot de passe soumis est chiffré au repos (AES-256-GCM) avant stockage ;
 * un champ vide conserve le secret existant.
 *
 * @returns 200 `{ok, smtp, arrival}`
 */
emailsRouter.put('/settings', (req, res) => {
  try {
    const out = {};
    if (req.body?.smtp) out.smtp = setSmtp(req.body.smtp);
    if (req.body?.arrival) out.arrival = setArrival(req.body.arrival);
    res.json({ ok: true, smtp: out.smtp ?? getSmtpPublic(), arrival: out.arrival ?? getArrival() });
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
    let sent = 0, skipped = 0, failed = 0;
    for (const userId of ids) {
      let r;
      if (b.code) {
        r = await sendToUser({ userId, code: b.code, marketing: true });
      } else {
        // Sujet/corps ad hoc : on les enregistre temporairement ? Non → rendu direct.
        r = await sendCustomToUser(userId, b.subject, b.body_html);
      }
      if (r.sent) sent++; else if (r.reason === 'OPT_OUT') skipped++; else failed++;
    }
    res.json({ ok: true, total: ids.length, sent, skipped, failed });
  } catch (err) { sendBusinessError(res, err); }
});

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
  return sendMail({ to: u.email, toUserId: u.id, subject: rendered.subject, html: rendered.html, templateCode: 'manual' });
}

// ── Journal ──────────────────────────────────────────────────────────────────
/**
 * GET /api/admin/email/log — 100 derniers envois.
 * Le journal ne contient ni corps de message ni pièce jointe : uniquement le
 * destinataire, le gabarit, le sujet et le statut.
 *
 * @returns 200 `{log}`
 */
emailsRouter.get('/log', (_req, res) => {
  res.json({ log: db.prepare(`SELECT id, to_email, template_code, subject, status, error, created_at FROM email_log ORDER BY id DESC LIMIT 100`).all() });
});
