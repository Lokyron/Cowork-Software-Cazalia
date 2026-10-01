// Ouverture de la base SQLite, application du schéma et migrations idempotentes.
//
// Le fichier de base contient des données sensibles (empreintes de mots de
// passe, secrets 2FA chiffrés, coordonnées des membres) : ses permissions
// doivent rester restrictives sur l'hôte (0600, propriétaire = utilisateur du
// service) — cf. `deploy/cazalia.service` et `deploy/durcissement.md`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { defaultSpaceContent } from './lib/spaceContent.js';
import { DEFAULT_TEMPLATES } from './lib/emailTemplates.js';
import { encryptSecret, isEncrypted } from './lib/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// S'assure que le dossier du fichier DB existe.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);

// WAL : indispensable pour la sérialisation des transactions de réservation (cf. brief §5.2).
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Applique le schéma (idempotent : tout est en CREATE TABLE IF NOT EXISTS).
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migrations idempotentes pour les bases déjà créées (ajouts de colonnes).
const reservationCols = db.prepare(`PRAGMA table_info(reservations)`).all().map((c) => c.name);
if (!reservationCols.includes('note')) {
  db.exec(`ALTER TABLE reservations ADD COLUMN note TEXT`);
}
// Places consommées par la réservation (inventaire). Anciennes résas = 1 place.
if (!reservationCols.includes('seats')) {
  db.exec(`ALTER TABLE reservations ADD COLUMN seats INTEGER NOT NULL DEFAULT 1`);
}
// Voucher Wi-Fi UniFi (UDM Pro) attaché à la réservation.
//   voucher_code       : code affiché au client (ex. "12345-67890")
//   voucher_id         : id du voucher côté UniFi (pour la révocation à l'annulation)
//   voucher_expires_at : fin de validité indicative (ISO/UTC)
if (!reservationCols.includes('voucher_code')) db.exec(`ALTER TABLE reservations ADD COLUMN voucher_code TEXT`);
if (!reservationCols.includes('voucher_id')) db.exec(`ALTER TABLE reservations ADD COLUMN voucher_id TEXT`);
if (!reservationCols.includes('voucher_expires_at')) db.exec(`ALTER TABLE reservations ADD COLUMN voucher_expires_at TEXT`);

