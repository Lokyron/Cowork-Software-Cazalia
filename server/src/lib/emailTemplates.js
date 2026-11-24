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
  ['booking_time', 'Plage horaire (ex. 09:00 - 12:00)'],
  ['credits_cost', 'Crédits consommés'],
  ['wifi_voucher', 'Code voucher Wi-Fi'],
  ['access_pin', "Code d'accès porte (PIN)"],
  ['wifi_ssid', 'Nom du réseau Wi-Fi'],
  ['arrival_instructions', "Consignes d'arrivée / plan d'accès"],
  ['refund_info', "Information de remboursement (annulation)"],
  ['previous_date', "Ancienne date (déplacement de réservation)"],
  ['previous_time', "Ancienne plage horaire (déplacement de réservation)"],
  ['calendar_url', "Lien « Ajouter à Google Agenda »"],
  ['reset_link', 'Lien de réinitialisation du mot de passe'],
  ['verify_link', "Lien de vérification de l'adresse e-mail"],
  ['lead_subject', 'Sujet choisi dans le formulaire de contact'],
  ['lead_message', 'Message saisi dans le formulaire de contact'],
  ['dashboard_url', "Lien vers l'espace client"],
  ['site_name', "Nom de l'établissement"],
];

// Coordonnées légales affichées dans le pied de page. Reprises telles quelles de la
// page des mentions légales (web/src/pages/Cgu.jsx, article 3) : ne pas les modifier
// ici sans modifier la source. Aucun autre identifiant (SIREN, SIRET) n'est repris.
const LEGAL_NAME = 'CAZALIA';
const LEGAL_ADDRESS = '99 rue du Faubourg Boutonnet, 34090 Montpellier';
const CONTACT_EMAIL = 'contact@cazalia.fr';

// Style des liens dans le corps des messages (charte : bleu marine, soulignés).
export const LINK_STYLE = 'color:#1c3155;text-decoration:underline;';

// Phrases d'aperçu (préheader) par gabarit : uniquement là où une phrase courte
// et évidente existe déjà dans le message. Les autres gabarits n'en ont pas.
export const PREHEADERS = {
  password_reset: 'Ce lien est valable 2 heures.',
  email_verification: 'Ce lien est valable 7 jours.',
  lead_ack: 'Nous avons bien pris en compte votre demande.',
};

// Variantes de la mention de pied de page, selon le destinataire.
//  - account   : message de service lié à un compte client
//  - contact   : accusé de réception d'une demande faite sans compte
//  - marketing : envoi commercial (newsletter, envoi manuel) à un membre
//  - internal  : notification interne (gérante, administrateurs)
export const FOOTER_VARIANTS = ['account', 'contact', 'marketing', 'internal'];

function footerNotice(variant, baseUrl) {
  const account = baseUrl ? `<a href="${escapeHtml(baseUrl)}/mon-compte" style="color:#5b6577;text-decoration:underline;">Mon compte</a>` : 'Mon compte';
  switch (variant) {
    case 'contact':
      return `E-mail envoyé suite à votre demande de contact. Il s'agit d'un accusé de réception automatique.`;
    case 'marketing':
      return `Vous recevez cet e-mail car vous avez accepté de recevoir nos actualités. `
        + `Pour vous désinscrire, décochez la newsletter dans ${account} ou écrivez à `
        + `<a href="mailto:${CONTACT_EMAIL}" style="color:#5b6577;text-decoration:underline;">${CONTACT_EMAIL}</a>.`;
    case 'internal':
      return `Notification interne - ne pas transférer.`;
    default:
      return `E-mail de service lié à votre compte. Vous pouvez gérer vos préférences de notification depuis ${account}.`;
  }
}

