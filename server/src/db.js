// Ouverture de la base SQLite, application du schéma et migrations idempotentes.
//
// Le fichier de base contient des données sensibles (empreintes de mots de
// passe, secrets 2FA chiffrés, coordonnées des membres) : ses permissions
// doivent rester restrictives sur l'hôte (0600, propriétaire = utilisateur du
// service) - cf. `deploy/cazalia.service` et `deploy/durcissement.md`.

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
// Acceptation des CGU à l'inscription : horodatage de preuve (RGPD / consentement
// documenté). NULL pour les comptes créés avant la mise en place de l'opt-in.
if (!userCols.includes('cgu_accepted_at')) db.exec(`ALTER TABLE users ADD COLUMN cgu_accepted_at TEXT`);
// Statut/profession facultatif, renseigné à l'inscription (page /rejoindre).
if (!userCols.includes('activity')) db.exec(`ALTER TABLE users ADD COLUMN activity TEXT`);

// Migration ponctuelle : chiffrement des secrets TOTP restés en clair.
// Le secret TOTP est un facteur d'authentification à part entière ; stocké en
// clair, il rend la 2FA inopérante dès qu'un tiers lit la base. `decryptSecret`
// tolérant les deux formats, la reprise est transparente pour les membres -
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

// ── Retrait complet du système de crédits ────────────────────────────────────
// Le portefeuille de crédits n'existe plus (paiement en euros à la réservation).
// On supprime les tables dédiées si elles subsistent (bases antérieures). Les
// colonnes héritées `spaces.credits_per_hour` / `reservations.credits_cost`
// restent inertes (valeur par défaut 0) pour ne pas réécrire ces tables.
db.exec(`DROP TABLE IF EXISTS credit_purchases`);
db.exec(`DROP TABLE IF EXISTS credit_transactions`);

// ── Passage aux EUROS + paiement à la réservation (abandon des crédits) ───────
// Prix en centimes sur les espaces ; champs de paiement sur les réservations et
// type de tarif sur les verrous de panier. Colonnes ajoutées pour les bases déjà
// créées (CREATE TABLE les porte déjà pour les bases neuves).
const spacePriceCols = db.prepare(`PRAGMA table_info(spaces)`).all().map((c) => c.name);
if (!spacePriceCols.includes('price_per_hour_cents')) db.exec(`ALTER TABLE spaces ADD COLUMN price_per_hour_cents INTEGER`);
if (!spacePriceCols.includes('price_half_day_cents')) db.exec(`ALTER TABLE spaces ADD COLUMN price_half_day_cents INTEGER`);
if (!spacePriceCols.includes('price_day_cents')) db.exec(`ALTER TABLE spaces ADD COLUMN price_day_cents INTEGER`);
// Backfill du tarif horaire depuis l'ancien crédit (1 crédit ≈ 1 €) là où absent.
// Les forfaits demi-journée / journée restent NULL : à renseigner dans l'admin Espaces.
db.exec(`UPDATE spaces SET price_per_hour_cents = credits_per_hour * 100 WHERE price_per_hour_cents IS NULL`);

const resPayCols = db.prepare(`PRAGMA table_info(reservations)`).all().map((c) => c.name);
if (!resPayCols.includes('price_cents')) db.exec(`ALTER TABLE reservations ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0`);
if (!resPayCols.includes('tarif_type')) db.exec(`ALTER TABLE reservations ADD COLUMN tarif_type TEXT`);
if (!resPayCols.includes('payment_status')) db.exec(`ALTER TABLE reservations ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'paid'`);
// Montant réellement encaissé : un code promo partiel fait que le prix affiché
// n'est pas ce que Stripe a prélevé. NULL sur l'existant (repli sur price_cents).
if (!resPayCols.includes('paid_cents')) db.exec(`ALTER TABLE reservations ADD COLUMN paid_cents INTEGER`);
if (!resPayCols.includes('stripe_session_id')) db.exec(`ALTER TABLE reservations ADD COLUMN stripe_session_id TEXT`);
if (!resPayCols.includes('payment_intent')) db.exec(`ALTER TABLE reservations ADD COLUMN payment_intent TEXT`);

