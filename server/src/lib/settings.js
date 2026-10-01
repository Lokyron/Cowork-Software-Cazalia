// Réglages applicatifs (table app_settings, valeurs JSON). Fournit la config SMTP
// (mot de passe chiffré au repos) et les consignes d'arrivée éditables par l'admin.

import { db } from '../db.js';
import { config } from '../config.js';
import { encryptSecret, decryptSecret } from './crypto.js';

const getStmt = db.prepare(`SELECT value FROM app_settings WHERE key = ?`);
const upsertStmt = db.prepare(
  `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
);

/**
 * Lit un réglage applicatif (valeur JSON).
 * @param {string} key Clé du réglage.
 * @param {*} [fallback] Valeur retournée si la clé est absente ou illisible.
 * @returns {*}
 */
export function getSetting(key, fallback = null) {
  const row = getStmt.get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
/**
 * Écrit un réglage applicatif (sérialisé en JSON).
 * @param {string} key Clé du réglage.
 * @param {*} value Valeur à enregistrer.
 * @returns {void}
 */
export function setSetting(key, value) {
  upsertStmt.run(key, JSON.stringify(value ?? null));
}

// ── SMTP ─────────────────────────────────────────────────────────────────────
const WIFI_SSID_DEFAULT = 'CAZALIA-BOUTONNET';

/**
 * Configuration SMTP effective (réglages en base par-dessus les variables
 * d'environnement), mot de passe DÉCHIFFRÉ.
 *
 * ⚠️ Usage strictement INTERNE (construction du transport nodemailer) : ce
 * retour contient le secret en clair et ne doit jamais partir vers un client.
 * La vue destinée à l'interface est `getSmtpPublic`.
 *
 * @returns {{host: string, port: number, secureMode: string, user: string,
 *            pass: string, fromName: string, fromEmail: string, configured: boolean}}
 */
export function getSmtp() {
  const s = getSetting('smtp', {}) || {};
  const host = s.host ?? config.smtp.host ?? '';
  const port = Number(s.port ?? config.smtp.port ?? 587);
  const secureMode = s.secure_mode ?? (port === 465 ? 'ssl' : 'starttls'); // 'ssl'|'starttls'|'none'
  const user = s.user ?? config.smtp.user ?? '';
  const pass = s.pass_enc ? decryptSecret(s.pass_enc) : (config.smtp.pass ?? '');
  const fromName = s.from_name ?? 'Cazalia';
  const fromEmail = s.from_email ?? config.smtp.from ?? '';
  return { host, port, secureMode, user, pass, fromName, fromEmail, configured: Boolean(host && fromEmail) };
}

/**
 * Vue de la configuration SMTP destinée à l'interface d'administration.
 * Le mot de passe est remplacé par le booléen `has_pass` : le secret ne quitte
 * jamais le serveur, y compris vers un administrateur authentifié (CWE-200).
 *
 * @returns {object} Configuration sans secret.
 */
export function getSmtpPublic() {
  const s = getSetting('smtp', {}) || {};
  const c = getSmtp();
  return {
    host: c.host, port: c.port, secure_mode: c.secureMode, user: c.user,
    from_name: c.fromName, from_email: c.fromEmail,
    has_pass: Boolean(s.pass_enc || config.smtp.pass), configured: c.configured,
  };
}

/**
 * Met à jour la configuration SMTP.
 * Un mot de passe soumis est chiffré au repos avant stockage ; un champ vide ou
 * absent CONSERVE le secret existant (l'interface n'ayant jamais reçu sa valeur,
 * elle ne peut pas le renvoyer). `clear_pass` permet de l'effacer explicitement.
 *
 * @param {Record<string, unknown>} b Champs soumis par l'administrateur.
 * @returns {object} Configuration publique après mise à jour.
 */
export function setSmtp(b) {
  const cur = getSetting('smtp', {}) || {};
  const next = {
    host: (b.host ?? cur.host ?? '').trim(),
    port: Number(b.port ?? cur.port ?? 587),
    secure_mode: b.secure_mode ?? cur.secure_mode ?? 'starttls',
    user: (b.user ?? cur.user ?? '').trim(),
    from_name: (b.from_name ?? cur.from_name ?? 'Cazalia').trim(),
    from_email: (b.from_email ?? cur.from_email ?? '').trim(),
    pass_enc: cur.pass_enc || null,
  };
  if (b.pass != null && b.pass !== '') next.pass_enc = encryptSecret(String(b.pass));
  if (b.clear_pass) next.pass_enc = null;
  setSetting('smtp', next);
  return getSmtpPublic();
}

// ── Consignes d'arrivée / réseau ─────────────────────────────────────────────
/**
 * Consignes d'arrivée et SSID Wi-Fi affichés au client.
 * @returns {{instructions: string, wifi_ssid: string}}
 */
export function getArrival() {
  const a = getSetting('arrival', {}) || {};
  return {
    instructions: a.instructions ?? "Présentez-vous à l'accueil. Le code Wi-Fi ci-dessous vous donne accès à Internet.",
    wifi_ssid: a.wifi_ssid ?? WIFI_SSID_DEFAULT,
  };
}
/**
 * Met à jour les consignes d'arrivée et le SSID.
 * @param {Record<string, unknown>} b Champs soumis.
 * @returns {{instructions: string, wifi_ssid: string}} Valeurs après mise à jour.
 */
export function setArrival(b) {
  const cur = getArrival();
  setSetting('arrival', {
    instructions: (b.instructions ?? cur.instructions ?? '').trim(),
    wifi_ssid: (b.wifi_ssid ?? cur.wifi_ssid ?? WIFI_SSID_DEFAULT).trim(),
  });
  return getArrival();
}
