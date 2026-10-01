// Contenu descriptif par défaut d'un espace (INVENTÉ — à remplacer par les vraies
// informations depuis l'admin Espaces). `amenities` = une prestation par ligne.

const ZONE = {
  description:
    "Un espace de travail partagé, lumineux et convivial, pensé pour travailler en " +
    "autonomie tout en profitant d'une ambiance stimulante. Vous disposez d'un poste " +
    "sur le créneau réservé, dans un cadre calme et inspirant.",
  amenities: [
    'Bureau spacieux et chaise ergonomique',
    'Wi-Fi fibre très haut débit',
    'Prises électriques et ports USB à chaque poste',
    'Café, thé et eau à volonté',
    'Accès à l\'espace détente et à la cuisine',
    'Casier sécurisé pour vos affaires',
    'Imprimante / scanner en libre-service',
  ].join('\n'),
};

const ROOM = {
  description:
    "Une salle privative et fermée, idéale pour vos réunions, entretiens, appels en " +
    "visioconférence ou sessions de travail concentré, à l'abri du bruit. Réservation " +
    "exclusive : la salle est rien qu'à vous sur le créneau choisi.",
  amenities: [
    'Salle privative et insonorisée',
    'Grand écran / TV pour vos présentations',
    'Visioconférence (webcam HD + micro)',
    'Tableau blanc et marqueurs',
    'Wi-Fi fibre dédié',
    'Bouteilles d\'eau offertes',
    'Réservable à l\'heure selon vos besoins',
  ].join('\n'),
};

/**
 * Contenu descriptif par défaut d'un espace, selon sa nature.
 * Utilisé à l'amorçage et à la création : un espace n'est jamais publié sans
 * description. Ces textes restent éditables depuis le back-office.
 *
 * @param {'zone'|'room'} kind Nature de l'espace.
 * @returns {{description: string, amenities: string}}
 */
export function defaultSpaceContent(kind) {
  return kind === 'room' ? { ...ROOM } : { ...ZONE };
}
