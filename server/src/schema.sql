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
  -- ── Abonnement mensuel récurrent (Stripe Subscriptions) ──────────────────────
  stripe_customer_id     TEXT,                         -- client Stripe (créé à la 1re souscription)
  stripe_subscription_id TEXT,                         -- abonnement Stripe actif (NULL si aucun)
  subscription_tier      TEXT NOT NULL DEFAULT 'NONE', -- 'NONE'|'ESSENTIEL'|'CONFORT'|'PREMIUM'
  subscription_status    TEXT NOT NULL DEFAULT 'none', -- 'none'|'active'|'past_due'|'canceled'
  current_period_start   TEXT,                          -- début de la période de facturation en cours (ISO/UTC)
  current_period_end     TEXT,                          -- fin de la période (ISO/UTC) - synchro Stripe
  -- Jours Open Space consommés sur la période en cours (Essentiel). Réel : une
  -- demi-journée vaut 0,5 j, une journée 1 j. Réinitialisé à chaque renouvellement.
  open_space_quota_used  REAL NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spaces (
  id               INTEGER PRIMARY KEY,
  name             TEXT    NOT NULL,
  kind             TEXT    NOT NULL CHECK (kind IN ('zone', 'room')),
  -- Catégorie métier (refonte modèle éco.) : pilote la tarification et la
  -- réservabilité en ligne. 'OPEN_SPACE' | 'MEETING_ROOM' | 'CONFIDENTIAL' |
  -- 'PRIVATE_OFFICE'. NULL = non catégorisé (non réservable en ligne par défaut).
  -- CONFIDENTIAL (libre-service) et PRIVATE_OFFICE (sur devis) ne sont pas
  -- réservables en ligne.
  category         TEXT,
  capacity         INTEGER NOT NULL CHECK (capacity >= 1),  -- inventaire: nb de places ; exclusif: nb d'occupants max
  exclusive        INTEGER NOT NULL DEFAULT 0,              -- 1 = réservation bloque toute la salle (forfait), sinon inventaire de places
  privatizable     INTEGER NOT NULL DEFAULT 0,             -- 1 = espace inventaire offrant l'option "privatiser" (prendre toute la capacité)
  credits_per_hour INTEGER NOT NULL CHECK (credits_per_hour >= 0),  -- LEGACY (crédits) - conservé, plus utilisé pour le prix
  -- Tarification en EUROS (centimes). price_per_hour_cents : tarif horaire (par
  -- place en inventaire, forfait salle en exclusif). Les forfaits demi-journée /
  -- journée sont facultatifs (NULL = non proposé pour cet espace).
  price_per_hour_cents  INTEGER,
  price_half_day_cents  INTEGER,
  price_day_cents       INTEGER,
  color            TEXT    DEFAULT '#1C3155',
  description      TEXT,                                   -- descriptif public (landing)
  tagline          TEXT,                                   -- phrase d'accroche de la carte (landing) ; NULL = phrase par défaut selon le type
  position         INTEGER NOT NULL DEFAULT 0,             -- ordre d'affichage (landing et admin) ; à égalité, tri par nom
  amenities        TEXT,                                   -- prestations incluses, 1 par ligne
  photo            TEXT,                                   -- nom de fichier dans le dossier des médias
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
  credits_cost INTEGER NOT NULL DEFAULT 0,            -- LEGACY (crédits) - conservé, plus alimenté
  seats        INTEGER NOT NULL DEFAULT 1,             -- places consommées (inventaire) ; 1 pour un espace exclusif
  -- Paiement en EUROS. price_cents = montant dû/payé. tarif_type = heure | demi_journee | journee.
  -- payment_status : 'paid' (payé Stripe), 'free' (résa admin gratuite / paiement hors ligne),
  --   'refunded' (remboursement total confirmé par Stripe via charge.refunded),
  --   'partially_refunded' (remboursement partiel confirmé par Stripe).
  price_cents       INTEGER NOT NULL DEFAULT 0,
  tarif_type        TEXT,
  payment_status    TEXT    NOT NULL DEFAULT 'paid',
  -- Mode de couverture de la réservation (refonte modèle éco.) :
  --   'STRIPE_ONE_OFF'          : payée à l'acte (CB)
  --   'SUBSCRIPTION_QUOTA'      : couverte par le quota Essentiel (décompte quota_days)
  --   'SUBSCRIPTION_UNLIMITED'  : incluse illimitée (Confort/Premium selon espace)
  --   'FREE_ADMIN'              : créée gratuitement par l'admin / paiement hors ligne
  payment_method    TEXT,
  -- Jours de quota Open Space consommés par cette réservation (0 sauf SUBSCRIPTION_QUOTA).
  quota_days        REAL    NOT NULL DEFAULT 0,
  stripe_session_id TEXT,
  payment_intent    TEXT,
  receipt_url       TEXT,                                 -- lien reçu Stripe (hosted) capté au webhook
  refunded_cents    INTEGER NOT NULL DEFAULT 0,           -- montant remboursé confirmé par Stripe
  refunded_at       TEXT,                                 -- horodatage du remboursement (ISO/UTC)
  note         TEXT,                                  -- note libre (admin)
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS idx_res_space_time ON reservations(space_id, start_at, end_at) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_res_user ON reservations(user_id);


-- Jetons de réinitialisation de mot de passe (lien envoyé par email - SMTP à venir).
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
  -- Statut à l'envoi : 'sent' | 'failed' | 'skipped'
  -- Enrichi ensuite par les webhooks de délivrabilité du fournisseur :
  -- 'delivered' | 'bounced' | 'blocked' | 'spam' | 'deferred' | 'unsubscribed'
  status        TEXT    NOT NULL,
  error         TEXT,
  provider      TEXT,                                     -- 'smtp' | 'brevo'
  message_id    TEXT,                                     -- identifiant fournisseur (recollage des webhooks)
  updated_at    TEXT,                                     -- dernier événement de délivrabilité reçu
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at);
-- ⚠️ L'index sur `message_id` est créé dans db.js, APRÈS les migrations : ce
-- fichier est rejoué à chaque démarrage, y compris sur une base antérieure où
-- `CREATE TABLE IF NOT EXISTS` n'ajoute pas la colonne - l'index échouerait ici
-- avec « no such column », et l'application ne démarrerait pas. Tout index
-- portant sur une colonne ajoutée par migration se déclare donc dans db.js.

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
  cost              INTEGER NOT NULL,                 -- montant en EUROS (centimes) pour ce verrou
  tarif_type        TEXT,                             -- heure | demi_journee | journee
  -- Mode de couverture résolu à l'ajout au panier (cf. reservations.payment_method).
  payment_method    TEXT,
  quota_days        REAL    NOT NULL DEFAULT 0,       -- jours de quota engagés par ce verrou
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

