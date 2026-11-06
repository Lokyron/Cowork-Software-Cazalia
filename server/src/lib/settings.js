// Réglages applicatifs (table app_settings, valeurs JSON). Fournit le choix du
// fournisseur d'envoi (SMTP ou Brevo), ses secrets (chiffrés au repos), le
// plafond d'envois quotidien et les consignes d'arrivée éditables par l'admin.

import crypto from 'node:crypto';
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
const WIFI_SSID_DEFAULT = 'Cazalia-Coworkers';

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

// ── Expéditeur (commun à tous les fournisseurs) ──────────────────────────────
/**
 * Nom et adresse d'expédition. Historiquement rangés avec la configuration SMTP,
 * ils sont communs aux deux fournisseurs : on les lit par cette fonction pour
 * éviter de dupliquer le réglage (et de le voir diverger) à la bascule.
 *
 * @returns {{fromName: string, fromEmail: string}}
 */
export function getSender() {
  const c = getSmtp();
  return { fromName: c.fromName, fromEmail: c.fromEmail };
}

// ── Fournisseur d'envoi & plafond quotidien ──────────────────────────────────
export const MAIL_PROVIDERS = ['smtp', 'brevo'];

// Plafond par défaut selon le fournisseur. 300/jour est la limite de l'offre
// gratuite Brevo ; un SMTP maison n'a pas de plafond connu de l'application, on
// ne lui en invente donc pas un (0 = illimité).
const DEFAULT_DAILY_LIMIT = { brevo: 300, smtp: 0 };
const DEFAULT_MARKETING_RESERVE = 30;

/**
 * Réglages d'envoi effectifs : fournisseur et plafond quotidien.
 *
 * @returns {{provider: string, dailyLimit: number, marketingReserve: number}}
 */
export function getMail() {
  const s = getSetting('mail', {}) || {};
  const candidate = s.provider ?? config.mail.provider ?? 'smtp';
  const provider = MAIL_PROVIDERS.includes(candidate) ? candidate : 'smtp';
  const limitRaw = s.daily_limit ?? config.mail.dailyLimit ?? DEFAULT_DAILY_LIMIT[provider];
  const reserveRaw = s.marketing_reserve ?? config.mail.marketingReserve ?? DEFAULT_MARKETING_RESERVE;
  const dailyLimit = Math.max(0, Number(limitRaw) || 0);
  // La réserve ne peut pas dépasser le plafond : elle bloquerait TOUT envoi
  // commercial dès le premier message de la journée.
  const marketingReserve = Math.min(Math.max(0, Number(reserveRaw) || 0), dailyLimit);
  return { provider, dailyLimit, marketingReserve };
}

/**
 * Met à jour le fournisseur d'envoi et le plafond quotidien.
 *
 * @param {Record<string, unknown>} b Champs soumis par l'administrateur.
 * @returns {{provider: string, dailyLimit: number, marketingReserve: number}}
 */
export function setMail(b) {
  const cur = getSetting('mail', {}) || {};
  const previous = getMail().provider;
  const provider = MAIL_PROVIDERS.includes(b.provider) ? b.provider : previous;
  // À la BASCULE de fournisseur, un plafond non soumis revient au défaut du
  // nouveau fournisseur : conserver les 300/jour de Brevo sur un SMTP maison
  // (ou l'inverse) briderait les envois sans que personne ne l'ait demandé.
  const keepLimit = provider === previous ? cur.daily_limit : undefined;
  const next = {
    provider,
    daily_limit: b.daily_limit != null ? Math.max(0, Number(b.daily_limit) || 0) : (keepLimit ?? DEFAULT_DAILY_LIMIT[provider]),
    marketing_reserve: b.marketing_reserve != null ? Math.max(0, Number(b.marketing_reserve) || 0) : (cur.marketing_reserve ?? DEFAULT_MARKETING_RESERVE),
  };
  setSetting('mail', next);
  return getMail();
}

// ── Brevo ────────────────────────────────────────────────────────────────────
/**
 * Configuration Brevo effective, secrets DÉCHIFFRÉS.
 *
 * ⚠️ Usage strictement INTERNE (appels à l'API, vérification du webhook) : la
 * vue destinée à l'interface est `getBrevoPublic`.
 *
 * @returns {{apiKey: string, webhookToken: string, configured: boolean}}
 */
