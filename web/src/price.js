// Affichage des prix d'un espace (vignettes landing + fiche détaillée).
//
// Règles produit :
//   • L'open space ne se réserve PAS à l'heure (seulement demi-journée / journée) :
//     on ignore donc le tarif horaire même s'il est renseigné en base.
//   • Dès qu'un espace a plusieurs points de prix, on n'affiche pas la liste mais
//     un prix d'appel « À partir de … » (le plus bas).
//   • Bureau privé (PRIVATE_OFFICE) : aucune notion de prix (uniquement sur devis).
//   • Salle confidentielle (CONFIDENTIAL) : libre-service, pas de prix.

export const eur = (cents) =>
  ((Number(cents) || 0) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

// Points de prix pertinents selon la catégorie (centimes), valeurs nulles exclues.
export function spacePricePoints(space) {
  const hour = space.price_per_hour_cents;
  const half = space.price_half_day_cents;
  const day = space.price_day_cents;
  // Open space : pas de tarif horaire.
  const raw = space.category === 'OPEN_SPACE' ? [half, day] : [hour, half, day];
  return raw.filter((c) => c != null);
}

/**
 * Décrit le prix à afficher pour un espace.
 * @returns {{kind:'devis'}|{kind:'libre'}|{kind:'none'}|{kind:'price', min:number, from:boolean}}
 *          `from` = true quand il existe plusieurs prix (⇒ « À partir de »).
 */
export function spacePrice(space) {
  if (space.category === 'PRIVATE_OFFICE') return { kind: 'devis' };
  if (space.category === 'CONFIDENTIAL') return { kind: 'libre' };
  const pts = spacePricePoints(space);
  if (pts.length === 0) return { kind: 'none' };
  return { kind: 'price', min: Math.min(...pts), from: pts.length > 1 };
}
