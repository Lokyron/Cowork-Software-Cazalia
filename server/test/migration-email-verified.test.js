// Migration de la vérification d'adresse e-mail.
//
// Décision du propriétaire : les comptes EXISTANTS au moment de la migration sont
// marqués vérifiés (aucun client actuel n'est bloqué du jour au lendemain) ; un
// compte créé APRÈS part à 0. Le backfill est gardé par l'ajout de la colonne :
// il ne se rejoue pas au démarrage suivant.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-emailverif-migr-'));
const TMP_DB = path.join(TMP_DIR, 'ancienne.db');

// Base « d'avant » : table `users` sans `email_verified`, avec deux comptes.
{
  const old = new Database(TMP_DB);
  old.exec(`
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY,
      email         TEXT    NOT NULL UNIQUE,
      display_name  TEXT    NOT NULL,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'member',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const ins = old.prepare(`INSERT INTO users (email, display_name, password_hash, role) VALUES (?, ?, 'x', ?)`);
  ins.run('ancien1@exemple.test', 'Ancien Un', 'member');
  ins.run('ancien2@exemple.test', 'Ancien Deux', 'admin');
  old.close();
}

process.env.DB_PATH = TMP_DB;
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const { db } = await import('../src/db.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

test('la colonne email_verified et la table des jetons existent après migration', () => {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  assert.ok(cols.includes('email_verified'));
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((t) => t.name);
  assert.ok(tables.includes('email_verifications'));
});

test('les comptes existants sont marqués vérifiés par la migration', () => {
  const rows = db.prepare(`SELECT email_verified FROM users`).all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.email_verified === 1));
});

test('un compte créé après la migration part à 0', () => {
  db.prepare(`INSERT INTO users (email, display_name, password_hash) VALUES ('nouveau@exemple.test', 'Nouveau', 'x')`).run();
  assert.equal(db.prepare(`SELECT email_verified FROM users WHERE email = 'nouveau@exemple.test'`).get().email_verified, 0);
});

test('le backfill ne se rejoue pas : le nouveau compte reste non vérifié après un vrai redémarrage', () => {
  // Second démarrage réel de db.js (processus fils, même fichier de base).
  execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/db.js')"], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DB_PATH: TMP_DB },
    stdio: 'pipe',
  });
  assert.equal(db.prepare(`SELECT email_verified FROM users WHERE email = 'nouveau@exemple.test'`).get().email_verified, 0);
  assert.equal(db.prepare(`SELECT email_verified FROM users WHERE email = 'ancien1@exemple.test'`).get().email_verified, 1);
});