export function getBrevo() {
  const s = getSetting('brevo', {}) || {};
  const apiKey = s.api_key_enc ? decryptSecret(s.api_key_enc) : (config.brevo.apiKey ?? '');
  const webhookToken = s.webhook_token_enc ? decryptSecret(s.webhook_token_enc) : (config.brevo.webhookToken ?? '');
  return { apiKey, webhookToken, configured: Boolean(apiKey) };
}

/**
 * Vue Brevo destinée à l'interface d'administration : AUCUN secret.
 * La clé d'API et le jeton de webhook ne quittent jamais le serveur - le jeton
 * n'est montré qu'une seule fois, à sa génération (cf. `rotateBrevoWebhookToken`).
 *
 * @returns {{has_api_key: boolean, has_webhook_token: boolean, configured: boolean}}
 */
export function getBrevoPublic() {
  const c = getBrevo();
  return {
    has_api_key: Boolean(c.apiKey),
    has_webhook_token: Boolean(c.webhookToken),
    configured: c.configured,
  };
}

/**
 * Met à jour la configuration Brevo. Une clé soumise est chiffrée au repos ;
 * un champ vide CONSERVE la clé existante (l'interface ne l'a jamais reçue, elle
 * ne peut donc pas la renvoyer). `clear_api_key` l'efface explicitement.
 *
 * @param {Record<string, unknown>} b Champs soumis par l'administrateur.
 * @returns {object} Vue publique après mise à jour.
 */
export function setBrevo(b) {
  const cur = getSetting('brevo', {}) || {};
  const next = { api_key_enc: cur.api_key_enc || null, webhook_token_enc: cur.webhook_token_enc || null };
  if (b.api_key != null && b.api_key !== '') next.api_key_enc = encryptSecret(String(b.api_key).trim());
  if (b.clear_api_key) next.api_key_enc = null;
  setSetting('brevo', next);
  return getBrevoPublic();
}

/**
 * Génère un nouveau jeton de webhook et le renvoie EN CLAIR, une seule fois.
 *
 * Le jeton est le seul secret de l'URL appelée par Brevo : il doit être
 * imprévisible (32 octets aléatoires) et sa valeur doit être recopiée dans la
 * configuration du webhook. Après cet appel, seule son EXISTENCE est consultable.
 *
 * @returns {string} Jeton en clair (à transmettre une fois, puis à oublier).
 */
export function rotateBrevoWebhookToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  const cur = getSetting('brevo', {}) || {};
  setSetting('brevo', { ...cur, webhook_token_enc: encryptSecret(token) });
  return token;
}

// ── Stripe (paiement en ligne) ───────────────────────────────────────────────
// Formules d'achat de crédits par défaut. ⚠️ TARIFS À CONFIRMER par la gérante :
// ces valeurs sont des repères (1 crédit ≈ 1 €) tant que la grille réelle n'est
// pas fixée. Elles sont surchargeables via le réglage `stripe.packs` en base.
export const DEFAULT_CREDIT_PACKS = [
  { id: 'p10', credits: 10, eur_cents: 1000, label: '10 crédits' },
  { id: 'p25', credits: 25, eur_cents: 2500, label: '25 crédits' },
  { id: 'p50', credits: 50, eur_cents: 5000, label: '50 crédits' },
  { id: 'p100', credits: 100, eur_cents: 10000, label: '100 crédits' },
];

/**
 * Normalise une liste de formules (filtre les entrées invalides).
 * @param {unknown} packs
 * @returns {Array<{id:string,credits:number,eur_cents:number,label:string}>}
 */
function sanitizePacks(packs) {
  if (!Array.isArray(packs)) return [];
  return packs
    .map((p) => ({
      id: String(p?.id ?? '').trim(),
      credits: Math.trunc(Number(p?.credits)),
      eur_cents: Math.trunc(Number(p?.eur_cents)),
      label: String(p?.label ?? '').trim(),
    }))
    .filter((p) => p.id && Number.isInteger(p.credits) && p.credits > 0
      && Number.isInteger(p.eur_cents) && p.eur_cents >= 50 && p.label);
}

/**
 * Configuration Stripe effective, secrets DÉCHIFFRÉS.
 *
 * ⚠️ Usage strictement INTERNE (création de session Checkout, vérification du
 * webhook) : la vue destinée à l'interface est `getStripePublic`.
 *
 * @returns {{secretKey:string, publishableKey:string, webhookSecret:string,
 *            packs:Array, enabled:boolean}}
 */
