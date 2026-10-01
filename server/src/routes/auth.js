import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  fakeVerify,
  createSession,
  destroySession,
  loginThrottle,
  recordFailedLogin,
  clearLoginThrottle,
} from '../auth.js';
import { requireAuth, sendBusinessError } from '../middleware.js';
import { rateLimit } from '../security.js';
import { securityEvent } from '../lib/audit.js';
import {
  assertStrongPassword,
  changeOwnPassword,
  getResetTokenInfo,
  consumeResetToken,
  createResetToken,
} from '../lib/passwords.js';
import { deleteUserAccount, getProfile, updateOwnProfile } from '../lib/users.js';
import { sendPasswordResetEmail } from '../lib/mailer.js';
import { generateSecret, sealSecret, otpauthUri, qrDataUrl, verifyToken } from '../lib/twofactor.js';

export const authRouter = Router();

// ── Limitation de débit des points d'entrée sensibles ────────────────────────
// Le compteur `loginThrottle` (par couple e-mail|IP) reste en place ; ces
// limiteurs s'y ajoutent au niveau de l'IP pour couvrir le balayage d'e-mails
// (énumération, création massive de comptes, mail-bombing) — CWE-307/CWE-770.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
const forgotLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8 });
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
// La 2FA se force par 10^6 combinaisons : sans plafond, quelques heures suffisent.
const twoFactorLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15 });
const passwordChangeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

// Format d'adresse e-mail accepté à l'inscription (contrôle de forme, pas de preuve).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Options du cookie de session.
 *
 * - `httpOnly` : inaccessible au JavaScript de la page (vol par XSS).
 * - `sameSite: 'lax'` : le cookie n'accompagne aucune requête mutante venue
 *   d'un autre site — première ligne de défense contre le CSRF, complétée par
 *   `sameOriginGuard`.
 * - `secure` : suit le protocole RÉEL de la requête (`req.secure` dépend de
 *   `trust proxy` + `X-Forwarded-Proto`). Le cookie reste utilisable en HTTP
 *   sur le LAN et passe automatiquement en `Secure` derrière un proxy HTTPS.
 *
 * @param {import('express').Request} req Requête en cours.
 * @returns {import('express').CookieOptions}
 */
const cookieOptions = (req) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: req.secure,
  maxAge: config.sessionTtlMs,
  path: '/',
});

/**
 * Options d'effacement du cookie de session.
 *
 * Les attributs doivent refléter ceux de la pose : un navigateur appliquant la
 * politique « Strict Secure Cookies » refuse qu'un cookie non-`Secure` écrase un
 * cookie `Secure`. Sans cet alignement, la déconnexion laisserait le cookie en
 * place côté navigateur — la session est bien détruite côté serveur, mais autant
 * ne pas laisser traîner un jeton périmé.
 *
 * @param {import('express').Request} req Requête en cours.
 * @returns {import('express').CookieOptions}
 */
const clearCookieOptions = (req) => {
  const { maxAge, ...rest } = cookieOptions(req);
  return rest;
};

/**
 * Projection d'un utilisateur vers le client : ne quitte jamais le serveur avec
 * l'empreinte de mot de passe, le secret TOTP ou les champs internes.
 *
 * @param {object} u Ligne `users` complète.
 * @returns {{id: number, email: string, display_name: string, role: string,
 *            must_change_password: boolean, totp_enabled: boolean}}
 */
function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    role: u.role,
    must_change_password: !!u.must_change_password,
    totp_enabled: !!u.totp_enabled,
  };
}

const findByEmail = db.prepare(`SELECT * FROM users WHERE email = ?`);
const insertUser = db.prepare(
  `INSERT INTO users (email, display_name, first_name, last_name, phone, password_hash, role)
   VALUES (@email, @display_name, @first_name, @last_name, @phone, @password_hash, @role)`
);
const countUsers = db.prepare(`SELECT COUNT(*) AS n FROM users`);

/**
 * POST /api/auth/register — inscription publique.
 * Le tout premier compte créé devient administrateur (amorçage du gestionnaire).
 *
 * @returns 201 `{user}` · 400 `CHAMPS_INVALIDES` · 400 `MOT_DE_PASSE_FAIBLE` · 409 `EMAIL_DEJA_PRIS`
 */
