// Tests du libellé du badge de disponibilité (`src/seatsLabel.js`) :
//   cd web && npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { seatNoun, seatsBadge, seatsCount, seatsHeading, seatsRemaining } from '../src/seatsLabel.js';

const OPEN = { kind: 'zone', privatizable: 0 };
const FOCUS = { kind: 'room', privatizable: 1 };
const ROOM = { kind: 'room', privatizable: 0 };

test('vocabulaire : poste pour l\'open space et le focus, place en repli', () => {
  assert.equal(seatNoun(OPEN), 'poste');
  assert.equal(seatNoun(FOCUS), 'poste');
  assert.equal(seatNoun(ROOM), 'place');
  assert.equal(seatNoun(null), 'place');
});

test('open space : « 3 postes restants sur 7 », accord au singulier', () => {
  assert.deepEqual(seatsBadge({ seats_left: 3, capacity: 7 }, OPEN, 1), { text: '3 postes restants sur 7', tone: 'green' });
  assert.deepEqual(seatsBadge({ seats_left: 1, capacity: 7 }, OPEN, 1), { text: '1 poste restant sur 7', tone: 'green' });
  assert.deepEqual(seatsBadge({ seats_left: 2, capacity: 4 }, ROOM, 1), { text: '2 places restantes sur 4', tone: 'green' });
  assert.equal(seatsBadge({ seats_left: 1, capacity: 4 }, ROOM, 1).text, '1 place restante sur 4');
});

test('demande supérieure à ce qui reste : rouge, mais le chiffre reste affiché', () => {
  assert.deepEqual(seatsBadge({ seats_left: 3, capacity: 7 }, OPEN, 4), { text: '3 postes restants sur 7', tone: 'red' });
  assert.deepEqual(seatsBadge({ seats_left: 0, capacity: 7 }, OPEN, 1), { text: 'Complet', tone: 'red' });
});

test('espace exclusif : « Disponible » ou « Réservé », jamais de nombre', () => {
  assert.deepEqual(seatsBadge({ exclusive: true, seats_left: 1, capacity: 8 }, ROOM, 1), { text: 'Disponible', tone: 'green' });
  assert.deepEqual(seatsBadge({ exclusive: true, seats_left: 0, capacity: 8 }, ROOM, 1), { text: 'Réservé', tone: 'red' });
});

test('donnée absente ou inexploitable : null (pas de chiffre inventé)', () => {
  assert.equal(seatsBadge(null, OPEN, 1), null);
  assert.equal(seatsBadge(undefined, OPEN, 1), null);
  assert.equal(seatsBadge({}, OPEN, 1), null);
  assert.equal(seatsBadge({ seats_left: '3' }, OPEN, 1), null);
  // Capacité inconnue : on garde le nombre restant, sans « sur N ».
  assert.equal(seatsBadge({ seats_left: 3 }, OPEN, 1).text, '3 postes restants');
});

test('vocabulaire partagé : le calendrier, le sélecteur et le badge disent le même mot', () => {
  assert.equal(seatsRemaining('poste', 7), '7 postes restants');
  assert.equal(seatsRemaining('poste', 1), '1 poste restant');
  assert.equal(seatsRemaining('place', 2), '2 places restantes');
  assert.equal(seatsRemaining('place', 1), '1 place restante');
  assert.equal(seatsHeading(OPEN), 'Postes');
  assert.equal(seatsHeading(ROOM), 'Places');
  assert.equal(seatsCount(OPEN, 3), '3 postes');
  assert.equal(seatsCount(OPEN, 1), '1 poste');
  // Le badge reprend exactement la formulation du calendrier, suivie de « sur N ».
  assert.equal(seatsBadge({ seats_left: 7, capacity: 7 }, OPEN, 1).text, `${seatsRemaining('poste', 7)} sur 7`);
});

test('seats non fini : la demande vaut 1 poste, jamais un badge faussement rouge ou vert', () => {
  for (const seats of [NaN, undefined, Infinity, -Infinity, null]) {
    const b = seatsBadge({ seats_left: 3, capacity: 7 }, OPEN, seats);
    assert.deepEqual(b, { text: '3 postes restants sur 7', tone: 'green' }, String(seats));
  }
  // Infinity : non fini donc ramené à 1 ; plus rien de restant reste « Complet ».
  assert.deepEqual(seatsBadge({ seats_left: 0, capacity: 7 }, OPEN, NaN), { text: 'Complet', tone: 'red' });
});

test('seats_left négatif ou décimal : jamais de chiffre absurde', () => {
  assert.deepEqual(seatsBadge({ seats_left: -2, capacity: 7 }, OPEN, 1), { text: 'Complet', tone: 'red' });
  assert.deepEqual(seatsBadge({ seats_left: -1, exclusive: false }, OPEN, 1), { text: 'Complet', tone: 'red' });
  assert.equal(seatsBadge({ seats_left: 2.9, capacity: 7 }, OPEN, 1).text, '2 postes restants sur 7');
  assert.equal(seatsBadge({ seats_left: Infinity, capacity: 7 }, OPEN, 1), null);
  assert.equal(seatsBadge({ seats_left: NaN, capacity: 7 }, OPEN, 1), null);
  // Capacité incohérente (inférieure au restant) ou non finie : « sur N » omis, jamais « 5 sur 3 ».
  assert.equal(seatsBadge({ seats_left: 5, capacity: 3 }, OPEN, 1).text, '5 postes restants');
  assert.equal(seatsBadge({ seats_left: 3, capacity: NaN }, OPEN, 1).text, '3 postes restants');
  // Exclusif avec restant négatif : « Réservé ».
  assert.deepEqual(seatsBadge({ exclusive: true, seats_left: -1, capacity: 8 }, ROOM, 1), { text: 'Réservé', tone: 'red' });
});
