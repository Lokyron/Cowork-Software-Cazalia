import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT) || 3001,
  // Interface d'écoute. Par défaut 127.0.0.1 : l'API n'est joignable QUE par le
  // reverse proxy nginx local. L'exposer sur 0.0.0.0 permettrait de contacter
  // l'API en contournant nginx et, `trust proxy` étant actif, de forger
  // `X-Forwarded-For` — donc de contourner toute la limitation de débit.
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
  // Durée de vie d'une session serveur.
  sessionTtlMs: 1000 * 60 * 60 * 24 * 14, // 14 jours
  // Fenêtre de remboursement total à l'annulation (cf. brief §5.3).
  refundWindowHours: Number(process.env.REFUND_WINDOW_HOURS) || 24,
  // Horaires d'ouverture (heure de Paris), par jour de semaine (0=dimanche … 6=samedi).
  // Chaque plage = [début, fin] en minutes depuis minuit. Appliqués aux clients ;
  // l'administrateur peut forcer une réservation hors de ces horaires.
  openingHours: {
    0: [],              // dimanche : fermé
    1: [[510, 1170]],   // lundi    : 8h30 – 19h30
    2: [[510, 1170]],   // mardi
    3: [[510, 1170]],   // mercredi
    4: [[510, 1170]],   // jeudi
    5: [[510, 1170]],   // vendredi
    6: [[540, 780]],    // samedi   : 9h00 – 13h00
  },
  // Durée de validité d'un lien de réinitialisation de mot de passe.
  resetTokenTtlMs: Number(process.env.RESET_TOKEN_TTL_MS) || 1000 * 60 * 60 * 2, // 2 h
  // URL publique utilisée pour construire le lien de reset (sinon dérivée de la requête).
  publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
  // SMTP : tant que SMTP_HOST n'est pas défini, le mailer reste en STUB (rien n'est envoyé).
  smtp: {
    host: process.env.SMTP_HOST || null,
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
    from: process.env.SMTP_FROM || 'Cazalia <no-reply@cowork.example.com>',
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
  // à provoquer un OOM — le durcissement se retournerait en déni de service.
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
  // en base — notamment le mot de passe SMTP (cf. lib/crypto.js + lib/settings.js).
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
  // Mot de passe par défaut des comptes créés par l'admin — DOIT être défini via
  // l'env `DEFAULT_USER_PASSWORD` (secret du service). À défaut, on génère une
  // valeur aléatoire par démarrage (jamais de mot de passe faible en dur dans le repo).
  // L'admin voit la valeur dans l'écran de création de compte ; l'utilisateur est
  // forcé de la changer à sa première connexion.
  defaultUserPassword:
    process.env.DEFAULT_USER_PASSWORD ||
    crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14),
};
