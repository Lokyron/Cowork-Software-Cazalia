# Cazalia — plateforme de gestion d'espace de coworking

Application web auto-hébergée pour gérer un espace de coworking de bout en bout :
réservation d'espaces par un solde de **crédits**, espace membre, back-office
d'administration, landing publique et e-mails transactionnels. Tout est centralisé
dans un seul outil, pensé pour tourner sur une petite infrastructure (un conteneur
Linux derrière un reverse proxy).

Interface en français. Licence **MIT**.

---

## Fonctionnalités

**Côté public**
- Landing de présentation (lieu, espaces, galerie, infos pratiques).
- Formulaire de pré-inscription / liste d'attente avant ouverture.
- Page légale complète (CGU, mentions légales, politique de confidentialité RGPD).

**Côté membre**
- Création de compte, connexion, gestion du profil, suppression du compte.
- Authentification à deux facteurs (TOTP) optionnelle.
- Réservation d'un ou plusieurs espaces sur des créneaux, avec disponibilités en
  temps réel et panier multi-espaces.
- Solde de **crédits** : consultation, historique des mouvements, relevé PDF.
- Mon planning (réservations à venir / passées), annulation avec re-crédit selon
  la fenêtre de remboursement.

**Côté administration**
- Tableau de bord, planning global, gestion des espaces.
- Gestion des membres (création de compte, recharge de crédits, réinitialisation
  de mot de passe), gestion des prospects (+ export CSV).
- Réglages et modèles d'e-mails transactionnels (SMTP).
- **Mises à jour in-app** : installation d'une nouvelle version depuis l'interface,
  canaux *stable* / *bêta* et retour arrière automatique (voir plus bas).

---

## Comment ça marche

### Modèle d'espaces unifié
Une **seule table `spaces`** couvre l'open-space *et* les salles :
- une **zone** open-space : `kind = 'zone'`, `capacity = N` (nombre de places) ;
- une **salle** : `kind = 'room'`, `capacity = 1` (réservation exclusive).

Conséquence : une **seule requête de disponibilité** gère les deux cas.

### Réservation atomique
Une réservation vérifie la disponibilité, débite les crédits, crée la réservation
et écrit le mouvement de crédits **dans une seule transaction SQLite**. C'est le
choix de `better-sqlite3` (API synchrone) qui rend ces transactions simples et
sûres : impossible de réserver au-delà de la capacité ou avec un solde insuffisant.

### Portefeuille en grand-livre
Le solde d'un membre n'est pas un simple compteur : il est dérivé d'un **grand-livre**
de mouvements (`credit_transactions`), ce qui donne un historique auditable et un
relevé PDF.

### Temps et fuseau
Les horaires sont stockés en **UTC (ISO 8601)** et affichés en `Europe/Paris`, pour
rester corrects indépendamment du fuseau de la machine.

### Authentification & sécurité
- Mots de passe hachés en **scrypt**, **sessions côté serveur** (cookie `httpOnly`,
  `SameSite=Lax`), throttling anti-brute-force sur le login.
- Deux rôles : `member` et `admin` ; le rôle est relu en base à chaque requête.
- Jetons de réinitialisation hachés, secrets TOTP et SMTP **chiffrés au repos**
  (AES-256-GCM, clé `APP_SECRET`).
- En-têtes de sécurité, garde same-origin, et journal d'événements de sécurité
  (sans e-mail en clair).

### E-mails transactionnels
Confirmation / modification de réservation, réinitialisation de mot de passe, etc.
SMTP configurable depuis l'admin ; modèles HTML responsive avec interpolation
`{{variable}}` ; mot de passe SMTP chiffré au repos.

---

## Stack technique

| Couche | Techno |
|---|---|
| API | Node.js + Express + `better-sqlite3` (SQLite, mode WAL) |
| Front | React + Vite (SPA) |
| Service | systemd (unité durcie), reverse proxy nginx |
| Cible | conteneur LXC Debian / Proxmox VE (sans Docker) |

---

## Démarrage en local

```bash
# 1. Dépendances
cd server && npm install
cd ../web && npm install

# 2. Base de données de démonstration (comptes de test)
cd ../server && npm run seed
#   admin@cowork.test / admin1234   (admin)
#   alice@cowork.test / alice1234   (membre)

# 3. Développement (deux terminaux)
cd server && npm run dev      # API sur http://localhost:3001
cd web && npm run dev         # Front sur http://localhost:5173 (proxy /api → :3001)
```

Build de production du front :

```bash
cd web && npm run build       # génère web/dist, servi par nginx
```

---

## Configuration

Toute la configuration passe par des variables d'environnement (voir
[`server/.env.example`](server/.env.example)). Les **secrets ne sont jamais versionnés** :
en production ils vivent dans un fichier d'environnement hors du dépôt.

| Variable | Rôle |
|---|---|
| `PORT`, `HOST` | Écoute de l'API (par défaut `127.0.0.1:3001`) |
| `DB_PATH` | Chemin de la base SQLite |
| `APP_SECRET` | Clé de chiffrement au repos (AES-256-GCM) — **obligatoire en prod** |
| `DEFAULT_USER_PASSWORD` | Mot de passe initial des comptes créés par l'admin |
| `PUBLIC_BASE_URL` | URL publique (liens dans les e-mails) |
| `SMTP_*` | Serveur d'envoi d'e-mails |
| `UNIFI_*` | Intégration bons Wi-Fi UniFi (optionnelle) |
| `UPDATE_*` | Mises à jour in-app (voir ci-dessous) |

---

## Déploiement

Pas de Docker. Le principe : copier le dépôt sur le serveur, installer les
dépendances, builder le front, puis servir `web/dist` par nginx et lancer l'API
via systemd.

Le dossier [`deploy/`](deploy) fournit des modèles :
- `cazalia.service` — unité systemd durcie (compte dédié non privilégié,
  `ProtectSystem=strict`, capacités retirées…) ;
- `nginx.conf` — vhost (fichiers statiques + proxy `/api`, limitation de débit) ;
- `cowork-update.{sh,service,path}` — système de mise à jour in-app.

Les secrets sont fournis par un `EnvironmentFile` lu par le service, hors du dépôt.

---

## Mise à jour in-app

L'administrateur peut installer une nouvelle version **depuis l'interface**
(`/admin/maj`), au choix sur le canal **stable** (branche `main`) ou **bêta**
(branche `beta`), avec **retour arrière automatique**.

Principe de sécurité : **l'application n'écrit jamais son propre code.** Elle se
contente de déposer un fichier de requête dans son dossier de données ; une unité
systemd `cowork-update.path` (exécutée en **root**, hors de l'application) détecte
ce fichier et lance l'updater, qui :

1. télécharge la branche du canal demandé (archive GitHub) ;
2. installe les dépendances et **build le front** dans un dossier de staging ;
3. **préserve les données** (galerie d'images, base) et **sauvegarde la base** ;
4. permute le dossier applicatif de façon atomique et redémarre le service ;
5. **restaure la version précédente** si la nouvelle ne démarre pas.

Le fichier de requête ne transporte qu'un **nom de canal** (jamais un nom de
branche) : le mapping canal → branche vit dans l'environnement du service root,
donc la partie non privilégiée ne peut pas pointer l'updater vers une référence
arbitraire.

---

## Licence

[MIT](LICENSE) © 2026 Cazalia.
