import { Router } from 'express';
import { reserve, reserveBatch, cancelReservation, listMyReservations } from '../lib/booking.js';
import { ensureVoucherForReservation, revokeVoucherForReservation } from '../lib/unifi.js';
import { sendBookingConfirmation, sendBookingCancelled } from '../lib/mailer.js';
import { requireAuth, sendBusinessError } from '../middleware.js';

export const reservationsRouter = Router();

/**
 * POST /api/reservations — réserve un créneau pour l'utilisateur connecté.
 *
 * Le bénéficiaire est TOUJOURS `req.user.id` : aucun identifiant d'utilisateur
 * n'est accepté depuis le corps de la requête, et aucune option de contournement
 * (horaires, surbooking, tarif) n'est transmise — celles-ci sont l'apanage des
 * routes `/api/admin` (OWASP A01).
 *
 * @returns 201 `{reservationId, cost, seats, voucher_code}` · 400 `CHAMPS_INVALIDES`
 *          · 402 `CREDITS_INSUFFISANTS` · 409 `COMPLET` · 401 `NON_AUTHENTIFIE`
 */
reservationsRouter.post('/reservations', requireAuth, async (req, res) => {
  try {
    const spaceId = Number(req.body?.space_id);
    const { start_at, end_at, seats } = req.body || {};
    if (!spaceId || !start_at || !end_at) {
      return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
    }
    const result = reserve(req.user.id, spaceId, start_at, end_at, seats);
    // Voucher Wi-Fi (best-effort, hors transaction) : n'échoue jamais la réservation.
    result.voucher_code = await ensureVoucherForReservation(result.reservationId);
    sendBookingConfirmation(result.reservationId).catch(() => {}); // e-mail auto (best-effort)
    res.status(201).json(result);
  } catch (err) {
    sendBusinessError(res, err);
  }
});

/**
 * POST /api/reservations/batch — réserve plusieurs créneaux en tout ou rien.
 * Le nombre de créneaux est plafonné côté métier (`TROP_DE_CRENEAUX`).
 *
 * @returns 201 `{reservations, total, count}` · 400 `CHAMPS_INVALIDES` ·
 *          400 `TROP_DE_CRENEAUX` · 402 `CREDITS_INSUFFISANTS` · 409 `COMPLET`
 */
reservationsRouter.post('/reservations/batch', requireAuth, async (req, res) => {
  try {
    const spaceId = Number(req.body?.space_id);
    const slots = req.body?.slots;
    if (!spaceId || !Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
    }
    const result = reserveBatch(req.user.id, spaceId, slots);
    // Un voucher par ligne de réservation (best-effort).
    await Promise.allSettled((result.reservations || []).map((r) => ensureVoucherForReservation(r.reservationId)));
    (result.reservations || []).forEach((r) => sendBookingConfirmation(r.reservationId).catch(() => {}));
    res.status(201).json(result);
  } catch (err) {
    sendBusinessError(res, err, 400, err.slotIndex != null ? { slot_index: err.slotIndex } : undefined);
  }
});

/**
 * GET /api/reservations/me — réservations de l'utilisateur connecté.
 * @returns 200 `{reservations}` · 401 `NON_AUTHENTIFIE`
 */
reservationsRouter.get('/reservations/me', requireAuth, (req, res) => {
  res.json({ reservations: listMyReservations(req.user.id) });
});

/**
 * DELETE /api/reservations/:id — annule une réservation.
 *
 * La propriété est contrôlée dans `cancelReservation`, à l'intérieur de la
 * transaction : un membre ne peut pas annuler la réservation d'un tiers en
 * devinant son identifiant (IDOR/BOLA).
 *
 * @returns 200 `{cancelled, refunded, amount}` · 403 `INTERDIT` ·
 *          404 `RESA_INTROUVABLE` · 409 `DEJA_ANNULEE`
 */
reservationsRouter.delete('/reservations/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = cancelReservation(id, req.user);
    await revokeVoucherForReservation(id); // révoque le voucher sur le UDM (best-effort)
    sendBookingCancelled(id, { refunded: result.refunded, amount: result.amount }).catch(() => {}); // e-mail auto
    res.json(result);
  } catch (err) {
    sendBusinessError(res, err);
  }
});
