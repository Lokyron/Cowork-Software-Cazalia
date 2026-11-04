// Intégration UniFi Access — PIN de porte temporaire par réservation.
//
// Modèle : pour chaque réservation on crée un « visiteur » UniFi Access avec une
// fenêtre de validité = le créneau réservé (+ marges de grâce), on lui génère un
// PIN, et on l'autorise sur la porte. UniFi expire le visiteur à la fin : le PIN
// ne fonctionne que pendant le créneau. À l'annulation, on supprime le visiteur.
//
// API OFFICIELLE UniFi Access (référence constructeur) : serveur LOCAL en
// HTTPS sur le port 12445, base `/api/v1/developer`, authentification
// `Authorization: Bearer <token>` (token créé dans l'app Access, avec les
// périmètres view:space / edit:visitor / view:credential). Certificat
// auto-signé. Enveloppe de réponse : { code: 'SUCCESS', msg, data }.
//
// Best-effort : les appels réseau se font APRÈS le commit de la réservation ; un
// échec (console injoignable, etc.) n'invalide JAMAIS la réservation — on log un
// avertissement et le PIN reste nul (le membre peut être accueilli autrement).

import https from 'node:https';
import { db } from '../db.js';
import { config } from '../config.js';

const BASE_PATH = '/api/v1/developer';

/** L'intégration est active si host + token + porte sont configurés. */
export function isConfigured() {
  const c = config.unifiAccess;
  return Boolean(c.host && c.token && c.door);
}

// Agent TLS : la console présente un certificat auto-signé. Validation standard
// par défaut ; désactivée seulement si l'exploitant l'assume
// (UNIFI_ACCESS_INSECURE_TLS=1) ou épingle l'empreinte SHA-256 — sinon on refuse
// plutôt que de se connecter en aveugle (CWE-295).
function agent() {
  const c = config.unifiAccess;
  if (!c.insecureTls && !c.tlsFingerprint) return null;
  const opts = { rejectUnauthorized: false, keepAlive: true };
  if (c.tlsFingerprint) {
    const want = c.tlsFingerprint.replace(/:/g, '').toLowerCase();
    opts.checkServerIdentity = (_host, cert) => {
      const got = (cert.fingerprint256 || '').replace(/:/g, '').toLowerCase();
      return got === want ? undefined : new Error('UniFi Access : empreinte de certificat inattendue');
    };
  }
  return new https.Agent(opts);
}

/**
 * Appel JSON à l'API Access (local, port 12445). Authentification
 * `Authorization: Bearer`. Renvoie `data` de l'enveloppe (ou le corps brut), ou
 * lève si le transport échoue, si le statut n'est pas 2xx, ou si l'enveloppe
 * signale une erreur.
 * @param {string} method
 * @param {string} pathname Sous `/api/v1/developer` (débute par « / »).
 * @param {object} [body]
 * @returns {Promise<any>}
 */
function request(method, pathname, body) {
  const c = config.unifiAccess;
  const ag = agent();
  if (!ag) {
    return Promise.reject(new Error(
      'UniFi Access : certificat auto-signé — définir UNIFI_ACCESS_TLS_FINGERPRINT ' +
      '(recommandé) ou UNIFI_ACCESS_INSECURE_TLS=1 pour accepter la console.'
    ));
  }
  const payload = body != null ? JSON.stringify(body) : null;
  const options = {
    host: c.host,
    port: c.port,
    path: `${BASE_PATH}${pathname}`,
    method,
    agent: ag,
    headers: {
      Authorization: `Bearer ${c.token}`,
      accept: 'application/json',
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON */ }
        const code = json?.code != null ? String(json.code).toUpperCase() : null;
        const codeOk = code === null || code === 'SUCCESS' || code === 'CODE_SUCCESS';
        if (res.statusCode >= 200 && res.statusCode < 300 && codeOk) {
          resolve(json && 'data' in json ? json.data : json);
        } else {
          reject(new Error(`UniFi Access ${method} ${pathname} → HTTP ${res.statusCode} ${json?.code || ''} ${json?.msg || raw.slice(0, 120)}`));
        }
      });
    });
    req.on('error', reject);
    // Réponse saine : <1 s en LAN. Délai court pour borner l'attente si la
    // console est injoignable (pour ne pas retarder l'e-mail qui attend le PIN).
    req.setTimeout(6000, () => req.destroy(new Error('UniFi Access : délai dépassé')));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Résolution de la porte (par UUID direct ou par nom) ──────────────────────
let _doorId = null;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Résout (et met en cache) l'identifiant de la porte configurée. `config.door`
 * peut être un UUID (utilisé tel quel) ou un nom (`name`/`full_name`).
 * @returns {Promise<string>}
 */
