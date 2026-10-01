// Double authentification TOTP (RFC 6238).
//
// Le secret TOTP est un facteur d'authentification à part entière : stocké en
// clair, il rendrait la 2FA inopérante dès qu'un attaquant lit la base. Il est
// donc CHIFFRÉ AU REPOS (AES-256-GCM, clé dérivée de `APP_SECRET`) via
// `lib/crypto.js` — le même mécanisme que le mot de passe SMTP.
//
// ⚠️ Conséquence d'exploitation : changer `APP_SECRET` rend les secrets TOTP
// illisibles. Les membres concernés devront reconfigurer leur 2FA.

import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { encryptSecret, decryptSecret } from './crypto.js';

// Tolérance ±1 pas de 30 s (dérive d'horloge du téléphone).
authenticator.options = { window: 1 };

const ISSUER = 'Cazalia';

/**
 * Génère un secret TOTP base32 (160 bits).
 * @returns {string} Secret EN CLAIR — à chiffrer avant stockage (`sealSecret`).
 */
export function generateSecret() {
  return authenticator.generateSecret();
}

/**
 * Chiffre un secret TOTP en vue de son stockage.
 * @param {string} secret Secret en clair.
 * @returns {string} Valeur chiffrée (préfixe `enc:v1:`).
 */
export function sealSecret(secret) {
  return encryptSecret(secret);
}

/**
 * Déchiffre un secret TOTP lu en base.
 * Tolère une valeur en clair : les secrets enregistrés avant l'introduction du
 * chiffrement restent exploitables jusqu'à la prochaine reconfiguration.
 *
 * @param {string | null} stored Valeur lue en base.
 * @returns {string} Secret en clair (chaîne vide si indéchiffrable).
 */
export function openSecret(stored) {
  return decryptSecret(stored);
}

/**
 * Construit l'URI `otpauth://` à encoder dans le QR code.
 * @param {string} email Identifiant affiché dans l'application d'authentification.
 * @param {string} secret Secret TOTP EN CLAIR.
 * @returns {string} URI otpauth.
 */
export function otpauthUri(email, secret) {
  return authenticator.keyuri(email, ISSUER, secret);
}

/**
 * Rend l'URI otpauth sous forme de QR code.
 * @param {string} uri URI otpauth.
 * @returns {Promise<string>} Image PNG en data-URL.
 */
export async function qrDataUrl(uri) {
  return QRCode.toDataURL(uri, { margin: 1, width: 220 });
}

/**
 * Vérifie un code TOTP contre un secret STOCKÉ (chiffré ou historique en clair).
 *
 * @param {string} token Code à 6 chiffres saisi par l'utilisateur.
 * @param {string | null} storedSecret Valeur du champ `users.totp_secret`.
 * @returns {boolean} `true` si le code est valide dans la fenêtre de tolérance.
 */
export function verifyToken(token, storedSecret) {
  if (!token || !storedSecret) return false;
  const secret = openSecret(storedSecret);
  if (!secret) return false;
  try {
    return authenticator.verify({ token: String(token).replace(/\s/g, ''), secret });
  } catch {
    return false;
  }
}
