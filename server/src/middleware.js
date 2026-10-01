import { config } from './config.js';
import { resolveSession } from './auth.js';
import { securityEvent } from './lib/audit.js';

/**
 * Résout le cookie de session et attache `req.user` (ou `null`).
 * Aucun contrôle d'accès ici : l'identité est établie, l'autorisation est
 * décidée par `requireAuth` / `requireAdmin` sur chaque route.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
export function attachUser(req, _res, next) {
  const sid = req.cookies?.[config.cookieName];
  req.user = resolveSession(sid) || null;
  next();
}

/**
 * Exige une session valide.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void} Répond 401 `NON_AUTHENTIFIE` si aucune session n'est établie.
 */
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'NON_AUTHENTIFIE' });
  next();
}

/**
 * Exige une session dont le rôle est `admin`.
 *
 * Le rôle est relu à CHAQUE requête depuis la base (`resolveSession` joint la
 * table `users`) : une rétrogradation prend effet immédiatement, sans attendre
 * l'expiration de la session. Toute tentative d'accès refusée est journalisée.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void} Répond 401 `NON_AUTHENTIFIE` ou 403 `INTERDIT`.
 */
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'NON_AUTHENTIFIE' });
  if (req.user.role !== 'admin') {
    securityEvent('acces_admin_refuse', { userId: req.user.id, ip: req.ip, chemin: req.originalUrl });
    return res.status(403).json({ error: 'INTERDIT' });
  }
  next();
}

// Traduit les erreurs métier (e.code) en statut HTTP cohérent.
const CODE_TO_STATUS = {
  COMPLET: 409,
  CREDITS_INSUFFISANTS: 402,
  CRENEAU_INVALIDE: 400,
  CRENEAU_PASSE: 400,
  DATE_INVALIDE: 400,
  MONTANT_INVALIDE: 400,
  ESPACE_INTROUVABLE: 404,
  RESA_INTROUVABLE: 404,
  DEJA_ANNULEE: 409,
  INTERDIT: 403,
  EMAIL_DEJA_PRIS: 409,
  IDENTIFIANTS_INVALIDES: 401,
  CHAMPS_INVALIDES: 400,
  MOT_DE_PASSE_FAIBLE: 400,
  MOT_DE_PASSE_ACTUEL_INVALIDE: 400,
  UTILISATEUR_INTROUVABLE: 404,
  TOKEN_INVALIDE: 400,
  CONFIRMATION_INVALIDE: 400,
  DERNIER_ADMIN: 409,
  AUCUN_CRENEAU: 400,
  HORS_HORAIRES: 400,
  PANIER_VIDE: 400,
  EMAIL_INVALIDE: 400,
  TELEPHONE_INVALIDE: 400,
  CONSENTEMENT_REQUIS: 400,
  STATUT_INVALIDE: 400,
  PROSPECT_INTROUVABLE: 404,
  TROP_DE_TENTATIVES: 429,
  MOT_DE_PASSE_INVALIDE: 400,
  ORIGINE_INTERDITE: 403,
  PERIODE_INVALIDE: 400,
  TROP_DE_CRENEAUX: 400,
  PANIER_PLEIN: 409,
};

/**
 * Traduit une erreur métier en réponse HTTP.
 *
 * Seul le CODE d'erreur est renvoyé au client — jamais `err.message` ni la pile
 * d'appels, qui exposeraient chemins de fichiers, requêtes SQL et versions
 * (CWE-209). Un code inconnu retombe sur `fallbackStatus`.
 *
 * @param {import('express').Response} res
 * @param {Error & {code?: string}} err Erreur levée par la couche métier.
 * @param {number} [fallbackStatus] Statut par défaut si le code n'est pas répertorié.
 * @param {Record<string, unknown>} [extra] Champs supplémentaires à joindre (ex. `slot_index`).
 * @returns {import('express').Response}
 */
export function sendBusinessError(res, err, fallbackStatus = 400, extra) {
  const code = err.code || 'ERREUR';
  const status = CODE_TO_STATUS[code] || fallbackStatus;
  return res.status(status).json({ error: code, ...(extra || {}) });
}
