import { Router } from 'express';
import { getStripe } from '../lib/settings.js';
import { requireAuth } from '../middleware.js';

export const paymentsRouter = Router();

/**
 * GET /api/payments/status — indique si le paiement en ligne (Stripe) est actif.
 * Consommé par le front pour autoriser (ou non) la réservation payante. L'achat
 * de « crédits » n'existe plus : on paie chaque réservation en euros à la résa.
 *
 * @returns 200 `{enabled}` · 401 `NON_AUTHENTIFIE`
 */
paymentsRouter.get('/payments/status', requireAuth, (_req, res) => {
  res.json({ enabled: getStripe().enabled });
});
