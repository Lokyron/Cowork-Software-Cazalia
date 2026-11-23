// Affichage des prix d'un espace (vignettes landing + fiche détaillée).
//
// Règles produit :
//   • L'open space ne se réserve PAS à l'heure (seulement demi-journée / journée) :
//     on ignore donc le tarif horaire même s'il est renseigné en base.
//   • Dès qu'un espace a plusieurs points de prix, on n'affiche pas la liste mais
//     un prix d'appel « À partir de … » (le plus bas).
//   • Bureau privé (PRIVATE_OFFICE) : demi-journée / journée seulement, au tarif
//     saisi dans l'admin ; sans tarif, il n'est proposé que sur devis.
//   • Un espace porte deux modes cumulables : réservation en ligne
//     (`online_bookable`) et devis (`quote_available`), cf. `spaceModes`.
//   • Salle confidentielle (CONFIDENTIAL) : libre-service, pas de prix.

export const eur = (cents) =>
  ((Number(cents) || 0) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

const positive = (c) => c != null && Number(c) > 0;

// Catégories dont le prix vient de la grille serveur (config.pricing) ; le
// bureau privé, lui, est facturé d'après les colonnes de l'espace.
const GRID_CATEGORIES = ['OPEN_SPACE', 'MEETING_ROOM'];

/** Types de tarif proposés en ligne pour un espace (miroir de pricing.js serveur). */
export function tarifTypesOffered(space) {
  if (space?.category === 'PRIVATE_OFFICE') {
    return [
      ...(positive(space.price_half_day_cents) ? ['demi_journee'] : []),
      ...(positive(space.price_day_cents) ? ['journee'] : []),
    ];
  }
  if (space?.category === 'OPEN_SPACE') return ['demi_journee', 'journee'];
  if (space?.category === 'MEETING_ROOM') return ['heure', 'demi_journee', 'journee'];
  return [];
}

/**
 * Modes de réservation effectifs d'un espace.
 *   online : réservable en ligne ET réellement tarifable (le serveur refuserait sinon) ;
 *   quote  : proposé sur devis.
 * Repli sur la catégorie si les colonnes de mode sont absentes de la réponse.
 */
export function spaceModes(space) {
  const flagOnline = space?.online_bookable != null
    ? Number(space.online_bookable) === 1
    : GRID_CATEGORIES.includes(space?.category);
  const quote = space?.quote_available != null
    ? Number(space.quote_available) === 1
    : space?.category === 'PRIVATE_OFFICE';
  const online = flagOnline && tarifTypesOffered(space).length > 0;
  return { online, quote };
}

// Points de prix pertinents selon la catégorie (centimes), valeurs nulles exclues.
export function spacePricePoints(space) {
  const hour = space.price_per_hour_cents;
  const half = space.price_half_day_cents;
  const day = space.price_day_cents;
  if (space.category === 'PRIVATE_OFFICE') return [half, day].filter(positive);
  // Open space : pas de tarif horaire.
  const raw = space.category === 'OPEN_SPACE' ? [half, day] : [hour, half, day];
  return raw.filter((c) => c != null);
}

/**
 * Décrit le prix à afficher pour un espace.
 * @returns {{kind:'devis'}|{kind:'libre'}|{kind:'none'}|{kind:'price', min:number, from:boolean, quote:boolean}}
 *          `from` = true quand il existe plusieurs prix (⇒ « À partir de ») ;
 *          `quote` = true quand l'espace est aussi proposé sur devis (double mode).
 */
export function spacePrice(space) {
  const { online, quote } = spaceModes(space);
  if (online) {
    const pts = spacePricePoints(space);
    if (pts.length > 0) return { kind: 'price', min: Math.min(...pts), from: pts.length > 1, quote };
    if (quote) return { kind: 'devis' };
    return { kind: 'none' };
  }
  if (quote) return { kind: 'devis' };
  if (space.category === 'CONFIDENTIAL') return { kind: 'libre' };
  if (space.category === 'PRIVATE_OFFICE') return { kind: 'none' }; // aucun mode actif
  const pts = spacePricePoints(space);
  if (pts.length === 0) return { kind: 'none' };
  return { kind: 'price', min: Math.min(...pts), from: pts.length > 1, quote: false };
}
