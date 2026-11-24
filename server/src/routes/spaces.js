import { Router } from 'express';
import { db } from '../db.js';
import { spaceAvailability, getActiveSpace, monthAvailability } from '../lib/booking.js';
import { effectivePricing, isOnlineBookable } from '../lib/pricing.js';
import { toUtcIso } from '../lib/time.js';
import { config } from '../config.js';
import { getArrival } from '../lib/settings.js';
import { getFrames } from '../lib/media.js';
import { sendBusinessError } from '../middleware.js';
import { rateLimit } from '../security.js';

export const spacesRouter = Router();

/**
 * GET /api/config - configuration PUBLIQUE consommée par le front.
 * N'expose que des informations destinées à l'affichage (horaires, SSID,
 * consignes d'arrivée) : aucun réglage sensible ne transite par cette route.
 *
 * @returns 200 `{openingHours, wifi_ssid, arrival_instructions}`
 */
spacesRouter.get('/config', (_req, res) => {
  const arrival = getArrival();
  res.json({ openingHours: config.openingHours, wifi_ssid: arrival.wifi_ssid, arrival_instructions: arrival.instructions });
});

/**
 * GET /api/spaces - espaces actifs (vitrine publique).
 * La sélection de colonnes est explicite : rien d'interne ne fuit par un `*`.
 * `photo_frame` : cadrage non destructif de la photo (ou `null`).
 * @returns 200 `{spaces}`
 */
