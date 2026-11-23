// Table de vérité SEO : constantes du site + métadonnées de chaque route publique.
//
// Ce module est importé par DEUX consommateurs :
//   - le front (via Vite), pour le composant <Seo> ;
//   - le plugin de build `web/seo/plugin.js` (via Node, hors Vite), qui génère
//     robots.txt, sitemap.xml et un index.html par route.
// Côté Node, `import.meta.env` est `undefined` : on ne l'évalue donc JAMAIS au
// chargement du module, uniquement dans `baseUrl()`, avec un accès optionnel.
// Le plugin passe lui-même la valeur de VITE_PUBLIC_BASE_URL (via loadEnv).
// Le module n'a aucun import : il reste chargeable tel quel par Node.

export const SITE_NAME = 'Cazalia';
export const DEFAULT_BASE_URL = 'https://cazalia.fr';
export const LEGAL_NAME = 'CAZALIA';
export const ADDRESS = {
  street: '99 rue du Faubourg Boutonnet',
  postalCode: '34090',
  city: 'Montpellier',
  country: 'FR',
};
export const PHONE = '+33766211483';
export const EMAIL = 'contact@cazalia.fr';
// Horaires lisibles (la version structurée schema.org vit dans index.html).
export const OPENING_HOURS = 'Lun-Ven 8h30-19h30, Samedi 9h-13h, Dimanche fermé';

// Visuel OG : on réutilise la photo d'accueil en l'état.
// TODO : un visuel dédié 1200×630 serait préférable pour les aperçus de lien.
export const OG_IMAGE_FILE = 'images/hero.jpg';

// Base d'URL publique, sans slash final. `override` sert au plugin Node.
export function baseUrl(override) {
  const fromEnv = override ?? import.meta.env?.VITE_PUBLIC_BASE_URL;
  return String(fromEnv || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export const ogImageUrl = (base = baseUrl()) => `${base}/${OG_IMAGE_FILE}`;

// URL canonique publiée d'une route (canonical, og:url, <loc> du sitemap) : seule
// source de cette forme. Toujours avec slash final (`/` → `https://cazalia.fr/`,
// `/tarifs` → `https://cazalia.fr/tarifs/`), car le build génère dist/<route>/index.html
// et un serveur statique redirige `/tarifs` vers `/tarifs/` (301). Les `path` de PAGES
// et les liens du front restent sans slash : seule l'URL absolue annoncée en a un.
export const canonicalUrl = (path, base = baseUrl()) => `${base}${path.replace(/\/+$/, '')}/`;

// Routes publiques déclarées dans App.jsx. Titres < 60 car., descriptions 140-160 car.
export const PAGES = [
  {
    path: '/',
    title: 'Cazalia, coworking à Montpellier (Boutonnet)',
    description: 'Espace de coworking au cœur de Boutonnet, à Montpellier : open space et salles de réunion à réserver à l’heure, à la journée ou en abonnement mensuel.',
    indexable: true,
  },
  {
    path: '/tarifs',
    title: 'Tarifs et abonnements coworking à Montpellier',
    description: 'Abonnements mensuels Essentiel, Confort et Premium, ou réservation à la carte : consultez les tarifs de l’open space et des salles de réunion de Cazalia.',
    indexable: true,
  },
  {
    path: '/rejoindre',
    title: 'Une journée de coworking offerte à Montpellier',
    description: 'Inscrivez-vous gratuitement et testez l’open space de Cazalia pendant une journée offerte, sans engagement, dans le quartier Boutonnet à Montpellier.',
    indexable: true,
  },
  {
    path: '/cgu',
    title: 'CGU et mentions légales | Cazalia',
    description: 'Conditions générales d’utilisation, mentions légales et politique de confidentialité de Cazalia, espace de coworking exploité par CAZALIA à Montpellier.',
    indexable: true,
  },
  {
    path: '/cgv',
    title: 'Conditions générales de vente | Cazalia',
    description: 'Conditions générales de vente de Cazalia : prix, réservation et paiement des espaces de coworking, abonnements, annulation et remboursement.',
    indexable: true,
  },
  {
    path: '/reclamation',
    title: 'Réclamation et remboursement | Cazalia',
    description: 'Une question sur une réservation, une annulation ou un remboursement ? Rappel de la politique d’annulation et formulaire de réclamation de Cazalia.',
    indexable: true,
  },
  {
    path: '/newsletter',
    title: 'Newsletter Cazalia | Actualités du coworking',
    description: 'Inscrivez-vous à la newsletter de Cazalia pour recevoir les actualités et les offres de notre espace de coworking à Montpellier. Désinscription en un clic.',
    indexable: true,
  },
];

// Chemins privés : exclus du sitemap, interdits dans robots.txt.
// `/admin` couvre aussi `/admin/*` (Disallow est un préfixe).
// `/test-checkout-flow` est VOLONTAIREMENT absent : la route n'a aucun <Guard>, donc
// l'afficher dans un robots.txt public en annoncerait l'existence (hameçonnage possible)
// sans la protéger. Elle reste hors sitemap et hors PAGES (titre neutre, pas de canonical).
// Ne pas l'ajouter ici « par cohérence ».
export const PRIVATE_PATHS = [
  '/login',
  '/reset-password',
  '/mot-de-passe-oublie',
  '/reserver',
  '/mon-espace',
  '/mon-planning',
  '/mes-paiements',
  '/mon-compte',
  '/admin',
];

// Retrouve la page publique d'un chemin (tolère le slash final).
export function findPage(pathname) {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return PAGES.find((page) => page.path === p);
}
