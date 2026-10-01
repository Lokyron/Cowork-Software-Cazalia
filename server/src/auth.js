import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

// ── Hachage de mot de passe : scrypt (brief §3) ──────────────────────────────
// Deux formats de stockage cohabitent :
//   • historique : "<salt_hex>:<hash_hex>"                    (scrypt par défaut, N=16384)
//   • courant    : "scrypt$<N>$<r>$<p>$<salt_hex>$<hash_hex>" (paramètres explicites)
// Le format courant permet de RELEVER le coût sans invalider les empreintes
// existantes : chaque empreinte est vérifiée avec les paramètres qui l'ont produite.

const LEGACY_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 64 };

/**
 * Refuse un mot de passe absent ou d'une longueur aberrante.
 *
 * Le plafond est une mesure ANTI-DoS : scrypt est volontairement coûteux, et
 * rien n'empêcherait sinon d'envoyer un mot de passe de 100 Kio à chaque essai.
 *
 * @param {unknown} password
 * @returns {string} Le mot de passe validé.
 * @throws {Error} `MOT_DE_PASSE_INVALIDE` si le type ou la longueur est incorrect.
 */
function assertHashable(password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > config.password.maxLength) {
    const e = new Error('MOT_DE_PASSE_INVALIDE');
    e.code = 'MOT_DE_PASSE_INVALIDE';
    throw e;
  }
  return password;
}

/**
 * Dérive une empreinte scrypt avec des paramètres donnés.
 *
 * @param {string} password Mot de passe en clair.
 * @param {Buffer} salt Sel aléatoire.
 * @param {{N: number, r: number, p: number, keyLen: number, maxmem?: number}} params
 * @returns {Buffer} Empreinte binaire de `params.keyLen` octets.
 */
function derive(password, salt, params) {
  return crypto.scryptSync(password, salt, params.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem ?? config.scrypt.maxmem,
  });
}

/**
 * Hache un mot de passe avec les paramètres scrypt courants.
 *
 * @param {string} password Mot de passe en clair (1 à `config.password.maxLength` caractères).
 * @returns {string} Empreinte au format `scrypt$N$r$p$salt$hash` (hexadécimal).
 * @throws {Error} `MOT_DE_PASSE_INVALIDE` si le mot de passe est vide ou trop long.
 */
export function hashPassword(password) {
  assertHashable(password);
  const { N, r, p, keyLen } = config.scrypt;
  const salt = crypto.randomBytes(16);
  const hash = derive(password, salt, { N, r, p, keyLen });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Analyse une empreinte stockée, quel que soit son format (courant ou historique).
 *
 * @param {string} stored Empreinte lue en base.
 * @returns {{salt: Buffer, expected: Buffer, params: {N: number, r: number, p: number, keyLen: number}} | null}
 *          `null` si l'empreinte est illisible.
 */
function parseStored(stored) {
  const value = String(stored ?? '');
  if (value.startsWith('scrypt$')) {
    const [, nRaw, rRaw, pRaw, saltHex, hashHex] = value.split('$');
    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!N || !r || !p || !saltHex || !hashHex) return null;
    const expected = Buffer.from(hashHex, 'hex');
    return { salt: Buffer.from(saltHex, 'hex'), expected, params: { N, r, p, keyLen: expected.length } };
  }
  const [saltHex, hashHex] = value.split(':');
  if (!saltHex || !hashHex) return null;
  const expected = Buffer.from(hashHex, 'hex');
  return { salt: Buffer.from(saltHex, 'hex'), expected, params: { ...LEGACY_PARAMS, keyLen: expected.length } };
}

/**
 * Vérifie un mot de passe contre une empreinte stockée, à temps constant.
 *
 * @param {string} password Mot de passe soumis.
 * @param {string} stored Empreinte lue en base (format courant ou historique).
 * @returns {boolean} `true` si le mot de passe correspond.
 */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > config.password.maxLength) return false;
  const parsed = parseStored(stored);
  if (!parsed) return false;
  let actual;
  try {
    actual = derive(password, parsed.salt, parsed.params);
  } catch {
    return false; // paramètres corrompus (maxmem dépassé, N non puissance de 2…)
  }
  // Comparaison à temps constant.
  return parsed.expected.length === actual.length && crypto.timingSafeEqual(parsed.expected, actual);
}

/**
 * Indique si une empreinte gagnerait à être recalculée avec les paramètres courants.
 * Permet une migration transparente lors d'une connexion réussie.
 *
 * @param {string} stored Empreinte lue en base.
 * @returns {boolean} `true` si le coût stocké est inférieur au coût configuré.
 */
export function needsRehash(stored) {
  const parsed = parseStored(stored);
  if (!parsed) return true;
  const { N, r, p } = config.scrypt;
  return parsed.params.N < N || parsed.params.r !== r || parsed.params.p !== p;
}

// Empreinte factice servant à égaliser le temps de réponse quand l'e-mail est
// inconnu : sans elle, un compte inexistant répond nettement plus vite qu'un
// mot de passe erroné, ce qui permet d'énumérer les comptes (CWE-208).
const DUMMY_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

