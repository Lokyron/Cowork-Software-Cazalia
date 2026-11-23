import { Router } from 'express';
import { db } from '../db.js';
import { createProspect, setProspectNote, OFFICE_START_ASAP } from '../lib/prospects.js';
import { sendMail, renderRaw, renderTemplate } from '../lib/mailer.js';
import { sendBusinessError } from '../middleware.js';
import { rateLimit } from '../security.js';

export const leadsRouter = Router();

// Boîte de réception des contacts / demandes de devis (gérante).
const LEADS_RECIPIENT = 'contact@cazalia.fr';
// Expéditeur distinct (no-reply@ même domaine) pour éviter l'envoi « à soi-même »
// contact@→contact@ souvent filtré ; Reply-To = l'auteur du formulaire.
const NOTIFY_FROM = `no-reply@${LEADS_RECIPIENT.split('@')[1]}`;

const ACTIVITY_LABEL = {
  independant: 'Indépendant', salarie_teletravail: 'Salarié en télétravail',
  etudiant: 'Étudiant', entreprise: 'Entreprise', autre: 'Autre',
};

/** Date ISO AAAA-MM-JJ -> JJ/MM/AAAA (format de lecture français). */
const fmtIsoFr = (iso) => iso.split('-').reverse().join('/');

/**
 * Lignes lisibles du besoin exprimé pour le bureau privatif (vide pour tout autre sujet).
 * @param {{office_seats: number | null, office_duration: string | null, office_start: string | null}} data
 * @returns {string[]} Une ligne « Libellé : valeur » par information renseignée.
 */
function needLines(data) {
  if (data.office_seats == null && !data.office_duration) return [];
  const lines = [];
  if (data.office_seats != null) lines.push(`Nombre de postes : ${data.office_seats}`);
  if (data.office_duration) lines.push(`Durée envisagée : ${data.office_duration}`);
  if (data.office_start) {
    lines.push(`Début souhaité : ${data.office_start === OFFICE_START_ASAP ? 'Dès que possible' : fmtIsoFr(data.office_start)}`);
  }
  return lines;
}

// Limitation de débit par IP. Le limiteur mutualisé (`security.js`) borne sa
// table de compteurs : la version précédente, locale à ce fichier, croissait
// indéfiniment au fil des adresses vues (CWE-770).
const leadsLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 6 });

