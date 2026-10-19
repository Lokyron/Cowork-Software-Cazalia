// Test de non-régression MIGRATION : l'application doit démarrer sur une base
// ANTÉRIEURE, pas seulement sur une base neuve.
//
// Incident du 2026-10-19 : `schema.sql` déclarait un index sur `email_log(message_id)`.
// Ce fichier étant rejoué à chaque démarrage, et `CREATE TABLE IF NOT EXISTS`
// n'ajoutant aucune colonne à une table existante, l'index échouait en
// « no such column: message_id » sur la base de production — l'API ne démarrait
// pas et la mise à jour in-app repartait en arrière. Les colonnes manquantes sont
// ajoutées par les migrations de `db.js`, qui s'exécutent APRÈS le schéma : tout
// index portant sur une colonne migrée doit donc être créé là, pas dans le schéma.
//
// Ce test fabrique une base au format d'AVANT, puis importe `db.js` : il échoue
// si une déclaration du schéma suppose une colonne encore absente.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-migr-'));
const TMP_DB = path.join(TMP_DIR, 'ancienne.db');

// Base « d'avant » : `email_log` sans provider / message_id / updated_at, avec
// une ligne déjà présente pour vérifier qu'une migration ne détruit rien.
{
  const old = new Database(TMP_DB);
  old.exec(`
    CREATE TABLE email_log (
      id            INTEGER PRIMARY KEY,
      to_email      TEXT    NOT NULL,
      to_user_id    INTEGER,
      template_code TEXT,
      subject       TEXT,
      status        TEXT    NOT NULL,
      error         TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_email_log_created ON email_log(created_at);
  `);
  old.prepare(`INSERT INTO email_log (to_email, status, subject) VALUES (?, 'sent', ?)`)
    .run('historique@exemple.test', 'Message anterieur');
  old.close();
}

process.env.DB_PATH = TMP_DB;
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

// L'import lui-même est le test : db.js applique le schéma puis les migrations.
const { db } = await import('../src/db.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

test('les colonnes du journal sont ajoutées à une base antérieure', () => {
  const cols = db.prepare(`PRAGMA table_info(email_log)`).all().map((c) => c.name);
  for (const col of ['provider', 'message_id', 'updated_at']) {
    assert.ok(cols.includes(col), `colonne ${col} manquante après migration`);
  }
});

test("l'index de recollage des webhooks est créé après la migration", () => {
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'email_log'`)
    .all().map((i) => i.name);
  assert.ok(idx.includes('idx_email_log_message'));
});

test('les lignes déjà journalisées survivent à la migration', () => {
  const row = db.prepare(`SELECT to_email, status, subject, provider FROM email_log`).get();
  assert.equal(row.to_email, 'historique@exemple.test');
  assert.equal(row.subject, 'Message anterieur');
  assert.equal(row.provider, null); // fournisseur inconnu pour l'historique
});

test('un second démarrage ne rejoue pas les migrations (idempotence)', () => {
  // `db.js` est déjà chargé ; on rejoue le schéma comme le fait un redémarrage.
  const schema = fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');
  assert.doesNotThrow(() => db.exec(schema));
});
