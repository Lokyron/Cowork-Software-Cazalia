// Panier de réservation - côté client (pour soi-même).
import { Router } from 'express';
import { config } from '../config.js';
import { addHold, listCart, removeHold, startBookingCheckout, checkoutFree, previewPromo } from '../lib/cart.js';
import { getStripe } from '../lib/settings.js';
import { requireAuth, sendBusinessError } from '../middleware.js';

export const cartRouter = Router();

/**
 * GET /api/cart - panier de l'utilisateur connecté.
 * @returns 200 `{holds, total, count}` · 401 `NON_AUTHENTIFIE`
 */
cartRouter.get('/cart', requireAuth, (req, res) => {
  try { res.json(listCart(req.user.id)); } catch (err) { sendBusinessError(res, err); }
});

/**
 * POST /api/cart - ajoute un créneau au panier (verrou de 10 min).
 * Aucune option de contournement n'est transmise : horaires et capacité
 * s'appliquent pleinement côté membre. Le `tarif_type` choisi est pris en compte.
 *
 * @returns 201 `{hold, cart}` · 400 `CHAMPS_INVALIDES`/`HORS_HORAIRES`/`CRENEAU_FORFAIT_INVALIDE`
 *          · 409 `COMPLET`/`PANIER_PLEIN`
 */
cartRouter.post('/cart', requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    const spaceId = Number(b.space_id);
    if (!spaceId || !b.start_at || !b.end_at) return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
    const hold = addHold(req.user.id, spaceId, b.start_at, b.end_at, b.seats, { tarifType: b.tarif_type });
    res.status(201).json({ hold, cart: listCart(req.user.id) });
  } catch (err) { sendBusinessError(res, err); }
});

/**
 * DELETE /api/cart/:id - retire une ligne du panier.
 * @returns 200 `{ok, cart}` · 403 `INTERDIT`
 */
cartRouter.delete('/cart/:id', requireAuth, (req, res) => {
  try { removeHold(Number(req.params.id), req.user); res.json({ ok: true, cart: listCart(req.user.id) }); }
  catch (err) { sendBusinessError(res, err); }
});

/**
 * POST /api/cart/promo/preview - prévisualise l'effet d'un code sur le panier
 * (remise et nouveau total) SANS rien enregistrer. Le code n'est comptabilisé
 * comme utilisé qu'à la confirmation du paiement (webhook).
 *
 * @returns 200 `{code, discount_cents, total_cents, new_total_cents, ...}`
 *          · 400 `PANIER_VIDE`/`PROMO_*`
 */
cartRouter.post('/cart/promo/preview', requireAuth, (req, res) => {
  try {
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'PROMO_INTROUVABLE' });
    res.json(previewPromo(req.user.id, code));
  } catch (err) { sendBusinessError(res, err, 400); }
});

/**
 * POST /api/cart/checkout - valide le panier de l'utilisateur connecté.
 *   • Membre : lance le PAIEMENT CB (session Stripe) ; les réservations sont
 *     créées à la confirmation du paiement (webhook). On renvoie l'URL Stripe.
 *   • Admin : réservation GRATUITE immédiate (un admin n'est jamais facturé,
 *     quel que soit le parcours utilisé). On renvoie `{free:true, ...}`.
 *
 * @returns 200 `{url}` ou `{free, reservations, count}` · 400 `PANIER_VIDE`/`HORS_HORAIRES`
 *          · 409 `COMPLET`/`PAIEMENT_INDISPONIBLE`
 */
cartRouter.post('/cart/checkout', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      return res.json(await checkoutFree(req.user.id));
    }
    if (!getStripe().enabled) return res.status(409).json({ error: 'PAIEMENT_INDISPONIBLE' });
    const baseUrl = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    const result = await startBookingCheckout(req.user.id, baseUrl, { promoCode: req.body?.promo_code || null });
    res.json(result);
  } catch (err) {
    if (err.code === 'STRIPE_NON_CONFIGURE') return res.status(409).json({ error: 'PAIEMENT_INDISPONIBLE' });
    sendBusinessError(res, err);
  }
});