// Normalise les Price IDs d'abonnement (chaînes `price_…` ; on ne force pas le
// préfixe pour rester tolérant, mais on borne et on trim). Clés attendues :
// ESSENTIEL / CONFORT / PREMIUM.
function sanitizeSubPrices(v) {
  const out = { ESSENTIEL: '', CONFORT: '', PREMIUM: '' };
  if (v && typeof v === 'object') {
    for (const k of Object.keys(out)) {
      const id = String(v[k] ?? '').trim();
      if (id && id.length <= 120) out[k] = id;
    }
  }
  return out;
}

// Fusionne les Price IDs du réglage en base et ceux de l'environnement (le
// réglage en base prime, champ par champ ; l'environnement sert d'amorçage).
function resolveSubPrices(stored) {
  const base = sanitizeSubPrices(stored);
  const env = config.stripe.subscriptionPrices || {};
  for (const k of ['ESSENTIEL', 'CONFORT', 'PREMIUM']) {
    if (!base[k] && env[k]) base[k] = String(env[k]).trim();
  }
  return base;
}

export function getStripe() {
  const s = getSetting('stripe', {}) || {};
  const secretKey = s.secret_key_enc ? decryptSecret(s.secret_key_enc) : (config.stripe.secretKey ?? '');
  const webhookSecret = s.webhook_secret_enc ? decryptSecret(s.webhook_secret_enc) : (config.stripe.webhookSecret ?? '');
  const publishableKey = s.publishable_key ?? config.stripe.publishableKey ?? '';
  const packsCustom = sanitizePacks(s.packs);
  const packs = packsCustom.length ? packsCustom : DEFAULT_CREDIT_PACKS;
  const subscriptionPrices = resolveSubPrices(s.subscription_prices);
  const subscriptionsEnabled = Boolean(secretKey && webhookSecret
    && subscriptionPrices.ESSENTIEL && subscriptionPrices.CONFORT && subscriptionPrices.PREMIUM);
  // Le paiement en ligne n'est actif qu'avec clé secrète ET secret de webhook :
  // sans vérification de signature, un POST forgé pourrait créditer un compte.
  return {
    secretKey, publishableKey, webhookSecret, packs, subscriptionPrices,
    enabled: Boolean(secretKey && webhookSecret),
    subscriptionsEnabled,
  };
}

/**
 * Vue Stripe destinée à l'interface d'administration : AUCUN secret.
 * @returns {{has_secret_key:boolean, has_webhook_secret:boolean,
 *            publishable_key:string, packs:Array, enabled:boolean}}
 */
export function getStripePublic() {
  const c = getStripe();
  return {
    has_secret_key: Boolean(c.secretKey),
    has_webhook_secret: Boolean(c.webhookSecret),
    publishable_key: c.publishableKey,
    packs: c.packs,
    subscription_prices: c.subscriptionPrices,
    enabled: c.enabled,
    subscriptions_enabled: c.subscriptionsEnabled,
  };
}

/**
 * Met à jour la configuration Stripe. Les clés soumises sont chiffrées au repos ;
 * un champ vide CONSERVE le secret existant. `clear_*` efface explicitement.
 *
 * @param {Record<string, unknown>} b Champs soumis par l'administrateur.
 * @returns {object} Vue publique après mise à jour.
 */
export function setStripe(b) {
  const cur = getSetting('stripe', {}) || {};
  const next = {
    secret_key_enc: cur.secret_key_enc || null,
    webhook_secret_enc: cur.webhook_secret_enc || null,
    publishable_key: (b.publishable_key ?? cur.publishable_key ?? '').trim(),
    packs: Array.isArray(b.packs) ? sanitizePacks(b.packs) : (cur.packs ?? null),
    subscription_prices: b.subscription_prices != null
      ? sanitizeSubPrices(b.subscription_prices)
      : (cur.subscription_prices ?? null),
  };
  if (b.secret_key != null && b.secret_key !== '') next.secret_key_enc = encryptSecret(String(b.secret_key).trim());
  if (b.clear_secret_key) next.secret_key_enc = null;
  if (b.webhook_secret != null && b.webhook_secret !== '') next.webhook_secret_enc = encryptSecret(String(b.webhook_secret).trim());
  if (b.clear_webhook_secret) next.webhook_secret_enc = null;
  setSetting('stripe', next);
  return getStripePublic();
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
