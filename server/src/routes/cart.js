// Panier de réservation — côté client (pour soi-même).
import { Router } from 'express';
import { addHold, listCart, removeHold, checkout } from '../lib/cart.js';
import { ensureVoucherForReservation } from '../lib/unifi.js';
import { sendBookingConfirmation } from '../lib/mailer.js';
import { requireAuth, sendBusinessError } from '../middleware.js';

export const cartRouter = Router();

/**
 * GET /api/cart — panier de l'utilisateur connecté.
 * @returns 200 `{holds, total, count, balance}` · 401 `NON_AUTHENTIFIE`
 */
cartRouter.get('/cart', requireAuth, (req, res) => {
  try { res.json(listCart(req.user.id)); } catch (err) { sendBusinessError(res, err); }
});

/**
 * POST /api/cart — ajoute un créneau au panier (pose un verrou de 10 minutes).
 * Aucune option de contournement n'est transmise à `addHold` : les horaires
 * d'ouverture et la capacité s'appliquent pleinement côté membre.
 *
 * @returns 201 `{hold, cart}` · 400 `CHAMPS_INVALIDES` · 400 `HORS_HORAIRES`
 *          · 409 `COMPLET` · 409 `PANIER_PLEIN`
 */
cartRouter.post('/cart', requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    const spaceId = Number(b.space_id);
    if (!spaceId || !b.start_at || !b.end_at) return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
    const hold = addHold(req.user.id, spaceId, b.start_at, b.end_at, b.seats);
    res.status(201).json({ hold, cart: listCart(req.user.id) });
  } catch (err) { sendBusinessError(res, err); }
});

/**
 * DELETE /api/cart/:id — retire une ligne du panier.
 * L'appartenance du verrou est vérifiée dans `removeHold`.
 * @returns 200 `{ok, cart}` · 403 `INTERDIT`
 */
cartRouter.delete('/cart/:id', requireAuth, (req, res) => {
  try { removeHold(Number(req.params.id), req.user); res.json({ ok: true, cart: listCart(req.user.id) }); }
  catch (err) { sendBusinessError(res, err); }
});

/**
 * POST /api/cart/checkout — transforme le panier en réservations (tout ou rien).
 * @returns 201 `{reservations, total, count}` · 400 `PANIER_VIDE`
 *          · 402 `CREDITS_INSUFFISANTS` · 409 `COMPLET`
 */
cartRouter.post('/cart/checkout', requireAuth, async (req, res) => {
  try {
    const result = checkout(req.user.id, req.user);
    await Promise.allSettled(result.reservations.map((r) => ensureVoucherForReservation(r.reservationId)));
    result.reservations.forEach((r) => sendBookingConfirmation(r.reservationId).catch(() => {}));
    res.status(201).json(result);
  } catch (err) { sendBusinessError(res, err); }
});
