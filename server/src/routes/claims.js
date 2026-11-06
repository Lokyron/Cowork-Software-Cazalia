import { Router } from 'express';
import { createClaim } from '../lib/claims.js';
import { sendMail, renderRaw } from '../lib/mailer.js';
import { sendBusinessError } from '../middleware.js';
import { rateLimit } from '../security.js';

export const claimsRouter = Router();

// Adresse de réception des réclamations (boîte de la gérante).
const CLAIMS_RECIPIENT = 'contact@cazalia.fr';
// Expéditeur des notifications internes : une adresse DISTINCTE du destinataire
// (no-reply@ sur le même domaine, authentifié Brevo) pour éviter l'envoi « à
// soi-même » contact@→contact@, souvent classé en indésirables. Le Reply-To
// pointe sur l'auteur du formulaire pour répondre directement.
const NOTIFY_FROM = `no-reply@${CLAIMS_RECIPIENT.split('@')[1]}`;

const KIND_LABEL = { annulation: 'Annulation', remboursement: 'Remboursement', autre: 'Autre' };

// Même rempart que la pré-inscription : champ piège + limitation de débit par IP.
const claimsLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 6 });

/**
 * POST /api/claims — réclamation consommateur (aucun compte requis).
 *
 * La réclamation est d'abord ENREGISTRÉE (trace durable), puis une notification
 * est envoyée à la gérante en best-effort : un échec d'e-mail ne doit pas perdre
 * la réclamation ni renvoyer une erreur au consommateur.
 *
 * @returns 201 `{ok:true}` · 400 erreur de validation · 429 `TROP_DE_TENTATIVES`
 */
claimsRouter.post('/claims', claimsLimiter, async (req, res) => {
  // Champ piège (honeypot) : rempli par les robots, invisible pour un humain.
  if (req.body && String(req.body.website || '').trim() !== '') {
    return res.status(201).json({ ok: true });
  }
  try {
    const userId = req.user?.id ?? null;
    const { id, data } = createClaim(req.body || {}, userId);

    // Notification best-effort à la gérante (ne lève jamais).
    try {
      const { subject, html } = renderRaw(
        `Nouvelle réclamation #{{id}} — {{kind}}`,
        `<h1 style="font-size:20px;margin:0 0 12px;">Réclamation #{{id}}</h1>
         <p style="margin:0 0 6px;"><strong>Type :</strong> {{kind}}</p>
         <p style="margin:0 0 6px;"><strong>Nom :</strong> {{first_name}} {{last_name}}</p>
         <p style="margin:0 0 6px;"><strong>E-mail :</strong> <a href="mailto:{{email}}">{{email}}</a></p>
         <p style="margin:0 0 6px;"><strong>Téléphone :</strong> <a href="tel:{{phone}}">{{phone}}</a></p>
         <p style="margin:0 0 6px;"><strong>Réservation :</strong> {{reservation_ref}}</p>
         <p style="margin:12px 0 4px;"><strong>Message :</strong></p>
         <p style="line-height:1.6;white-space:pre-wrap;margin:0;">{{message}}</p>`,
        {
          id,
          kind: KIND_LABEL[data.kind] || data.kind,
          first_name: data.first_name,
          last_name: data.last_name,
          email: data.email,
          phone: data.phone || '—',
          reservation_ref: data.reservation_ref || '—',
          message: data.message,
        }
      );
      await sendMail({
        to: CLAIMS_RECIPIENT, subject, html, templateCode: 'claim_notification',
        fromEmail: NOTIFY_FROM, fromName: 'Cazalia — Réclamations', replyTo: data.email,
      });
    } catch { /* journalisé par le mailer ; la réclamation est déjà enregistrée */ }

    res.status(201).json({ ok: true });
  } catch (err) {
    sendBusinessError(res, err, 400);
  }
});
