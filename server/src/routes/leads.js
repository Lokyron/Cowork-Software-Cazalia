import { Router } from 'express';
import { createProspect, setProspectNote } from '../lib/prospects.js';
import { sendMail, renderRaw } from '../lib/mailer.js';
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

// Limitation de débit par IP. Le limiteur mutualisé (`security.js`) borne sa
// table de compteurs : la version précédente, locale à ce fichier, croissait
// indéfiniment au fil des adresses vues (CWE-770).
const leadsLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 6 });

/**
 * POST /api/leads - pré-inscription publique (aucun compte requis).
 *
 * Deux protections complémentaires : un champ piège (`website`), invisible pour
 * un humain mais rempli par la plupart des robots, et une limitation de débit
 * par adresse IP. Le piège renvoie un succès factice : signaler le rejet
 * apprendrait au robot à contourner le mécanisme.
 *
 * @returns 201 `{ok:true}` · 400 erreur de validation · 429 `TROP_DE_TENTATIVES`
 */
leadsRouter.post('/leads', leadsLimiter, async (req, res) => {
  if (req.body && String(req.body.website || '').trim() !== '') {
    return res.status(201).json({ ok: true });
  }
  try {
    const source = typeof req.body?.source === 'string' ? req.body.source : null;
    const isDevis = source === 'devis_bureau_prive';
    const { id, data } = createProspect(req.body || {}, source);
    // Message libre (demande de devis « votre projet ») : conservé en note pour
    // ne pas le perdre si l'e-mail échoue.
    const message = String(req.body?.message || '').trim().slice(0, 2000);
    if (message) { try { setProspectNote(id, message); } catch { /* best-effort */ } }

    // Notification best-effort à la gérante (ne fait jamais échouer la saisie).
    try {
      const { subject, html } = renderRaw(
        isDevis ? `Demande de devis - Bureau Privé #{{id}}` : `Nouveau contact #{{id}}`,
        `<h1 style="font-size:20px;margin:0 0 12px;">{{title}}</h1>
         <p style="margin:0 0 6px;"><strong>Nom :</strong> {{first_name}} {{last_name}}</p>
         <p style="margin:0 0 6px;"><strong>E-mail :</strong> <a href="mailto:{{email}}">{{email}}</a></p>
         <p style="margin:0 0 6px;"><strong>Téléphone :</strong> <a href="tel:{{phone}}">{{phone}}</a></p>
         <p style="margin:0 0 6px;"><strong>Profil :</strong> {{activity}}</p>
         <p style="margin:0 0 6px;"><strong>Origine :</strong> {{source}}</p>
         <p style="margin:12px 0 4px;"><strong>Message :</strong></p>
         <p style="line-height:1.6;white-space:pre-wrap;margin:0;">{{message}}</p>`,
        {
          id,
          title: isDevis ? 'Demande de devis - Bureau Privé longue durée' : 'Nouveau contact',
          first_name: data.first_name,
          last_name: data.last_name,
          email: data.email,
          phone: data.phone,
          activity: ACTIVITY_LABEL[data.activity] || data.activity || '-',
          source: source || '-',
          message: message || '-',
        }
      );
      await sendMail({
        to: LEADS_RECIPIENT, subject, html, templateCode: 'lead_notification',
        fromEmail: NOTIFY_FROM, fromName: isDevis ? 'Cazalia - Devis' : 'Cazalia - Contact', replyTo: data.email,
      });
    } catch { /* journalisé par le mailer ; le prospect est déjà enregistré */ }

    res.status(201).json({ ok: true });
  } catch (err) {
    sendBusinessError(res, err, 400);
  }
});
