// Utilitaires d'échappement partagés par le moteur d'e-mails (`mailer.js`) et la
// mise en page des messages (`emailTemplates.js`). Module dédié pour éviter un
// cycle d'imports entre ces deux fichiers.

/**
 * Échappe les caractères significatifs en HTML.
 *
 * Indispensable pour toute valeur d'origine utilisateur insérée dans le corps
 * d'un e-mail : plusieurs variables de gabarit proviennent de champs librement
 * modifiables (`client_name`, `first_name`, `space_name`, `note`…). Sans
 * échappement, un membre pourrait faire figurer un lien de sa composition dans
 * un e-mail transactionnel authentique émis par Cazalia — un vecteur de
 * hameçonnage particulièrement crédible (CWE-79 / CWE-116).
 *
 * L'échappement reste correct pour une valeur placée dans un attribut `href` :
 * « &amp; » est la forme attendue d'une esperluette en HTML.
 *
 * @param {unknown} value Valeur à insérer.
 * @returns {string} Chaîne sûre à interpoler dans du HTML.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Nettoie une valeur destinée à un en-tête de message (sujet, nom d'expéditeur).
 *
 * Les retours chariot sont retirés : injectés dans un en-tête SMTP, ils
 * permettraient d'ajouter des en-têtes arbitraires — un `Bcc:` par exemple
 * (injection d'en-tête, CWE-93).
 *
 * @param {unknown} value Valeur à assainir.
 * @returns {string} Valeur sur une seule ligne.
 */
export function headerSafe(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}
