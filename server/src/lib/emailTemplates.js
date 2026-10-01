// Templates d'e-mails par défaut + moteur d'interpolation {{variable}} + layout HTML
// responsive. Les templates sont amorcés en base (email_templates) au démarrage et
// deviennent éditables depuis l'admin ; ce fichier fournit les valeurs par défaut.

import { escapeHtml } from './html.js';

// Variables proposées à l'admin (documentation dans l'éditeur). Toutes ne sont pas
// pertinentes pour chaque template, mais l'interpolation ignore les inconnues.
export const TEMPLATE_VARIABLES = [
  ['client_name', 'Nom complet du client'],
  ['first_name', 'Prénom du client'],
  ['space_name', "Nom de l'espace réservé"],
  ['booking_date', 'Date de la réservation (ex. lun. 14 oct. 2026)'],
  ['booking_time', 'Plage horaire (ex. 09:00 – 12:00)'],
  ['credits_cost', 'Crédits consommés'],
  ['wifi_voucher', 'Code voucher Wi-Fi'],
  ['wifi_ssid', 'Nom du réseau Wi-Fi'],
  ['arrival_instructions', "Consignes d'arrivée / plan d'accès"],
  ['refund_info', "Information de remboursement (annulation)"],
  ['calendar_url', "Lien « Ajouter à Google Agenda »"],
  ['reset_link', 'Lien de réinitialisation du mot de passe'],
  ['dashboard_url', "Lien vers l'espace client"],
  ['site_name', "Nom de l'établissement"],
];

