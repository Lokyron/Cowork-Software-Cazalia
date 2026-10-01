import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// Galerie de la landing : les photos sont lues dynamiquement depuis un dossier
// dédié (`config.galleryDir`). Déposer / retirer un fichier image dans ce dossier
// le fait apparaître / disparaître du carrousel sans rebuild ni redéploiement.
const GALLERY_DIR = path.resolve(config.galleryDir);
const IMG_RE = /\.(jpe?g|png|webp|gif|avif)$/i;

export const galleryRouter = Router();

/**
 * GET /api/gallery — liste les photos du carrousel.
 * Seuls les fichiers dont l'extension figure dans `IMG_RE` sont exposés ; les
 * fichiers cachés sont ignorés.
 *
 * @returns 200 `{images: string[]}` — URLs encodées à servir telles quelles.
 */
galleryRouter.get('/gallery', (_req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(GALLERY_DIR)
      .filter((f) => IMG_RE.test(f) && !f.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' }));
  } catch {
    files = []; // dossier absent ou vide : galerie vide (pas d'erreur).
  }
  res.json({ images: files.map((f) => `/api/gallery/${encodeURIComponent(f)}`) });
});

/**
 * GET /api/gallery/:file — sert une photo du carrousel.
 *
 * Trois protections cumulées contre la traversée de répertoire (CWE-22) :
 * `path.basename` supprime toute composante de chemin (`../`), l'extension est
 * validée par liste blanche, et le chemin résolu est vérifié comme strictement
 * contenu dans le dossier de la galerie.
 *
 * @returns 200 image · 404 si le nom est refusé ou le fichier absent
 */
galleryRouter.get('/gallery/:file', (req, res) => {
  const name = path.basename(req.params.file);
  if (!IMG_RE.test(name)) return res.status(404).end();
  const full = path.join(GALLERY_DIR, name);
  if (!full.startsWith(GALLERY_DIR + path.sep)) return res.status(404).end();
  res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});