const holdTarifCols = db.prepare(`PRAGMA table_info(reservation_holds)`).all().map((c) => c.name);
if (!holdTarifCols.includes('tarif_type')) db.exec(`ALTER TABLE reservation_holds ADD COLUMN tarif_type TEXT`);

// ── Traçabilité paiement / remboursement Stripe (audit data flow) ─────────────
// Reçu Stripe capté au webhook + suivi des remboursements confirmés par Stripe
// (event charge.refunded). Sans ces colonnes, un remboursement effectué dans
// Stripe ne laissait AUCUNE trace en base et l'espace client ne pouvait ni
// afficher un justificatif ni le statut « remboursée ».
const resTraceCols = db.prepare(`PRAGMA table_info(reservations)`).all().map((c) => c.name);
if (!resTraceCols.includes('receipt_url')) db.exec(`ALTER TABLE reservations ADD COLUMN receipt_url TEXT`);
if (!resTraceCols.includes('refunded_cents')) db.exec(`ALTER TABLE reservations ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0`);
if (!resTraceCols.includes('refunded_at')) db.exec(`ALTER TABLE reservations ADD COLUMN refunded_at TEXT`);

const orderTraceCols = db.prepare(`PRAGMA table_info(reservation_orders)`).all().map((c) => c.name);
if (orderTraceCols.length && !orderTraceCols.includes('amount_paid_cents')) db.exec(`ALTER TABLE reservation_orders ADD COLUMN amount_paid_cents INTEGER`);
if (orderTraceCols.length && !orderTraceCols.includes('receipt_url')) db.exec(`ALTER TABLE reservation_orders ADD COLUMN receipt_url TEXT`);
if (orderTraceCols.length && !orderTraceCols.includes('refunded_cents')) db.exec(`ALTER TABLE reservation_orders ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0`);

// UniFi Access : PIN de porte temporaire par réservation (cf. lib/unifiAccess.js).
const accessCols = db.prepare(`PRAGMA table_info(reservations)`).all().map((c) => c.name);
if (!accessCols.includes('access_pin')) db.exec(`ALTER TABLE reservations ADD COLUMN access_pin TEXT`);
if (!accessCols.includes('access_visitor_id')) db.exec(`ALTER TABLE reservations ADD COLUMN access_visitor_id TEXT`);
if (!accessCols.includes('access_expires_at')) db.exec(`ALTER TABLE reservations ADD COLUMN access_expires_at TEXT`);

// Gabarit e-mail de confirmation : « Crédits » → « Montant » + variable euros.
const eurosTmpl = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('migr_euros_tmpl_v1');
if (!eurosTmpl) {
  const row = db.prepare(`SELECT body_html FROM email_templates WHERE code = 'booking_confirmation'`).get();
  if (row && row.body_html.includes('{{credits_cost}}')) {
    const patched = row.body_html.replace('>Crédits<', '>Montant<').replace('{{credits_cost}}', '{{price}}');
    db.prepare(`UPDATE email_templates SET body_html = ?, updated_at = datetime('now') WHERE code = 'booking_confirmation'`).run(patched);
  }
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('migr_euros_tmpl_v1', ?, datetime('now'))`).run(JSON.stringify('done'));
}

// Gabarit de confirmation : insère le bloc PIN de porte + la ligne café/thé
// (devant le bloc Wi-Fi) pour les bases dont le template a été semé avant Access.
const accessTmpl = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('migr_access_block_v1');
if (!accessTmpl) {
  const row = db.prepare(`SELECT body_html FROM email_templates WHERE code = 'booking_confirmation'`).get();
  if (row && row.body_html.includes('{{wifi_block}}') && !row.body_html.includes('{{access_block}}')) {
    const insert = `<p style="margin:0 0 16px;line-height:1.6;color:#5b6577;">☕ Café &amp; thé inclus dans votre réservation.</p>\n{{access_block}}\n{{wifi_block}}`;
    const patched = row.body_html.replace('{{wifi_block}}', insert);
    db.prepare(`UPDATE email_templates SET body_html = ?, updated_at = datetime('now') WHERE code = 'booking_confirmation'`).run(patched);
  }
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('migr_access_block_v1', ?, datetime('now'))`).run(JSON.stringify('done'));
}

