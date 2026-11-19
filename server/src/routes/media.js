// Médias du site : service public des photos et administration (envoi,
// suppression, ordre du carrousel, affectation du bandeau et de la présentation).
//
// Les photos sont servies par l'API, et non par le build du front : elles vivent
// dans un dossier persistant et doivent donc rester modifiables sans
// redéploiement (cf. lib/media.js).
//
// Les anciennes routes `/api/gallery` restent servies : un onglet déjà ouvert
// avec l'ancien front continue de fonctionner après une mise à jour.

import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import { db } from '../db.js';
import { requireAdmin, sendBusinessError } from '../middleware.js';
import { rateLimit } from '../security.js';
import {
  SLOTS, listFiles, getMedia, getMediaUrls, mediaUrl, mediaPath, mimeForFile,
  safeName, saveImage, addToCarousel, setSlot, setCarouselOrder, deleteImage, isWritable,
  FRAME_CONTEXTS, getFrames, setFrame, purgeSpaceFrame,
} from '../lib/media.js';

export const mediaRouter = Router();

// ── Public ───────────────────────────────────────────────────────────────────
/**
 * GET /api/media - photos publiées (carrousel, bandeau, présentation).
 * `frames` : cadrages non destructifs (carrousel keyé par URL, bandeau, présentation).
 * @returns 200 `{carousel: string[], hero: string|null, presentation: string|null, frames}`
 */
mediaRouter.get('/media', (_req, res) => res.json(getMediaUrls()));

/**
 * GET /api/gallery - ancienne forme, conservée pour compatibilité.
 * @returns 200 `{images: string[]}`
 */
mediaRouter.get('/gallery', (_req, res) => res.json({ images: getMediaUrls().carousel }));

/**
 * Sert un fichier média.
 *
 * Le nom est réduit à un nom nu et validé par liste blanche d'extensions, et le
 * chemin résolu est vérifié comme contenu dans le dossier des médias (CWE-22).
 * Le type MIME est déduit de l'extension, jamais du contenu envoyé jadis par le
 * client : on ne sert donc que des types d'image.
 *
 * @returns 200 image · 404 si le nom est refusé ou le fichier absent
 */
function serveMedia(req, res) {
  const full = mediaPath(req.params.file);
  const mime = full && mimeForFile(req.params.file);
  if (!full || !mime) return res.status(404).end();
  res.type(mime);
  // Les noms portent un suffixe aléatoire : un remplacement change l'URL, le
  // cache peut donc être long sans risque de servir une photo périmée.
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).end(); });
}
mediaRouter.get('/media/:file', serveMedia);
mediaRouter.get('/gallery/:file', serveMedia);

// ── Administration ───────────────────────────────────────────────────────────
export const adminMediaRouter = Router();
adminMediaRouter.use(requireAdmin);

const detachFromSpaces = (file) => {
  try {
    const ids = db.prepare(`SELECT id FROM spaces WHERE photo = ?`).all(file).map((r) => r.id);
    db.prepare(`UPDATE spaces SET photo = NULL WHERE photo = ?`).run(file);
    ids.forEach(purgeSpaceFrame); // le cadrage suivait la photo
  } catch { /* colonne absente */ }
};

/**
 * GET /api/admin/media - bibliothèque complète (noms de fichiers inclus).
 * `frames` est en forme interne (carrousel keyé par fichier, espaces par id).
 * @returns 200 `{files, carousel, hero, presentation, spaces, frames}`
 */
adminMediaRouter.get('/', (_req, res) => {
  const m = getMedia();
  const withUrl = (f) => ({ file: f, url: mediaUrl(f) });
  const spaces = db.prepare(`SELECT id, name, photo FROM spaces WHERE active = 1 ORDER BY name`).all();
  res.json({
    // `writable` à faux = volume mal monté : l'interface le signale avant que
    // l'exploitant ne tente un envoi voué à l'échec.
    writable: isWritable(),
    files: listFiles().map(withUrl),
    carousel: m.carousel.map(withUrl),
    hero: m.hero ? withUrl(m.hero) : null,
    presentation: m.presentation ? withUrl(m.presentation) : null,
    spaces: spaces.map((s) => ({ ...s, url: mediaUrl(s.photo) })),
    frames: getFrames({ spaceIds: spaces.map((s) => s.id) }),
  });
});

/**
 * POST /api/admin/media?slot=carousel|hero|presentation&name=photo.jpg
 *
 * Le corps est l'image BRUTE (pas de multipart : aucune dépendance d'analyse à
 * auditer). Le front réduit la photo dans le navigateur avant l'envoi, la limite
 * de taille sert donc de garde-fou et non de contrainte d'usage.
 *
 * Le format est reconnu par la SIGNATURE BINAIRE du contenu : un type déclaré
 * ne prouve rien. Sans `slot`, la photo rejoint la bibliothèque sans affectation
 * (cas de la photo d'un espace, rattachée ensuite à la salle).
 *
 * @returns 201 `{ok, file, url}` · 400 `CORPS_VIDE` / `FORMAT_NON_SUPPORTE` ·
 *          500 `DOSSIER_NON_INSCRIPTIBLE` · 413 corps trop grand
 */
