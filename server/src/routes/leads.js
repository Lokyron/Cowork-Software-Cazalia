import { Router } from 'express';
import { createProspect } from '../lib/prospects.js';
import { sendBusinessError } from '../middleware.js';
import { rateLimit } from '../security.js';

export const leadsRouter = Router();

// Limitation de débit par IP. Le limiteur mutualisé (`security.js`) borne sa
// table de compteurs : la version précédente, locale à ce fichier, croissait
// indéfiniment au fil des adresses vues (CWE-770).
const leadsLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 6 });

/**
 * POST /api/leads — pré-inscription publique (aucun compte requis).
 *
 * Deux protections complémentaires : un champ piège (`website`), invisible pour
 * un humain mais rempli par la plupart des robots, et une limitation de débit
 * par adresse IP. Le piège renvoie un succès factice : signaler le rejet
 * apprendrait au robot à contourner le mécanisme.
 *
 * @returns 201 `{ok:true}` · 400 erreur de validation · 429 `TROP_DE_TENTATIVES`
 */
leadsRouter.post('/leads', leadsLimiter, (req, res) => {
  if (req.body && String(req.body.website || '').trim() !== '') {
    return res.status(201).json({ ok: true });
  }
  try {
    const source = typeof req.body?.source === 'string' ? req.body.source : null;
    createProspect(req.body || {}, source);
    res.status(201).json({ ok: true });
  } catch (err) {
    sendBusinessError(res, err, 400);
  }
});