async function resolveDoorId() {
  if (_doorId) return _doorId;
  const want = String(config.unifiAccess.door || '').trim();
  if (UUID_RE.test(want)) { _doorId = want; return _doorId; }
  const doors = await request('GET', '/doors');
  const list = Array.isArray(doors) ? doors : [];
  const wl = want.toLowerCase();
  const match = list.find((d) => (d.name || '').toLowerCase() === wl || (d.full_name || '').toLowerCase() === wl);
  if (!match) throw new Error(`UniFi Access : porte « ${want} » introuvable`);
  _doorId = match.id;
  return _doorId;
}

/** Génère un PIN (corps vide, longueur selon le réglage de la console). @returns {Promise<string>} */
async function generatePin() {
  // POST sans corps (doc : `--data ''`). `data` de l'enveloppe = le PIN (string).
  const pin = await request('POST', '/credentials/pin_codes');
  const code = pin && typeof pin === 'object' ? (pin.pin_code || pin.code || pin.data) : pin;
  if (!code) throw new Error('UniFi Access : PIN non généré');
  return String(code);
}

/**
 * Crée un visiteur borné à [startEpoch, endEpoch] autorisé sur la porte, lui
 * assigne un PIN généré, et renvoie { visitorId, pin }.
 * @param {{firstName:string,lastName:string,startEpoch:number,endEpoch:number}} p
 * @returns {Promise<{visitorId:string, pin:string}>}
 */
export async function createVisitorWithPin({ firstName, lastName, startEpoch, endEpoch }) {
  const doorId = await resolveDoorId();
  const visitor = await request('POST', '/visitors', {
    first_name: firstName || 'Membre',
    last_name: lastName || 'Cazalia',
    start_time: startEpoch,
    end_time: endEpoch,
    visit_reason: 'Others',
    resources: [{ id: doorId, type: 'door' }],
  });
  const visitorId = visitor?.id;
  if (!visitorId) throw new Error('UniFi Access : réponse de création de visiteur inattendue');
  const pin = await generatePin();
  await request('PUT', `/visitors/${encodeURIComponent(visitorId)}/pin_codes`, { pin_code: pin });
  return { visitorId, pin };
}

/** Supprime un visiteur (révocation du PIN). `is_force` = suppression physique (query). */
export async function deleteVisitor(visitorId) {
  await request('DELETE', `/visitors/${encodeURIComponent(visitorId)}?is_force=true`);
}

// ── Intégration réservation ──────────────────────────────────────────────────
const getResStmt = db.prepare(
  `SELECT r.id, r.user_id, r.status, r.start_at, r.end_at, r.access_pin, r.access_visitor_id,
          u.first_name, u.last_name, u.display_name
     FROM reservations r JOIN users u ON u.id = r.user_id WHERE r.id = ?`
);
const setAccessStmt = db.prepare(
  `UPDATE reservations SET access_pin = ?, access_visitor_id = ?, access_expires_at = ? WHERE id = ?`
);
const clearAccessStmt = db.prepare(
  `UPDATE reservations SET access_pin = NULL, access_visitor_id = NULL, access_expires_at = NULL WHERE id = ?`
);

const toEpoch = (iso) => Math.floor(new Date(iso).getTime() / 1000);

/**
 * Génère (si besoin) le PIN de porte d'une réservation et l'enregistre en base.
 * Idempotent (ne régénère pas si déjà présent). Best-effort : ne lève jamais.
 * @param {number} reservationId
 * @returns {Promise<string|null>} Le PIN, ou null si indisponible.
 */
export async function ensureAccessPinForReservation(reservationId) {
  if (!isConfigured()) return null;
  const r = getResStmt.get(reservationId);
  if (!r || r.status !== 'confirmed') return null;
  if (r.access_pin) return r.access_pin; // déjà généré
  try {
    const c = config.unifiAccess;
    const startEpoch = toEpoch(r.start_at) - c.graceBeforeMin * 60;
    const endEpoch = toEpoch(r.end_at) + c.graceAfterMin * 60;
    const first = r.first_name || (r.display_name || '').split(' ')[0] || 'Membre';
    const last = r.last_name || (r.display_name || '').split(' ').slice(1).join(' ') || 'Cazalia';
    const { visitorId, pin } = await createVisitorWithPin({ firstName: first, lastName: last, startEpoch, endEpoch });
    setAccessStmt.run(pin, visitorId, new Date(endEpoch * 1000).toISOString(), reservationId);
    return pin;
  } catch (err) {
    console.warn(`[unifi-access] PIN résa #${reservationId} échoué :`, err.message);
    return null;
  }
}

/**
 * Révoque l'accès (supprime le visiteur) d'une réservation annulée. Best-effort.
 * @param {number} reservationId
 */
export async function revokeAccessForReservation(reservationId) {
  if (!isConfigured()) return;
  const r = getResStmt.get(reservationId);
  if (!r || !r.access_visitor_id) return;
  try {
    await deleteVisitor(r.access_visitor_id);
  } catch (err) {
    console.warn(`[unifi-access] révocation résa #${reservationId} échouée :`, err.message);
  }
  clearAccessStmt.run(reservationId);
}
