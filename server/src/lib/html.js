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
 * un e-mail transactionnel authentique émis par Cazalia - un vecteur de
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
 * permettraient d'ajouter des en-têtes arbitraires - un `Bcc:` par exemple
 * (injection d'en-tête, CWE-93).
 *
 * @param {unknown} value Valeur à assainir.
 * @returns {string} Valeur sur une seule ligne.
 */
export function headerSafe(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Déséchappe les entités HTML courantes (une seule passe : « &amp;lt; » → « &lt; »). */
function decodeEntities(str) {
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/**
 * Convertit un e-mail HTML en version texte brut (partie `text/plain`).
 *
 * Conversion volontairement simple, sans dépendance : les messages sont produits
 * par l'application (tableaux, paragraphes, liens). Retire `<head>`, `<style>`,
 * `<script>` et le texte d'aperçu masqué ; rend `<a href="u">libellé</a>` en
 * « libellé (u) » ; transforme les fins de bloc en retours à la ligne et les `<li>`
 * en tirets ; déséchappe les entités ; effondre les espaces et lignes vides multiples.
 *
 * @param {unknown} html HTML à convertir.
 * @returns {string} Texte brut, terminé par un retour à la ligne (vide si rien à dire).
 */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script)\b[\s\S]*?<\/\1\s*>/gi, '')
    // Préheader : bloc masqué, sans balise imbriquée.
    .replace(/<div\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/div\s*>/gi, '');
  // Les sauts de ligne n'ont de sens que dans les blocs `white-space:pre-wrap`
  // (message d'un visiteur) ; ailleurs ce n'est que de l'indentation de source.
  s = s.replace(/(<(p|div)\b[^>]*pre-wrap[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
    (_, open, _t, inner, close) => open + inner.replace(/\r?\n/g, '<br>') + close);
  s = s.replace(/\s+/g, ' ');
  // Liens : « libellé (URL) », ou l'URL seule quand le libellé est déjà l'URL.
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (m, attrs, inner) => {
    const h = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs) || [];
    const href = h[1] ?? h[2];
    const label = inner.replace(/<[^>]*>/g, '').trim();
    const url = String(href || '').trim();
    if (!url || url === '#') return label;
    const bare = decodeEntities(url).replace(/^mailto:|^tel:/i, '');
    const lbl = decodeEntities(label);
    if (label && lbl === bare && bare !== decodeEntities(url)) return label; // « a@b.fr » : l'adresse suffit
    if (!label || lbl === decodeEntities(url)) return url;
    return `${label} (${url})`;
  });
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(h[1-6]|p)\s*>/gi, '\n\n')
    .replace(/<\/(div|tr|table|ul|ol)\s*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  s = decodeEntities(s)
    .replace(/[ \t\f\v ‌]+/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s ? `${s}\n` : '';
}
