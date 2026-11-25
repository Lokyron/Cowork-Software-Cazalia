// Fonctions pures de la page Tarifs (sans React, testables sous `node --test`).
// Les montants arrivent en centimes depuis GET /api/pricing.

// Les tarifs de la vitrine sont des montants ronds : on évite « 20,00 € » et on
// ne montre les centimes que s'il y en a réellement.
export const eurc = (cents) => {
  const v = (Number(cents) || 0) / 100;
  return Number.isInteger(v) ? `${v} €` : v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
};

export const CONFIDENTIELLE = 'En accès libre, sous réserve de non-privatisation';

const positive = (c) => c != null && Number(c) > 0;

/**
 * Carte « Bureau privatif » de la section Ponctuel, ou null.
 * Elle n'existe que si l'API déclare le bureau réservable en ligne (`bookable`)
 * ET qu'au moins un forfait a un prix : sinon la section reste à trois cartes.
 */
export function privateOfficeCard(office) {
  if (!office || office.bookable !== true) return null;
  const half = positive(office.half_day_cents) ? Number(office.half_day_cents) : null;
  const day = positive(office.day_cents) ? Number(office.day_cents) : null;
  if (half == null && day == null) return null;
  const lines = [];
  // « à partir de » : les bureaux réservables n'ont pas tous les mêmes prix (cf. GET /api/pricing).
  const from = office.from === true;
  if (day != null && half != null) lines.push(`${from ? 'à partir de ' : ''}${eurc(half)} la demi-journée`);
  lines.push('Même pièce que la salle confidentielle');
  return {
    name: 'Bureau privatif',
    price: eurc(day ?? half),
    unit: day != null ? '/ journée' : '/ demi-journée',
    from,
    lines,
  };
}

// Forfaits du bureau privatif réellement réservables en ligne, en toutes lettres
// (« une demi-journée ou une journée », « une journée »…), ou null.
export function bureauForfaitsLabel(office) {
  const card = privateOfficeCard(office);
  if (!card) return null;
  const half = positive(office.half_day_cents);
  const day = positive(office.day_cents);
  if (half && day) return 'une demi-journée ou une journée';
  return day ? 'une journée' : 'une demi-journée';
}

// Note du samedi. Accepte des booléens (réponse de l'API) comme des listes de
// fenêtres (config serveur) : `[]` est « fermé », pas « vrai ».
const ouvert = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v));
export const samediNote = (samedi) =>
  samedi && ouvert(samedi.demi_journee) && !ouvert(samedi.journee)
    ? 'Le samedi, seule la demi-journée du matin est ouverte.'
    : '';

// Nombre de colonnes de la grille Ponctuel : 2 pour 4 (2x2), 8… ; 3 sinon.
export const ponctuelColumns = (n) => (n % 2 === 0 && n % 3 !== 0 ? 2 : 3);

// Accès ponctuel : une carte par espace, au même format que les formules.
export const ponctuelFrom = (t) => {
  const cards = [
    {
      name: 'Open Space',
      price: eurc(t.open_space.journee), unit: '/ journée',
      lines: [
        `${eurc(t.open_space.demi_journee)} la demi-journée`,
        'Poste de travail en espace partagé',
        'Salle confidentielle incluse, sous réserve de non-privatisation',
      ],
    },
    {
      name: 'Salle de réunion',
      price: eurc(t.meeting_room.heure), unit: '/ heure',
      lines: [
        `${eurc(t.meeting_room.demi_journee)} la demi-journée · ${eurc(t.meeting_room.journee)} la journée`,
        'Salle privative, réservée pour vous seul',
      ],
    },
  ];
  const bureau = privateOfficeCard(t.private_office);
  if (bureau) cards.push(bureau);
  cards.push({
    name: 'Salle confidentielle',
    price: 'Incluse', unit: null,
    lines: ['Avec toute réservation d\'open space', CONFIDENTIELLE, 'Rien à réserver'],
  });
  return cards;
};
