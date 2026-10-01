// Intégration UniFi (UDM Pro) — génération/révocation d'un voucher Wi-Fi par
// réservation via l'API d'intégration OFFICIELLE (UniFi Network 9.x+).
//
//   Base locale : https://{host}/proxy/network/integration/v1
//   Auth        : en-tête X-API-KEY
//   Endpoints   : GET    /sites
//                 POST   /sites/{siteId}/hotspot/vouchers
//                 GET    /sites/{siteId}/hotspot/vouchers/{id}
//                 DELETE /sites/{siteId}/hotspot/vouchers/{id}
//
// Contraintes de contexte :
//  - Le contrôleur LOCAL présente un certificat AUTO-SIGNÉ : la stratégie TLS est
//    explicite (épinglage d'empreinte, ou désactivation assumée) — cf. plus bas.
//  - better-sqlite3 est SYNCHRONE : les appels réseau (async) se font APRÈS le commit
//    de la transaction de réservation, puis on met à jour la ligne (best-effort).
//  - L'intégration est DÉGRADABLE : si elle est inactive ou en échec, la réservation
//    reste valide (voucher_code = NULL) ; on log un avertissement, on ne jette jamais
//    vers l'appelant depuis les fonctions d'orchestration.

import https from 'node:https';
import { config } from '../config.js';
import { db } from '../db.js';

// Agent TLS du mode LOCAL. Le contrôleur présente un certificat auto-signé ;
// deux stratégies, par ordre de préférence :
//   1. ÉPINGLAGE (`UNIFI_TLS_FINGERPRINT`) : la validation d'autorité est levée
//      mais l'empreinte SHA-256 du certificat présenté est comparée à celle
//      attendue → un intercepteur est détecté.
//   2. DÉSACTIVATION EXPLICITE (`UNIFI_INSECURE_TLS=1`) : aucune vérification.
//      À n'utiliser que sur un segment réseau de confiance ; sans ce drapeau,
//      le mode local échoue plutôt que de se connecter en aveugle (CWE-295).
// Le mode CLOUD (api.ui.com) conserve toujours la validation par défaut.
function localAgentOptions() {
  const { insecureTls, tlsFingerprint } = config.unifi;
  if (!insecureTls && !tlsFingerprint) return null;
  const agent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    checkServerIdentity: (host, cert) => {
      if (!tlsFingerprint) return undefined; // mode « insecure » assumé
      const seen = String(cert.fingerprint256 || '').replace(/:/g, '').toLowerCase();
      const expected = tlsFingerprint.replace(/:/g, '').toLowerCase();
      if (seen !== expected) {
        return new Error(`UniFi : empreinte de certificat inattendue pour ${host}`);
      }
      return undefined;
    },
  });
  return agent;
}
const insecureAgent = localAgentOptions();

/**
 * Indique si l'intégration UniFi est exploitable (clé + cible configurées).
 * @returns {boolean}
 */
export function isConfigured() {
  return Boolean(config.unifi.apiKey && (config.unifi.consoleId || config.unifi.host));
}

/**
 * Détermine la cible HTTP selon le mode d'accès configuré.
 * Le mode CLOUD prime dès que `UNIFI_CONSOLE_ID` est défini.
 *
 * @returns {{host: string, basePath: string, secure: boolean}} `secure` indique
 *          que la validation TLS standard s'applique (mode cloud).
 */
function target() {
  if (config.unifi.consoleId) {
    return {
      host: 'api.ui.com',
      basePath: `/v1/connector/consoles/${encodeURIComponent(config.unifi.consoleId)}/proxy/network/integration/v1`,
      secure: true,
    };
  }
  return { host: config.unifi.host, basePath: '/proxy/network/integration/v1', secure: false };
}

