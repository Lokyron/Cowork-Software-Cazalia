// Migration de rattrapage « bureau privé exclusif » (migr_bureau_prive_exclusif_v1)
// sur une base ANTÉRIEURE : un bureau privé resté en inventaire de places passe
// en exclusif, les autres catégories ne bougent pas, et la migration ne se rejoue pas.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-migr-bureau-'));
const TMP_DB = path.join(TMP_DIR, 'ancienne.db');

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
  const ins = old.prepare(`INSERT INTO spaces (name, kind, category, capacity, exclusive, privatizable, description) VALUES (?, ?, ?, 6, ?, ?, 'x')`);
  ins.run('A open', 'zone', 'OPEN_SPACE', 0, 0);
  ins.run('B bureau', 'room', 'PRIVATE_OFFICE', 0, 1); // inventaire de places + privatisable : à corriger
  ins.run('C salle', 'room', 'MEETING_ROOM', 0, 1);
  old.close();
}

process.env.DB_PATH = TMP_DB;
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const { db } = await import('../src/db.js');
test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

const state = () => Object.fromEntries(
  db.prepare(`SELECT name, exclusive AS e, privatizable AS p FROM spaces`).all().map((r) => [r.name, [r.e, r.p]])
);

test('le bureau privé existant passe en exclusif, sans privatisation ; les autres catégories sont intactes', () => {
  assert.deepEqual(state(), { 'A open': [0, 0], 'B bureau': [1, 0], 'C salle': [0, 1] });
  assert.ok(db.prepare(`SELECT 1 FROM app_settings WHERE key = 'migr_bureau_prive_exclusif_v1'`).get());
});

test('la migration ne se rejoue pas : un réglage ultérieur est préservé au redémarrage', () => {
  db.prepare(`UPDATE spaces SET exclusive = 0 WHERE name = 'B bureau'`).run();
  // Second démarrage : nouveau processus important db.js sur la même base.
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import('./src/db.js');`], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, DB_PATH: TMP_DB },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(state()['B bureau'], [0, 0]);
});
