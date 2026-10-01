# syntax=docker/dockerfile:1
#
# Image unique Cazalia : build du front (Vite) + API Express qui sert à la fois
# l'API et le front statique. Le TLS est assuré par un reverse proxy en amont.
# Données persistantes (base SQLite, galerie) montées en volumes → l'image est
# jetable et reproductible, donc l'app est déplaçable telle quelle.

# ── 1. Build du front ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS web-build
WORKDIR /app/web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ── 2. Dépendances serveur (better-sqlite3 : prebuild, sinon compilation) ─────
FROM node:20-bookworm-slim AS server-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ── 3. Image finale ───────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
# Métadonnées de version, injectées par la CI (identifie l'image installée).
ARG GIT_SHA=unknown
ARG GIT_BRANCH=unknown
ARG CHANNEL=unknown
LABEL org.opencontainers.image.title="Cazalia" \
      org.opencontainers.image.source="https://github.com/Lokyron/Cowork-Software-Cazalia" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    DB_PATH=/data/cowork.db \
    GALLERY_DIR=/gallery \
    TRUST_PROXY=1
# Dossiers de données (montés en volumes), accessibles au compte non-root `node`.
RUN mkdir -p /data /gallery && chown -R node:node /data /gallery
WORKDIR /app/server
COPY --chown=node:node server/ ./
COPY --from=server-deps --chown=node:node /app/server/node_modules ./node_modules
COPY --from=web-build --chown=node:node /app/web/dist /app/web/dist
# VERSION relu par l'app (server/src/update.js → installedVersion), à la racine /app.
RUN printf '{"commit":"%s","branch":"%s","channel":"%s","installedAt":"%s"}\n' \
      "$GIT_SHA" "$GIT_BRANCH" "$CHANNEL" "$(date -Is)" > /app/VERSION \
    && chown node:node /app/VERSION
USER node
EXPOSE 3001
# Health-check : l'endpoint public /api/config répond sans authentification.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3001) +'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