authRouter.post('/register', registerLimiter, (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const firstName = String(req.body?.first_name || '').trim();
    const lastName = String(req.body?.last_name || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const password = String(req.body?.password || '');

    // Tous les champs sont obligatoires ; longueurs bornées (insertion directe en base).
    if (!EMAIL_RE.test(email) || email.length > 160 || !firstName || !lastName || !phone ||
        firstName.length > 80 || lastName.length > 80 || phone.length > 30) {
      return res.status(400).json({ error: 'CHAMPS_INVALIDES' });
    }
    // Politique de mot de passe commune à tous les points d'entrée (cf. lib/passwords.js).
    assertStrongPassword(password);
    if (findByEmail.get(email)) {
      return res.status(409).json({ error: 'EMAIL_DEJA_PRIS' });
    }
    const displayName = `${firstName} ${lastName}`;
    // Le tout premier compte créé devient admin (bootstrap du gestionnaire).
    const role = countUsers.get().n === 0 ? 'admin' : 'member';
    const info = insertUser.run({
      email,
      display_name: displayName,
      first_name: firstName,
      last_name: lastName,
      phone,
      password_hash: hashPassword(password),
      role,
    });
    const user = { id: info.lastInsertRowid, email, display_name: displayName, role };

    const session = createSession(user.id);
    res.cookie(config.cookieName, session.id, cookieOptions(req));
    return res.status(201).json({ user });
  } catch (err) {
    return sendBusinessError(res, err, 500);
  }
});

