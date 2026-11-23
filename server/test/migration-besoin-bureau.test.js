// Migration des colonnes « besoin bureau privatif » sur une base ANTÉRIEURE
// (table `prospects` sans `subject` ni `office_*`), avec un prospect déjà présent.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-migr-besoin-'));
const TMP_DB = path.join(TMP_DIR, 'ancienne.db');

{
  const old = new Database(TMP_DB);
  old.exec(`
    CREATE TABLE prospects (
      id INTEGER PRIMARY KEY,
      first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      email TEXT NOT NULL, phone TEXT NOT NULL, activity TEXT,
      consent INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'nouveau'
        CHECK (status IN ('nouveau','contacte','journee_offerte','converti','pas_interesse')),
      note TEXT, source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  old.prepare(`INSERT INTO prospects (first_name, last_name, email, phone, consent) VALUES ('Ancien', 'Prospect', 'ancien@exemple.test', '0612345678', 1)`).run();
  old.close();
}

process.env.DB_PATH = TMP_DB;
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

// L'import lui-même est le test : db.js applique le schéma puis les migrations.
const { db } = await import('../src/db.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

test('les colonnes du besoin sont ajoutées à une base antérieure', () => {
  const cols = db.prepare(`PRAGMA table_info(prospects)`).all().map((c) => c.name);
  for (const col of ['subject', 'office_seats', 'office_duration', 'office_start']) {
    assert.ok(cols.includes(col), `colonne ${col} manquante après migration`);
  }
});

test('les prospects antérieurs survivent, besoin à NULL', () => {
  const r = db.prepare(`SELECT first_name, subject, office_seats, office_duration, office_start FROM prospects`).get();
  assert.equal(r.first_name, 'Ancien');
  assert.equal(r.subject, null);
  assert.equal(r.office_seats, null);
  assert.equal(r.office_duration, null);
  assert.equal(r.office_start, null);
});

// Idempotence : on rejoue le VRAI db.js dans un processus fils sur la même base.
// Rejouer la migration à la main dans le test ne prouverait rien — il resterait
// vert même si la garde `PRAGMA table_info` disparaissait de db.js.
test('un second démarrage réel de db.js ne rejoue pas les migrations', () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/db.js')"], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DB_PATH: TMP_DB },
      stdio: 'pipe',
    });
  });
  // Les colonnes sont toujours là, en un seul exemplaire, et le prospect antérieur n'a pas bougé.
  const cols = db.prepare(`PRAGMA table_info(prospects)`).all().map((c) => c.name);
  for (const name of ['subject', 'office_seats', 'office_duration', 'office_start']) {
    assert.equal(cols.filter((c) => c === name).length, 1, name);
  }
  const r = db.prepare(`SELECT office_seats, office_duration, office_start FROM prospects WHERE id = 1`).get();
  assert.deepEqual(r, { office_seats: null, office_duration: null, office_start: null });
});