/**
 * Exécute une requête HTTPS vers l'API d'intégration UniFi.
 *
 * @param {'GET'|'POST'|'DELETE'} method Verbe HTTP.
 * @param {string} pathname Chemin relatif à la base de l'API.
 * @param {object} [body] Charge utile JSON.
 * @returns {Promise<object|string|null>} Réponse désérialisée.
 * @throws {Error & {status?: number, body?: unknown}} En cas d'erreur HTTP,
 *         de délai dépassé, ou si le mode local est utilisé sans stratégie TLS
 *         explicite (`UNIFI_TLS_FINGERPRINT` ou `UNIFI_INSECURE_TLS`).
 */
function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const t = target();
    if (!t.secure && !insecureAgent) {
      return reject(new Error(
        'UniFi (mode local) : définir UNIFI_TLS_FINGERPRINT (recommandé) ou UNIFI_INSECURE_TLS=1 ' +
        'pour accepter le certificat auto-signé du contrôleur.'
      ));
    }
    const payload = body != null ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host: t.host,
        port: 443,
        path: t.basePath + pathname,
        method,
        ...(t.secure ? {} : { agent: insecureAgent }),
        timeout: 8000,
        headers: {
          'X-API-KEY': config.unifi.apiKey,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          let data = null;
          if (raw) { try { data = JSON.parse(raw); } catch { data = raw; } }
          if (ok) return resolve(data);
          const err = new Error(`UniFi ${method} ${pathname} → HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          err.body = data;
          reject(err);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`UniFi ${method} ${pathname} → timeout`)));
    if (payload) req.write(payload);
    req.end();
  });
}

let _siteId = null;

/**
 * Résout (et met en cache) l'identifiant technique du site UniFi configuré.
 * L'API renvoie `{ data: [{ id, internalReference, name }, …] }`.
 *
 * @returns {Promise<string>} UUID du site.
 * @throws {Error} Si l'API ne retourne aucun site.
 */
async function resolveSiteId() {
  if (_siteId) return _siteId;
  const r = await request('GET', '/sites');
  const list = Array.isArray(r?.data) ? r.data : Array.isArray(r) ? r : [];
  if (!list.length) throw new Error('UniFi : aucun site retourné par /sites');
  const wanted = String(config.unifi.site || 'default').toLowerCase();
  const match =
    list.find((s) => String(s.internalReference || '').toLowerCase() === wanted) ||
    list.find((s) => String(s.name || '').toLowerCase() === wanted) ||
    list[0];
  _siteId = match.id;
  return _siteId;
}

/**
 * Extrait la liste de vouchers d'une réponse, en tolérant les variantes de schéma
 * rencontrées selon la version du contrôleur.
 *
 * @param {unknown} r Réponse brute.
 * @returns {object[]} Vouchers (tableau vide si le schéma est inattendu).
 */
function vouchersOf(r) {
  if (Array.isArray(r?.vouchers)) return r.vouchers;
  if (Array.isArray(r?.data)) return r.data;
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object' && (r.id || r.code)) return [r];
  return [];
}

/**
 * Crée un voucher Wi-Fi à usage unique.
 * La réponse de création ne contient parfois que l'identifiant : on relit alors
 * le voucher pour récupérer le code lisible.
 *
 * @param {{name: string}} params Libellé du voucher côté contrôleur.
 * @returns {Promise<{id: string, code?: string}>} Voucher créé.
 * @throws {Error} Si la réponse du contrôleur est inexploitable.
 */
export async function createVoucher({ name }) {
  const siteId = await resolveSiteId();
  const body = { count: 1, name, timeLimitMinutes: config.unifi.timeLimitMinutes };
  if (config.unifi.guestLimit) body.authorizedGuestLimit = config.unifi.guestLimit; // sinon illimité
  const created = vouchersOf(await request('POST', `/sites/${siteId}/hotspot/vouchers`, body))[0];
  if (!created?.id) throw new Error('UniFi : réponse de création de voucher inattendue');
  if (created.code) return created;
  // Relecture pour obtenir le code lisible.
  const full = await request('GET', `/sites/${siteId}/hotspot/vouchers/${created.id}`).catch(() => null);
  return full && (full.code || full.id) ? full : created;
}

/**
 * Supprime un voucher côté contrôleur.
 * L'identifiant est encodé : il provient de la base, mais rien ne garantit à ce
 * niveau qu'il ne contient pas de caractère significatif dans une URL.
 *
 * @param {string} id Identifiant du voucher côté UniFi.
 * @returns {Promise<void>}
 */
export async function deleteVoucher(id) {
  const siteId = await resolveSiteId();
  await request('DELETE', `/sites/${encodeURIComponent(siteId)}/hotspot/vouchers/${encodeURIComponent(id)}`);
}

/**
 * Met en forme un code brut UniFi (10 chiffres) en « XXXXX-XXXXX ».
 * @param {unknown} code Code brut.
 * @returns {string} Code formaté, ou la valeur telle quelle si le format diffère.
 */
function formatCode(code) {
  const s = String(code || '');
  return /^\d{10}$/.test(s) ? `${s.slice(0, 5)}-${s.slice(5)}` : s;
}

// ── Orchestration liée à la base (best-effort, jamais bloquant) ───────────────

const getResStmt = db.prepare(
  `SELECT r.id, r.user_id, r.status, r.voucher_code, r.voucher_id,
          u.display_name
     FROM reservations r JOIN users u ON u.id = r.user_id
    WHERE r.id = ?`
);
const setVoucherStmt = db.prepare(
  `UPDATE reservations SET voucher_code = ?, voucher_id = ?, voucher_expires_at = ? WHERE id = ?`
);
const clearVoucherIdStmt = db.prepare(`UPDATE reservations SET voucher_id = NULL WHERE id = ?`);

// Génère (si besoin) le voucher d'une réservation et l'enregistre en base.
// Renvoie le code formaté, ou null si intégration inactive / en échec.
/**
 * Génère si besoin le voucher Wi-Fi d'une réservation et l'enregistre en base.
 * Fonctionnement DÉGRADABLE : toute erreur est journalisée et absorbée — une
 * indisponibilité du contrôleur ne doit jamais invalider une réservation payée.
 *
 * @param {number} reservationId Réservation concernée.
 * @returns {Promise<string|null>} Code formaté, ou `null` si inactif/en échec.
 */
export async function ensureVoucherForReservation(reservationId) {
  if (!isConfigured()) return null;
  const r = getResStmt.get(reservationId);
  if (!r || r.status !== 'confirmed') return null;
  if (r.voucher_code) return r.voucher_code; // déjà généré
  try {
    // Nom du client en tête (visible même si la liste UDM tronque), id de résa pour la traçabilité.
    const clientName = (r.display_name || '').trim() || `Utilisateur #${r.user_id}`;
    const v = await createVoucher({ name: `${clientName} — Résa #${r.id}` });
    const code = formatCode(v.code);
    const expires = v.expiresAt || v.expires_at || null;
    setVoucherStmt.run(code, String(v.id), expires, r.id);
    return code;
  } catch (err) {
    console.warn(`[unifi] génération voucher résa #${reservationId} échouée :`, err.message);
    return null;
  }
}

// Révoque le voucher d'une réservation annulée (best-effort). Conserve voucher_code
// pour l'affichage grisé côté UI ; efface voucher_id (évite une double-suppression).
/**
 * Révoque le voucher d'une réservation annulée (best-effort).
 * `voucher_code` est conservé pour l'affichage historique ; `voucher_id` est
 * effacé afin d'éviter une seconde tentative de suppression.
 *
 * @param {number} reservationId Réservation annulée.
 * @returns {Promise<void>} Ne rejette jamais.
 */
export async function revokeVoucherForReservation(reservationId) {
  if (!isConfigured()) return;
  const r = getResStmt.get(reservationId);
  if (!r || !r.voucher_id) return;
  try {
    await deleteVoucher(r.voucher_id);
  } catch (err) {
    console.warn(`[unifi] révocation voucher résa #${reservationId} échouée :`, err.message);
  } finally {
    clearVoucherIdStmt.run(reservationId);
  }
}
