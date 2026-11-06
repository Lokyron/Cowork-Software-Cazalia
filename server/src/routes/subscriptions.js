import { Router } from 'express';
import { config } from '../config.js';
import {
  startSubscriptionCheckout, startBillingPortal, getSubscriptionSummary,
} from '../lib/subscriptions.js';
import { requireAuth, sendBusinessError } from '../middleware.js';

export const subscriptionsRouter = Router();

/**
 * POST /api/subscriptions/checkout - lance la souscription d'une formule.
 * Crée (ou réutilise) le client Stripe puis une session Checkout `subscription`.
 * @returns 200 `{url}` · 400 `TIER_INVALIDE` · 409 `ABONNEMENT_INDISPONIBLE`/`DEJA_ABONNE`
 */
subscriptionsRouter.post('/subscriptions/checkout', requireAuth, async (req, res) => {
  try {
    const tier = String(req.body?.tier || '').toUpperCase();
    const baseUrl = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    res.json(await startSubscriptionCheckout(req.user.id, tier, baseUrl));
  } catch (err) {
    if (err.code === 'STRIPE_NON_CONFIGURE') return res.status(409).json({ error: 'ABONNEMENT_INDISPONIBLE' });
    sendBusinessError(res, err);
  }
});

/**
 * POST /api/subscriptions/portal - ouvre le Customer Portal Stripe (gestion CB,
 * factures, résiliation).
 * @returns 200 `{url}` · 409 `AUCUN_ABONNEMENT`/`ABONNEMENT_INDISPONIBLE`
 */
subscriptionsRouter.post('/subscriptions/portal', requireAuth, async (req, res) => {
  try {
    const baseUrl = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    res.json(await startBillingPortal(req.user.id, baseUrl));
  } catch (err) {
    if (err.code === 'STRIPE_NON_CONFIGURE') return res.status(409).json({ error: 'ABONNEMENT_INDISPONIBLE' });
    sendBusinessError(res, err);
  }
});

/**
 * GET /api/subscriptions/me - résumé de l'abonnement de l'appelant (jauge quota).
 * @returns 200 `{tier, status, current_period_end, quota_used, quota_total}`
 */
subscriptionsRouter.get('/subscriptions/me', requireAuth, (req, res) => {
  try { res.json(getSubscriptionSummary(req.user.id)); } catch (err) { sendBusinessError(res, err); }
});
