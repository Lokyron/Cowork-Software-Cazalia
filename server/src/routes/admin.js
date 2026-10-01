import { Router } from 'express';
import { db } from '../db.js';
import { topUp, getBalance, getLedger, getLedgerBetween } from '../lib/wallet.js';
import { streamInvoicePdf } from '../lib/invoice.js';
import {
  listPlanning,
  getReservationDetail,
  setReservationNote,
  moveReservation,
  adminCancelReservation,
  reserve,
  reserveBatch,
} from '../lib/booking.js';
import { toUtcIso, parsePeriod } from '../lib/time.js';
import { ensureVoucherForReservation, revokeVoucherForReservation } from '../lib/unifi.js';
import { addHold, listCart, removeHold, checkout } from '../lib/cart.js';
import { requireAdmin, sendBusinessError } from '../middleware.js';
import { config } from '../config.js';
import { adminSetPassword, createResetToken } from '../lib/passwords.js';
import { adminUpdateUser, adminCreateUser, deleteUserAccount } from '../lib/users.js';
import { sendPasswordResetEmail, sendReservationNotification, sendBookingConfirmation } from '../lib/mailer.js';
import { defaultSpaceContent } from '../lib/spaceContent.js';
import { getDashboardStats } from '../lib/dashboard.js';
import { securityEvent } from '../lib/audit.js';
import {
  listProspects,
  countsByStatus,
  setProspectStatus,
  setProspectNote,
  deleteProspect,
  exportCsv,
} from '../lib/prospects.js';

export const adminRouter = Router();

// TOUTES les routes de ce routeur exigent le rôle `admin`. Le contrôle est posé
// une fois, au niveau du routeur : ajouter une route ici ne peut pas, par
// oubli, créer un point d'entrée non protégé (défense en profondeur contre
// l'élévation de privilèges verticale, OWASP A01).
adminRouter.use(requireAdmin);

// ── Tableau de bord : indicateurs agrégés ────────────────────────────────────
adminRouter.get('/dashboard', (_req, res) => {
  try {
    res.json(getDashboardStats());
  } catch (err) {
    sendBusinessError(res, err, 500);
  }
});

// ── Espaces : CRUD (zones et salles, une seule table) ────────────────────────
const insertSpace = db.prepare(
  `INSERT INTO spaces (name, kind, capacity, exclusive, privatizable, credits_per_hour, color, description, amenities, active)
   VALUES (@name, @kind, @capacity, @exclusive, @privatizable, @credits_per_hour, @color, @description, @amenities, @active)`
);

adminRouter.get('/spaces', (_req, res) => {
  res.json({ spaces: db.prepare(`SELECT * FROM spaces ORDER BY kind, name`).all() });
});

adminRouter.post('/spaces', (req, res) => {
  try {
    const b = req.body || {};
    const kind = b.kind === 'room' ? 'room' : 'zone';
    const exclusive = b.exclusive ? 1 : 0;
    // Exclusif : la capacité = nb d'occupants (info). Inventaire : nb de places.
    const capacity = Math.max(1, Number(b.capacity) || 1);
    const defaults = defaultSpaceContent(kind);
    const space = {
      name: String(b.name || '').trim(),
      kind,
      capacity,
      exclusive,
      privatizable: !exclusive && b.privatizable ? 1 : 0,
      credits_per_hour: Math.max(0, Number(b.credits_per_hour) || 0),
      color: b.color || '#1C3155',
      description: b.description != null ? String(b.description) : defaults.description,
      amenities: b.amenities != null ? String(b.amenities) : defaults.amenities,
      active: b.active === false ? 0 : 1,
    };
    if (!space.name) return res.status(400).json({ error: 'NOM_REQUIS' });
    const info = insertSpace.run(space);
    res.status(201).json({ space: db.prepare(`SELECT * FROM spaces WHERE id = ?`).get(info.lastInsertRowid) });
  } catch (err) {
    sendBusinessError(res, err, 500);
  }
});

