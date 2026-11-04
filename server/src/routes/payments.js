import { Router } from 'express';
import { config } from '../config.js';
import { getStripe } from '../lib/settings.js';
import { createCheckoutSession, findPack } from '../lib/stripe.js';
import { recordPending } from '../lib/purchases.js';
import { requireAuth, sendBusinessError } from '../middleware.js';
import { rateLimit } from '../security.js';

export const paymentsRouter = Router();

// Quelques créations de session par minute suffisent largement : au-delà, on
// borne (une session ouverte non payée ne coûte rien, mais inutile d'en abuser).
const checkoutLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

/**
 * GET /api/wallet/packs — formules d'achat de crédits et disponibilité du paiement.
 * @returns 200 `{enabled, packs}` · 401 `NON_AUTHENTIFIE`
 */
paymentsRouter.get('/wallet/packs', requireAuth, (_req, res) => {
  const { enabled, packs } = getStripe();
  res.json({ enabled, packs });
});

/**
 * POST /api/wallet/checkout — crée une session Stripe Checkout pour une formule.
 * Le membre est identifié par la SESSION (jamais par le corps) : impossible de
 * créditer le portefeuille d'un autre.
 *
 * @returns 200 `{url}` · 400 `PACK_INVALIDE` · 409 `STRIPE_NON_CONFIGURE`
 *          · 401 `NON_AUTHENTIFIE` · 429 `TROP_DE_TENTATIVES`
 */
paymentsRouter.post('/wallet/checkout', requireAuth, checkoutLimiter, async (req, res) => {
  try {
    const { enabled } = getStripe();
    if (!enabled) return res.status(409).json({ error: 'STRIPE_NON_CONFIGURE' });

    const pack = findPack(String(req.body?.pack_id || ''));
    if (!pack) return res.status(400).json({ error: 'PACK_INVALIDE' });

    const baseUrl = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    const session = await createCheckoutSession({ userId: req.user.id, pack, baseUrl });
    recordPending({ userId: req.user.id, sessionId: session.id, credits: pack.credits, amountEurCents: pack.eur_cents });

    res.json({ url: session.url });
  } catch (err) {
    if (err.code === 'STRIPE_NON_CONFIGURE') return res.status(409).json({ error: 'STRIPE_NON_CONFIGURE' });
    sendBusinessError(res, err, 500);
  }
});
