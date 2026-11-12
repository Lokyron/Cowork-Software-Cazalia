import { Router } from 'express';
import { config } from '../config.js';
import { cancelReservation, listMyReservations } from '../lib/booking.js';
import { listMyTransactions, listMyPendingOrders } from '../lib/orders.js';
import { addHold, startBookingCheckout, checkoutFree } from '../lib/cart.js';
import { getStripe } from '../lib/settings.js';
import { revokeVoucherForReservation } from '../lib/unifi.js';
import { revokeAccessForReservation } from '../lib/unifiAccess.js';
import { sendBookingCancelled, sendRefundRequestToAdmin } from '../lib/mailer.js';
import { requireAuth, sendBusinessError } from '../middleware.js';

export const reservationsRouter = Router();

/**
 * POST /api/reservations - démarre la réservation+PAIEMENT d'un créneau pour le
 * membre connecté : pose un verrou puis crée une session Stripe Checkout. La
 * réservation réelle est créée à la confirmation du paiement (webhook). On
 * renvoie l'URL de paiement vers laquelle le client est redirigé.
 *
 * Le bénéficiaire est TOUJOURS `req.user.id` ; aucune option de contournement
 * n'est transmise (apanage des routes `/api/admin`, OWASP A01).
 *
 * Un utilisateur de rôle `admin` n'est jamais facturé : sa réservation est
 * créée gratuitement et immédiatement (pas de passage par Stripe), on renvoie
 * `{free:true, ...}`.
 *
 * @returns 200 `{url}` ou `{free, reservations, count}`
 *          · 400 `CHAMPS_INVALIDES`/`HORS_HORAIRES`/`CRENEAU_FORFAIT_INVALIDE`
 *          · 409 `COMPLET`/`PAIEMENT_INDISPONIBLE`
 */
reservationsRouter.post('/reservations', requireAuth, async (req, res) => {
  try {
    const spaceId = Number(req.body?.space_id);
    const { start_at, end_at, seats, tarif_type } = req.body || {};
    if (!spaceId || !start_at || !end_at) return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && !getStripe().enabled) return res.status(409).json({ error: 'PAIEMENT_INDISPONIBLE' });
    addHold(req.user.id, spaceId, start_at, end_at, seats, { tarifType: tarif_type, adminMode: isAdmin });
    if (isAdmin) return res.json(await checkoutFree(req.user.id));
    const baseUrl = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    const result = await startBookingCheckout(req.user.id, baseUrl, { promoCode: req.body?.promo_code || null });
    res.json(result);
  } catch (err) {
    if (err.code === 'STRIPE_NON_CONFIGURE') return res.status(409).json({ error: 'PAIEMENT_INDISPONIBLE' });
    sendBusinessError(res, err);
  }
});

/**
 * POST /api/reservations/batch - réserve+paie plusieurs créneaux en un seul
 * paiement : pose un verrou par créneau puis crée une session Stripe du panier.
 *
 * Comme `/reservations`, un utilisateur de rôle `admin` n'est jamais facturé :
 * réservations créées gratuitement et immédiatement, réponse `{free:true, ...}`.
 *
 * @returns 200 `{url}` ou `{free, reservations, count}`
 *          · 400 `CHAMPS_INVALIDES` · 409 `COMPLET`/`PAIEMENT_INDISPONIBLE`
 */
reservationsRouter.post('/reservations/batch', requireAuth, async (req, res) => {
  try {
    const spaceId = Number(req.body?.space_id);
    const slots = req.body?.slots;
    if (!spaceId || !Array.isArray(slots) || slots.length === 0) return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && !getStripe().enabled) return res.status(409).json({ error: 'PAIEMENT_INDISPONIBLE' });
    slots.forEach((s, i) => addHold(req.user.id, spaceId, s.start_at, s.end_at, s.seats, { tarifType: s.tarif_type, adminMode: isAdmin }));
    if (isAdmin) return res.json(await checkoutFree(req.user.id));
    const baseUrl = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    const result = await startBookingCheckout(req.user.id, baseUrl, { promoCode: req.body?.promo_code || null });
    res.json(result);
  } catch (err) {
    if (err.code === 'STRIPE_NON_CONFIGURE') return res.status(409).json({ error: 'PAIEMENT_INDISPONIBLE' });
    sendBusinessError(res, err, 400, err.slotIndex != null ? { slot_index: err.slotIndex } : undefined);
  }
});

/**
 * GET /api/reservations/me - réservations de l'utilisateur connecté.
 * `processing` = paiements RÉELLEMENT réglés chez Stripe dont le webhook n'a pas
 * encore créé la réservation. Permet au front d'afficher un bandeau « paiement en
 * cours » et de ne pas laisser croire à une résa perdue. Une tentative de paiement
 * abandonnée n'en fait pas partie : rien n'a été réglé (cf. listMyPendingOrders).
 *
 * @returns 200 `{reservations, processing}` · 401 `NON_AUTHENTIFIE`
 */
reservationsRouter.get('/reservations/me', requireAuth, async (req, res) => {
  try {
    res.json({
      reservations: listMyReservations(req.user.id),
      processing: await listMyPendingOrders(req.user.id),
    });
  } catch (err) { sendBusinessError(res, err); }
});

/**
 * GET /api/transactions/me - historique des paiements en ligne de l'appelant.
 * L'identité vient de la SESSION (pas de paramètre) : aucune transaction d'un
 * autre membre n'est accessible.
 *
 * @returns 200 `{transactions}` · 401 `NON_AUTHENTIFIE`
 */
reservationsRouter.get('/transactions/me', requireAuth, (req, res) => {
  res.json({ transactions: listMyTransactions(req.user.id) });
});

/**
 * DELETE /api/reservations/:id - annule une réservation. La propriété est
 * contrôlée dans `cancelReservation` (anti-IDOR). Si un remboursement est dû
 * (annulation dans les délais d'une résa payée en ligne), l'admin est notifié
 * par e-mail pour l'effectuer dans Stripe (pas de remboursement automatique).
 *
 * @returns 200 `{cancelled, refunded, amount}` · 403 `INTERDIT` ·
 *          404 `RESA_INTROUVABLE` · 409 `DEJA_ANNULEE`
 */
reservationsRouter.delete('/reservations/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = cancelReservation(id, req.user);
    await revokeVoucherForReservation(id); // best-effort
    await revokeAccessForReservation(id);  // révoque le PIN de porte (best-effort)
    sendBookingCancelled(id, { refunded: result.refunded, amount: result.amount }).catch(() => {});
    if (result.refunded) sendRefundRequestToAdmin(id, { amount: result.amount }).catch(() => {});
    res.json(result);
  } catch (err) {
    sendBusinessError(res, err);
  }
});
