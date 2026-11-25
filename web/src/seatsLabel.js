// Libellé du badge de disponibilité d'un créneau précis (CartBuilder, BookingModal).
// Fonction pure : testée dans `test/seats-label.test.js`.

/**
 * Nom d'une unité de réservation, selon l'espace. Le vocabulaire du site est « poste »
 * (open space, salle focus : « 1 poste », « Privatiser (2 postes) », CGU « poste en
 * open-space ») ; « place » reste le repli pour un espace en inventaire qui ne serait
 * ni une zone ni privatisable.
 * @param {{kind?: string, privatizable?: boolean|number}|null|undefined} space
 * @returns {'poste'|'place'}
 */
export function seatNoun(space) {
  return space && (space.kind === 'zone' || space.privatizable) ? 'poste' : 'place';
}

/**
 * Intitulé d'un champ de quantité : « Postes » / « Places », le même mot que `seatNoun`.
 * @param {{kind?: string, privatizable?: boolean|number}|null|undefined} space
 * @returns {'Postes'|'Places'}
 */
export function seatsHeading(space) {
  return seatNoun(space) === 'poste' ? 'Postes' : 'Places';
}

/**
 * « 3 postes restants », « 1 poste restant », « 2 places restantes » : accord du nom et
 * de « restant ». Partagé par le badge de créneau et le calendrier (même vocabulaire).
 * @param {'poste'|'place'} noun Nom retourné par `seatNoun`.
 * @param {number} n Nombre restant (entier >= 1).
 * @returns {string}
 */
export function seatsRemaining(noun, n) {
  const plural = n > 1;
  // « restant » s'accorde : un poste restant, des postes restants ; une place restante, des places restantes.
  const rest = noun === 'poste' ? (plural ? 'restants' : 'restant') : (plural ? 'restantes' : 'restante');
  return `${n} ${noun}${plural ? 's' : ''} ${rest}`;
}

/**
 * Nombre de places suivi du bon nom : « 1 poste », « 3 postes », « 2 places ».
 * @param {{kind?: string, privatizable?: boolean|number}|null|undefined} space
 * @param {number} n
 * @returns {string}
 */
export function seatsCount(space, n) {
  return `${n} ${seatNoun(space)}${n > 1 ? 's' : ''}`;
}

/**
 * Texte et couleur du badge de disponibilité.
 *   • Espace EXCLUSIF : pas de « places restantes », « Disponible » ou « Réservé ».
 *   • Inventaire : « 3 postes restants sur 7 » ; « Complet » quand il ne reste rien.
 *     Le badge est rouge quand il reste moins que la demande (`seats`), même si l'espace
 *     n'est pas plein : le serveur refuse alors la réservation (`COMPLET`).
 *   • Un `seats_left` négatif ou décimal est ramené à un entier >= 0 ; un `seats` non fini vaut 1.
 *   • Réponse absente ou sans nombre exploitable : `null` (l'appelant garde son repli
 *     « … » : jamais de chiffre inventé).
 * @param {{exclusive?: boolean, seats_left?: number, capacity?: number}|null|undefined} avail Réponse de GET /api/availability.
 * @param {{kind?: string, privatizable?: boolean|number}|null|undefined} space
 * @param {number} seats Nombre de places demandé.
 * @returns {{text: string, tone: 'green'|'red'} | null}
 */
export function seatsBadge(avail, space, seats) {
  if (!avail || !Number.isFinite(avail.seats_left)) return null;
  // Jamais de chiffre absurde : entier, jamais négatif ; une demande illisible vaut 1 poste.
  const left = Math.max(0, Math.floor(avail.seats_left));
  const wanted = Number.isFinite(seats) ? seats : 1;
  const tone = left < wanted ? 'red' : 'green';
  if (avail.exclusive) return { text: tone === 'red' ? 'Réservé' : 'Disponible', tone };
  if (left <= 0) return { text: 'Complet', tone: 'red' };
  // « sur N » seulement si N est une capacité plausible (« 5 sur 3 » n'a aucun sens).
  const of = Number.isFinite(avail.capacity) && avail.capacity >= left && avail.capacity > 0 ? ` sur ${avail.capacity}` : '';
  return { text: `${seatsRemaining(seatNoun(space), left)}${of}`, tone };
}