adminRouter.put('/spaces/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM spaces WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'ESPACE_INTROUVABLE' });

  const b = req.body || {};
  const kind = b.kind === 'room' || b.kind === 'zone' ? b.kind : existing.kind;
  const capacity = Math.max(1, Number(b.capacity ?? existing.capacity) || 1);
  const exclusive = b.exclusive != null ? (b.exclusive ? 1 : 0) : existing.exclusive;
  const next = {
    name: b.name != null ? String(b.name).trim() : existing.name,
    kind,
    capacity,
    exclusive,
    privatizable: exclusive ? 0 : (b.privatizable != null ? (b.privatizable ? 1 : 0) : existing.privatizable),
    credits_per_hour: b.credits_per_hour != null ? Math.max(0, Number(b.credits_per_hour)) : existing.credits_per_hour,
    color: b.color ?? existing.color,
    description: b.description != null ? String(b.description) : existing.description,
    amenities: b.amenities != null ? String(b.amenities) : existing.amenities,
    active: b.active != null ? (b.active ? 1 : 0) : existing.active,
  };
  db.prepare(
    `UPDATE spaces SET name=@name, kind=@kind, capacity=@capacity, exclusive=@exclusive, privatizable=@privatizable,
        credits_per_hour=@credits_per_hour, color=@color,
        description=@description, amenities=@amenities, active=@active WHERE id=@id`
  ).run({ ...next, id });
  res.json({ space: db.prepare(`SELECT * FROM spaces WHERE id = ?`).get(id) });
});

// ── Recharge manuelle des crédits d'un membre (brief §5.3) ───────────────────
adminRouter.post('/wallet/topup', (req, res) => {
  try {
    const userId = Number(req.body?.user_id);
    const amount = Number(req.body?.amount);
    const note = req.body?.note ? String(req.body.note) : null;
    // Montant payé en euros (optionnel) → centimes.
    const euros = Number(req.body?.euros);
    const amountEurCents = Number.isFinite(euros) && euros > 0 ? Math.round(euros * 100) : null;
    if (!userId) return res.status(400).json({ error: 'USER_ID_REQUIS' });
    const member = db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId);
    if (!member) return res.status(404).json({ error: 'MEMBRE_INTROUVABLE' });
    const result = topUp({ userId, amount, createdBy: req.user.id, note, amountEurCents });
    securityEvent('admin_recharge_credits', {
      adminId: req.user.id, cibleId: userId, credits: amount, eurCents: amountEurCents, ip: req.ip,
    });
    res.status(201).json(result);
  } catch (err) {
    sendBusinessError(res, err);
  }
});

// ── Planning global ───────────────────────────────────────────────────────────
adminRouter.get('/planning', (req, res) => {
  try {
    // Défaut : 7 jours glissants à partir de maintenant.
    const from = req.query.from ? toUtcIso(req.query.from) : new Date().toISOString();
    const to = req.query.to
      ? toUtcIso(req.query.to)
      : new Date(Date.now() + 7 * 86_400_000).toISOString();
    res.json({ from, to, reservations: listPlanning({ from, to }) });
  } catch (err) {
    sendBusinessError(res, err);
  }
});

// ── Membres (avec solde calculé depuis le grand-livre) ───────────────────────
adminRouter.get('/members', (_req, res) => {
  const users = db
    .prepare(
      `SELECT id, email, display_name, first_name, last_name, phone, role, created_at
         FROM users ORDER BY display_name`
    )
    .all();
  res.json({ members: users.map((u) => ({ ...u, balance: getBalance(u.id) })) });
});

