// Médias du site (photos modifiables depuis l'administration).
//
// Les fichiers vivent dans un dossier PERSISTANT, hors du build du front
// (`config.galleryDir`, monté en volume `/gallery` en Docker) : une mise à jour
// de l'application ne doit jamais effacer les photos de Cazalia. Leur
// affectation (carrousel, bandeau, présentation) est un réglage en base.
//
// Compatibilité : avant cet écran, le carrousel était simplement « tous les
// fichiers du dossier, par ordre alphabétique ». Ce comportement est conservé —
// une photo déposée à la main sur le serveur apparaît toujours, en fin de
// carrousel — et l'ordre enregistré depuis l'administration prime.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getSetting, setSetting } from './settings.js';

export const MEDIA_DIR = path.resolve(config.galleryDir);

// Extensions servies (fichiers déjà présents inclus).
const SERVED_RE = /\.(jpe?g|png|webp|gif|avif)$/i;

// Formats ACCEPTÉS À L'ENVOI, reconnus par leur signature binaire et non par le
// type déclaré par le client : un `Content-Type: image/jpeg` ne prouve rien sur
// le contenu réel du corps de la requête.
const SIGNATURES = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};

/** Emplacements nommés : une seule photo chacun. */
export const SLOTS = ['hero', 'presentation'];

/**
 * Type MIME à servir pour un fichier, déduit de son extension (liste blanche).
 * @param {string} name Nom de fichier.
 * @returns {string | null}
 */
export function mimeForFile(name) {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] || null;
}

/**
 * Valide un nom de fichier venant du client et le réduit à un nom NU.
 *
 * `path.basename` supprime toute composante de chemin (`../`), puis l'extension
 * est validée : on ne peut désigner qu'un fichier image du dossier des médias
 * (CWE-22).
 *
 * @param {unknown} raw Nom reçu.
 * @returns {string | null} Nom sûr, ou `null` s'il est refusé.
 */
export function safeName(raw) {
  const name = path.basename(String(raw || ''));
  if (!name || name.startsWith('.') || !SERVED_RE.test(name)) return null;
  return name;
}

/**
 * Chemin absolu d'un média, garanti dans le dossier des médias.
 * @param {string} name Nom de fichier déjà validé par `safeName`.
 * @returns {string | null}
 */
export function mediaPath(name) {
  const safe = safeName(name);
  if (!safe) return null;
  const full = path.join(MEDIA_DIR, safe);
  // Double garde : même après `basename`, on vérifie le chemin résolu.
  if (!full.startsWith(MEDIA_DIR + path.sep)) return null;
  return full;
}

/**
 * Fichiers image présents sur le disque, triés naturellement.
 * @returns {string[]}
 */