-- Réclamations consommateur (art. L612-1 s. C. conso.) : formulaire public de
-- réclamation / demande de remboursement. Trace durable, doublée d'une
-- notification e-mail à la gérante. `user_id` renseigné si l'auteur est connecté.
CREATE TABLE IF NOT EXISTS claims (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id),
  first_name      TEXT    NOT NULL,
  last_name       TEXT    NOT NULL,
  email           TEXT    NOT NULL,
  phone           TEXT,                                 -- téléphone de rappel (requis au formulaire)
  reservation_ref TEXT,                                 -- n° de réservation (facultatif)
  kind            TEXT    NOT NULL,                      -- 'annulation' | 'remboursement' | 'autre'
  message         TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'nouveau',    -- 'nouveau' | 'en_cours' | 'resolu'
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);


-- Commandes de réservation payées en ligne (euros). Une session Checkout Stripe
-- porte un « panier » de créneaux ; à la confirmation du paiement (webhook), les
-- créneaux du `payload` deviennent des réservations. Idempotent via session_id.
CREATE TABLE IF NOT EXISTS reservation_orders (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  session_id     TEXT    NOT NULL UNIQUE,              -- id de la session Checkout Stripe
  payment_intent TEXT,
  promo_id       INTEGER REFERENCES promo_codes(id),  -- code promo appliqué (si saisi au panier)
  total_cents    INTEGER NOT NULL,                     -- montant AVANT remise (somme des créneaux)
  amount_paid_cents INTEGER,                            -- montant RÉELLEMENT encaissé (amount_total Stripe, après remise)
  receipt_url    TEXT,                                 -- lien reçu Stripe (hosted) capté au webhook
  refunded_cents INTEGER NOT NULL DEFAULT 0,           -- montant remboursé confirmé par Stripe (charge.refunded)
  payload        TEXT    NOT NULL,                     -- JSON: [{space_id,start_at,end_at,seats,tarif_type,price_cents}]
  status         TEXT    NOT NULL DEFAULT 'pending',   -- 'pending' | 'paid'
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_reservation_orders_user ON reservation_orders(user_id);

-- Codes promotionnels (miroir local des Coupons + Promotion Codes Stripe). Stripe
-- reste la source de vérité pour l'application de la remise et le comptage des
-- utilisations (times_redeemed) ; cette table sert à lister/gérer côté admin.
CREATE TABLE IF NOT EXISTS promo_codes (
  id                INTEGER PRIMARY KEY,
  code              TEXT    NOT NULL UNIQUE,            -- code public saisi au paiement
  stripe_coupon_id  TEXT    NOT NULL,                   -- Coupon Stripe (règle de remise)
  stripe_promo_id   TEXT    NOT NULL,                   -- Promotion Code Stripe
  reduction_type    TEXT    NOT NULL,                   -- 'percent' | 'amount'
  reduction_value   INTEGER NOT NULL,                   -- % (1-100) ou centimes d'euro
  tarif_restriction TEXT,                               -- 'journee' | 'demi_journee' | 'heure' | NULL (tous)
  max_redemptions   INTEGER,                            -- limite GLOBALE (NULL = illimité)
  max_per_user      INTEGER,                            -- limite PAR PERSONNE (NULL = illimité)
  expires_at        TEXT,                               -- ISO 8601, NULL = sans expiration
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Utilisations d'un code promo, par personne. Renseignée à la confirmation du
-- paiement (webhook) : sert à faire respecter la limite « N fois par personne »,
-- que Stripe ne gère pas nativement pour un code partagé.
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id         INTEGER PRIMARY KEY,
  promo_id   INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  order_id   INTEGER REFERENCES reservation_orders(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_promo_user ON promo_redemptions(promo_id, user_id);
