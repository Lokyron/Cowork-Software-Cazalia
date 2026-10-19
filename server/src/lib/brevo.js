// Intégration Brevo (ex-Sendinblue) — envoi transactionnel par API HTTP.
//
//   Base      : https://api.brevo.com/v3
//   Auth      : en-tête `api-key`
//   Endpoints : POST   /smtp/email        (envoi)
//               GET    /account           (test de connexion, ne consomme pas de quota)
//               GET    /webhooks          (liste des webhooks transactionnels)
//               POST   /webhooks          (déclaration du webhook de délivrabilité)
//               DELETE /webhooks/{id}     (retrait de l'ancien webhook)
//
// Pourquoi l'API plutôt que le relais SMTP de Brevo :
//  - aucun port sortant 465/587 à ouvrir depuis le conteneur (le trafic sort en 443) ;
//  - la réponse d'envoi porte un `messageId`, que l'on journalise pour recoller
//    les événements de délivrabilité reçus par webhook (cf. routes/webhooks.js) ;
//  - les erreurs sont explicites (JSON) au lieu d'un code SMTP numérique.
//
// Ce module ne connaît NI la base NI les réglages : il reçoit tout en argument et
// lève en cas d'échec. L'orchestration (journal, dégradation) vit dans mailer.js.

// Délai de garde : un envoi d'e-mail ne doit jamais retenir une requête HTTP de
// l'application (réservation, reset) plus de quelques secondes.
const TIMEOUT_MS = 15_000;
const BASE = 'https://api.brevo.com/v3';

/**
 * Événements de délivrabilité souscrits à la déclaration du webhook.
 *
 * Volontairement SANS `opened` ni `click` : le suivi d'ouverture implique un
 * pixel espion et un traitement de données de comportement qui demanderaient une
 * base légale et une mention dans les CGU — pour un usage transactionnel, il
 * n'apporte rien. On ne collecte que ce qui sert à diagnostiquer un non-reçu.
 *
 * @type {string[]}
 */
export const WEBHOOK_EVENTS = [
  'delivered', 'hardBounce', 'softBounce', 'blocked', 'spam', 'invalid', 'deferred', 'error', 'unsubscribed',
];

/**
 * Appel JSON authentifié à l'API Brevo.
 *
 * @param {string} apiKey Clé d'API Brevo (en-tête `api-key`).
 * @param {string} path Chemin relatif à la base (ex. `/smtp/email`).
 * @param {{method?: string, body?: unknown}} [options]
 * @returns {Promise<object>} Corps de réponse décodé (`{}` si vide).
 * @throws {Error} Si le réseau échoue ou si Brevo répond un statut d'erreur ;
 *         le message reprend le `message` renvoyé par l'API quand il existe.
 */
async function call(apiKey, path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'api-key': apiKey,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Panne réseau, DNS ou dépassement du délai de garde.
    throw new Error(`Brevo injoignable : ${err.message}`);
  }

  const text = await res.text();
  let payload = {};
  if (text) { try { payload = JSON.parse(text); } catch { payload = { raw: text }; } }

  if (!res.ok) {
    // L'API renvoie {code, message} ; on garde les deux, le code est parlant
    // (`unauthorized`, `invalid_parameter`, `not_enough_credits`…).
    const detail = payload.message || payload.raw || res.statusText;
    const err = new Error(`Brevo ${res.status} : ${detail}`);
    err.status = res.status;
    err.brevoCode = payload.code || null;
    throw err;
  }
  return payload;
}

/**
 * Vérifie la clé d'API et renvoie le compte associé.
 * Appel de LECTURE : il ne consomme pas le quota d'envoi quotidien, ce qui
 * permet de tester la configuration sans entamer les 300 e-mails/jour de
 * l'offre gratuite.
 *
 * @param {string} apiKey Clé d'API Brevo.
 * @returns {Promise<{email: string, companyName: string, plan: object[]}>}
 */
export async function getAccount(apiKey) {
  return call(apiKey, '/account');
}