// Réserver un ou plusieurs créneaux POUR un membre (walk-in). Débite son solde.
adminRouter.post('/members/:id/reservations', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const spaceId = Number(req.body?.space_id);
    const slots = req.body?.slots;
    if (!userId || !spaceId || !Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
    }
    if (!db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId)) {
      return res.status(404).json({ error: 'UTILISATEUR_INTROUVABLE' });
    }
    const result = reserveBatch(userId, spaceId, slots);
    await Promise.allSettled((result.reservations || []).map((r) => ensureVoucherForReservation(r.reservationId)));
    (result.reservations || []).forEach((r) => sendBookingConfirmation(r.reservationId).catch(() => {}));
    res.status(201).json(result);
  } catch (err) {
    sendBusinessError(res, err, 400, err.slotIndex != null ? { slot_index: err.slotIndex } : undefined);
  }
});

// POST /admin/reservations — réservation unitaire depuis le planning, POUR un client,
// avec droits avancés (bypass) : hors horaires, surbooking, tarif/remise personnalisé.
adminRouter.post('/reservations', async (req, res) => {
  try {
    const b = req.body || {};
    const userId = Number(b.user_id);
    const spaceId = Number(b.space_id);
    if (!userId || !spaceId || !b.start_at || !b.end_at) return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
    if (!db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId)) {
      return res.status(404).json({ error: 'UTILISATEUR_INTROUVABLE' });
    }
    const opts = {
      ignoreHours: !!b.ignore_hours,
      allowOverbooking: !!b.allow_overbooking,
      customCost: b.custom_cost != null && b.custom_cost !== '' ? Number(b.custom_cost) : undefined,
      createdBy: req.user.id,
    };
    const result = reserve(userId, spaceId, b.start_at, b.end_at, b.seats, opts);
    result.voucher_code = await ensureVoucherForReservation(result.reservationId);
    sendBookingConfirmation(result.reservationId).catch(() => {}); // confirmation au client (best-effort)
    res.status(201).json(result);
  } catch (err) {
    sendBusinessError(res, err);
  }
});

// ── Panier multi-espaces POUR un client (droits bypass par ligne) ────────────
adminRouter.get('/cart', (req, res) => {
  try {
    const userId = Number(req.query.user_id);
    if (!userId) return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
    res.json(listCart(userId));
  } catch (err) { sendBusinessError(res, err); }
});

adminRouter.post('/cart', (req, res) => {
  try {
    const b = req.body || {};
    const userId = Number(b.user_id);
    const spaceId = Number(b.space_id);
    if (!userId || !spaceId || !b.start_at || !b.end_at) return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
    if (!db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId)) return res.status(404).json({ error: 'UTILISATEUR_INTROUVABLE' });
    const opts = {
      ignoreHours: !!b.ignore_hours,
      allowOverbooking: !!b.allow_overbooking,
      customCost: b.custom_cost != null && b.custom_cost !== '' ? Number(b.custom_cost) : undefined,
      createdBy: req.user.id,
    };
    const hold = addHold(userId, spaceId, b.start_at, b.end_at, b.seats, opts);
    res.status(201).json({ hold, cart: listCart(userId) });
  } catch (err) { sendBusinessError(res, err); }
});

adminRouter.delete('/cart/:id', (req, res) => {
  try { removeHold(Number(req.params.id), req.user); res.json({ ok: true }); }
  catch (err) { sendBusinessError(res, err); }
});

adminRouter.post('/cart/checkout', async (req, res) => {
  try {
    const userId = Number(req.body?.user_id);
    if (!userId) return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
    const result = checkout(userId, req.user);
    await Promise.allSettled(result.reservations.map((r) => ensureVoucherForReservation(r.reservationId)));
    result.reservations.forEach((r) => sendBookingConfirmation(r.reservationId).catch(() => {}));
    res.status(201).json(result);
  } catch (err) { sendBusinessError(res, err); }
});

