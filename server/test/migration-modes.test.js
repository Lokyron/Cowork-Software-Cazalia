// Migration des modes de réservation (online_bookable / quote_available) sur une
// base ANTÉRIEURE : la colonne est ajoutée, le backfill reproduit l'ancien
// comportement déduit de la catégorie, et un redémarrage n'écrase rien.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-migr-modes-'));
const TMP_DB = path.join(TMP_DIR, 'ancienne.db');

// Base « d'avant » : table spaces avec `category` mais sans les colonnes de mode.
{
  const old = new Database(TMP_DB);
  old.exec(`
    CREATE TABLE spaces (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, category TEXT,
      capacity INTEGER NOT NULL, exclusive INTEGER NOT NULL DEFAULT 0, privatizable INTEGER NOT NULL DEFAULT 0,
      credits_per_hour INTEGER NOT NULL DEFAULT 0, price_per_hour_cents INTEGER, price_half_day_cents INTEGER,
      price_day_cents INTEGER, color TEXT, description TEXT, tagline TEXT, position INTEGER NOT NULL DEFAULT 0,
      amenities TEXT, photo TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const ins = old.prepare(`INSERT INTO spaces (name, kind, category, capacity, description) VALUES (?, ?, ?, 4, 'x')`);
  ins.run('A open', 'zone', 'OPEN_SPACE');
  ins.run('B salle', 'room', 'MEETING_ROOM');
  ins.run('C focus', 'room', 'CONFIDENTIAL');
  ins.run('D bureau', 'room', 'PRIVATE_OFFICE');
  old.close();
}

process.env.DB_PATH = TMP_DB;
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const { db } = await import('../src/db.js');
test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

const modes = () => Object.fromEntries(
  db.prepare(`SELECT name, online_bookable AS o, quote_available AS q FROM spaces`).all().map((r) => [r.name, [r.o, r.q]])
);

test('le backfill reproduit le comportement antérieur', () => {
  assert.deepEqual(modes(), {
    'A open': [1, 0], 'B salle': [1, 0], 'C focus': [0, 0], 'D bureau': [0, 1],
  });
});

test('un redémarrage (schéma rejoué) est idempotent et n\'écrase pas un réglage admin', () => {
  db.prepare(`UPDATE spaces SET online_bookable = 1 WHERE name = 'D bureau'`).run(); // double mode
  const schema = fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');
  assert.doesNotThrow(() => db.exec(schema));
  assert.deepEqual(modes()['D bureau'], [1, 1]);
});
