import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT) || 3001,
  // Interface d'écoute. Par défaut 127.0.0.1 : l'API n'est joignable QUE par le
  // reverse proxy nginx local. L'exposer sur 0.0.0.0 permettrait de contacter
  // l'API en contournant nginx et, `trust proxy` étant actif, de forger
  // `X-Forwarded-For` - donc de contourner toute la limitation de débit.
  host: process.env.HOST || '127.0.0.1',
  // Nombre de proxys de confiance devant l'API (nginx local = 1). Mettre 0 si
  // l'API est exposée directement : `req.ip` cesse alors d'être falsifiable.
  trustProxy: process.env.TRUST_PROXY != null ? Number(process.env.TRUST_PROXY) : 1,
  // Taille maximale d'un corps de requête JSON (anti-DoS mémoire).
  jsonBodyLimit: process.env.JSON_BODY_LIMIT || '100kb',
  // Hôtes autorisés à émettre des requêtes mutantes (garde anti-CSRF). L'hôte de
  // la requête courante est toujours accepté ; cette liste sert aux alias.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
  // Fichier SQLite. En prod (LXC) : /var/lib/cazalia/data.db par exemple.
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cowork.db'),
  // Dossier des photos de la galerie (carrousel de la landing). Persistant, hors
  // du build `dist` : déposer des images dedans les fait apparaître automatiquement.
  // En prod (LXC) : /opt/cazalia/web/gallery.
  galleryDir: process.env.GALLERY_DIR || path.join(__dirname, '..', '..', 'web', 'gallery'),
  // Mise à jour in-app (voir server/src/update.js et deploy/cowork-update.*).
  // L'app ne fait QUE déposer un fichier de requête dans le dossier de données ;
  // l'updater tourne en root, hors de l'application. On ne transmet jamais un nom
  // de branche, seulement un nom de canal (stable/beta) → l'app ne peut pas
  // pointer l'updater vers une ref arbitraire. Le mapping canal→branche vit dans
  // l'environnement du service root.
  update: {
    enabled: process.env.UPDATE_ENABLED === '1' || process.env.UPDATE_ENABLED === 'true',
    repo: process.env.UPDATE_REPO || 'Lokyron/Cowork-Software-Cazalia',
    branch: process.env.UPDATE_BRANCH || 'main',
    betaBranch: process.env.UPDATE_BETA_BRANCH === undefined ? 'beta' : process.env.UPDATE_BETA_BRANCH,
    checkHours: Number(process.env.UPDATE_CHECK_HOURS) || 24,
  },
  // ── Grille tarifaire (refonte modèle éco.) ──────────────────────────────────
  // Source de vérité UNIQUE des prix Open Space / Salle de réunion (en centimes
  // d'euro). Les prix par espace en base ne servent plus pour ces deux catégories :
  // le moteur lib/pricing.js calcule le prix effectif selon la catégorie de
  // l'espace et l'abonnement de l'utilisateur. Open Space : demi-journée / journée
  // uniquement (pas d'horaire). Salle de réunion : heure / demi-journée / journée.
  pricing: {
    OPEN_SPACE: { demi_journee: 1200, journee: 2000 },
    MEETING_ROOM: { heure: 2000, demi_journee: 3500, journee: 5000 },
    // Remise Salle de réunion pour l'abonnement Confort (−50 %).
    CONFORT_MEETING_DISCOUNT: 0.5,
    // Prix mensuels des abonnements (affichage ; le montant réel vient des Prices
    // Stripe configurés dans l'admin). En centimes.
    SUBSCRIPTIONS: { ESSENTIEL: 16000, CONFORT: 22000, PREMIUM: 30000 },
    // Quota mensuel de jours Open Space inclus dans l'abonnement Essentiel.
    ESSENTIEL_QUOTA_DAYS: 12,
  },
  // Durée de vie d'une session serveur.
  sessionTtlMs: 1000 * 60 * 60 * 24 * 14, // 14 jours
  // Fenêtre de remboursement total à l'annulation (cf. brief §5.3).
  refundWindowHours: Number(process.env.REFUND_WINDOW_HOURS) || 24,
  // Horaires d'ouverture (heure de Paris), par jour de semaine (0=dimanche … 6=samedi).
  // Chaque plage = [début, fin] en minutes depuis minuit. Appliqués aux clients ;
  // l'administrateur peut forcer une réservation hors de ces horaires.
  openingHours: {
    0: [],              // dimanche : fermé
    1: [[510, 1170]],   // lundi    : 8h30 - 19h30
    2: [[510, 1170]],   // mardi
    3: [[510, 1170]],   // mercredi
    4: [[510, 1170]],   // jeudi
    5: [[510, 1170]],   // vendredi
    6: [[540, 780]],    // samedi   : 9h00 - 13h00
  },
  // Créneaux FORFAITAIRES (heure de Paris, minutes depuis minuit), par jour de
  // semaine. Un créneau réservé « au forfait » doit correspondre EXACTEMENT à
  // l'une de ces fenêtres. En semaine : matin 8h30-14h, après-midi 14h-19h30,
  // journée 8h30-19h30. Samedi : une seule demi-journée 9h-13h (pas de journée).
  forfaitSlots: {
    0: { demi_journee: [], journee: [] },
    1: { demi_journee: [[510, 840], [840, 1170]], journee: [[510, 1170]] },
    2: { demi_journee: [[510, 840], [840, 1170]], journee: [[510, 1170]] },
    3: { demi_journee: [[510, 840], [840, 1170]], journee: [[510, 1170]] },
    4: { demi_journee: [[510, 840], [840, 1170]], journee: [[510, 1170]] },
    5: { demi_journee: [[510, 840], [840, 1170]], journee: [[510, 1170]] },
    6: { demi_journee: [[540, 780]], journee: [] },
  },
  // Durée de validité d'un lien de réinitialisation de mot de passe.
  resetTokenTtlMs: Number(process.env.RESET_TOKEN_TTL_MS) || 1000 * 60 * 60 * 2, // 2 h
  // URL publique utilisée pour construire le lien de reset (sinon dérivée de la requête).
  publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
  // Fournisseur d'envoi d'e-mails : 'smtp' (nodemailer) ou 'brevo' (API HTTP).
  // Valeur d'AMORÇAGE seulement : le réglage enregistré en base (app_settings →
  // clé `mail`, éditable dans /admin/emails) prime dès qu'il existe.
  mail: {
    provider: process.env.MAIL_PROVIDER || null, // null => 'smtp'
    // Plafond d'envois par jour civil (heure de Paris). 0 = aucun plafond.
    // `null` laisse le défaut dépendre du fournisseur : 300/jour pour Brevo
    // (plafond de l'offre gratuite), aucun plafond pour un SMTP maison.
    dailyLimit: process.env.MAIL_DAILY_LIMIT ? Number(process.env.MAIL_DAILY_LIMIT) : null,
    // Part du plafond réservée aux messages non commerciaux. Une campagne ne peut
    // pas consommer les derniers envois du jour : il doit toujours rester de quoi
    // envoyer une réinitialisation de mot de passe ou une confirmation de résa.
    marketingReserve: process.env.MAIL_MARKETING_RESERVE ? Number(process.env.MAIL_MARKETING_RESERVE) : null,
  },
  // Brevo (ex-Sendinblue) - fournisseur transactionnel hébergé en UE.
  // Secrets d'amorçage ; en exploitation ils sont saisis dans /admin/emails et
  // stockés CHIFFRÉS en base (cf. lib/crypto.js).
  brevo: {
    apiKey: process.env.BREVO_API_KEY || null,
    // Jeton de l'URL de webhook (authentifie les appels entrants de Brevo).
    webhookToken: process.env.BREVO_WEBHOOK_TOKEN || null,
  },
  // Stripe - paiement en ligne (recharge de crédits par Checkout hébergé).
  // Secrets d'amorçage ; peuvent aussi être saisis en base (app_settings → `stripe`,
  // chiffrés via lib/crypto.js). La clé publiable n'est pas secrète. Tant que la
  // clé secrète ET le secret de webhook ne sont pas définis, le paiement en ligne
  // reste désactivé (le membre recharge sur place). Utiliser des clés de TEST en beta.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || null,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    // Price IDs récurrents des abonnements (créés dans le Dashboard Stripe,
    // test ET live). Amorçage par l'environnement ; surchargés par le réglage
    // `stripe.subscription_prices` en base s'il existe. Tant que les trois ne
    // sont pas définis, la souscription en ligne reste désactivée.
    subscriptionPrices: {
      ESSENTIEL: process.env.STRIPE_PRICE_ESSENTIEL || null,
      CONFORT: process.env.STRIPE_PRICE_CONFORT || null,
      PREMIUM: process.env.STRIPE_PRICE_PREMIUM || null,
    },
  },
  // SMTP : tant que SMTP_HOST n'est pas défini, le mailer reste en STUB (rien n'est envoyé).
  smtp: {
    host: process.env.SMTP_HOST || null,
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
    from: process.env.SMTP_FROM || 'Cazalia <no-reply@cazalia.fr>',
  },
  // Anti-brute-force login (cf. brief §3).
  login: {
    maxAttempts: 5,
    windowMs: 1000 * 60 * 15, // 15 min
  },
  // Paramètres de hachage scrypt (OWASP « Password Storage »).
  // N=2^16, r=8, p=1 → ~64 Mio et ~0,3 s par empreinte : 4× le coût des
  // paramètres Node par défaut (N=2^14). Le palier supérieur recommandé
  // (N=2^17 → 128 Mio) est volontairement ÉCARTÉ ici : le conteneur cible ne
  // dispose que de 1 Gio de RAM et quelques connexions simultanées suffiraient
  // à provoquer un OOM - le durcissement se retournerait en déni de service.
  // Relever SCRYPT_N si l'instance est redimensionnée.
  // `maxmem` doit suivre : la valeur par défaut de Node (32 Mio) est insuffisante.
  // Les empreintes produites avec les anciens paramètres restent vérifiables :
  // le format de stockage embarque désormais les paramètres utilisés.
  scrypt: {
    N: Number(process.env.SCRYPT_N) || 65536,
    r: Number(process.env.SCRYPT_R) || 8,
    p: Number(process.env.SCRYPT_P) || 1,
    keyLen: 64,
    maxmem: Number(process.env.SCRYPT_MAXMEM) || 128 * 1024 * 1024,
  },
  // Politique de mot de passe. La longueur maximale borne le coût CPU du
  // hachage (un mot de passe de 100 Kio ne doit pas être hachable).
  password: {
    minLength: Number(process.env.PASSWORD_MIN_LENGTH) || 10,
    maxLength: 200,
  },
  // Plafond de créneaux acceptés dans une réservation groupée (anti-DoS : la
  // transaction SQLite est synchrone et bloque le process mono-thread).
  maxSlotsPerBatch: Number(process.env.MAX_SLOTS_PER_BATCH) || 60,
  cookieName: 'cowork_sid',
  isProd: process.env.NODE_ENV === 'production',
  // Secret de chiffrement au repos (AES-256-GCM) pour les données sensibles stockées
  // en base - notamment le mot de passe SMTP (cf. lib/crypto.js + lib/settings.js).
  // DOIT être défini en prod via l'env `APP_SECRET` (32+ octets aléatoires). À défaut,
  // une valeur aléatoire est générée à CHAQUE démarrage : les secrets déjà chiffrés
  // deviendraient illisibles → à ne pas laisser sans APP_SECRET en production.
  appSecret: process.env.APP_SECRET || crypto.randomBytes(32).toString('hex'),
  // Intégration UniFi (UDM Pro) : génération d'un voucher Wi-Fi par réservation via
  // l'API d'intégration officielle UniFi Network (v9+/v10). L'intégration reste INACTIVE
  // (aucune réservation n'échoue à cause du voucher) tant que UNIFI_API_KEY n'est pas
  // défini ET qu'aucune cible (consoleId cloud OU host local) n'est configurée.
  //
  // DEUX MODES d'accès (clé X-API-KEY dans les deux cas) :
  //  - CLOUD (recommandé en prod) : clé créée sur unifi.ui.com, appels via le proxy
  //    connecteur https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/network/…
  //    → aucune route vers le LAN de l'UDM nécessaire (le serveur sort par Internet).
  //  - LOCAL : clé d'intégration locale, appels directs https://{host}/proxy/network/…
  //    (certificat auto-signé). Nécessite une route réseau serveur → UDM.
  // Si consoleId est défini, le mode CLOUD prime.
  unifi: {
    apiKey: process.env.UNIFI_API_KEY || null,          // clé X-API-KEY
    consoleId: process.env.UNIFI_CONSOLE_ID || null,    // mode cloud : id de la console (GET api.ui.com/v1/hosts)
    host: process.env.UNIFI_HOST || null,               // mode local : IP/hostname du UDM Pro
    site: process.env.UNIFI_SITE || 'default',          // référence interne du site (internalReference)
    // Voucher : 24 h de validité (à partir de la 1ʳᵉ connexion), appareils illimités.
    timeLimitMinutes: Number(process.env.UNIFI_VOUCHER_MINUTES) || 1440,
    // null / 0 => aucune limite d'appareils.
    guestLimit: process.env.UNIFI_VOUCHER_GUEST_LIMIT ? Number(process.env.UNIFI_VOUCHER_GUEST_LIMIT) : null,
    // Mode LOCAL uniquement : le contrôleur présente un certificat auto-signé.
    // La vérification TLS n'est désactivée QUE si l'exploitant l'accepte
    // explicitement (`UNIFI_INSECURE_TLS=1`) ; à défaut, on peut épingler
    // l'empreinte SHA-256 du certificat via `UNIFI_TLS_FINGERPRINT`.
    // Le mode CLOUD (api.ui.com) garde toujours la validation par défaut.
    insecureTls: process.env.UNIFI_INSECURE_TLS === '1',
    tlsFingerprint: process.env.UNIFI_TLS_FINGERPRINT || null,
  },
  // ── UniFi Access (controle de porte - PIN temporaire par reservation) ────────
  // API OFFICIELLE UniFi Access (reference constructeur) : serveur LOCAL sur le
  // port 12445 en HTTPS, base `/api/v1/developer`, authentification
  // `Authorization: Bearer <token>`. Le token est cree dans l'app Access
  // (Access > Settings > General > Advanced > API Token) avec les perimetres
  // view:space (portes), edit:visitor (visiteurs), view:credential (PIN).
  // Certificat auto-signe → TLS strict par defaut (poser UNIFI_ACCESS_INSECURE_TLS=1
  // ou epingler l'empreinte). Le serveur doit JOINDRE la console sur le LAN en
  // 12445 (regle pare-feu entre VLAN requise). Inactif tant que host + token +
  // porte ne sont pas definis (best-effort : une reservation n'echoue jamais).
  unifiAccess: {
    host: process.env.UNIFI_ACCESS_HOST || null,
    port: Number(process.env.UNIFI_ACCESS_PORT) || 12445,
    token: process.env.UNIFI_ACCESS_TOKEN || null, // Authorization: Bearer
    door: process.env.UNIFI_ACCESS_DOOR || null,
    graceBeforeMin: Number(process.env.UNIFI_ACCESS_GRACE_BEFORE_MIN) || 10,
    graceAfterMin: Number(process.env.UNIFI_ACCESS_GRACE_AFTER_MIN) || 15,
    insecureTls: process.env.UNIFI_ACCESS_INSECURE_TLS === '1',
    tlsFingerprint: process.env.UNIFI_ACCESS_TLS_FINGERPRINT || null,
  },
  // Mot de passe par défaut des comptes créés par l'admin - DOIT être défini via
  // l'env `DEFAULT_USER_PASSWORD` (secret du service). À défaut, on génère une
  // valeur aléatoire par démarrage (jamais de mot de passe faible en dur dans le repo).
  // L'admin voit la valeur dans l'écran de création de compte ; l'utilisateur est
  // forcé de la changer à sa première connexion.
  defaultUserPassword:
    process.env.DEFAULT_USER_PASSWORD ||
    crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14),
};
