import { Router } from 'express';
import { syncContact } from '../lib/newsletter.js';
import { rateLimit } from '../security.js';

export const newsletterRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Même posture anti-abus que les prospects : limitation par IP + champ piège.
const subscribeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 6 });

/**
 * POST /api/newsletter/subscribe - inscription publique à la newsletter.
 *
 * Aucun compte requis. Protections : champ piège (`website`) et limitation de
 * débit. Le consentement est obligatoire (RGPD). Le contact est ajouté à la
 * liste Brevo configurée en admin.
 *
 * @returns 201 `{ok:true}` · 400 `EMAIL_INVALIDE`/`CONSENTEMENT_REQUIS`
 *          · 503 `NEWSLETTER_INDISPONIBLE` (Brevo/liste non configurés) · 429 `TROP_DE_TENTATIVES`
 */
newsletterRouter.post('/newsletter/subscribe', subscribeLimiter, async (req, res) => {
  // Piège à robots : un humain ne remplit pas ce champ. Succès factice.
  if (req.body && String(req.body.website || '').trim() !== '') {
    return res.status(201).json({ ok: true });
  }
  const email = String(req.body?.email || '').trim().toLowerCase();
  const consent = req.body?.consent === true || req.body?.consent === 1 || req.body?.consent === 'on';
  const firstName = String(req.body?.first_name || '').trim().slice(0, 80);
  if (!EMAIL_RE.test(email) || email.length > 160) return res.status(400).json({ error: 'EMAIL_INVALIDE' });
  if (!consent) return res.status(400).json({ error: 'CONSENTEMENT_REQUIS' });

  const r = await syncContact({ email, subscribed: true, firstName });
  if (!r.synced && r.reason === 'NEWSLETTER_NON_CONFIGUREE') {
    return res.status(503).json({ error: 'NEWSLETTER_INDISPONIBLE' });
  }
  // Autres échecs Brevo : best-effort, on confirme quand même au visiteur (l'échec
  // est journalisé côté serveur) pour ne pas exposer d'état technique.
  return res.status(201).json({ ok: true });
});
