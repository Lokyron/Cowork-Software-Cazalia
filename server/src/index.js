import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';

import { config } from './config.js';
import './db.js'; // initialise la base + schéma
import { attachUser } from './middleware.js';
import { securityHeaders, sameOriginGuard } from './security.js';
import { securityEvent } from './lib/audit.js';
import { purgeExpiredSessions } from './auth.js';
import { authRouter } from './routes/auth.js';
import { spacesRouter } from './routes/spaces.js';
import { reservationsRouter } from './routes/reservations.js';
import { cartRouter } from './routes/cart.js';
import { walletRouter } from './routes/wallet.js';
import { leadsRouter } from './routes/leads.js';
import { galleryRouter } from './routes/gallery.js';
import { adminRouter } from './routes/admin.js';
import { emailsRouter } from './routes/emails.js';
import { updateRouter } from './routes/update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Contrôle des prérequis de production ─────────────────────────────────────
// `APP_SECRET` chiffre les secrets stockés en base (mot de passe SMTP, secrets
// TOTP). Absent, une clé aléatoire est régénérée à chaque démarrage : les
// secrets déjà chiffrés deviennent illisibles silencieusement.
if (config.isProd && !process.env.APP_SECRET) {
  console.error(
    '[securite] APP_SECRET absent en production : les secrets chiffrés en base ' +
    '(mot de passe SMTP, secrets 2FA) seront ILLISIBLES au prochain redémarrage. ' +
    'Définir APP_SECRET (32 octets aléatoires) dans l\'unité systemd.'
  );
}

const app = express();

// N'annonce pas la pile technique dans les réponses (réduction d'empreinte).
app.disable('x-powered-by');

// Nombre de proxys de confiance. `req.ip` — sur lequel repose toute la
// limitation de débit — n'est fiable QUE si cette valeur correspond à la
// réalité du déploiement : avec `trust proxy` actif et une API joignable
// directement, `X-Forwarded-For` devient falsifiable (CWE-348).
app.set('trust proxy', config.trustProxy);

app.use(securityHeaders);
// Corps JSON borné : au-delà, Express répond 413 sans charger la charge utile.
app.use(express.json({ limit: config.jsonBodyLimit }));
app.use(cookieParser());
app.use(sameOriginGuard);
app.use(attachUser);

// API
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api', spacesRouter);
app.use('/api', reservationsRouter);
app.use('/api', cartRouter);
app.use('/api', walletRouter);
app.use('/api', leadsRouter);
app.use('/api', galleryRouter);
app.use('/api/admin/update', updateRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/email', emailsRouter);

// Toute route /api/ non reconnue répond en JSON : sans cela, la requête
// retomberait sur le front statique et renverrait du HTML à un client d'API.
app.use('/api', (_req, res) => res.status(404).json({ error: 'ROUTE_INTROUVABLE' }));

// Build front statique (servi par Nginx en prod ; pratique en dev/preview ici).
const webDist = path.join(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  // `dotfiles: 'ignore'` : aucun fichier caché déposé par erreur dans le build
  // (.env, .git, .DS_Store) ne peut être servi.
  app.use(express.static(webDist, { dotfiles: 'ignore' }));
  app.get('*', (req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// Filet de sécurité pour erreurs non gérées. La trace complète part dans le
// journal du service ; le client ne reçoit qu'un code générique — une pile
// d'appels révélerait chemins, versions et structure interne (CWE-209).
app.use((err, req, res, _next) => {
  console.error('[erreur]', req.method, req.path, err);
  if (res.headersSent) return; // réponse déjà en cours (ex. flux PDF)
  res.status(500).json({ error: 'ERREUR_SERVEUR' });
});

// Purge des sessions expirées toutes les heures.
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

app.listen(config.port, config.host, () => {
  console.log(`Cazalia — API → http://${config.host}:${config.port}`);
  securityEvent('demarrage', { host: config.host, port: config.port, prod: config.isProd });
});