// E-mails « modification » et « annulation » : ajoute le bloc PIN de porte au
// mail de modification, et la mention de désactivation des codes à l'annulation.
const resaMailsV2 = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('migr_resa_mails_v2');
if (!resaMailsV2) {
  const BTN_MARK = '<p style="margin:18px 0 0;">';
  const upd = db.prepare(`UPDATE email_templates SET body_html = ?, updated_at = datetime('now') WHERE code = ?`);
  const mod = db.prepare(`SELECT body_html FROM email_templates WHERE code = 'booking_modified'`).get();
  if (mod && !mod.body_html.includes('{{access_block}}') && mod.body_html.includes(BTN_MARK)) {
    upd.run(mod.body_html.replace(BTN_MARK, `{{access_block}}\n{{wifi_block}}\n${BTN_MARK}`), 'booking_modified');
  }
  const can = db.prepare(`SELECT body_html FROM email_templates WHERE code = 'booking_cancelled'`).get();
  if (can && !can.body_html.includes('désactivés') && can.body_html.includes(BTN_MARK)) {
    const note = `<p style="margin:0 0 16px;line-height:1.6;color:#5b6577;">🔒 Votre code d'accès à la porte et votre code Wi-Fi pour ce créneau ont été désactivés.</p>\n${BTN_MARK}`;
    upd.run(can.body_html.replace(BTN_MARK, note), 'booking_cancelled');
  }
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('migr_resa_mails_v2', ?, datetime('now'))`).run(JSON.stringify('done'));
}

// « Café & thé inclus » ajouté aux prestations des espaces qui ne le mentionnent pas.
const cafeFlag = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('migr_cafe_the_v1');
if (!cafeFlag) {
  const rows = db.prepare(`SELECT id, amenities FROM spaces`).all();
  const updAmen = db.prepare(`UPDATE spaces SET amenities = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const s of rows) {
      const a = s.amenities || '';
      if (!/caf[eé].{0,6}th[eé]|th[eé].{0,6}caf[eé]/i.test(a)) {
        updAmen.run((a ? a + '\n' : '') + 'Café & thé inclus', s.id);
      }
    }
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('migr_cafe_the_v1', ?, datetime('now'))`).run(JSON.stringify('done'));
  });
  tx();
}

// Journal des e-mails : traçabilité du fournisseur et recollage des événements
// de délivrabilité reçus par webhook (cf. routes/webhooks.js).
const emailLogCols = db.prepare(`PRAGMA table_info(email_log)`).all().map((c) => c.name);
if (!emailLogCols.includes('provider')) db.exec(`ALTER TABLE email_log ADD COLUMN provider TEXT`);
if (!emailLogCols.includes('message_id')) db.exec(`ALTER TABLE email_log ADD COLUMN message_id TEXT`);
if (!emailLogCols.includes('updated_at')) db.exec(`ALTER TABLE email_log ADD COLUMN updated_at TEXT`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_email_log_message ON email_log(message_id)`);

// Codes promo : colonne « limite par personne » (ajoutée après la 1re version du
// système) et rattachement d'un code à une commande de réservation. `promo_codes`
// et `promo_redemptions` sont créées par le schéma (CREATE TABLE IF NOT EXISTS).
const promoCols = db.prepare(`PRAGMA table_info(promo_codes)`).all().map((c) => c.name);
if (promoCols.length && !promoCols.includes('max_per_user')) {
  db.exec(`ALTER TABLE promo_codes ADD COLUMN max_per_user INTEGER`);
}
const orderCols = db.prepare(`PRAGMA table_info(reservation_orders)`).all().map((c) => c.name);
if (orderCols.length && !orderCols.includes('promo_id')) {
  db.exec(`ALTER TABLE reservation_orders ADD COLUMN promo_id INTEGER`);
}

const spaceCols = db.prepare(`PRAGMA table_info(spaces)`).all().map((c) => c.name);
if (!spaceCols.includes('description')) db.exec(`ALTER TABLE spaces ADD COLUMN description TEXT`);
if (!spaceCols.includes('amenities')) db.exec(`ALTER TABLE spaces ADD COLUMN amenities TEXT`);
// Photo de l'espace : nom de fichier dans le dossier des médias (cf. lib/media.js).
if (!spaceCols.includes('photo')) db.exec(`ALTER TABLE spaces ADD COLUMN photo TEXT`);