// Recalcule l'empreinte d'un mot de passe encore stocké avec d'anciens paramètres.
const rehashStmt = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`);

/**
 * POST /api/auth/login — authentification par e-mail + mot de passe, puis code
 * TOTP si la 2FA est active sur le compte.
 *
 * @returns 200 `{user}` · 200 `{mfa_required:true}` · 401 `IDENTIFIANTS_INVALIDES`
 *          · 401 `CODE_2FA_INVALIDE` · 429 `TROP_DE_TENTATIVES`
 */
authRouter.post('/login', loginLimiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const key = `${email}|${req.ip}`;

  const throttle = loginThrottle(key);
  if (throttle.blocked) {
    res.set('Retry-After', String(throttle.retryAfterSec));
    return res.status(429).json({ error: 'TROP_DE_TENTATIVES', retry_after_sec: throttle.retryAfterSec });
  }

  const user = findByEmail.get(email);
  // Compte inconnu : on consomme quand même le budget CPU d'une vérification,
  // sans quoi le temps de réponse trahirait l'existence de l'adresse (CWE-208).
  if (!user) {
    fakeVerify(password);
    recordFailedLogin(key);
    securityEvent('login_echec', { email, ip: req.ip, motif: 'compte_inconnu' });
    return res.status(401).json({ error: 'IDENTIFIANTS_INVALIDES' });
  }
  if (!verifyPassword(password, user.password_hash)) {
    recordFailedLogin(key);
    securityEvent('login_echec', { userId: user.id, ip: req.ip, motif: 'mot_de_passe' });
    return res.status(401).json({ error: 'IDENTIFIANTS_INVALIDES' });
  }

  // 2FA (TOTP) : mot de passe OK mais code exigé si la 2FA est active.
  if (user.totp_enabled) {
    const token = String(req.body?.token || '').replace(/\s/g, '');
    if (!token) return res.json({ mfa_required: true }); // le front demandera l'OTP
    if (!verifyToken(token, user.totp_secret)) {
      recordFailedLogin(key);
      securityEvent('login_echec', { userId: user.id, ip: req.ip, motif: 'code_2fa' });
      return res.status(401).json({ error: 'CODE_2FA_INVALIDE', mfa_required: true });
    }
  }

  // Migration transparente du coût de hachage lors d'une connexion réussie.
  if (needsRehash(user.password_hash)) {
    try { rehashStmt.run(hashPassword(password), user.id); } catch { /* non bloquant */ }
  }

  clearLoginThrottle(key);
  const session = createSession(user.id);
  res.cookie(config.cookieName, session.id, cookieOptions(req));
  securityEvent('login_ok', { userId: user.id, ip: req.ip, mfa: !!user.totp_enabled });
  return res.json({ user: publicUser(user) });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req.cookies?.[config.cookieName]);
  res.clearCookie(config.cookieName, clearCookieOptions(req));
  return res.json({ ok: true });
});

/**
 * GET /api/auth/me — profil de session (ou `null` si non authentifié).
 * @returns 200 `{user}`
 */
authRouter.get('/me', (req, res) => {
  return res.json({ user: req.user });
});

// Profil complet (page « Mon compte ») + mise à jour self-service.
authRouter.get('/profile', requireAuth, (req, res) => {
  try { return res.json({ profile: getProfile(req.user.id) }); }
  catch (err) { return sendBusinessError(res, err); }
});

authRouter.patch('/me', requireAuth, (req, res) => {
  try { return res.json({ profile: updateOwnProfile(req.user.id, req.body || {}) }); }
  catch (err) { return sendBusinessError(res, err); }
});

// Demande publique de réinitialisation (« mot de passe oublié »). Réponse toujours
// identique (anti-énumération) ; l'e-mail n'est envoyé que si le compte existe.
/**
 * POST /api/auth/forgot-password — demande publique de réinitialisation.
 * Réponse toujours identique, que le compte existe ou non (anti-énumération).
 *
 * @returns 200 `{ok:true}` · 429 `TROP_DE_TENTATIVES`
 */
authRouter.post('/forgot-password', forgotLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  try {
    const user = email ? findByEmail.get(email) : null;
    if (user) {
      const { token } = createResetToken(user.id, null);
      const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
      await sendPasswordResetEmail({
        to: user.email, displayName: user.display_name,
        resetUrl: `${base}/reset-password?token=${token}`, userId: user.id,
      });
    }
  } catch (err) {
    console.warn('[forgot-password]', err.message); // on n'expose rien au client
  }
  return res.json({ ok: true });
});

// ── Double authentification (TOTP) — optionnelle ─────────────────────────────
const getUserFull = db.prepare(`SELECT * FROM users WHERE id = ?`);
const setTotpSecret = db.prepare(`UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?`);
const enableTotp = db.prepare(`UPDATE users SET totp_enabled = 1 WHERE id = ?`);
const disableTotp = db.prepare(`UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?`);

// 1) Démarrer la configuration : génère un secret + QR (pas encore actif).
/**
 * POST /api/auth/2fa/setup — génère un secret TOTP et son QR code.
 * Le secret est enregistré CHIFFRÉ et la 2FA reste inactive tant qu'un premier
 * code n'a pas été validé par `/2fa/enable`.
 *
 * @returns 200 `{secret, otpauth_uri, qr}` · 401 `NON_AUTHENTIFIE`
 */
authRouter.post('/2fa/setup', requireAuth, twoFactorLimiter, async (req, res) => {
  try {
    const secret = generateSecret();
    setTotpSecret.run(sealSecret(secret), req.user.id);
    const uri = otpauthUri(req.user.email, secret);
    const qr = await qrDataUrl(uri);
    return res.json({ secret, otpauth_uri: uri, qr });
  } catch (err) {
    return sendBusinessError(res, err, 500);
  }
});

// 2) Activer : vérifie un premier code contre le secret configuré.
/**
 * POST /api/auth/2fa/enable — active la 2FA après vérification d'un premier code.
 * @returns 200 `{ok:true}` · 400 `SETUP_2FA_REQUIS` · 400 `CODE_2FA_INVALIDE` · 429 `TROP_DE_TENTATIVES`
 */
authRouter.post('/2fa/enable', requireAuth, twoFactorLimiter, (req, res) => {
  const token = String(req.body?.token || '').replace(/\s/g, '');
  const u = getUserFull.get(req.user.id);
  if (!u?.totp_secret) return res.status(400).json({ error: 'SETUP_2FA_REQUIS' });
  if (!verifyToken(token, u.totp_secret)) return res.status(400).json({ error: 'CODE_2FA_INVALIDE' });
  enableTotp.run(req.user.id);
  securityEvent('2fa_activee', { userId: req.user.id, ip: req.ip });
  return res.json({ ok: true });
});

// 3) Désactiver : exige un code valide si la 2FA est active.
/**
 * POST /api/auth/2fa/disable — désactive la 2FA.
 * Un code valide est exigé tant que la 2FA est active : un cookie volé ne suffit
 * pas à retirer le second facteur.
 *
 * @returns 200 `{ok:true}` · 400 `CODE_2FA_INVALIDE` · 429 `TROP_DE_TENTATIVES`
 */
authRouter.post('/2fa/disable', requireAuth, twoFactorLimiter, (req, res) => {
  const token = String(req.body?.token || '').replace(/\s/g, '');
  const u = getUserFull.get(req.user.id);
  if (u?.totp_enabled && !verifyToken(token, u.totp_secret)) {
    return res.status(400).json({ error: 'CODE_2FA_INVALIDE' });
  }
  disableTotp.run(req.user.id);
  securityEvent('2fa_desactivee', { userId: req.user.id, ip: req.ip });
  return res.json({ ok: true });
});

// ── Suppression de son propre compte (confirmation "SUPPRIMER") ──────────────
/**
 * DELETE /api/auth/me — suppression définitive de son propre compte.
 * Exige la confirmation littérale « SUPPRIMER » dans le corps de la requête.
 *
 * @returns 200 `{ok:true}` · 400 `CONFIRMATION_INVALIDE` · 409 `DERNIER_ADMIN`
 */
authRouter.delete('/me', requireAuth, (req, res) => {
  try {
    if (String(req.body?.confirm) !== 'SUPPRIMER') {
      return res.status(400).json({ error: 'CONFIRMATION_INVALIDE' });
    }
    deleteUserAccount(req.user.id);
    destroySession(req.cookies?.[config.cookieName]);
    res.clearCookie(config.cookieName, clearCookieOptions(req));
    return res.json({ ok: true });
  } catch (err) {
    return sendBusinessError(res, err);
  }
});

// ── Changement de mot de passe par l'utilisateur lui-même ────────────────────
/**
 * POST /api/auth/change-password — changement de mot de passe par l'utilisateur.
 * Toutes les autres sessions sont invalidées ; l'appareil courant reçoit une
 * session neuve (pas de réutilisation de l'identifiant précédent).
 *
 * @returns 200 `{ok:true}` · 400 `MOT_DE_PASSE_ACTUEL_INVALIDE` · 400 `MOT_DE_PASSE_FAIBLE`
 */
authRouter.post('/change-password', requireAuth, passwordChangeLimiter, (req, res) => {
  try {
    const current = String(req.body?.current_password || '');
    const next = String(req.body?.new_password || '');
    changeOwnPassword(req.user.id, current, next);
    // changeOwnPassword a invalidé toutes les sessions : on en recrée une pour
    // garder l'appareil courant connecté (les autres appareils sont déconnectés).
    const session = createSession(req.user.id);
    res.cookie(config.cookieName, session.id, cookieOptions(req));
    securityEvent('mot_de_passe_change', { userId: req.user.id, ip: req.ip });
    return res.json({ ok: true });
  } catch (err) {
    return sendBusinessError(res, err);
  }
});

// ── Réinitialisation via lien (public, consommé depuis l'email) ──────────────
// Valide un jeton et renvoie l'email associé (pour afficher la page de reset).
/**
 * GET /api/auth/reset-password/:token — valide un jeton et renvoie de quoi
 * afficher la page de réinitialisation. Aucune distinction entre jeton
 * inexistant, expiré ou déjà consommé.
 *
 * @returns 200 `{valid, email, display_name}` · 400 `TOKEN_INVALIDE` · 429 `TROP_DE_TENTATIVES`
 */
authRouter.get('/reset-password/:token', resetLimiter, (req, res) => {
  const info = getResetTokenInfo(req.params.token);
  if (!info) return res.status(400).json({ error: 'TOKEN_INVALIDE' });
  return res.json({ valid: true, email: info.email, display_name: info.display_name });
});

// Applique le nouveau mot de passe à partir d'un jeton valide.
/**
 * POST /api/auth/reset-password — applique un nouveau mot de passe à partir
 * d'un jeton valide, puis détruit toutes les sessions du compte.
 *
 * @returns 200 `{ok:true}` · 400 `TOKEN_INVALIDE` · 400 `MOT_DE_PASSE_FAIBLE` · 429 `TROP_DE_TENTATIVES`
 */
authRouter.post('/reset-password', resetLimiter, (req, res) => {
  try {
    const token = String(req.body?.token || '');
    const next = String(req.body?.new_password || '');
    const { userId } = consumeResetToken(token, next);
    securityEvent('mot_de_passe_reinitialise', { userId, ip: req.ip });
    return res.json({ ok: true });
  } catch (err) {
    return sendBusinessError(res, err);
  }
});