spacesRouter.get('/spaces', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, kind, category, online_bookable, quote_available, capacity, exclusive, privatizable,
              price_per_hour_cents, price_half_day_cents, price_day_cents,
              color, description, tagline, amenities, photo
         FROM spaces WHERE active = 1 ORDER BY position, kind, name`
    )
    .all();
  const { spaces: frames } = getFrames({ spaceIds: rows.map((r) => r.id) });
  res.json({ spaces: rows.map((r) => ({ ...r, photo_frame: r.photo ? (frames[r.id] || null) : null })) });
});

/**
 * GET /api/pricing - grille tarifaire publique (vitrine).
 *
 * La page Tarifs recopiait ces montants à la main, au risque d'afficher autre
 * chose que ce qui est réellement facturé. Ils sortent désormais de la source de
 * vérité du moteur (`config.pricing`). Montants en CENTIMES d'euro.
 *
 * Note : `subscriptions` est indicatif — le montant réellement prélevé vient des
 * Prices Stripe configurés dans l'administration.
 *
 * @returns 200 `{open_space, meeting_room, subscriptions, confort_meeting_discount,
 *                essentiel_quota_days, samedi}`
 */
spacesRouter.get('/pricing', (_req, res) => {
  const samedi = config.forfaitSlots?.[6] || { demi_journee: [], journee: [] };
  res.json({
    open_space: config.pricing.OPEN_SPACE,
    meeting_room: config.pricing.MEETING_ROOM,
    subscriptions: config.pricing.SUBSCRIPTIONS,
    confort_meeting_discount: config.pricing.CONFORT_MEETING_DISCOUNT,
    essentiel_quota_days: config.pricing.ESSENTIEL_QUOTA_DAYS,
    // Le samedi n'ouvre qu'une demi-journée : la vitrine doit le dire, sans quoi
    // le client ne découvre la contrainte qu'au moment de réserver.
    samedi: {
      demi_journee: (samedi.demi_journee || []).length > 0,
      journee: (samedi.journee || []).length > 0,
    },
  });
});

/**
 * GET /api/availability?space_id&from&to&seats - places restantes et coût estimé.
 * Route publique : elle ne renvoie que des agrégats (nombre de places libres),
 * jamais l'identité des occupants.
 *
 * @returns 200 `{space_id, from, to, exclusive, privatizable, capacity, seats_left, cost}`
 *          · 400 `SPACE_ID_REQUIS` · 400 `CRENEAU_INVALIDE` · 404 `ESPACE_INTROUVABLE`
 */
spacesRouter.get('/availability', (req, res) => {
  try {
    const spaceId = Number(req.query.space_id);
    if (!spaceId) return res.status(400).json({ error: 'SPACE_ID_REQUIS' });
    const from = toUtcIso(req.query.from);
    const to = toUtcIso(req.query.to);
    if (to <= from) return res.status(400).json({ error: 'CRENEAU_INVALIDE' });
    const seats = Math.max(1, Math.floor(Number(req.query.seats) || 1));

    const a = spaceAvailability(spaceId, from, to);
    if (!a) return res.status(404).json({ error: 'ESPACE_INTROUVABLE' });
    // Prix EFFECTIF EN CENTIMES selon l'abonnement de l'utilisateur connecté
    // (moteur lib/pricing.js). `base_cents` = prix de référence (barré à l'UI),
    // `discount_label` = mention à afficher (ex. « −50 % Confort », « Inclus »).
    // Si le créneau ne correspond pas au forfait / tarif indisponible → cost null.
    const tarifType = ['heure', 'demi_journee', 'journee'].includes(req.query.tarif_type) ? req.query.tarif_type : 'heure';
    const space = getActiveSpace(spaceId);
    let cost = null; let baseCents = null; let discountLabel = null; let method = null;
    try {
      const p = effectivePricing({ user: req.user || null, space, startIso: from, endIso: to, seats, tarifType });
      cost = p.cents; baseCents = p.baseCents; discountLabel = p.discountLabel; method = p.method;
    } catch { cost = null; }
    res.json({
      space_id: spaceId, from, to, tarif_type: tarifType,
      exclusive: a.exclusive, privatizable: a.privatizable, capacity: a.capacity,
      seats_left: a.seats_left, cost, base_cents: baseCents, discount_label: discountLabel, payment_method: method,
    });
  } catch (err) {
    sendBusinessError(res, err);
  }
});

// Route qui balaie un mois : 60 requêtes / minute / IP. Un visiteur qui
// feuillette le calendrier (un mois par clic, plus un changement de formule ou
// d'espace) en fait une dizaine à la minute au plus ; 60 laisse de la marge, y
// compris pour plusieurs visiteurs derrière une même IP (coworking, entreprise),
// et borne un balayage automatisé à une requête par seconde.
const monthLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

/**
 * GET /api/availability/month?space_id&month&seats&tarif_type&slot[&exclude_reservation_id]
 * - statut de chaque jour d'un mois (calendrier). `month` = `YYYY-MM`, du mois
 * précédent à +36 mois. `tarif_type` : `heure` (défaut), `demi_journee`, `journee`.
 * `slot` : `matin`, `aprem`, `journee`.
 *
 * Route publique (aucune session requise), donc deux garde-fous de confidentialité :
 *  - un visiteur ne voit que les espaces `online_bookable`. Un bureau privatif
 *    nominatif a un `id` public (`GET /api/spaces`) : `seats_left`, jour par jour
 *    sur 37 mois, y révélerait son occupation exacte. Refus : 409 `ESPACE_NON_RESERVABLE`
 *    (le code de la réservation en ligne). Une session ADMIN voit tous les espaces
 *    (les écrans d'administration réservent hors ligne).
 *  - `exclude_reservation_id` (écran de déplacement) n'est honoré que pour un admin.
 *    Pour tout autre demandeur il est validé (format) puis ignoré : avec lui, un
 *    visiteur sonderait l'existence d'une réservation en comparant deux réponses.
 *
 * La réponse ne porte que des agrégats - jamais d'identité ni d'horaire de réservation.
 * `seats_left` vaut `null` (jour fermé / passé) ou quand le jour couvre plusieurs fenêtres
 * (deux demi-journées, deux plages d'ouverture) qui n'ont pas le même nombre de places :
 * un chiffre unique mentirait. Le calendrier compte aussi les verrous de panier, ce que
 * `moveReservation` ne fait pas : il est donc plus strict que le déplacement.
 *
 * @returns 200 `{space_id, month, tarif_type, seats, timezone, capacity, exclusive, days: [{date, status, seats_left}]}`
 *          avec `status` ∈ `open|partial|full|closed|past`
 *          · 400 `SPACE_ID_REQUIS` · 400 `MOIS_INVALIDE` · 400 `MOIS_HORS_FENETRE`
 *          · 400 `TARIF_TYPE_INVALIDE` · 400 `SLOT_INVALIDE` · 400 `PLACES_INVALIDES`
 *          · 400 `RESERVATION_ID_INVALIDE`
 *          · 404 `ESPACE_INTROUVABLE` · 409 `ESPACE_NON_RESERVABLE` · 429 `TROP_DE_TENTATIVES`
 */
spacesRouter.get('/availability/month', monthLimiter, (req, res) => {
  try {
    const { space_id: spaceRaw, month, seats: seatsRaw, tarif_type: tarifRaw, slot: slotRaw, exclude_reservation_id: exclRaw } = req.query;
    if (typeof spaceRaw !== 'string' || !/^\d+$/.test(spaceRaw) || !Number(spaceRaw)) {
      return res.status(400).json({ error: 'SPACE_ID_REQUIS' });
    }
    const tarifType = tarifRaw === undefined ? 'heure' : tarifRaw;
    if (!['heure', 'demi_journee', 'journee'].includes(tarifType)) return res.status(400).json({ error: 'TARIF_TYPE_INVALIDE' });
    if (slotRaw !== undefined && !['matin', 'aprem', 'journee'].includes(slotRaw)) return res.status(400).json({ error: 'SLOT_INVALIDE' });
    if (seatsRaw !== undefined && !(typeof seatsRaw === 'string' && /^\d+$/.test(seatsRaw) && Number(seatsRaw) >= 1)) {
      return res.status(400).json({ error: 'PLACES_INVALIDES' });
    }
    if (exclRaw !== undefined && !(typeof exclRaw === 'string' && /^\d{1,15}$/.test(exclRaw) && Number(exclRaw) >= 1)) {
      return res.status(400).json({ error: 'RESERVATION_ID_INVALIDE' });
    }
    const isAdmin = req.user?.role === 'admin';
    const space = getActiveSpace(Number(spaceRaw));
    if (!space) return res.status(404).json({ error: 'ESPACE_INTROUVABLE' });
    if (!isAdmin && !isOnlineBookable(space)) return res.status(409).json({ error: 'ESPACE_NON_RESERVABLE' });
    const result = monthAvailability(Number(spaceRaw), month, {
      seats: seatsRaw === undefined ? 1 : Number(seatsRaw), tarifType, slot: slotRaw,
      excludeReservationId: isAdmin && exclRaw !== undefined ? Number(exclRaw) : 0,
    });
    if (!result) return res.status(404).json({ error: 'ESPACE_INTROUVABLE' });
    res.json(result);
  } catch (err) {
    sendBusinessError(res, err);
  }
});