// Phrase d'accroche de la carte sur la landing (éditable depuis l'admin).
// NULL = on garde la phrase par défaut calculée côté front selon le type.
if (!spaceCols.includes('tagline')) db.exec(`ALTER TABLE spaces ADD COLUMN tagline TEXT`);

// Ordre d'affichage choisi dans l'admin. Au premier ajout de la colonne, on
// recopie l'ordre actuel (kind, name) : l'affichage ne bouge pas tant que
// personne n'a rien réglé.
const addingSpacePosition = !spaceCols.includes('position');
if (addingSpacePosition) {
  db.exec(`ALTER TABLE spaces ADD COLUMN position INTEGER NOT NULL DEFAULT 0`);
  db.exec(`UPDATE spaces SET position = (
             SELECT COUNT(*) FROM spaces s2
              WHERE s2.kind < spaces.kind
                 OR (s2.kind = spaces.kind AND s2.name < spaces.name))`);
}

// ── Refonte modèle éco. : abonnements + catégories d'espaces + quota ──────────
// Catégorie métier de l'espace (pilote tarification + réservabilité en ligne).
const addingSpaceCategory = !spaceCols.includes('category');
if (addingSpaceCategory) db.exec(`ALTER TABLE spaces ADD COLUMN category TEXT`);

// Abonnement sur les comptes membres (Stripe Subscriptions + quota Open Space).
const subUserCols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
if (!subUserCols.includes('stripe_customer_id')) db.exec(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`);
if (!subUserCols.includes('stripe_subscription_id')) db.exec(`ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT`);
if (!subUserCols.includes('subscription_tier')) db.exec(`ALTER TABLE users ADD COLUMN subscription_tier TEXT NOT NULL DEFAULT 'NONE'`);
if (!subUserCols.includes('subscription_status')) db.exec(`ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'none'`);
if (!subUserCols.includes('current_period_start')) db.exec(`ALTER TABLE users ADD COLUMN current_period_start TEXT`);
if (!subUserCols.includes('current_period_end')) db.exec(`ALTER TABLE users ADD COLUMN current_period_end TEXT`);
if (!subUserCols.includes('open_space_quota_used')) db.exec(`ALTER TABLE users ADD COLUMN open_space_quota_used REAL NOT NULL DEFAULT 0`);
// Résiliation programmée en fin de période (miroir de `cancel_at_period_end`
// chez Stripe, tenu à jour par le webhook customer.subscription.updated).
if (!subUserCols.includes('subscription_cancel_at_period_end')) db.exec(`ALTER TABLE users ADD COLUMN subscription_cancel_at_period_end INTEGER NOT NULL DEFAULT 0`);

// Mode de couverture + jours de quota sur réservations et verrous de panier.
const covResCols = db.prepare(`PRAGMA table_info(reservations)`).all().map((c) => c.name);
if (!covResCols.includes('payment_method')) db.exec(`ALTER TABLE reservations ADD COLUMN payment_method TEXT`);
if (!covResCols.includes('quota_days')) db.exec(`ALTER TABLE reservations ADD COLUMN quota_days REAL NOT NULL DEFAULT 0`);
const covHoldCols = db.prepare(`PRAGMA table_info(reservation_holds)`).all().map((c) => c.name);
if (!covHoldCols.includes('payment_method')) db.exec(`ALTER TABLE reservation_holds ADD COLUMN payment_method TEXT`);
if (!covHoldCols.includes('quota_days')) db.exec(`ALTER TABLE reservation_holds ADD COLUMN quota_days REAL NOT NULL DEFAULT 0`);

// Téléphone de rappel sur les réclamations (formulaire conso.).
const claimCols = db.prepare(`PRAGMA table_info(claims)`).all().map((c) => c.name);
if (claimCols.length && !claimCols.includes('phone')) db.exec(`ALTER TABLE claims ADD COLUMN phone TEXT`);

// Backfill UNIQUE de la catégorie au 1er ajout (n'écrase pas un réglage admin
// ultérieur). Heuristique par nom ; corrigeable ensuite dans l'admin Espaces.
if (addingSpaceCategory) {
  db.exec(`UPDATE spaces SET category = 'MEETING_ROOM'
             WHERE category IS NULL AND (name LIKE '%éunion%' OR name LIKE '%eunion%')`);
  db.exec(`UPDATE spaces SET category = 'CONFIDENTIAL'
             WHERE category IS NULL AND (name LIKE '%ocus%' OR name LIKE '%onfiden%')`);
  db.exec(`UPDATE spaces SET category = 'PRIVATE_OFFICE'
             WHERE category IS NULL AND (name LIKE '%riv%')`);
  db.exec(`UPDATE spaces SET category = 'OPEN_SPACE'
             WHERE category IS NULL AND (kind = 'zone' OR name LIKE '%pen%space%' OR name LIKE '%pen-space%')`);
}

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

// SSID Wi-Fi : l'ancien réseau « CAZALIA-BOUTONNET » devient « Cazalia-Coworkers ».
// On ne corrige QUE la valeur restée à l'ancien défaut ; un SSID personnalisé
// depuis l'admin est préservé.
const wifiSsidFlag = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('migr_wifi_ssid_coworkers_v1');
if (!wifiSsidFlag) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'arrival'`).get();
  if (row) {
    let arrival = null;
    try { arrival = JSON.parse(row.value); } catch { arrival = null; }
    if (arrival && typeof arrival === 'object'
        && (arrival.wifi_ssid == null || /^cazalia-boutonnet$/i.test(String(arrival.wifi_ssid).trim()))) {
      arrival.wifi_ssid = 'Cazalia-Coworkers';
      db.prepare(`UPDATE app_settings SET value = ?, updated_at = datetime('now') WHERE key = 'arrival'`).run(JSON.stringify(arrival));
    }
  }
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('migr_wifi_ssid_coworkers_v1', ?, datetime('now'))`).run(JSON.stringify('done'));
}

// Déplacement de réservation : nouveau gabarit mettant en évidence l'ancien vs le
// nouveau créneau (variables {{previous_date}}/{{previous_time}}). Remplace le
// gabarit tant qu'il n'a pas été mis à niveau (absence de {{previous_date}}).
const moveSlotsFlag = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('migr_resa_move_slots_v1');
if (!moveSlotsFlag) {
  const def = DEFAULT_TEMPLATES.find((t) => t.code === 'booking_modified');
  const cur = db.prepare(`SELECT body_html FROM email_templates WHERE code = 'booking_modified'`).get();
  if (def && cur && !cur.body_html.includes('{{previous_date}}')) {
    db.prepare(`UPDATE email_templates SET label = ?, subject = ?, body_html = ?, updated_at = datetime('now') WHERE code = 'booking_modified'`)
      .run(def.label, def.subject, def.body_html);
  }
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('migr_resa_move_slots_v1', ?, datetime('now'))`).run(JSON.stringify('done'));
}

// Boutons « Voir ma réservation » / « Ajouter à mon agenda » : empilés (une ligne
// chacun) au lieu d'être collés. On cible le séparateur « &nbsp;&nbsp; » placé
// devant le bouton agenda, présent aussi bien dans le gabarit semé que dans celui
// corrigé par migr_calendar_btn_v1. Idempotent (garde + séparateur absent après coup).
const ctaStackFlag = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('migr_cta_stack_v1');
if (!ctaStackFlag) {
  const rows = db.prepare(`SELECT code, body_html FROM email_templates WHERE code IN ('booking_confirmation','booking_modified')`).all();
  const upd = db.prepare(`UPDATE email_templates SET body_html = ?, updated_at = datetime('now') WHERE code = ?`);
  const ctaTx = db.transaction(() => {
    for (const row of rows) {
      if (!row.body_html.includes('&nbsp;&nbsp;<a href="{{calendar_url}}"')) continue;
      const patched = row.body_html.replace('</a>&nbsp;&nbsp;<a href="{{calendar_url}}"', '</a><br><br><a href="{{calendar_url}}"');
      upd.run(patched, row.code);
    }
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('migr_cta_stack_v1', ?, datetime('now'))`).run(JSON.stringify('done'));
  });
  ctaTx();
}
