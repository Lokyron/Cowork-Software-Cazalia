// Journal des événements de sécurité.
//
// Objectif : disposer d'une trace exploitable des tentatives d'accès et des
// actions sensibles (CWE-778), SANS y déverser de données personnelles ni de
// secrets (CWE-532). Les identifiants directs — adresse e-mail, jeton, mot de
// passe — ne sont jamais écrits : une adresse est réduite à une empreinte
// tronquée, qui permet de corréler des tentatives entre elles sans révéler qui
// est visé si le journal fuite.
//
// La sortie va sur stdout, donc dans le journal systemd du service
// (`journalctl -u cazalia`), déjà collecté et rotaté par l'hôte.

import crypto from 'node:crypto';

// Clés dont la valeur ne doit JAMAIS apparaître en clair dans le journal.
const SENSITIVE_KEYS = new Set(['email', 'password', 'token', 'secret', 'cookie', 'authorization']);

/**
 * Réduit une valeur identifiante à une empreinte courte et non réversible.
 *
 * @param {unknown} value Valeur à masquer (adresse e-mail, jeton…).
 * @returns {string} Douze caractères hexadécimaux préfixés (`sha256:…`).
 */
function pseudonymize(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 12)}`;
}

/**
 * Écrit un événement de sécurité sur la sortie standard, au format JSON.
 *
 * @param {string} event Nom de l'événement (`login_ok`, `login_echec`,
 *        `2fa_activee`, `mot_de_passe_change`, `acces_refuse`…).
 * @param {Record<string, unknown>} [details] Contexte. Les clés sensibles
 *        (`email`, `token`, `secret`…) sont automatiquement pseudonymisées.
 * @returns {void} Ne lève jamais : la journalisation ne doit pas casser une requête.
 */
export function securityEvent(event, details = {}) {
  try {
    const safe = {};
    for (const [k, v] of Object.entries(details)) {
      if (v === undefined) continue;
      safe[k] = SENSITIVE_KEYS.has(k) ? pseudonymize(v) : v;
    }
    console.log(JSON.stringify({ ts: new Date().toISOString(), canal: 'securite', event, ...safe }));
  } catch {
    /* la journalisation ne doit jamais faire échouer une requête */
  }
}
