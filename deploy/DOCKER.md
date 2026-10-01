# Déploiement Docker (portable)

Cette variante conteneurisée rend l'application **déplaçable sur n'importe quel
hôte Docker**. Image unique (API + front statique), base SQLite et galerie en
volumes, mises à jour in-app par **tags d'image** avec rollback.

## 1. Intégration continue (images)

`.github/workflows/docker-image.yml` build et publie sur **GHCR** à chaque push :

| Branche | Tag d'image |
|---|---|
| `main` | `ghcr.io/lokyron/cowork-software-cazalia:stable` |
| `beta` | `ghcr.io/lokyron/cowork-software-cazalia:beta` |

(+ un tag immuable `sha-<commit>`). La version (commit/branche/canal) est **bakée**
dans l'image (`/app/VERSION`), que l'app relit pour afficher ce qui est installé.

> Après le premier build, rendre le **package GHCR public** (Settings du package)
> pour que l'hôte puisse tirer l'image sans authentification.

## 2. Hôte de production

```bash
# Dossiers de données (DOIVENT appartenir à l'uid 1000 = user 'node' du conteneur)
install -d -o 1000 -g 1000 /opt/cazalia/data /opt/cazalia/gallery

# Config (secrets hors image)
cp server/.env.example /opt/cazalia/.env    # renseigner APP_SECRET, SMTP_*, UNIFI_*…
cp docker-compose.prod.yml /opt/cazalia/

# Démarrage (canal stable)
cd /opt/cazalia && COWORK_CHANNEL=stable docker compose -f docker-compose.prod.yml up -d
```

Le reverse proxy en amont assure le TLS et pointe sur `127.0.0.1:3001`.

## 3. Mise à jour in-app (host watcher)

Même principe que la version systemd : **l'app n'agit jamais sur son propre
conteneur**. Elle dépose `/data/update.request` (volume) ; un watcher root sur
l'hôte fait le travail.

```bash
install -m 0755 deploy/cazalia-docker-update.sh /usr/local/bin/cazalia-docker-update
install -m 0644 deploy/cazalia-update.service /etc/systemd/system/
install -m 0644 deploy/cazalia-update.path    /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now cazalia-update.path
```

Flux : bouton admin → `update.request` (canal) → `cazalia-update.path` déclenche
`cazalia-docker-update` → `docker compose pull` du tag du canal → recréation →
attente `healthy` → **rollback au digest précédent si le health-check échoue**.

## 4. Migration depuis la version systemd/nginx

```bash
# Copier la base et la galerie vers les volumes Docker
cp -a /var/lib/lucie-cowork/cowork.db*      /opt/cazalia/data/
cp -a /opt/lucie-cowork/web/gallery/.       /opt/cazalia/gallery/
chown -R 1000:1000 /opt/cazalia/data /opt/cazalia/gallery
```

Puis démarrer le conteneur, vérifier, basculer le reverse proxy, et retirer
l'ancien service systemd + nginx + l'updater tarball.

## Notes
- Durcissement : conteneur **non-root** (`node`), rootfs lisible, données isolées
  en volumes ; le reste du durcissement réseau reste au niveau de l'hôte/proxy.
- `better-sqlite3` est compilé à la construction de l'image (stage `server-deps`).