// Thème sombre : les styles inline restent la référence (clients sans <style>) ; ce
// bloc ne fait que les surcharger quand le client le permet. L'en-tête garde son
// fond blanc pour que le logo (bleu marine, PNG transparent) reste lisible.
//
// Liens : approche POSITIVE, sans `:not()`. Une règle générale `.em-card a` recolore TOUS les
// liens en bleu clair (sélecteur simple : classe + élément, le mieux supporté), puis des règles
// d'attribut RESTAURENT ce qui ne doit pas l'être, déclarées après (même spécificité ou plus :
// la dernière gagne) :
//  - un <a> portant un fond en style inline (`background…` : texte collé depuis Word, `transparent`,
//    anciens boutons) perd ce fond : le texte bleu clair se lit sur la carte sombre, jamais sur un
//    fond clair hérité (cas des 1,23:1 de la version `:not`, où ce lien gardait son bleu marine) ;
//  - les deux anciens boutons en base (corps jamais migrés : `<a>` à fond inline, sans classe)
//    retrouvent leurs couleurs d'origine, lisibles sur la carte sombre (13:1 l'un et l'autre) ;
//  - les boutons du nouveau balisage (fond porté par la cellule `.em-btn`) sont recolorés par
//    `.em-btn a` et `.em-btn-ghost a`, déclarés en dernier.
// Le fond de la carte est posé par `.em-page .em-card`, un sélecteur du MÊME genre (descendant)
// que les règles de texte : un client qui rejette les sélecteurs descendants perd les deux
// ensemble et garde une carte claire à texte foncé, au lieu d'une carte sombre à texte foncé.
//
// Ce qui dégrade encore, dit tel quel : un client qui honore `prefers-color-scheme` et les
// sélecteurs de classe mais rejette les sélecteurs D'ATTRIBUT (`[style*=…]`) perd les règles de
// restauration. Les liens de texte restent lisibles (la règle générale n'en a pas besoin : 8,2:1),
// le nouveau balisage aussi (classes seules), mais un ancien bouton fantôme (fond blanc en ligne,
// corps non migré ou édité à la main) y porterait du bleu clair sur blanc (~1,9:1), de même qu'un
// lien à `background-color` clair collé dans un corps. Les règles `[style*="color:#5b6577"]` et
// consorts, antérieures, partagent ce même seuil de support. Les clients qui retirent tout le
// <style> ou ignorent les media queries (Outlook Windows) restent sur les styles en ligne, intacts.
const DARK_CSS = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    body, .em-page { background:#10151f !important; color:#e6eaf2 !important; }
    .em-page .em-card { background:#1a2233 !important; }
    .em-card, .em-card td, .em-card p, .em-card h1 { color:#e6eaf2 !important; }
    .em-head, .em-head td { background:#ffffff !important; }
    .em-card a { color:#9bbcf0 !important; }
    .em-foot, .em-foot td { background:#141b29 !important; color:#a9b3c4 !important; }
    .em-foot a { color:#a9b3c4 !important; }
    .em-card [style*="color:#5b6577"] { color:#a9b3c4 !important; }
    .em-card [style*="background:#f5f8ff"] { background:#222c42 !important; border-color:#3a4863 !important; }
    .em-card [style*="background:#eef7ee"] { background:#1f3a26 !important; border-color:#2f5a38 !important; }
    .em-card [style*="color:#2f7a33"] { color:#8fd19a !important; }
    .em-card a[style*="background"] { background:transparent !important; }
    .em-card a[style*="background:#1c3155"] { background:#1c3155 !important; color:#ffffff !important; }
    .em-card a[style*="background:#ffffff"] { background:#ffffff !important; color:#1c3155 !important; }
    .em-card .em-btn { background:#3a63a8 !important; }
    .em-card .em-btn a { color:#ffffff !important; }
    .em-card .em-btn-ghost { background:#1a2233 !important; border-color:#4a5f87 !important; }
    .em-card .em-btn-ghost a { color:#cfe0ff !important; }
  }`;

// Layout responsive commun. `content` = HTML interne du template interpolé.
// `logoUrl` (absolu) → logo image dans l'en-tête ; sinon repli sur le nom en texte.
// `footer` : variante de mention de pied (cf. FOOTER_VARIANTS). `preheader` : texte
// d'aperçu masqué (facultatif). `baseUrl` : racine absolue du site, pour les liens du pied.
export function wrapHtml({ title, content, siteName = 'Cazalia', logoUrl = '', footer = 'account', preheader = '', baseUrl = '' }) {
  // `content` est déjà rendu (gabarit de confiance + variables échappées) ; les
  // autres valeurs sont échappées ici, le sujet pouvant contenir « & », « < »…
  const safeSite = escapeHtml(siteName);
  const safeTitle = escapeHtml(title || siteName);
  // Logo : 640×200 d'origine, affiché à 36 px de haut → 115 px de large. `width`
  // en attribut ET en style : Outlook ignore `width:auto` et afficherait 640 px.
  // Le style de l'img sert aussi au texte de repli (`alt`) quand les images sont bloquées.
  const header = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${safeSite}" width="115" height="36" style="display:block;border:0;width:115px;height:36px;color:#1c3155;font-size:20px;font-weight:800;line-height:36px;letter-spacing:.04em;">`
    : `<span style="color:#1c3155;font-size:20px;font-weight:800;letter-spacing:.04em;">${safeSite}</span>`;
  const pre = preheader
    ? `<div style="display:none;font-size:1px;color:#eef1f5;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>\n`
    : '';
  const legal = footer === 'internal' ? ''
    : `<br>${LEGAL_NAME} - ${LEGAL_ADDRESS}`
      + (baseUrl ? ` · <a href="${escapeHtml(baseUrl)}/cgu" style="color:#5b6577;text-decoration:underline;">Mentions légales</a>` : '');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${safeTitle}</title>
<style>${DARK_CSS}
</style></head>
<body style="margin:0;padding:0;background:#eef1f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#182135;">
  ${pre}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="em-page" style="background:#eef1f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="em-card" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(24,33,53,.08);">
        <tr><td class="em-head" style="background:#ffffff;padding:18px 28px;border-bottom:3px solid #1c3155;">
          ${header}
        </td></tr>
        <tr><td style="padding:28px;">
          ${content}
        </td></tr>
        <tr><td class="em-foot" style="padding:18px 28px;background:#f4f6f9;color:#5b6577;font-size:12px;line-height:1.6;">
          ${safeSite} - Espace de coworking · Boutonnet, Montpellier${legal}<br>
          ${footerNotice(footer, baseUrl)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Boutons HTML réutilisables (dans les templates). Motif « bulletproof » : une table
// dont la cellule porte le fond (`bgcolor`, lu par Outlook/Word) et un lien en
// `display:block` qui remplit la cellule (zone cliquable entière sur les clients
// modernes). `mso-padding-alt` rend le remplissage sous Outlook. Hauteur : 44 px.
const btn = (href, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>`
  + `<td align="center" bgcolor="#1c3155" height="44" class="em-btn" style="background:#1c3155;border-radius:9px;mso-padding-alt:14px 22px;">`
  + `<a href="${href}" style="display:block;padding:14px 22px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;line-height:16px;border-radius:9px;">${label}</a>`
  + `</td></tr></table>`;
// Variante « fantôme » : bordure portée par la cellule (1 px) → padding réduit d'autant. Bordure en
// couleur pleine (rgba non supporté par Outlook).
const btnGhost = (href, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>`
  + `<td align="center" bgcolor="#ffffff" height="44" class="em-btn-ghost" style="background:#ffffff;border:1px solid #c6ccd4;border-radius:9px;mso-padding-alt:13px 21px;">`
  + `<a href="${href}" style="display:block;padding:13px 21px;color:#1c3155;text-decoration:none;font-size:15px;font-weight:600;line-height:16px;border-radius:9px;">${label}</a>`
  + `</td></tr></table>`;
// Bouton « Ajouter à mon agenda » : rendu uniquement si {{calendar_url}} est fourni.
// La ligne est encadrée de marqueurs `<!--cal-->` / `<!--/cal-->` que le mailer retire
// quand la variable est vide (cf. `dropEmptyCalendar` dans mailer.js). Le jeton
// `{{calendar_url}}` reste dans le gabarit stocké : les migrations de db.js s'y fient.
const calendarRow = (label) => `<!--cal--><tr><td style="padding:10px 0 0;">${btnGhost('{{calendar_url}}', label)}</td></tr><!--/cal-->`;

// Groupe de boutons d'action EMPILÉS (une ligne par bouton, espacement vertical
// propre). Mise en page par tableau : seule technique fiable sous Outlook et la
// plupart des clients mail (un simple display:block ne stacke pas partout).
// `calendarLabel` : la migration de db.js y réinjecte le libellé déjà présent en base.
const ctaStack = (primaryHref, primaryLabel, calendarLabel = '📅 Ajouter à mon agenda') => `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 0;border-collapse:collapse;">
  <tr><td>${btn(primaryHref, primaryLabel)}</td></tr>
  ${calendarRow(calendarLabel)}
</table>`;

// Lien de secours en clair sous un bouton (URL longue : retour à la ligne forcé).
const fallbackLink = (href) =>
  `<p style="margin:0 0 16px;color:#5b6577;font-size:12px;line-height:1.6;">Si le bouton ne fonctionne pas, copiez ce lien&nbsp;:<br><span style="word-break:break-all;">${href}</span></p>`;

const voucherBox = `
  <div style="border:1px solid rgba(28,49,85,.15);border-radius:10px;padding:14px 16px;background:#f5f8ff;margin:16px 0;">
    <div style="font-size:12px;font-weight:700;color:#5b6577;text-transform:uppercase;letter-spacing:.03em;">Accès Wi-Fi invité</div>
    <div style="margin:6px 0;">Réseau : <strong>{{wifi_ssid}}</strong></div>
    <div style="font-size:22px;font-weight:800;letter-spacing:.06em;font-family:ui-monospace,Menlo,monospace;">{{wifi_voucher}}</div>
    <div style="font-size:12px;color:#5b6577;margin-top:6px;">Utilisable sur tous vos appareils, valable 24&nbsp;h après la première connexion.</div>
  </div>`;

// Encart « PIN de porte » (rendu uniquement si {{access_pin}} est fourni).
// Le bandeau « Où trouver le digicode ? » est volontairement proéminent (fond
// ambré contrasté) : c'est l'information qui bloque le plus les nouveaux venus.
const accessBox = `
  <div style="border:1px solid rgba(28,49,85,.15);border-radius:10px;padding:14px 16px;background:#f5f8ff;margin:16px 0;">
    <div style="font-size:12px;font-weight:700;color:#5b6577;text-transform:uppercase;letter-spacing:.03em;">Code d'accès porte</div>
    <div style="font-size:26px;font-weight:800;letter-spacing:.18em;font-family:ui-monospace,Menlo,monospace;margin:6px 0;">{{access_pin}}</div>
    <div style="font-size:12px;color:#5b6577;">À composer sur le digicode. Valable uniquement pendant votre créneau réservé.</div>
    <div style="margin-top:12px;padding:12px 14px;border-radius:8px;background:#fff6e5;border:1px solid #f3d9a0;color:#5a4a1e;font-size:13px;line-height:1.55;">
      <div style="font-weight:800;margin-bottom:4px;">📍 Où se trouve le digicode&nbsp;?</div>
      Face à la porte d'entrée, c'est le <strong>petit boîtier carré blanc situé sur la droite</strong>.
      <strong>Tapez une fois dessus</strong> pour activer l'affichage des chiffres, puis composez votre code.
    </div>
  </div>`;

// Templates par défaut. `{{wifi_block}}` est un bloc conditionnel géré par le mailer.
export const DEFAULT_TEMPLATES = [
  {
    code: 'booking_confirmation',
    label: 'Confirmation de réservation',
    subject: 'Votre réservation {{space_name}} - {{booking_date}}',
    body_html: `
<h1 style="margin:0 0 12px;font-size:22px;">Réservation confirmée ✅</h1>
<p style="margin:0 0 16px;line-height:1.6;">Bonjour {{first_name}},</p>
<p style="margin:0 0 16px;line-height:1.6;">Votre réservation est bien enregistrée :</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 16px;">
  <tr><td style="padding:6px 0;color:#5b6577;">Espace</td><td style="padding:6px 0;text-align:right;font-weight:600;">{{space_name}}</td></tr>
  <tr><td style="padding:6px 0;color:#5b6577;">Date</td><td style="padding:6px 0;text-align:right;font-weight:600;">{{booking_date}}</td></tr>
  <tr><td style="padding:6px 0;color:#5b6577;">Horaire</td><td style="padding:6px 0;text-align:right;font-weight:600;">{{booking_time}}</td></tr>
  <tr><td style="padding:6px 0;color:#5b6577;">Montant</td><td style="padding:6px 0;text-align:right;font-weight:600;">{{price}}</td></tr>
</table>
<p style="margin:0 0 16px;line-height:1.6;color:#5b6577;">☕ Café &amp; thé inclus dans votre réservation.</p>
{{access_block}}
{{wifi_block}}
<div style="margin:16px 0;line-height:1.6;">{{arrival_instructions}}</div>
${ctaStack('{{dashboard_url}}', 'Voir ma réservation')}`,
  },
  {
    code: 'booking_modified',
    label: 'Déplacement de réservation',
    subject: 'Votre réservation {{space_name}} a été déplacée',
    body_html: `
<h1 style="margin:0 0 12px;font-size:22px;">Réservation déplacée</h1>
<p style="margin:0 0 16px;line-height:1.6;">Bonjour {{first_name}},</p>
<p style="margin:0 0 16px;line-height:1.6;">Votre réservation <strong>{{space_name}}</strong> a été déplacée. Voici votre nouveau créneau :</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 10px;">
  <tr><td style="padding:6px 0;color:#5b6577;">Ancien créneau</td><td style="padding:6px 0;text-align:right;color:#5b6577;text-decoration:line-through;">{{previous_date}} · {{previous_time}}</td></tr>
</table>
<div style="border:1px solid #cfe6cf;border-radius:10px;padding:12px 16px;background:#eef7ee;margin:0 0 16px;">
  <div style="font-size:12px;font-weight:700;color:#2f7a33;text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px;">Nouveau créneau</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
    <tr><td style="padding:4px 0;color:#5b6577;">Date</td><td style="padding:4px 0;text-align:right;font-weight:600;">{{booking_date}}</td></tr>
    <tr><td style="padding:4px 0;color:#5b6577;">Horaire</td><td style="padding:4px 0;text-align:right;font-weight:600;">{{booking_time}}</td></tr>
  </table>
</div>
<p style="margin:0 0 16px;line-height:1.6;color:#5b6577;">🔁 Votre code d'accès à la porte a été régénéré pour ce nouveau créneau : utilisez celui indiqué ci-dessous.</p>
{{access_block}}
{{wifi_block}}
${ctaStack('{{dashboard_url}}', 'Voir ma réservation')}`,
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
<p style="margin:0 0 16px;line-height:1.6;color:#5b6577;">🔒 Votre code d'accès à la porte et votre code Wi-Fi pour ce créneau ont été désactivés.</p>
<div style="margin:18px 0 0;">${btn('{{dashboard_url}}', 'Réserver un nouveau créneau')}</div>`,
  },
  {
    code: 'password_reset',
    label: 'Réinitialisation du mot de passe',
    subject: 'Réinitialisation de votre mot de passe {{site_name}}',
    body_html: `
<h1 style="margin:0 0 12px;font-size:22px;">Réinitialisation du mot de passe</h1>
<p style="margin:0 0 16px;line-height:1.6;">Bonjour {{first_name}},</p>
<p style="margin:0 0 16px;line-height:1.6;">Vous avez demandé à réinitialiser votre mot de passe. Ce lien est valable 2&nbsp;heures :</p>
<div style="margin:0 0 16px;">${btn('{{reset_link}}', 'Choisir un nouveau mot de passe')}</div>
${fallbackLink('{{reset_link}}')}
<p style="margin:0;color:#5b6577;font-size:13px;line-height:1.6;">Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.</p>`,
  },
  {
    code: 'email_verification',
    label: "Vérification de l'adresse e-mail",
    subject: 'Confirmez votre adresse e-mail {{site_name}}',
    body_html: `
<h1 style="margin:0 0 12px;font-size:22px;">Confirmez votre adresse e-mail</h1>
<p style="margin:0 0 16px;line-height:1.6;">Bonjour {{first_name}},</p>
<p style="margin:0 0 16px;line-height:1.6;">Bienvenue chez {{site_name}}. Pour pouvoir réserver un espace, merci de confirmer votre adresse e-mail en cliquant sur le bouton ci-dessous. Ce lien est valable 7&nbsp;jours :</p>
<div style="margin:0 0 16px;">${btn('{{verify_link}}', 'Confirmer mon adresse')}</div>
${fallbackLink('{{verify_link}}')}
<p style="margin:0;color:#5b6577;font-size:13px;line-height:1.6;">Si vous n'êtes pas à l'origine de cette inscription, ignorez cet e-mail. Vous pouvez demander un nouveau lien depuis votre espace membre.</p>`,
  },
  {
    code: 'lead_ack',
    label: 'Accusé de réception (formulaire de contact)',
    subject: 'Nous avons bien reçu votre demande - {{site_name}}',
    body_html: `
<h1 style="margin:0 0 12px;font-size:22px;">Merci de nous avoir contactés</h1>
<p style="margin:0 0 16px;line-height:1.6;">Bonjour {{first_name}},</p>
<p style="margin:0 0 16px;line-height:1.6;">Nous avons bien pris en compte votre demande et nous vous répondrons dans les meilleurs délais.</p>
<p style="margin:0 0 6px;line-height:1.6;color:#5b6577;">Pour mémoire, voici votre demande :</p>
<p style="margin:0 0 6px;line-height:1.6;"><strong>Sujet :</strong> {{lead_subject}}</p>
<p style="margin:12px 0 4px;line-height:1.6;"><strong>Votre message :</strong></p>
<p style="margin:0 0 16px;line-height:1.6;white-space:pre-wrap;">{{lead_message}}</p>
<p style="margin:0;color:#5b6577;font-size:13px;line-height:1.6;">Cet e-mail est un accusé de réception automatique. Si vous n'êtes pas à l'origine de cette demande, vous pouvez l'ignorer.</p>`,
  },
  {
    code: 'manual',
    label: 'Message ponctuel (envoi manuel)',
    subject: '{{site_name}} - information',
    body_html: `
<p style="margin:0 0 16px;line-height:1.6;">Bonjour {{first_name}},</p>
<p style="margin:0 0 16px;line-height:1.6;">[Votre message ici]</p>
<div style="margin:18px 0 0;">${btn('{{dashboard_url}}', 'Accéder à mon espace')}</div>`,
  },
];

// ── Gabarits INTERNES (en dur, non éditables, non amorcés en base) ───────────
// Notifications destinées à la gérante / aux administrateurs. Ils passent par le
// même layout (`wrapHtml`, mention « notification interne »). Les valeurs sont des
// marqueurs `{{…}}` : `renderRaw` les échappe. Aucun bouton d'action : l'application
// ne construit nulle part d'URL de fiche prospect, de réclamation ou de paiement Stripe.
const P = 'margin:0 0 6px;line-height:1.6;';
const field = (label, valueHtml) => `<p style="${P}"><strong>${label}&nbsp;:</strong> ${valueHtml}</p>`;
const mailLink = (v) => `<a href="mailto:${v}" style="${LINK_STYLE}">${v}</a>`;
const telLink = (v) => `<a href="tel:${v}" style="${LINK_STYLE}">${v}</a>`;
const textBlock = (labelHtml, v) =>
  `<p style="margin:14px 0 4px;line-height:1.6;"><strong>${labelHtml}&nbsp;:</strong></p>`
  + `<p style="margin:0 0 16px;line-height:1.6;white-space:pre-wrap;">${v}</p>`;
const H1 = (t) => `<h1 style="margin:0 0 16px;font-size:22px;">${t}</h1>`;

export const INTERNAL_TEMPLATES = {
  lead_notification: {
    // Le sujet choisi (liste fermée, validé par createProspect) figure en tête de l'objet.
    subject: '{{lead_subject}} - demande #{{id}}',
    body: ({ hasNeed = false } = {}) => H1('{{title}}')
      + field('Sujet', '{{lead_subject}}')
      + field('Nom', '{{first_name}} {{last_name}}')
      + field('E-mail', mailLink('{{email}}'))
      + field('Téléphone', telLink('{{phone}}'))
      + field('Profil', '{{activity}}')
      + field('Origine', '{{source}}')
      + (hasNeed ? textBlock('Besoin exprimé (bureau privatif)', '{{need}}') : '')
      + textBlock('{{message_label}}', '{{message}}'),
  },
  claim_notification: {
    subject: 'Nouvelle réclamation #{{id}} - {{kind}}',
    body: () => H1('Réclamation #{{id}}')
      + field('Type', '{{kind}}')
      + field('Nom', '{{first_name}} {{last_name}}')
      + field('E-mail', mailLink('{{email}}'))
      + field('Téléphone', telLink('{{phone}}'))
      + field('Réservation', '{{reservation_ref}}')
      + textBlock('Message', '{{message}}'),
  },
  refund_request: {
    subject: 'Remboursement à effectuer - {{amount}} ({{member_name}})',
    body: ({ hasPaymentIntent = false } = {}) => H1('Remboursement à effectuer')
      + `<p style="margin:0 0 16px;line-height:1.6;">Une réservation payée en ligne a été annulée <strong>dans les délais</strong>. `
      + `Un remboursement est à effectuer manuellement depuis le tableau de bord Stripe.</p>`
      + `<ul style="margin:0 0 16px;padding:0 0 0 20px;line-height:1.7;">`
      + `<li><strong>Membre&nbsp;:</strong> {{member_name}} ({{member_email}})</li>`
      + `<li><strong>Espace&nbsp;:</strong> {{space_name}}</li>`
      + `<li><strong>Créneau&nbsp;:</strong> {{slot}}</li>`
      + `<li><strong>Montant à rembourser&nbsp;:</strong> {{amount}}</li>`
      + (hasPaymentIntent ? `<li><strong>Paiement Stripe&nbsp;:</strong> {{payment_intent}}</li>` : '')
      + `</ul>`,
  },
};

export { voucherBox, accessBox, btn, btnGhost, fallbackLink, ctaStack };
