// Chiffrement au repos (AES-256-GCM) des secrets stockés en base — p.ex. le mot de
// passe SMTP. La clé est dérivée de `config.appSecret` (scrypt). Format de sortie :
//   "enc:v1:<iv b64>:<tag b64>:<ciphertext b64>"
// Le préfixe permet de distinguer une valeur chiffrée d'un texte en clair (migration).

import crypto from 'node:crypto';
import { config } from '../config.js';

const PREFIX = 'enc:v1:';
// Clé dérivée une fois (sel fixe : le secret global fait déjà office d'entropie).
const key = crypto.scryptSync(String(config.appSecret), 'cowork.smtp.v1', 32);

/**
 * Indique si une valeur est au format chiffré de ce module.
 * Permet de tolérer, à la lecture, une valeur encore en clair issue d'une
 * version antérieure (migration sans rupture).
 *
 * @param {unknown} value Valeur lue en base.
 * @returns {boolean}
 */
export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Chiffre un secret destiné à être stocké en base (AES-256-GCM).
 * GCM est un mode AUTHENTIFIÉ : une valeur altérée en base est détectée au
 * déchiffrement au lieu d'être silencieusement acceptée.
 *
 * @param {string | null} plain Secret en clair.
 * @returns {string} `enc:v1:<iv>:<tag>:<ciphertext>` en base64, ou `''` si vide.
 */
export function encryptSecret(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/**
 * Déchiffre un secret stocké en base.
 *
 * @param {string | null} value Valeur lue en base (chiffrée ou encore en clair).
 * @returns {string} Secret en clair, ou `''` si la valeur est indéchiffrable —
 *          typiquement après un changement d'`APP_SECRET`.
 */
export function decryptSecret(value) {
  if (!isEncrypted(value)) return value ?? ''; // tolère un ancien clair
  try {
    const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Clé changée (APP_SECRET différent) → secret illisible.
    return '';
  }
}
