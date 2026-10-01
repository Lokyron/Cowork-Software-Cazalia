// Durcissement transverse : en-têtes de sécurité HTTP, limitation de débit et
// garde anti-CSRF. Tout est implémenté avec les primitives natives d'Express /
// Node (aucune dépendance tierce supplémentaire à auditer).

import { config } from './config.js';

// ── En-têtes de sécurité (OWASP Secure Headers) ──────────────────────────────
// La politique CSP autorise :
//   - les scripts/styles du build Vite servis par l'origine elle-même ;
//   - `'unsafe-inline'` pour les styles UNIQUEMENT (React/Vite injectent des
//     styles inline ; aucun script inline n'est utilisé par l'application) ;
//   - Google Fonts (import dans `web/src/styles.css`) ;
//   - `data:` pour les images (QR code de la 2FA rendu en data-URL).
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  'upgrade-insecure-requests',
].join('; ');

/**
 * Applique les en-têtes de sécurité à toutes les réponses.
 *
 * `Strict-Transport-Security` n'est émis que sur une requête réellement servie
 * en HTTPS (`req.secure`, qui dépend de `trust proxy` + `X-Forwarded-Proto`) :
 * l'envoyer en HTTP est sans effet et rendrait le déploiement LAN inaccessible
 * si le domaine venait à être servi en clair.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Le filtre XSS legacy d'IE/Chrome introduit ses propres failles : on le neutralise.
  res.setHeader('X-XSS-Protection', '0');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// ── Limitation de débit (compteur mémoire, mono-process LXC) ─────────────────
// Chaque limiteur possède sa propre table `clé -> {count, first}`. La table est
// BORNÉE (`MAX_KEYS`) : sans cela, un attaquant faisant varier l'adresse IP ou
// l'e-mail ferait croître la mémoire du process indéfiniment (CWE-770).
const MAX_KEYS = 5_000;

/**
 * Purge les entrées expirées, puis — si la table reste saturée — les plus
 * anciennes, afin de garantir une empreinte mémoire constante.
 *
 * @param {Map<string, {count: number, first: number}>} store
 * @param {number} windowMs Fenêtre de comptage en millisecondes.
 * @returns {void}
 */
function evict(store, windowMs) {
  const now = Date.now();
  for (const [k, rec] of store) {
    if (now - rec.first > windowMs) store.delete(k);
  }
  if (store.size <= MAX_KEYS) return;
  // Map conserve l'ordre d'insertion : les premières clés sont les plus anciennes.
  const excess = store.size - MAX_KEYS;
  let i = 0;
  for (const k of store.keys()) {
    store.delete(k);
    if (++i >= excess) break;
  }
}

/**
 * Fabrique un middleware de limitation de débit.
 *
 * @param {object} options
 * @param {number} options.windowMs Durée de la fenêtre glissante (ms).
 * @param {number} options.max Nombre de requêtes autorisées par fenêtre.
 * @param {(req: import('express').Request) => string} [options.keyFn]
 *        Dérivation de la clé de comptage (par défaut : adresse IP).
 * @returns {import('express').RequestHandler} Middleware renvoyant 429 au-delà du seuil.
 */
export function rateLimit({ windowMs, max, keyFn }) {
  const store = new Map();
  const key = keyFn || ((req) => req.ip || 'inconnu');
  return function rateLimiter(req, res, next) {
    evict(store, windowMs);
    const k = key(req);
    const now = Date.now();
    const rec = store.get(k);
    if (!rec || now - rec.first > windowMs) {
      store.set(k, { count: 1, first: now });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - rec.first)) / 1000));
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'TROP_DE_TENTATIVES', retry_after_sec: retryAfterSec });
    }
    return next();
  };
}

// ── Garde anti-CSRF (défense en profondeur) ─────────────────────────────────
// Le cookie de session est déjà `SameSite=Lax` et l'API n'accepte que du JSON
// (donc hors formulaire HTML cross-site). On ajoute une vérification d'origine
// pour les méthodes mutantes : un navigateur envoie toujours `Origin` sur une
// requête non-GET, et `Sec-Fetch-Site` sur les navigateurs modernes.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rejette les requêtes mutantes provenant d'une origine tierce.
 *
 * Les clients non-navigateur (curl, scripts d'exploitation, sondes de
 * supervision) n'envoient pas d'`Origin` : ils ne portent pas non plus de
 * cookie ambiant, la garde les laisse donc passer — elle ne protège que du
 * scénario CSRF, elle ne remplace pas l'authentification.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
export function sameOriginGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return res.status(403).json({ error: 'ORIGINE_INTERDITE' });
  }

  const origin = req.get('origin');
  if (!origin) return next(); // client non-navigateur : pas de cookie ambiant
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: 'ORIGINE_INTERDITE' });
  }
  const allowed = new Set(config.allowedOrigins);
  if (allowed.has(originHost) || originHost === req.get('host')) return next();
  return res.status(403).json({ error: 'ORIGINE_INTERDITE' });
}
