import { Router } from 'express';
import { db } from '../db.js';
import { spaceAvailability, getActiveSpace } from '../lib/booking.js';
import { effectivePricing } from '../lib/pricing.js';
import { toUtcIso } from '../lib/time.js';
import { config } from '../config.js';
import { getArrival } from '../lib/settings.js';
import { sendBusinessError } from '../middleware.js';

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
 * @returns 200 `{spaces}`
 */
spacesRouter.get('/spaces', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, kind, category, capacity, exclusive, privatizable,
              price_per_hour_cents, price_half_day_cents, price_day_cents,
              color, description, tagline, amenities, photo
         FROM spaces WHERE active = 1 ORDER BY position, kind, name`
    )
    .all();
  res.json({ spaces: rows });
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
