PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL,                      -- dérivé : "prénom nom"
  first_name    TEXT,
  last_name     TEXT,
  phone         TEXT,
  password_hash TEXT    NOT NULL,                      -- scrypt: salt:hash (hex)
  role          TEXT    NOT NULL DEFAULT 'member',     -- 'member' | 'admin'
  must_change_password INTEGER NOT NULL DEFAULT 0,     -- 1 => changement forcé à la connexion
  totp_secret   TEXT,                                  -- secret base32 (2FA), null si non configurée
  totp_enabled  INTEGER NOT NULL DEFAULT 0,            -- 1 => 2FA active (OTP exigé au login)
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spaces (
  id               INTEGER PRIMARY KEY,
  name             TEXT    NOT NULL,
  kind             TEXT    NOT NULL CHECK (kind IN ('zone', 'room')),
  capacity         INTEGER NOT NULL CHECK (capacity >= 1),  -- inventaire: nb de places ; exclusif: nb d'occupants max
  exclusive        INTEGER NOT NULL DEFAULT 0,              -- 1 = réservation bloque toute la salle (forfait), sinon inventaire de places
  privatizable     INTEGER NOT NULL DEFAULT 0,             -- 1 = espace inventaire offrant l'option "privatiser" (prendre toute la capacité)
  credits_per_hour INTEGER NOT NULL CHECK (credits_per_hour >= 0),  -- inventaire: prix PAR place/h ; exclusif: forfait salle/h
  color            TEXT    DEFAULT '#1C3155',
  description      TEXT,                                   -- descriptif public (landing)
  amenities        TEXT,                                   -- prestations incluses, 1 par ligne
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reservations (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  space_id     INTEGER NOT NULL REFERENCES spaces(id),
  start_at     TEXT    NOT NULL,                       -- ISO 8601 / UTC
  end_at       TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  credits_cost INTEGER NOT NULL,
  seats        INTEGER NOT NULL DEFAULT 1,             -- places consommées (inventaire) ; 1 pour un espace exclusif
  note         TEXT,                                  -- note libre (admin)
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS idx_res_space_time ON reservations(space_id, start_at, end_at) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_res_user ON reservations(user_id);

-- Portefeuille = GRAND-LIVRE. Le solde = SUM(amount). PAS de colonne "solde".
--   amount > 0 : recharge / remboursement
--   amount < 0 : paiement d'une réservation
CREATE TABLE IF NOT EXISTS credit_transactions (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  amount         INTEGER NOT NULL,
  reason         TEXT    NOT NULL CHECK (reason IN ('topup','booking','refund','adjust')),
  reservation_id INTEGER REFERENCES reservations(id),
  note           TEXT,
  amount_eur_cents INTEGER,                            -- recharge : montant payé en euros (centimes)
  created_by     INTEGER REFERENCES users(id),         -- admin qui crédite, ou le membre
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credit_user ON credit_transactions(user_id);

-- Jetons de réinitialisation de mot de passe (lien envoyé par email — SMTP à venir).
CREATE TABLE IF NOT EXISTS password_resets (
  token      TEXT    PRIMARY KEY,                       -- aléatoire (hex)
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT    NOT NULL,
  used_at    TEXT,                                       -- non NULL => déjà consommé
  created_by INTEGER REFERENCES users(id),               -- admin qui a déclenché, ou NULL
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);

-- Sessions côté serveur (cookie httpOnly référence cet enregistrement).
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,                       -- token aléatoire
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Prospects / pré-inscriptions (page publique de démarchage, hors comptes membres).
-- Collecte de contacts avant l'ouverture (offre "journée découverte").
CREATE TABLE IF NOT EXISTS prospects (
  id          INTEGER PRIMARY KEY,
  first_name  TEXT    NOT NULL,
  last_name   TEXT    NOT NULL,
  email       TEXT    NOT NULL,
  phone       TEXT    NOT NULL,
  activity    TEXT,                                    -- profession / statut (facultatif)
  consent     INTEGER NOT NULL DEFAULT 0,              -- consentement RGPD (recontact)
  status      TEXT    NOT NULL DEFAULT 'nouveau'
                CHECK (status IN ('nouveau','contacte','journee_offerte','converti','pas_interesse')),
  note        TEXT,                                    -- note libre (admin)
  source      TEXT,                                    -- provenance éventuelle (?src=...)
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prospects_created ON prospects(created_at);
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);

-- Réglages applicatifs (clé/valeur JSON) : config SMTP (mot de passe chiffré),
-- consignes d'arrivée / plan d'accès, etc. Édités depuis l'admin.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,                          -- JSON encodé
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Templates d'e-mails (sujet + corps HTML), interpolation {{variable}}.
CREATE TABLE IF NOT EXISTS email_templates (
  code       TEXT    PRIMARY KEY,                        -- ex. 'booking_confirmation'
  label      TEXT    NOT NULL,                            -- libellé admin
  subject    TEXT    NOT NULL,
  body_html  TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Journal des envois (audit).
CREATE TABLE IF NOT EXISTS email_log (
  id            INTEGER PRIMARY KEY,
  to_email      TEXT    NOT NULL,
  to_user_id    INTEGER REFERENCES users(id),
  template_code TEXT,
  subject       TEXT,
  status        TEXT    NOT NULL,                         -- 'sent' | 'failed' | 'skipped'
  error         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at);

-- Panier de réservation : verrous temporaires (10 min) posés en attendant le paiement.
--   user_id    = bénéficiaire de la réservation (client)
--   created_by = auteur du panier (le client lui-même, ou un admin)
--   expires_at = échéance du verrou (ISO/UTC) ; au-delà, le hold est ignoré/purgé
-- Les droits admin (bypass) sont mémorisés par ligne pour le checkout.
CREATE TABLE IF NOT EXISTS reservation_holds (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  space_id          INTEGER NOT NULL REFERENCES spaces(id),
  start_at          TEXT    NOT NULL,
  end_at            TEXT    NOT NULL,
  seats             INTEGER NOT NULL DEFAULT 1,
  cost              INTEGER NOT NULL,
  ignore_hours      INTEGER NOT NULL DEFAULT 0,
  allow_overbooking INTEGER NOT NULL DEFAULT 0,
  created_by        INTEGER REFERENCES users(id),
  expires_at        TEXT    NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS idx_holds_space_time ON reservation_holds(space_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_holds_user ON reservation_holds(user_id);
CREATE INDEX IF NOT EXISTS idx_holds_expires ON reservation_holds(expires_at);