adminMediaRouter.post(
  '/',
  rateLimit({ windowMs: 60_000, max: 30 }),
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '6mb' }),
  (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'CORPS_VIDE' });
      }
      const { file, url } = saveImage(req.body, req.query.name);
      const slot = String(req.query.slot || '');
      if (slot === 'carousel') addToCarousel(file);
      else if (SLOTS.includes(slot)) setSlot(slot, file);
      res.status(201).json({ ok: true, file, url });
    } catch (err) {
      if (err.code === 'FORMAT_NON_SUPPORTE') return res.status(400).json({ error: 'FORMAT_NON_SUPPORTE' });
      if (err.code === 'DOSSIER_NON_INSCRIPTIBLE') {
        console.error('[media]', err.message);
        return res.status(500).json({ error: 'DOSSIER_NON_INSCRIPTIBLE' });
      }
      sendBusinessError(res, err);
    }
  }
);

/**
 * PUT /api/admin/media/carousel - enregistre l'ordre d'affichage.
 * @returns 200 `{ok, carousel}`
 */
adminMediaRouter.put('/carousel', (req, res) => {
  try {
    const kept = setCarouselOrder(req.body?.order);
    res.json({ ok: true, carousel: kept.map((f) => ({ file: f, url: mediaUrl(f) })) });
  } catch (err) { sendBusinessError(res, err); }
});

/**
 * PUT /api/admin/media/slot - affecte (ou vide) un emplacement nommé.
 * Corps : `{slot: 'hero'|'presentation', file: string|null}`.
 * @returns 200 `{ok, hero, presentation}` · 400 `EMPLACEMENT_INCONNU` / `FICHIER_INTROUVABLE`
 */
adminMediaRouter.put('/slot', (req, res) => {
  try {
    const slot = String(req.body?.slot || '');
    if (!SLOTS.includes(slot)) return res.status(400).json({ error: 'EMPLACEMENT_INCONNU' });
    const raw = req.body?.file;
    if (raw == null || raw === '') {
      setSlot(slot, null);
    } else {
      const file = safeName(raw);
      const full = file && mediaPath(file);
      if (!full || !fs.existsSync(full)) return res.status(400).json({ error: 'FICHIER_INTROUVABLE' });
      setSlot(slot, file);
    }
    const m = getMedia();
    res.json({ ok: true, hero: m.hero, presentation: m.presentation });
  } catch (err) { sendBusinessError(res, err); }
});

/**
 * PUT /api/admin/media/frame - recadrage non destructif d'une photo, PAR EMPLACEMENT.
 * Corps : `{context: 'carousel'|'hero'|'presentation'|'spaces', target, frame}` ;
 * `target` = nom de fichier (carrousel) ou id d'espace ; ignoré pour hero/presentation.
 * `frame` = `{zoom, posX, posY}` (bornés côté serveur) ou `null` pour réinitialiser.
 * Le fichier d'origine n'est jamais modifié.
 * @returns 200 `{ok, frames}` · 400 `CONTEXTE_INCONNU` / `FICHIER_INTROUVABLE` / `ESPACE_INTROUVABLE`
 */
adminMediaRouter.put('/frame', (req, res) => {
  try {
    const context = String(req.body?.context || '');
    if (!FRAME_CONTEXTS.includes(context)) return res.status(400).json({ error: 'CONTEXTE_INCONNU' });
    let target = null;
    if (context === 'carousel') {
      target = safeName(req.body?.target);
      if (!target || !getMedia().carousel.includes(target)) return res.status(400).json({ error: 'FICHIER_INTROUVABLE' });
    } else if (context === 'spaces') {
      const id = Number(req.body?.target);
      const ok = Number.isInteger(id) && db.prepare(`SELECT 1 FROM spaces WHERE id = ? AND active = 1`).get(id);
      if (!ok) return res.status(400).json({ error: 'ESPACE_INTROUVABLE' });
      target = id;
    }
    setFrame(context, target, req.body?.frame);
    const ids = db.prepare(`SELECT id FROM spaces WHERE active = 1`).all().map((s) => s.id);
    res.json({ ok: true, frames: getFrames({ spaceIds: ids }) });
  } catch (err) { sendBusinessError(res, err); }
});

/**
 * DELETE /api/admin/media/:file - supprime le fichier et toutes ses affectations
 * (carrousel, emplacements nommés, photo d'un espace).
 * @returns 200 `{ok}` · 404 `FICHIER_INTROUVABLE`
 */
adminMediaRouter.delete('/:file', (req, res) => {
  try {
    const ok = deleteImage(req.params.file, detachFromSpaces);
    if (!ok) return res.status(404).json({ error: 'FICHIER_INTROUVABLE' });
    res.json({ ok: true });
  } catch (err) { sendBusinessError(res, err); }
});