export function listFiles() {
  try {
    return fs.readdirSync(MEDIA_DIR)
      .filter((f) => SERVED_RE.test(f) && !f.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' }));
  } catch {
    return []; // dossier absent : aucune photo, pas une erreur
  }
}

const readSetting = () => getSetting('media', {}) || {};

/**
 * URL publique d'un média.
 * @param {string | null} name Nom de fichier.
 * @returns {string | null}
 */
export function mediaUrl(name) {
  return name ? `/api/media/${encodeURIComponent(name)}` : null;
}

/**
 * Affectation effective des médias.
 *
 * L'ordre enregistré est filtré sur les fichiers RÉELLEMENT présents (une photo
 * supprimée à la main sur le serveur ne doit pas laisser un trou), puis les
 * fichiers non référencés sont ajoutés à la fin.
 *
 * @returns {{carousel: string[], hero: string | null, presentation: string | null}}
 */
export function getMedia() {
  const s = readSetting();
  const present = new Set(listFiles());
  const hero = s.hero && present.has(s.hero) ? s.hero : null;
  const presentation = s.presentation && present.has(s.presentation) ? s.presentation : null;

  const ordered = (Array.isArray(s.carousel) ? s.carousel : []).filter((f) => present.has(f));
  const known = new Set([...ordered, hero, presentation].filter(Boolean));
  const extras = [...present].filter((f) => !known.has(f));
  return { carousel: [...ordered, ...extras], hero, presentation };
}

/** Vue publique : les URLs à utiliser telles quelles par le front. */
export function getMediaUrls() {
  const m = getMedia();
  return {
    carousel: m.carousel.map(mediaUrl),
    hero: mediaUrl(m.hero),
    presentation: mediaUrl(m.presentation),
  };
}

/**
 * Construit un nom de fichier sûr et unique à partir du nom d'origine.
 * Le suffixe aléatoire évite qu'un second envoi écrase la photo précédente —
 * et qu'un nom choisi par le client permette de viser un fichier existant.
 *
 * @param {string} originalName Nom proposé par le client (indicatif).
 * @param {string} ext Extension déduite de la signature binaire.
 * @returns {string}
 */
function buildName(originalName, ext) {
  const base = path.basename(String(originalName || 'photo'), path.extname(String(originalName || '')))
    .normalize('NFD').replace(/[̀-ͯ]/g, '')      // accents
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';
  return `${base}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
}

/**
 * Indique si le dossier des médias est inscriptible par le service.
 *
 * Cas réel en Docker : si le dossier hôte bind-monté n'existe pas, Docker le
 * crée en root alors que le conteneur tourne en `node` (uid 1000) — tout envoi
 * échouerait alors en EACCES. On préfère le dire dans l'écran d'administration
 * plutôt que de laisser l'exploitant devant une erreur 500.
 *
 * @returns {boolean}
 */
export function isWritable() {
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    fs.accessSync(MEDIA_DIR, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enregistre une image envoyée depuis l'administration.
 *
 * @param {Buffer} buffer Corps brut de la requête.
 * @param {string} originalName Nom d'origine (indicatif, resservi pour lisibilité).
 * @returns {{file: string, url: string}}
 * @throws {Error} `FORMAT_NON_SUPPORTE` si la signature binaire n'est pas reconnue,
 *         `DOSSIER_NON_INSCRIPTIBLE` si le dossier des médias n'est pas accessible
 *         en écriture (volume mal monté).
 */
export function saveImage(buffer, originalName) {
  const sig = SIGNATURES.find((s) => s.test(buffer));
  if (!sig) {
    const err = new Error('FORMAT_NON_SUPPORTE');
    err.code = 'FORMAT_NON_SUPPORTE';
    throw err;
  }
  const file = buildName(originalName, sig.ext);
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    fs.writeFileSync(path.join(MEDIA_DIR, file), buffer, { mode: 0o640 });
  } catch (cause) {
    // Dossier absent, en lecture seule, ou appartenant à un autre utilisateur.
    const err = new Error(`DOSSIER_NON_INSCRIPTIBLE (${MEDIA_DIR}) : ${cause.message}`);
    err.code = 'DOSSIER_NON_INSCRIPTIBLE';
    throw err;
  }
  return { file, url: mediaUrl(file) };
}

/**
 * Ajoute une photo au carrousel (en fin de liste), sans doublon.
 * @param {string} file Nom de fichier.
 * @returns {void}
 */
export function addToCarousel(file) {
  const s = readSetting();
  const current = (Array.isArray(s.carousel) ? s.carousel : getMedia().carousel).filter((f) => f !== file);
  setSetting('media', { ...s, carousel: [...current, file] });
}

/**
 * Affecte une photo à un emplacement nommé (bandeau, présentation).
 * @param {string} slot Nom de l'emplacement (`SLOTS`).
 * @param {string | null} file Nom de fichier, ou `null` pour vider l'emplacement.
 * @returns {void}
 */
export function setSlot(slot, file) {
  if (!SLOTS.includes(slot)) return;
  const s = readSetting();
  // Une photo promue en bandeau quitte le carrousel : la même image aux deux
  // endroits n'a pas de sens et surprendrait à la suppression.
  const carousel = (Array.isArray(s.carousel) ? s.carousel : getMedia().carousel).filter((f) => f !== file);
  setSetting('media', { ...s, carousel, [slot]: file || null });
}

/**
 * Enregistre l'ordre du carrousel.
 * Les noms inconnus sont écartés : l'ordre reçu du client ne peut pas introduire
 * de fichier arbitraire dans la liste.
 *
 * @param {unknown[]} order Noms de fichiers, dans l'ordre souhaité.
 * @returns {string[]} Ordre retenu.
 */
export function setCarouselOrder(order) {
  const present = new Set(listFiles());
  const s = readSetting();
  const slots = new Set(SLOTS.map((k) => s[k]).filter(Boolean));
  const seen = new Set();
  const clean = (Array.isArray(order) ? order : [])
    .map((f) => safeName(f))
    .filter((f) => f && present.has(f) && !slots.has(f) && !seen.has(f) && seen.add(f));
  setSetting('media', { ...s, carousel: clean });
  return clean;
}

/**
 * Supprime un média : le fichier et toutes ses affectations.
 *
 * @param {string} name Nom de fichier.
 * @param {(file: string) => void} [onDetach] Appelé pour détacher le fichier
 *        ailleurs (photo d'un espace, par exemple).
 * @returns {boolean} `false` si le nom est refusé ou le fichier absent.
 */
export function deleteImage(name, onDetach) {
  const full = mediaPath(name);
  if (!full) return false;
  const safe = safeName(name);
  const s = readSetting();
  setSetting('media', {
    ...s,
    carousel: (Array.isArray(s.carousel) ? s.carousel : []).filter((f) => f !== safe),
    hero: s.hero === safe ? null : (s.hero ?? null),
    presentation: s.presentation === safe ? null : (s.presentation ?? null),
  });
  if (onDetach) onDetach(safe);
  try {
    fs.unlinkSync(full);
    return true;
  } catch {
    return false; // déjà absent : les affectations ont tout de même été nettoyées
  }
}