// Fiche d'un membre : infos + solde + historique enrichi des transactions.
adminRouter.get('/members/:id', (req, res) => {
  const id = Number(req.params.id);
  const member = db
    .prepare(
      `SELECT id, email, display_name, first_name, last_name, phone, role, created_at
         FROM users WHERE id = ?`
    )
    .get(id);
  if (!member) return res.status(404).json({ error: 'UTILISATEUR_INTROUVABLE' });
  res.json({
    member: { ...member, balance: getBalance(id) },
    transactions: getLedger(id),
  });
});

// Création d'un compte par l'admin (mot de passe par défaut + changement forcé).
adminRouter.post('/users', (req, res) => {
  try {
    const result = adminCreateUser(req.body || {});
    securityEvent('admin_compte_cree', {
      adminId: req.user.id, cibleId: result.user.id, role: result.user.role, ip: req.ip,
    });
    res.status(201).json(result);
  } catch (err) {
    sendBusinessError(res, err);
  }
});

/**
 * GET /api/admin/members/:id/invoice?from&to — relevé PDF d'un membre.
 * La période est validée avant l'émission des en-têtes ; le nom de fichier ne
 * reprend que l'identifiant numérique (aucune donnée utilisateur dans l'en-tête
 * `Content-Disposition`).
 *
 * @returns 200 `application/pdf` · 400 `PERIODE_INVALIDE` · 404 `UTILISATEUR_INTROUVABLE`
 */
adminRouter.get('/members/:id/invoice', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
  const member = db
    .prepare(`SELECT id, email, display_name, first_name, last_name, phone FROM users WHERE id = ?`)
    .get(id);
  if (!member) return res.status(404).json({ error: 'UTILISATEUR_INTROUVABLE' });
  let period;
  try {
    period = parsePeriod(req.query.from, req.query.to);
  } catch (err) {
    return sendBusinessError(res, err);
  }
  const transactions = getLedgerBetween(id, period.fromIso, period.toIso);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="releve-${id}.pdf"`);
  streamInvoicePdf(res, { member, transactions, fromIso: period.fromIso, toIso: period.toIso });
});

// Édition des informations d'un compte (prénom, nom, email, téléphone, rôle).
adminRouter.put('/users/:id', (req, res) => {
  try {
    const cibleId = Number(req.params.id);
    const before = db.prepare(`SELECT role FROM users WHERE id = ?`).get(cibleId);
    const user = adminUpdateUser(cibleId, req.body || {});
    if (before && before.role !== user.role) {
      securityEvent('admin_role_change', {
        adminId: req.user.id, cibleId, avant: before.role, apres: user.role, ip: req.ip,
      });
    }
    res.json({ user });
  } catch (err) {
    sendBusinessError(res, err);
  }
});

// Suppression d'un membre par l'admin (confirmation "SUPPRIMER", crédits perdus).
adminRouter.delete('/users/:id', (req, res) => {
  try {
    if (String(req.body?.confirm) !== 'SUPPRIMER') {
      return res.status(400).json({ error: 'CONFIRMATION_INVALIDE' });
    }
    const cibleId = Number(req.params.id);
    deleteUserAccount(cibleId);
    securityEvent('admin_compte_supprime', { adminId: req.user.id, cibleId, ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    sendBusinessError(res, err);
  }
});

// ── Définir le mot de passe d'un membre à la volée ───────────────────────────
adminRouter.post('/users/:id/password', (req, res) => {
  try {
    const id = Number(req.params.id);
    const newPassword = String(req.body?.new_password || '');
    const r = adminSetPassword(id, newPassword);
    securityEvent('admin_mot_de_passe_defini', { adminId: req.user.id, cibleId: id, ip: req.ip });
    res.json({ ok: true, email: r.email });
  } catch (err) {
    sendBusinessError(res, err);
  }
});

// ── Envoyer un lien de réinitialisation par email ────────────────────────────
// SMTP pas encore branché : le mailer est en stub. Tant qu'il n'envoie rien,
// on renvoie le lien à l'admin (qui est de confiance) pour transmission manuelle.
adminRouter.post('/users/:id/reset-link', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { token, user } = createResetToken(id, req.user.id);
    const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${base}/reset-password?token=${token}`;
    const mail = await sendPasswordResetEmail({
      to: user.email,
      displayName: user.display_name,
      resetUrl,
      userId: user.id,
    });
    res.json({
      ok: true,
      email: user.email,
      email_sent: mail.sent,
      reason: mail.reason || null,
      // Lien renvoyé uniquement quand l'email n'a pas pu partir (SMTP absent).
      reset_url: mail.sent ? undefined : resetUrl,
    });
  } catch (err) {
    sendBusinessError(res, err);
  }
});