/**
 * Consomme le même budget CPU qu'une vérification réelle, sans révéler
 * l'existence du compte. À appeler quand l'e-mail soumis est introuvable.
 *
 * @param {string} password Mot de passe soumis (jeté après calcul).
 * @returns {false} Toujours `false`.
 */
export function fakeVerify(password) {
  try {
    verifyPassword(String(password ?? ''), DUMMY_HASH);
  } catch {
    /* ignoré : ce calcul n'est là que pour le temps de réponse */
  }
  return false;
}

// ── Sessions côté serveur (cookie httpOnly référence l'id) ────────────────────
const insertSession = db.prepare(
  `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`
);
const getSession = db.prepare(
  `SELECT s.id, s.user_id, s.expires_at, u.email, u.display_name, u.role, u.must_change_password, u.totp_enabled
     FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?`
);
const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);
const deleteUserSessions = db.prepare(`DELETE FROM sessions WHERE user_id = ?`);
const purgeExpired = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`);

/**
 * Ouvre une session serveur et renvoie son identifiant (256 bits d'entropie).
 * L'identifiant n'est jamais dérivé de données utilisateur : il ne peut pas
 * être deviné ni fixé par un tiers (anti-fixation de session).
 *
 * @param {number} userId Identifiant de l'utilisateur authentifié.
 * @returns {{id: string, expiresAt: string}} Jeton de session et expiration ISO/UTC.
 */
export function createSession(userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlMs).toISOString();
  insertSession.run(id, userId, expiresAt);
  return { id, expiresAt };
}

/**
 * Résout un identifiant de session en profil utilisateur.
 * Une session expirée est supprimée à la volée (pas de session « zombie »).
 *
 * @param {string | undefined} sessionId Valeur du cookie de session.
 * @returns {{id: number, email: string, display_name: string, role: string,
 *            must_change_password: boolean, totp_enabled: boolean} | null}
 */
export function resolveSession(sessionId) {
  if (!sessionId) return null;
  const row = getSession.get(sessionId);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    deleteSession.run(sessionId);
    return null;
  }
  return {
    id: row.user_id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    must_change_password: !!row.must_change_password,
    totp_enabled: !!row.totp_enabled,
  };
}

/**
 * Ferme une session précise (déconnexion).
 * @param {string | undefined} sessionId
 * @returns {void}
 */
export function destroySession(sessionId) {
  if (sessionId) deleteSession.run(sessionId);
}

/**
 * Invalide TOUTES les sessions d'un utilisateur.
 * Appelé à chaque changement/réinitialisation de mot de passe : un attaquant
 * ayant volé un cookie perd l'accès dès que la victime change son mot de passe.
 *
 * @param {number} userId
 * @returns {void}
 */
export function destroyUserSessions(userId) {
  deleteUserSessions.run(userId);
}

/**
 * Supprime les sessions expirées de la base (tâche horaire).
 * @returns {void}
 */
export function purgeExpiredSessions() {
  purgeExpired.run(new Date().toISOString());
}

// ── Throttling anti-brute-force du login (brief §3) ──────────────────────────
// Compteur en mémoire par clé (email|ip). Suffisant pour un mono-process LXC.
// La table est BORNÉE : sans plafond, faire varier l'e-mail ou l'adresse IP
// suffirait à faire croître la mémoire du process indéfiniment (CWE-770).
const attempts = new Map();
const MAX_TRACKED_KEYS = 5_000;

/**
 * Purge les entrées expirées puis, si nécessaire, les plus anciennes.
 * @returns {void}
 */
function evictAttempts() {
  const now = Date.now();
  for (const [k, rec] of attempts) {
    if (now - rec.first > config.login.windowMs) attempts.delete(k);
  }
  if (attempts.size <= MAX_TRACKED_KEYS) return;
  let excess = attempts.size - MAX_TRACKED_KEYS;
  for (const k of attempts.keys()) {
    attempts.delete(k);
    if (--excess <= 0) break;
  }
}

/**
 * Indique si la clé donnée est actuellement bloquée pour cause d'essais répétés.
 *
 * @param {string} key Clé de comptage (convention : `email|ip`).
 * @returns {{blocked: boolean, retryAfterSec?: number}}
 */
export function loginThrottle(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (rec && now - rec.first > config.login.windowMs) {
    attempts.delete(key);
  }
  const cur = attempts.get(key);
  if (cur && cur.count >= config.login.maxAttempts) {
    const retryMs = config.login.windowMs - (now - cur.first);
    return { blocked: true, retryAfterSec: Math.ceil(retryMs / 1000) };
  }
  return { blocked: false };
}

/**
 * Enregistre un échec d'authentification pour la clé donnée.
 *
 * @param {string} key Clé de comptage (convention : `email|ip`).
 * @returns {void}
 */
export function recordFailedLogin(key) {
  evictAttempts();
  const now = Date.now();
  const rec = attempts.get(key);
  if (rec && now - rec.first <= config.login.windowMs) {
    rec.count += 1;
  } else {
    attempts.set(key, { count: 1, first: now });
  }
}

/**
 * Remet à zéro le compteur d'échecs (appelé après une connexion réussie).
 *
 * @param {string} key Clé de comptage (convention : `email|ip`).
 * @returns {void}
 */
export function clearLoginThrottle(key) {
  attempts.delete(key);
}
