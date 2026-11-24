import { Router } from 'express';
import { db } from '../db.js';
import { createProspect, validateProspect, setProspectNote, OFFICE_START_ASAP } from '../lib/prospects.js';
import { sendMail, renderRaw, renderTemplate, logSkipped, templateExists, wouldAcceptSend } from '../lib/mailer.js';
import { INTERNAL_TEMPLATES } from '../lib/emailTemplates.js';
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
// Seuls les accusés réellement partis comptent : une ligne 'skipped' (quota,
// gabarit absent) ou 'failed' (fournisseur en panne) ne doit pas bloquer un
// visiteur légitime pendant 24 h (même logique que `countSentTodayStmt`).
const ACK_MAX_PER_ADDRESS = 2;
const ackCountStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM email_log
    WHERE template_code = 'lead_ack' AND lower(to_email) = lower(?)
      AND status NOT IN ('skipped', 'failed')
      AND created_at >= datetime('now', '-24 hours')`
);

// Champ piège : valeur d'`ack_sent` que le chemin nominal AURAIT renvoyée, sans rien envoyer ni
// écrire en base. Le compteur `email_log` ne bouge pas sur ce chemin ; pour que des requêtes
// répétées suivent la même courbe (true, true, puis false au plafond), les accusés « virtuels »
// sont comptés en mémoire sur la même fenêtre de 24 h et s'ajoutent au compte réel.
// Mémoire bornée (`TRAP_MAX_ADDRESSES`), perdue au redémarrage du processus.
const TRAP_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRAP_MAX_ADDRESSES = 5000;
const trapAcks = new Map(); // adresse (minuscules) -> horodatages (ms) des accusés virtuels

/**
 * @param {string} email Adresse validée par `validateProspect`.
 * @returns {boolean} Ce que `ack_sent` aurait valu pour cette adresse via le chemin nominal.
 *          Seul l'échec du fournisseur après appel reste imprévisible (le nominal répondrait `false`).
 */
function predictAckSent(email) {
  try {
    const key = String(email).toLowerCase();
    const now = Date.now();
    const virtual = (trapAcks.get(key) || []).filter((t) => now - t < TRAP_WINDOW_MS);
    if (ackCountStmt.get(email).n + virtual.length >= ACK_MAX_PER_ADDRESS) return false;
    if (!templateExists('lead_ack') || !wouldAcceptSend({ templateCode: 'lead_ack' })) return false;
    virtual.push(now);
    trapAcks.delete(key); // réinsertion en fin : l'adresse la plus ancienne est évincée en premier
    trapAcks.set(key, virtual);
    if (trapAcks.size > TRAP_MAX_ADDRESSES) trapAcks.delete(trapAcks.keys().next().value);
    return true;
  } catch { return false; }
}

/**
 * POST /api/leads - pré-inscription publique (aucun compte requis).
 *
 * Deux protections complémentaires : un champ piège (`website`), invisible pour
 * un humain mais rempli par la plupart des robots, et une limitation de débit
 * par adresse IP. Le piège renvoie un succès factice : signaler le rejet
 * apprendrait au robot à contourner le mécanisme. Il n'agit qu'APRÈS la validation de la
 * charge utile, pour que les réponses (400 / 201) soient indiscernables d'un envoi nominal.
 * Limite connue : la latence diffère (le chemin nominal fait des appels réseau), non égalisée.
 *
 * Le sujet est obligatoire et doit appartenir à `LEAD_SUBJECTS` (`SUJET_INVALIDE` sinon).
 *
 * Un accusé de réception est envoyé au visiteur (best-effort, jamais pour le honeypot),
 * au plus `ACK_MAX_PER_ADDRESS` par adresse et par 24 h. Au-delà, l'accusé est omis
 * mais le prospect est enregistré, la gérante notifiée et la réponse reste 201.
 *
 * La réponse 201 porte `ack_sent` : `true` si l'accusé a été remis au fournisseur, `false`
 * s'il a été omis (plafond, quota, gabarit absent, panne). Le honeypot répond ce que le chemin
 * nominal aurait répondu (`predictAckSent` : plafond par adresse, gabarit, fournisseur, quota),
 * sans rien envoyer. Limite connue : une panne du fournisseur APRÈS l'appel (réseau, rejet)
 * ne peut pas être prédite ; le nominal répondrait alors `false`, le piège `true`.
 *
 * @returns 201 `{ok:true, ack_sent:boolean}` · 400 erreur de validation · 429 `TROP_DE_TENTATIVES`
 */
leadsRouter.post('/leads', leadsLimiter, async (req, res) => {
  try {
    // Champ piège : la charge est VALIDÉE comme un envoi nominal (400 identique si elle est
    // invalide, sinon un robot distinguerait les deux d'un coup), puis court-circuitée avec
    // un faux succès : rien n'est enregistré, aucun e-mail ne part.
    if (req.body && String(req.body.website || '').trim() !== '') {
      const trapData = validateProspect(req.body);
      return res.status(201).json({ ok: true, ack_sent: predictAckSent(trapData.email) });
    }
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
        INTERNAL_TEMPLATES.lead_notification.subject,
        INTERNAL_TEMPLATES.lead_notification.body({ hasNeed: need.length > 0 }),
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
        },
        { footer: 'internal' },
      );
      await sendMail({
        to: LEADS_RECIPIENT, subject, html, templateCode: 'lead_notification',
        fromEmail: NOTIFY_FROM, fromName: 'Cazalia - Contact', replyTo: data.email,
      });
    } catch { /* journalisé par le mailer ; le prospect est déjà enregistré */ }

    // Accusé de réception au visiteur (sans compte : pas de `sendToUser`). Best-effort :
    // un échec ne change ni la réponse ni l'enregistrement. Jamais atteint quand le
    // honeypot est rempli (retour anticipé plus haut) ; le limiteur par IP et le plafond par adresse (2 / 24 h) bornent les envois.
    let ackSent = false;
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
        const out = await sendMail({
          // Expéditeur par défaut (celui réglé dans l'admin) ; réponses vers la boîte de contact.
          to: data.email, subject: ack.subject, html: ack.html, templateCode: 'lead_ack',
          replyTo: LEADS_RECIPIENT,
        });
        ackSent = Boolean(out?.sent);
      } else if (alreadyAcked < ACK_MAX_PER_ADDRESS) {
        // Gabarit absent : rien n'est parti, on en garde la trace (le plafond, lui, est déjà visible
        // dans le journal par les accusés précédents).
        logSkipped({ toEmail: data.email, templateCode: 'lead_ack', reason: 'TEMPLATE_INTROUVABLE' });
      }
    } catch { /* journalisé par le mailer ; le prospect est déjà enregistré */ }

    res.status(201).json({ ok: true, ack_sent: ackSent });
  } catch (err) {
    sendBusinessError(res, err, 400);
  }
});
