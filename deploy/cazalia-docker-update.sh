#!/usr/bin/env bash
# Updater Cazalia — version Docker.
#
# Tourne en root sur l'hôte Docker, lancé par cazalia-update.service quand
# l'application (dans le conteneur) dépose son fichier de requête dans le volume
# de données. L'application ne lance jamais ce script : elle ne fait qu'écrire la
# requête. Ici, un nom de canal (stable/beta) devient un tag d'image.
#
# Étapes : lire le canal → tirer le tag d'image correspondant → recréer le
# conteneur → attendre qu'il soit « healthy » → revenir à l'image précédente si
# le health-check échoue.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/cazalia}
COMPOSE=${COMPOSE:-$APP_DIR/docker-compose.prod.yml}
DATA_DIR=${DATA_DIR:-$APP_DIR/data}
CONTAINER=${CONTAINER:-cazalia}
IMAGE=${IMAGE:-ghcr.io/lokyron/cowork-software-cazalia}

REQUEST_FILE="$DATA_DIR/update.request"
STATUS_FILE="$DATA_DIR/update.status"
STEP=start

status() { # state step [message]
  printf '{"state":"%s","step":"%s","message":"%s","at":"%s"}\n' \
    "$1" "$2" "${3:-}" "$(date -Is)" > "$STATUS_FILE"
  chmod 644 "$STATUS_FILE" 2>/dev/null || true   # lisible par le conteneur (uid node)
}
fail() { status failed "$STEP" "$1"; exit 1; }
trap 'fail "l_updater s_est arrêté pendant : $STEP"' ERR

# Canal demandé (et SEULEMENT un nom de canal) → tag d'image.
CHANNEL=$(sed -n 's/^channel=\([a-z][a-z0-9]\{0,15\}\)$/\1/p' "$REQUEST_FILE" 2>/dev/null | head -n1 || true)
case "$CHANNEL" in
  beta) CHANNEL=beta ;;
  *)    CHANNEL=stable ;;
esac
rm -f "$REQUEST_FILE"
export COWORK_CHANNEL="$CHANNEL"

compose() { docker compose -f "$COMPOSE" "$@"; }

STEP=pull
status running "$STEP"
# Image actuellement en service, pour un éventuel rollback (ID immuable sha256).
PREVIOUS=$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)
compose pull

STEP=recreate
status running "$STEP"
compose up -d

STEP=health
status running "$STEP"
# Attendre l'état « healthy » du conteneur (le HEALTHCHECK de l'image teste /api/config).
ok=0
for _ in $(seq 1 30); do
  sleep 2
  h=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo none)
  case "$h" in
    healthy) ok=1; break ;;
    none)    docker ps --filter "name=^${CONTAINER}$" --filter status=running -q | grep -q . && { ok=1; break; } ;;
    unhealthy) break ;;
  esac
done

if [ "$ok" != "1" ]; then
  STEP=rollback
  status running "$STEP"
  if [ -n "$PREVIOUS" ]; then
    # Réaffecte le tag du canal à l'image précédente (locale) et relance sans pull.
    docker tag "$PREVIOUS" "${IMAGE}:${CHANNEL}"
    compose up -d || true
  fi
  fail "la nouvelle image n_a pas démarré (healthy), retour à la version précédente"
fi

# Nettoyage léger des images orphelines.
docker image prune -f >/dev/null 2>&1 || true
status done complete "installé l_image ${IMAGE}:${CHANNEL}"