const userCols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
for (const col of ['first_name', 'last_name', 'phone']) {
  if (!userCols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
}
if (!userCols.includes('must_change_password')) {
  db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`);
}
if (!userCols.includes('totp_secret')) db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT`);
if (!userCols.includes('totp_enabled')) db.exec(`ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`);
// Facturation / entreprise (page « Mon compte »).
if (!userCols.includes('company_name')) db.exec(`ALTER TABLE users ADD COLUMN company_name TEXT`);
if (!userCols.includes('vat_number')) db.exec(`ALTER TABLE users ADD COLUMN vat_number TEXT`);
if (!userCols.includes('billing_address')) db.exec(`ALTER TABLE users ADD COLUMN billing_address TEXT`);
// Préférences de notification (1 = accepte). Transactionnels toujours envoyés ;
// notify_marketing pilote uniquement les envois manuels/marketing.
if (!userCols.includes('notify_booking')) db.exec(`ALTER TABLE users ADD COLUMN notify_booking INTEGER NOT NULL DEFAULT 1`);
if (!userCols.includes('notify_marketing')) db.exec(`ALTER TABLE users ADD COLUMN notify_marketing INTEGER NOT NULL DEFAULT 1`);

// Migration ponctuelle : chiffrement des secrets TOTP restés en clair.
// Le secret TOTP est un facteur d'authentification à part entière ; stocké en
// clair, il rend la 2FA inopérante dès qu'un tiers lit la base. `decryptSecret`
// tolérant les deux formats, la reprise est transparente pour les membres —
// aucune reconfiguration n'est nécessaire.
// ⚠️ Comme pour le mot de passe SMTP, un changement d'`APP_SECRET` rendra ces
// secrets illisibles : les membres devront alors réactiver leur 2FA.
const totpToSeal = db
  .prepare(`SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL AND totp_secret <> ''`)
  .all()
  .filter((u) => !isEncrypted(u.totp_secret));
if (totpToSeal.length) {
  const sealStmt = db.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`);
  const sealAll = db.transaction((rows) => {
    for (const u of rows) sealStmt.run(encryptSecret(u.totp_secret), u.id);
  });
  sealAll(totpToSeal);
  console.log(`[migration] ${totpToSeal.length} secret(s) TOTP chiffre(s) au repos.`);
}

const txCols = db.prepare(`PRAGMA table_info(credit_transactions)`).all().map((c) => c.name);
if (!txCols.includes('amount_eur_cents')) {
  db.exec(`ALTER TABLE credit_transactions ADD COLUMN amount_eur_cents INTEGER`);
}

const spaceCols = db.prepare(`PRAGMA table_info(spaces)`).all().map((c) => c.name);
if (!spaceCols.includes('description')) db.exec(`ALTER TABLE spaces ADD COLUMN description TEXT`);
if (!spaceCols.includes('amenities')) db.exec(`ALTER TABLE spaces ADD COLUMN amenities TEXT`);

// Typologie de réservation : exclusif (bloque toute la salle, tarif forfait) vs
// inventaire de places (tarif par place) + option de privatisation.
const addingSpaceTypology = !spaceCols.includes('exclusive');
if (!spaceCols.includes('exclusive')) db.exec(`ALTER TABLE spaces ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0`);
if (!spaceCols.includes('privatizable')) db.exec(`ALTER TABLE spaces ADD COLUMN privatizable INTEGER NOT NULL DEFAULT 0`);

// Backfill unique (au 1er ajout des colonnes) pour les salles existantes :
// « Réunion » → exclusive + 8 occupants ; « Focus » → privatisable + 2 postes.
// Guardé pour ne PAS écraser les réglages faits ensuite depuis l'admin.
if (addingSpaceTypology) {
  db.exec(`UPDATE spaces SET exclusive = 1, capacity = CASE WHEN capacity < 8 THEN 8 ELSE capacity END
             WHERE kind = 'room' AND (name LIKE '%éunion%' OR name LIKE '%eunion%')`);
  db.exec(`UPDATE spaces SET privatizable = 1, capacity = CASE WHEN capacity < 2 THEN 2 ELSE capacity END
             WHERE kind = 'room' AND name LIKE '%ocus%'`);
}

// Remplit un contenu descriptif par défaut pour les espaces qui n'en ont pas encore
// (INVENTÉ ; modifiable ensuite depuis l'admin Espaces).
const spacesToFill = db.prepare(`SELECT id, kind FROM spaces WHERE description IS NULL`).all();
if (spacesToFill.length) {
  const upd = db.prepare(`UPDATE spaces SET description = @description, amenities = @amenities WHERE id = @id`);
  const fill = db.transaction((rows) => {
    for (const s of rows) {
      const c = defaultSpaceContent(s.kind);
      upd.run({ id: s.id, description: c.description, amenities: c.amenities });
    }
  });
  fill(spacesToFill);
}

// Amorçage des templates d'e-mails (idempotent : n'écrase pas ceux édités par l'admin).
const insertTemplate = db.prepare(
  `INSERT OR IGNORE INTO email_templates (code, label, subject, body_html) VALUES (@code, @label, @subject, @body_html)`
);
const seedTemplates = db.transaction((rows) => { for (const t of rows) insertTemplate.run(t); });
seedTemplates(DEFAULT_TEMPLATES);

// Migration ponctuelle (garde par flag) : ajoute le bouton « Ajouter à mon agenda »
// aux templates de réservation semés AVANT l'introduction de la variable {{calendar_url}}.
// N'agit pas si le bouton est déjà présent → respecte d'éventuelles éditions admin.
const calFlag = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('migr_calendar_btn_v1');
if (!calFlag) {
  const CAL_BTN = `&nbsp;&nbsp;<a href="{{calendar_url}}" style="display:inline-block;background:#ffffff;color:#1c3155;text-decoration:none;padding:10px 18px;border-radius:9px;font-weight:600;border:1px solid rgba(28,49,85,.25);">📅 Ajouter à mon agenda</a>`;
  const selRows = db.prepare(`SELECT code, body_html FROM email_templates WHERE code IN ('booking_confirmation','booking_modified')`).all();
  const updBody = db.prepare(`UPDATE email_templates SET body_html = ?, updated_at = datetime('now') WHERE code = ?`);
  const setFlag = db.prepare(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('migr_calendar_btn_v1', ?, datetime('now'))`);
  const calTx = db.transaction(() => {
    for (const row of selRows) {
      if (row.body_html.includes('{{calendar_url}}')) continue; // déjà présent
      const i = row.body_html.lastIndexOf('</p>');
      const patched = i >= 0 ? row.body_html.slice(0, i) + CAL_BTN + row.body_html.slice(i) : `${row.body_html}<p>${CAL_BTN}</p>`;
      updBody.run(patched, row.code);
    }
    setFlag.run(JSON.stringify('done'));
  });
  calTx();
}