// Plafond d'accusés de réception par ADRESSE destinataire : le limiteur par IP
// ne suffit pas, des IP tournantes permettraient d'arroser une adresse tierce
// depuis le domaine de l'établissement (réputation d'expéditeur). Le compte
// s'appuie sur `email_log` (une ligne par envoi tenté), sans table supplémentaire.
const ACK_MAX_PER_ADDRESS = 2;
const ackCountStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM email_log
    WHERE template_code = 'lead_ack' AND lower(to_email) = lower(?)
      AND created_at >= datetime('now', '-24 hours')`
);

/**
 * POST /api/leads - pré-inscription publique (aucun compte requis).
 *
 * Deux protections complémentaires : un champ piège (`website`), invisible pour
 * un humain mais rempli par la plupart des robots, et une limitation de débit
 * par adresse IP. Le piège renvoie un succès factice : signaler le rejet
 * apprendrait au robot à contourner le mécanisme.
 *
 * Le sujet est obligatoire et doit appartenir à `LEAD_SUBJECTS` (`SUJET_INVALIDE` sinon).
 *
 * Un accusé de réception est envoyé au visiteur (best-effort, jamais pour le honeypot),
 * au plus `ACK_MAX_PER_ADDRESS` par adresse et par 24 h. Au-delà, l'accusé est omis
 * mais le prospect est enregistré, la gérante notifiée et la réponse reste 201.
 *
 * @returns 201 `{ok:true}` · 400 erreur de validation · 429 `TROP_DE_TENTATIVES`
 */
leadsRouter.post('/leads', leadsLimiter, async (req, res) => {
  if (req.body && String(req.body.website || '').trim() !== '') {
    return res.status(201).json({ ok: true });
  }
  try {
    const source = typeof req.body?.source === 'string' ? req.body.source : null;
    const { id, data } = createProspect(req.body || {}, source);
    // Message libre de la demande : conservé en note pour
    // ne pas le perdre si l'e-mail échoue.
    const message = String(req.body?.message || '').trim().slice(0, 2000);
    if (message) { try { setProspectNote(id, message); } catch { /* best-effort */ } }

    const need = needLines(data);

    // Notification best-effort à la gérante (ne fait jamais échouer la saisie).
    try {
      const { subject, html } = renderRaw(
        // Le sujet choisi (liste fermée, validé par createProspect) figure en tête de l'objet.
        `{{lead_subject}} - demande #{{id}}`,
        `<h1 style="font-size:20px;margin:0 0 12px;">{{title}}</h1>
         <p style="margin:0 0 6px;"><strong>Sujet :</strong> {{lead_subject}}</p>
         <p style="margin:0 0 6px;"><strong>Nom :</strong> {{first_name}} {{last_name}}</p>
         <p style="margin:0 0 6px;"><strong>E-mail :</strong> <a href="mailto:{{email}}">{{email}}</a></p>
         <p style="margin:0 0 6px;"><strong>Téléphone :</strong> <a href="tel:{{phone}}">{{phone}}</a></p>
         <p style="margin:0 0 6px;"><strong>Profil :</strong> {{activity}}</p>
         <p style="margin:0 0 6px;"><strong>Origine :</strong> {{source}}</p>
         ${need.length ? `<p style="margin:12px 0 4px;"><strong>Besoin exprimé (bureau privatif) :</strong></p>
         <p style="line-height:1.6;white-space:pre-wrap;margin:0;">{{need}}</p>` : ''}
         <p style="margin:12px 0 4px;"><strong>{{message_label}} :</strong></p>
         <p style="line-height:1.6;white-space:pre-wrap;margin:0;">{{message}}</p>`,
        {
          id,
          title: 'Nouvelle demande de contact',
          lead_subject: data.subject,
          first_name: data.first_name,
          last_name: data.last_name,
          email: data.email,
          phone: data.phone,
          activity: ACTIVITY_LABEL[data.activity] || data.activity || '-',
          source: source || '-',
          need: need.join('\n'),
          // Pour le bureau privatif, le message est le « besoin particulier » (facultatif).
          message_label: need.length ? 'Besoin particulier' : 'Message',
          message: message || '-',
        }
      );
      await sendMail({
        to: LEADS_RECIPIENT, subject, html, templateCode: 'lead_notification',
        fromEmail: NOTIFY_FROM, fromName: 'Cazalia - Contact', replyTo: data.email,
      });
    } catch { /* journalisé par le mailer ; le prospect est déjà enregistré */ }

    // Accusé de réception au visiteur (sans compte : pas de `sendToUser`). Best-effort :
    // un échec ne change ni la réponse ni l'enregistrement. Jamais atteint quand le
    // honeypot est rempli (retour anticipé plus haut) ; le limiteur par IP et le plafond par adresse (2 / 24 h) bornent les envois.
    try {
      const alreadyAcked = ackCountStmt.get(data.email).n;
      const ack = alreadyAcked >= ACK_MAX_PER_ADDRESS ? null : renderTemplate('lead_ack', {
        first_name: data.first_name,
        lead_subject: data.subject,
        // Rappel du besoin exprimé + message : une seule variable, le gabarit stocké en
        // base (éventuellement personnalisé par l'admin) n'a donc pas à changer.
        lead_message: need.length ? [...need, message ? `\n${message}` : ''].filter(Boolean).join('\n') : (message || '-'),
      });
      if (ack) {
        await sendMail({
          // Expéditeur par défaut (celui réglé dans l'admin) ; réponses vers la boîte de contact.
          to: data.email, subject: ack.subject, html: ack.html, templateCode: 'lead_ack',
          replyTo: LEADS_RECIPIENT,
        });
      }
    } catch { /* journalisé par le mailer ; le prospect est déjà enregistré */ }

    res.status(201).json({ ok: true });
  } catch (err) {
    sendBusinessError(res, err, 400);
  }
});
