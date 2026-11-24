// Limiteur de débit de GET /api/availability/month : 60 requêtes / minute / IP.
// Fichier à part : le compteur est propre à chaque processus de test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-month-limite-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const { db } = await import('../src/db.js');
const { parisDateKey } = await import('../src/lib/time.js');
const { default: express } = await import('express');
const { spacesRouter } = await import('../src/routes/spaces.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

const app = express();
app.use('/api', spacesRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(() => { server.close(); });

// Espace réservable en ligne : les requêtes légitimes doivent réellement passer (200).
const SPACE = Number(db.prepare(
  `INSERT INTO spaces (name, kind, capacity, exclusive, credits_per_hour, active, online_bookable) VALUES ('Open space', 'zone', 10, 0, 0, 1, 1)`
).run().lastInsertRowid);

// Mois relatif à l'horloge réelle (la route n'a pas d'horloge injectable).
const monthOffset = (n) => {
  const [y, m] = parisDateKey().split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

// Le limiteur (`rateLimit`, security.js) compte dans une fenêtre de 60 s lue par `Date.now()`.
// Avec l'horloge réelle, 61 requêtes qui franchiraient une frontière de fenêtre verraient la
// 61e repasser en 200 : test intermittent. On GÈLE donc `Date.now` le temps du test (la
// fenêtre ne peut plus expirer), puis on la fait expirer en avançant l'horloge
// factice, ce qui vérifie aussi que le quota se rouvre après une minute.
test('la 61e requête d\'une minute est refusée en 429 ; les erreurs 400 consomment aussi le quota', async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    await scenario();
    // Une minute plus tard (+1 ms : la fenêtre est « > windowMs ») : le quota est rouvert.
    clock += 60 * 1000 + 1;
    const base = `http://127.0.0.1:${server.address().port}/api/availability/month`;
    const r = await fetch(`${base}?space_id=${SPACE}&month=${monthOffset(1)}`);
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  } finally {
    Date.now = realNow;
  }
});

async function scenario() {
  const base = `http://127.0.0.1:${server.address().port}/api/availability/month`;
  const legit = `${base}?space_id=${SPACE}&month=${monthOffset(1)}`;
  const refused = `${base}?space_id=${SPACE}&month=${monthOffset(50)}`; // hors fenêtre : 400
  // 10 requêtes REFUSÉES (400) : le limiteur est monté avant la validation, elles comptent.
  for (let i = 0; i < 10; i += 1) {
    const r = await fetch(refused);
    assert.equal(r.status, 400, `erreur ${i + 1}`);
    assert.equal((await r.json()).error, 'MOIS_HORS_FENETRE');
  }
  // Il reste donc 50 requêtes légitimes, toutes servies...
  for (let i = 0; i < 50; i += 1) {
    const r = await fetch(legit);
    assert.equal(r.status, 200, `requête légitime ${i + 1}`);
    assert.equal(Array.isArray((await r.json()).days), true);
  }
  // ... et la 61e de la minute, légitime elle aussi, est refusée.
  const r = await fetch(legit);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await r.json()).error, 'TROP_DE_TENTATIVES');
}