// ── Réservations : note / déplacement / suppression (planning admin) ──────────
// PATCH : met à jour la note et/ou déplace le créneau. notify => email au membre.
adminRouter.patch('/reservations/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { note, start_at, end_at, notify } = req.body || {};
    const changed = [];

    if (start_at && end_at) {
      moveReservation(id, start_at, end_at);
      changed.push('horaire');
    }
    if (note !== undefined) {
      setReservationNote(id, note);
      changed.push('note');
    }

    const reservation = getReservationDetail(id);
    if (!reservation) return res.status(404).json({ error: 'RESA_INTROUVABLE' });

    let notifyResult = null;
    if (notify && changed.length) {
      notifyResult = await sendReservationNotification({
        to: reservation.member_email,
        displayName: reservation.member_name,
        action: changed.includes('horaire') ? 'modification' : 'note',
        reservation,
      });
    }
    res.json({ ok: true, changed, reservation, notify: notifyResult });
  } catch (err) {
    sendBusinessError(res, err);
  }
});

// Suppression (= annulation + remboursement total). notify => email au membre.
adminRouter.post('/reservations/:id/cancel', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const reservation = getReservationDetail(id); // avant annulation, pour l'email
    const result = adminCancelReservation(id, req.user.id);
    await revokeVoucherForReservation(id); // révoque le voucher sur le UDM (best-effort)

    let notifyResult = null;
    if (req.body?.notify && reservation) {
      notifyResult = await sendReservationNotification({
        to: reservation.member_email,
        displayName: reservation.member_name,
        action: 'annulation',
        reservation,
        refund: { refunded: result.refunded, amount: result.amount },
      });
    }
    res.json({ ok: true, ...result, notify: notifyResult });
  } catch (err) {
    sendBusinessError(res, err);
  }
});

// ── Prospects / pré-inscriptions (démarchage avant ouverture) ────────────────
adminRouter.get('/prospects', (req, res) => {
  try {
    const { q, status } = req.query;
    res.json({
      prospects: listProspects({ q, status }),
      counts: countsByStatus(),
    });
  } catch (err) {
    sendBusinessError(res, err, 500);
  }
});

/**
 * GET /api/admin/prospects/export.csv — export des pré-inscriptions.
 * Les cellules pouvant être interprétées comme des formules sont neutralisées
 * en amont (`lib/prospects.js`, injection de formule CSV).
 * Déclarée AVANT `/prospects/:id` pour éviter toute collision de motif.
 *
 * @returns 200 `text/csv`
 */
adminRouter.get('/prospects/export.csv', (_req, res) => {
  try {
    const csv = exportCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="prospects-cazalia.csv"');
    // Empêche un navigateur de tenter d'interpréter le fichier autrement.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(csv);
  } catch (err) {
    sendBusinessError(res, err, 500);
  }
});

adminRouter.patch('/prospects/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (typeof req.body?.status === 'string') setProspectStatus(id, req.body.status);
    if (req.body?.note !== undefined) setProspectNote(id, req.body.note);
    res.json({ ok: true });
  } catch (err) {
    sendBusinessError(res, err);
  }
});

adminRouter.delete('/prospects/:id', (req, res) => {
  try {
    deleteProspect(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    sendBusinessError(res, err);
  }
});