/**
 * Envoie un e-mail transactionnel.
 *
 * @param {object} params
 * @param {string} params.apiKey Clé d'API Brevo.
 * @param {{name?: string, email: string}} params.sender Expéditeur (le domaine
 *        doit être authentifié chez Brevo, sinon l'envoi est refusé).
 * @param {string} params.to Adresse du destinataire.
 * @param {string} params.subject Sujet rendu.
 * @param {string} params.html Corps HTML rendu.
 * @param {string | null} [params.tag] Étiquette Brevo (code du gabarit) : elle
 *        permet de filtrer les statistiques par type de message côté Brevo.
 * @returns {Promise<{messageId: string | null}>}
 * @throws {Error} Si l'envoi est refusé (clé invalide, domaine non authentifié,
 *         quota épuisé…).
 */
export async function sendEmail({ apiKey, sender, to, subject, html, tag = null }) {
  const body = {
    sender: sender.name ? { name: sender.name, email: sender.email } : { email: sender.email },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  };
  if (tag) body.tags = [tag];
  const out = await call(apiKey, '/smtp/email', { method: 'POST', body });
  return { messageId: normalizeMessageId(out.messageId) };
}

/**
 * Normalise un identifiant de message Brevo.
 * L'API d'envoi renvoie `<xxx@smtp-relay.mailin.fr>` tandis que le webhook
 * expose `message-id` tantôt avec, tantôt sans chevrons : on stocke et on
 * compare toujours la forme NUE, sans quoi aucun événement ne se recollerait au
 * journal.
 *
 * @param {unknown} id Identifiant brut.
 * @returns {string | null} Identifiant sans chevrons, ou `null`.
 */
export function normalizeMessageId(id) {
  if (!id) return null;
  const s = String(id).trim().replace(/^</, '').replace(/>$/, '');
  return s || null;
}

// Correspondance événement Brevo → statut du journal `email_log`.
// Brevo emploie le camelCase à la souscription (`hardBounce`) et le snake_case
// dans la charge utile du webhook (`hard_bounce`) : les deux formes sont admises.
const EVENT_STATUS = {
  delivered: 'delivered',
  hard_bounce: 'bounced', hardbounce: 'bounced',
  soft_bounce: 'bounced', softbounce: 'bounced',
  invalid_email: 'bounced', invalid: 'bounced',
  blocked: 'blocked',
  spam: 'spam', complaint: 'spam',
  unsubscribed: 'unsubscribed', unsubscribe: 'unsubscribed',
  deferred: 'deferred',
  error: 'failed',
};

/**
 * Traduit un événement de webhook en statut de journal.
 *
 * @param {unknown} event Nom de l'événement reçu (`delivered`, `hard_bounce`…).
 * @returns {string | null} Statut à écrire dans `email_log`, ou `null` si
 *          l'événement n'est pas suivi (`request`, `opened`, `click`…).
 */
export function eventToStatus(event) {
  const key = String(event || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return EVENT_STATUS[key] || EVENT_STATUS[key.replace(/_/g, '')] || null;
}

/**
 * Déclare (ou redéclare) le webhook de délivrabilité chez Brevo.
 *
 * Les webhooks transactionnels précédemment créés pour la MÊME application sont
 * supprimés : le jeton d'URL étant renouvelé à chaque appel, les anciens
 * pointeraient vers une URL devenue invalide et Brevo accumulerait des échecs.
 * On ne touche qu'aux webhooks dont la description porte notre marqueur, pour ne
 * pas détruire un webhook créé à la main pour un autre usage.
 *
 * @param {object} params
 * @param {string} params.apiKey Clé d'API Brevo.
 * @param {string} params.url URL publique à appeler (jeton inclus).
 * @param {string} [params.marker] Marqueur de description identifiant nos webhooks.
 * @returns {Promise<{id: number | null, removed: number}>}
 * @throws {Error} Si Brevo refuse la déclaration (URL non publique, clé invalide…).
 */
export async function declareWebhook({ apiKey, url, marker = 'cazalia-delivrabilite' }) {
  let removed = 0;
  try {
    const list = await call(apiKey, '/webhooks?type=transactional');
    for (const w of list.webhooks || []) {
      if (String(w.description || '').includes(marker)) {
        await call(apiKey, `/webhooks/${w.id}`, { method: 'DELETE' });
        removed += 1;
      }
    }
  } catch {
    // Le ménage est best-effort : s'il échoue, la déclaration ci-dessous reste utile.
  }
  const created = await call(apiKey, '/webhooks', {
    method: 'POST',
    body: { url, description: `Journal de délivrabilité (${marker})`, events: WEBHOOK_EVENTS, type: 'transactional' },
  });
  return { id: created.id ?? null, removed };
}
