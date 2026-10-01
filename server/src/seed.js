// Jeu de données de démonstration. Idempotent : ne réinsère pas si déjà présent.
//   node src/seed.js
import { db } from './db.js';
import { hashPassword } from './auth.js';
import { topUp } from './lib/wallet.js';
import { defaultSpaceContent } from './lib/spaceContent.js';

const upsertUser = db.prepare(
  `INSERT INTO users (email, display_name, password_hash, role)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(email) DO NOTHING`
);
const getUser = db.prepare(`SELECT * FROM users WHERE email = ?`);

function ensureUser(email, name, password, role) {
  upsertUser.run(email, name, hashPassword(password), role);
  return getUser.get(email);
}

const admin = ensureUser('admin@cowork.test', 'Gestionnaire', 'admin1234', 'admin');
const alice = ensureUser('alice@cowork.test', 'Alice Membre', 'alice1234', 'member');
const bob = ensureUser('bob@cowork.test', 'Bob Membre', 'bob1234', 'member');

// Espaces : zones (open-space) + salles (capacity = 1).
const spaceCount = db.prepare(`SELECT COUNT(*) AS n FROM spaces`).get().n;
if (spaceCount === 0) {
  const ins = db.prepare(
    `INSERT INTO spaces (name, kind, capacity, exclusive, privatizable, credits_per_hour, color, description, amenities)
     VALUES (@name, @kind, @capacity, @exclusive, @privatizable, @credits_per_hour, @color, @description, @amenities)`
  );
  const mk = (name, kind, capacity, cph, color, opts = {}) => {
    const c = defaultSpaceContent(kind);
    ins.run({
      name, kind, capacity,
      exclusive: opts.exclusive ? 1 : 0,
      privatizable: opts.privatizable ? 1 : 0,
      credits_per_hour: cph, color, description: c.description, amenities: c.amenities,
    });
  };
  mk('Open-space — Rez', 'zone', 12, 2, '#1C3155');                    // inventaire, prix/place
  mk('Open-space — Étage', 'zone', 8, 3, '#2E7D32');                   // inventaire, prix/place
  mk('Salle Focus', 'room', 2, 5, '#B71C1C', { privatizable: true }); // 2 postes, privatisation ×2
  mk('Salle Réunion', 'room', 8, 8, '#6A1B9A', { exclusive: true });  // exclusive, 8 occupants, forfait
}

// Crédits de départ pour les membres (si solde nul).
const balance = (id) =>
  db.prepare(`SELECT COALESCE(SUM(amount),0) AS b FROM credit_transactions WHERE user_id = ?`).get(id).b;
for (const m of [alice, bob]) {
  if (balance(m.id) === 0) {
    topUp({ userId: m.id, amount: 50, createdBy: admin.id, note: 'Crédits de démonstration' });
  }
}

console.log('Seed terminé.');
console.log('  admin@cowork.test / admin1234  (admin)');
console.log('  alice@cowork.test / alice1234  (membre, 50 crédits)');
console.log('  bob@cowork.test   / bob1234    (membre, 50 crédits)');