// Layout responsive commun. `content` = HTML interne du template interpolé.
// `logoUrl` (absolu) → logo image dans l'en-tête ; sinon repli sur le nom en texte.
export function wrapHtml({ title, content, siteName = 'Cazalia', logoUrl = '' }) {
  // `content` est déjà rendu (gabarit de confiance + variables échappées) ; les
  // autres valeurs sont échappées ici, le sujet pouvant contenir « & », « < »…
  const safeSite = escapeHtml(siteName);
  const safeTitle = escapeHtml(title || siteName);
  const header = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${safeSite}" height="36" style="display:block;border:0;height:36px;width:auto;">`
    : `<span style="color:#1c3155;font-size:20px;font-weight:800;letter-spacing:.04em;">${safeSite}</span>`;
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title></head>
<body style="margin:0;padding:0;background:#eef1f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#182135;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(24,33,53,.08);">
        <tr><td style="background:#ffffff;padding:18px 28px;border-bottom:3px solid #1c3155;">
          ${header}
        </td></tr>
        <tr><td style="padding:28px;">
          ${content}
        </td></tr>
        <tr><td style="padding:18px 28px;background:#f4f6f9;color:#5b6577;font-size:12px;line-height:1.6;">
          ${safeSite} — Espace de coworking · Boutonnet, Montpellier<br>
          Cet e-mail vous est envoyé suite à votre activité sur votre espace client.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Boutons HTML réutilisables (dans les templates).
const btn = (href, label) =>
  `<a href="${href}" style="display:inline-block;background:#1c3155;color:#fff;text-decoration:none;padding:11px 20px;border-radius:9px;font-weight:600;">${label}</a>`;
const btnGhost = (href, label) =>
  `<a href="${href}" style="display:inline-block;background:#ffffff;color:#1c3155;text-decoration:none;padding:10px 18px;border-radius:9px;font-weight:600;border:1px solid rgba(28,49,85,.25);">${label}</a>`;
// Bouton « Ajouter à mon agenda » (rendu uniquement si {{calendar_url}} est fourni).
const calendarBtn = btnGhost('{{calendar_url}}', '📅 Ajouter à mon agenda');

const voucherBox = `
  <div style="border:1px solid rgba(28,49,85,.15);border-radius:10px;padding:14px 16px;background:#f5f8ff;margin:16px 0;">
    <div style="font-size:12px;font-weight:700;color:#5b6577;text-transform:uppercase;letter-spacing:.03em;">Accès Wi-Fi invité</div>
    <div style="margin:6px 0;">Réseau : <strong>{{wifi_ssid}}</strong></div>
    <div style="font-size:22px;font-weight:800;letter-spacing:.06em;font-family:ui-monospace,Menlo,monospace;">{{wifi_voucher}}</div>
    <div style="font-size:12px;color:#5b6577;margin-top:6px;">Utilisable sur tous vos appareils, valable 24&nbsp;h après la première connexion.</div>
  </div>`;

// Templates par défaut. `{{wifi_block}}` est un bloc conditionnel géré par le mailer.
export const DEFAULT_TEMPLATES = [
  {
    code: 'booking_confirmation',
    label: 'Confirmation de réservation',
    subject: 'Votre réservation {{space_name}} — {{booking_date}}',
    body_html: `
<h1 style="margin:0 0 12px;font-size:22px;">Réservation confirmée ✅</h1>
<p style="margin:0 0 16px;line-height:1.6;">Bonjour {{first_name}},</p>
<p style="margin:0 0 16px;line-height:1.6;">Votre réservation est bien enregistrée :</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 16px;">
  <tr><td style="padding:6px 0;color:#5b6577;">Espace</td><td style="padding:6px 0;text-align:right;font-weight:600;">{{space_name}}</td></tr>
  <tr><td style="padding:6px 0;color:#5b6577;">Date</td><td style="padding:6px 0;text-align:right;font-weight:600;">{{booking_date}}</td></tr>
  <tr><td style="padding:6px 0;color:#5b6577;">Horaire</td><td style="padding:6px 0;text-align:right;font-weight:600;">{{booking_time}}</td></tr>
  <tr><td style="padding:6px 0;color:#5b6577;">Crédits</td><td style="padding:6px 0;text-align:right;font-weight:600;">{{credits_cost}}</td></tr>
</table>
{{wifi_block}}
<div style="margin:16px 0;line-height:1.6;">{{arrival_instructions}}</div>
<p style="margin:18px 0 0;">${btn('{{dashboard_url}}', 'Voir ma réservation')}&nbsp;&nbsp;${calendarBtn}</p>`,
  },
  {
    code: 'booking_modified',
    label: 'Modification de réservation',
    subject: 'Votre réservation {{space_name}} a été modifiée',
    body_html: `
<h1 style="margin:0 0 12px;font-size:22px;">Réservation modifiée</h1>
<p style="margin:0 0 16px;line-height:1.6;">Bonjour {{first_name}},</p>
<p style="margin:0 0 16px;line-height:1.6;">Votre réservation <strong>{{space_name}}</strong> a été mise à jour. Nouveau créneau :</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 16px;">
  <tr><td style="padding:6px 0;color:#5b6577;">Date</td><td style="padding:6px 0;text-align:right;font-weight:600;">{{booking_date}}</td></tr>
  <tr><td style="padding:6px 0;color:#5b6577;">Horaire</td><td style="padding:6px 0;text-align:right;font-weight:600;">{{booking_time}}</td></tr>
</table>
<p style="margin:18px 0 0;">${btn('{{dashboard_url}}', 'Voir ma réservation')}&nbsp;&nbsp;${calendarBtn}</p>`,
  },
  {
    code: 'booking_cancelled',
    label: 'Annulation de réservation',
    subject: 'Annulation de votre réservation {{space_name}}',
    body_html: `
<h1 style="margin:0 0 12px;font-size:22px;">Réservation annulée</h1>
<p style="margin:0 0 16px;line-height:1.6;">Bonjour {{first_name}},</p>
<p style="margin:0 0 16px;line-height:1.6;">Votre réservation <strong>{{space_name}}</strong> du {{booking_date}} ({{booking_time}}) a été annulée.</p>
<p style="margin:0 0 16px;line-height:1.6;">{{refund_info}}</p>
<p style="margin:18px 0 0;">${btn('{{dashboard_url}}', 'Réserver un nouveau créneau')}</p>`,
  },
  {
    code: 'password_reset',
    label: 'Réinitialisation du mot de passe',
    subject: 'Réinitialisation de votre mot de passe {{site_name}}',
    body_html: `
<h1 style="margin:0 0 12px;font-size:22px;">Réinitialisation du mot de passe</h1>
<p style="margin:0 0 16px;line-height:1.6;">Bonjour {{first_name}},</p>
<p style="margin:0 0 16px;line-height:1.6;">Vous avez demandé à réinitialiser votre mot de passe. Ce lien est valable 2&nbsp;heures :</p>
<p style="margin:0 0 16px;">${btn('{{reset_link}}', 'Choisir un nouveau mot de passe')}</p>
<p style="margin:0;color:#5b6577;font-size:13px;line-height:1.6;">Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.</p>`,
  },
  {
    code: 'manual',
    label: 'Message ponctuel (envoi manuel)',
    subject: '{{site_name}} — information',
    body_html: `
<p style="margin:0 0 16px;line-height:1.6;">Bonjour {{first_name}},</p>
<p style="margin:0 0 16px;line-height:1.6;">[Votre message ici]</p>
<p style="margin:18px 0 0;">${btn('{{dashboard_url}}', 'Accéder à mon espace')}</p>`,
  },
];

export { voucherBox };
