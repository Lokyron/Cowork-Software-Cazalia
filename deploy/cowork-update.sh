#!/usr/bin/env bash
# Updater Cazalia.
#
# Tourne en root, lancé par cowork-update.service quand l'application dépose son
# fichier de requête. L'application ne lance jamais ce script et n'écrit jamais
# dans son propre dossier : cette séparation est tout l'intérêt.
#
# La branche installée est celle vers laquelle pointe le canal demandé : stable
# suit UPDATE_BRANCH, beta suit UPDATE_BETA_BRANCH.
#
# Étapes : télécharger la branche en tarball ; installer les dépendances de prod
# du serveur et BUILDER le front (Vite) dans un dossier de staging voisin ;
# reporter la galerie (photos uploadées) ; sauvegarder la base ; permuter les
# deux dossiers par un simple renommage ; redémarrer le service ; revenir à la
# version précédente si la nouvelle ne démarre pas.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/cazalia}
DATA_DIR=${DATA_DIR:-/var/lib/cazalia}
SERVICE=${SERVICE:-cazalia}
APP_USER=${APP_USER:-cowork}
REPO=${UPDATE_REPO:-Lokyron/Cowork-Software-Cazalia}
BRANCH=${UPDATE_BRANCH:-main}
BETA_BRANCH=${UPDATE_BETA_BRANCH:-beta}

REQUEST_FILE="$DATA_DIR/update.request"
STATUS_FILE="$DATA_DIR/update.status"
STEP=start

status() { # state step [message]
  printf '{"state":"%s","step":"%s","message":"%s","at":"%s"}\n' \
    "$1" "$2" "${3:-}" "$(date -Is)" > "$STATUS_FILE"
  chown "$APP_USER" "$STATUS_FILE" 2>/dev/null || true
}
fail() { status failed "$STEP" "$1"; exit 1; }
trap 'fail "l_updater s_est arrêté pendant : $STEP"' ERR

# L'application écrit le canal voulu, et seulement un nom de canal : c'est ici
# qu'un nom devient une branche, pour que le côté non privilégié ne puisse pas
# pointer l'updater vers une autre ref. Tout imprévu retombe sur stable.
# `|| true` : un fichier de requête illisible ne doit pas déclencher le trap ERR.
CHANNEL=$(sed -n 's/^channel=\([a-z][a-z0-9]\{0,15\}\)$/\1/p' "$REQUEST_FILE" 2>/dev/null | head -n1 || true)
case "$CHANNEL" in
  beta) CHANNEL=beta; BRANCH="$BETA_BRANCH" ;;
  *)    CHANNEL=stable ;;
esac

rm -f "$REQUEST_FILE"

STEP=download
status running "$STEP"
STAGING=$(mktemp -d "${APP_DIR}.update-XXXXXX")   # même système de fichiers → la permutation est un renommage
cleanup() { [ -d "$STAGING" ] && rm -rf "$STAGING"; }
trap cleanup EXIT
curl -fsSL --max-time 180 "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" \
  | tar -xz -C "$STAGING" --strip-components=1
[ -f "$STAGING/server/package.json" ] || fail "l_archive téléchargée n_est pas Cazalia"
[ -f "$STAGING/web/package.json" ] || fail "l_archive téléchargée n_est pas Cazalia (web)"

STEP=version
status running "$STEP"
SHA=$(curl -fsSL --max-time 30 "https://api.github.com/repos/${REPO}/commits/${BRANCH}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).sha||""))')

STEP=dependencies
status running "$STEP"
# npm install (et non npm ci) : le dépôt ne versionne pas de package-lock.json.
(cd "$STAGING/server" && npm install --omit=dev --no-audit --no-fund >/dev/null)

STEP=build
status running "$STEP"
# Le build Vite a besoin des devDependencies ; une fois le dist produit, le
# node_modules du front ne sert plus (nginx sert des fichiers statiques).
(cd "$STAGING/web" && npm install --no-audit --no-fund >/dev/null && npm run build >/dev/null)
[ -f "$STAGING/web/dist/index.html" ] || fail "le build du front n_a rien produit"
rm -rf "$STAGING/web/node_modules"

STEP=swap
status running "$STEP"
chown -R root:root "$STAGING"
# mktemp donne 0700, infranchissable pour le compte de service : on redonne à
# l'arbre la forme d'une install normale, lisible par tous, modifiable par root.
chmod -R a+rX,go-w "$STAGING"

# Galerie : on reporte les photos vivantes (défauts + uploads) par-dessus celles
# du dépôt, et on les laisse au compte de service (ReadWritePaths).
if [ -d "$APP_DIR/web/gallery" ]; then
  rm -rf "$STAGING/web/gallery"
  cp -a "$APP_DIR/web/gallery" "$STAGING/web/gallery"
fi

# Sauvegarde de la base avant bascule (en plus du .previous pour le rollback).
STEP=backup
status running "$STEP"
if [ -f "$DATA_DIR/cowork.db" ]; then
  BKP_DIR="$DATA_DIR/backups"
  TS=$(date +%Y%m%d-%H%M%S)
  RUN="$BKP_DIR/$TS"
  mkdir -p "$RUN"
  for f in cowork.db cowork.db-wal cowork.db-shm; do
    [ -f "$DATA_DIR/$f" ] && cp -a "$DATA_DIR/$f" "$RUN/$f" || true
  done
  chown -R "$APP_USER:$APP_USER" "$BKP_DIR" 2>/dev/null || true
  # Ne garder que les 10 sauvegardes les plus récentes.
  ls -1dt "$BKP_DIR"/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf
fi

STEP=swap
status running "$STEP"
printf '{"commit":"%s","branch":"%s","channel":"%s","installedAt":"%s"}\n' \
  "$SHA" "$BRANCH" "$CHANNEL" "$(date -Is)" > "$STAGING/VERSION"
PREVIOUS="${APP_DIR}.previous"
rm -rf "$PREVIOUS"
mv "$APP_DIR" "$PREVIOUS"
mv "$STAGING" "$APP_DIR"
trap - EXIT
# La galerie doit rester modifiable par le service (dépôt d'uploads).
chown -R "$APP_USER:$APP_USER" "$APP_DIR/web/gallery" 2>/dev/null || true

STEP=restart
status running "$STEP"
systemctl restart "$SERVICE"
sleep 3
if ! systemctl is-active --quiet "$SERVICE"; then
  rm -rf "${APP_DIR}.failed"
  mv "$APP_DIR" "${APP_DIR}.failed"
  mv "$PREVIOUS" "$APP_DIR"
  systemctl restart "$SERVICE" || true
  fail "la nouvelle version n_a pas démarré, la précédente a été remise en place"
fi

status done complete "installé ${BRANCH} (${SHA:0:7})"
rm -rf "$PREVIOUS"
