# Cazalia / Lucie Cowork — consignes pour tout agent de code

> Ce fichier s'adresse à **n'importe quel assistant de code** qui travaille sur ce dépôt :
> Antigravity, Gemini, Codex, Cursor, ou Claude Code hors de sa propre configuration.
> Claude Code lit en plus [`CLAUDE.md`](CLAUDE.md) — mêmes règles, plus son système de sous-agents.
> Si les deux fichiers se contredisent, c'est un bug de documentation : signale-le.

Le projet change de main : le propriétaire alterne entre plusieurs assistants selon ses limites
d'usage. Tu reprends donc un travail commencé par un autre, et un autre reprendra le tien. Les
sections suivantes existent pour que cette couture ne coûte rien.

## 0. Où tu es

Plateforme auto-hébergée de réservation d'un espace de co-working (marque **Cazalia**, identifiant
technique historique « Lucie Cowork »). Les membres réservent des places en open-space ou des salles
et **paient en euros** — Stripe Checkout à la réservation, ou abonnement mensuel. Panier
multi-espaces, codes promo, annulation remboursée au-delà de 24 h, voucher Wi-Fi UniFi et code de
porte UniFi Access par réservation, 2FA TOTP. Back-office complet, landing publique.

JavaScript **ESM**. `server/` = Express 4 + better-sqlite3 + nodemailer + Stripe. `web/` = React 18 +
React Router 6 + Vite 5. Base SQLite en fichier unique, transactions synchrones.

**En production** : CT 120 (`10.1.20.120`) sur le PVE Cazalia, service **systemd natif**
`lucie-cowork.service` — **pas Docker**, malgré le `Dockerfile` et les `docker-compose` présents
dans le dépôt. Public sur `https://cazalia.fr` via Nginx Proxy Manager (CT 100) → nginx local →
API `127.0.0.1:3001`. Mise à jour depuis Administration ▸ Mise à jour, **canal `beta`**.

## 1. Les trois règles qui ne se discutent pas

1. **Stripe est en livemode.** Chaque montant, chaque code promo, chaque remboursement touche l'argent
   réel d'un client réel. Le chemin `webhook Stripe → réservation` est le **seul** qui transforme un
   paiement en réservation : s'il casse, le client paie et ne voit jamais sa réservation, et
   l'application ne journalise rien puisqu'elle n'est jamais appelée. On ne « teste pas vite fait »
   sur la production.
2. **Une réservation se pose dans une transaction unique.** Vérifier la disponibilité puis écrire en
   deux temps, c'est du sur-booking : deux membres dans la même salle, un litige, un remboursement.
   Le contrôle **et** l'écriture vivent dans la même transaction better-sqlite3. La disponibilité
   applique la même formule aux zones (capacité) et aux salles (exclusives) — `server/src/lib/booking.js`.
3. **On ne casse pas la prod pour aller plus vite.** Sauvegarde de `cowork.db` avant toute mise à jour,
   `npm test` avant tout déploiement, et aucune intervention sur le CT 120 qui n'ait été demandée
   explicitement. Aucun secret dans un commit, un message ou un rapport.

## 2. Lis ça avant d'écrire une ligne

| Fichier | Ce qu'il contient |
|---|---|
| [`DOCUMENTATION.md`](DOCUMENTATION.md) | **La fiche de reprise.** Stack, arborescence, les ~30 variables d'environnement, tous les endpoints, la mise en service Brevo, la gestion des photos, et au §8 la dette et les pièges |
| [`BRIEF.md`](BRIEF.md) | Cahier des charges : §4-5 le modèle de données et la logique critique, §9 les décisions encore ouvertes |
| `server/src/lib/` | Le cœur métier : `booking.js` (disponibilité), `cart.js`, `pricing.js`, `orders.js`, `subscriptions.js`, `stripe.js`, `promos.js` |
| [`deploy/durcissement.md`](deploy/durcissement.md) | Runbook de durcissement du conteneur |
| `../Infra local/` | Hors dépôt : reverse proxy et SSL (`Reverse-proxy-et-SSL.md`), intégration Stripe (`STRIPE_INTEGRATION.md`) |

**Recommandation de reprise** : `BRIEF.md` §4-5, puis `booking.js`, `cart.js`, `pricing.js`,
`orders.js`, puis `npm test`.

## 3. Ce qui est déjà passé à travers — ne le refais pas

Chacun de ces points a coûté du temps ou de l'argent. Ce sont des **pièges de ce projet**, pas des
étourderies isolées.

1. **Les webhooks Stripe dépendent du filtrage GeoIP UniFi.** La règle « France uniquement » jetait
   silencieusement toutes les livraisons de Stripe, dont les 15 adresses d'émission sont hors de
   France. Symptômes trompeurs : le client paie et ne voit jamais sa réservation, l'abonnement ne
   s'active pas, le bandeau « paiement en cours de traitement » ne disparaît plus — et **l'application
   ne journalise rien**, n'ayant jamais été appelée. Tester l'endpoint depuis la France ne révèle rien.
   Diagnostic : compter les livraisons vues par le proxy
   (`grep 'webhooks/stripe' /data/logs/*access*.log` sur le CT 100) ; une livraison réussie porte
   l'agent `Stripe/1.0`. **État au 2026-11-12 : le GeoIP a été entièrement désactivé** pour rétablir le
   service ; il reste à le réactiver avec les IP de Stripe
   (`https://stripe.com/files/ips/ips_webhooks.json`) en exception.
2. **`npm install` dans `server/` casse l'environnement local.** `better-sqlite3` ne se recompile pas
   sur toutes les machines (node-gyp). Le `node_modules` livré est utilisable tel quel ; une
   réinstallation le détruit et l'API ne démarre plus. **Restent vérifiables sans l'API** :
   `cd server && npm test`, `node --check <fichier>` sur chaque fichier serveur modifié,
   `cd web && npm run build`, et les migrations en important `src/db.js` avec un `DB_PATH` jetable.
3. **Les pièges de déploiement systemd / nginx**, tous déjà payés une fois :
   `MemoryDenyWriteExecute=yes` fait planter Node (JIT V8) ; les en-têtes de sécurité ne doivent être
   émis **qu'une seule fois** (nginx **ou** l'application, jamais les deux) ; nginx ne doit pas
   écraser `X-Forwarded-Proto`, sinon le cookie n'est jamais `Secure` et HSTS n'est jamais émis ;
   `TRUST_PROXY` reste à `1` même avec les deux proxys en cascade.
4. **UniFi Access n'est joignable que sur `10.1.20.1`**, pas sur `10.1.10.1` : l'inter-VLAN est
   filtré. API officielle locale, port `12445`, authentification Bearer, périmètres
   `view:space` / `edit:visitor` / `view:credential`, `INSECURE_TLS=1`. Pour les vouchers Wi-Fi en
   revanche, c'est l'**API cloud** `api.ui.com` qui est le mode retenu : une clé `unifi.ui.com` ne
   fonctionne pas en local.
5. **Les codes promo sont gérés dans Stripe, l'application est en lecture seule.** L'écran admin est
   un miroir synchronisé : ne lui ajoute pas d'écriture. La limite par personne passe par la
   métadonnée `max_per_user` ; « une formule offerte » se fait avec un coupon de montant fixe
   restreint au produit formule.
6. **Le code promo de la journée découverte (`JOURNEE-CAZALIA`) n'existe qu'en dur** dans
   `web/src/pages/Rejoindre.jsx`. Il est affiché une seule fois, sur l'écran de confirmation
   d'inscription, et n'est repris dans aucun e-mail ni en base : un inscrit qui quitte cette page le
   perd définitivement. **Ne pas rediriger automatiquement depuis cet écran.**
7. **Un dossier bind-monté créé par Docker appartient à root**, et tous les envois de photos échouent.
   Il doit appartenir à l'uid 1000. Correctif sur l'hôte :
   `install -d -o 1000 -g 1000 /opt/cazalia/gallery`.
8. **Le portefeuille de crédits a été retiré le 2026-11-07.** Les tables `credit_transactions` et
   `credit_purchases` sont supprimées ; les colonnes `spaces.credits_per_hour` et
   `reservations.credits_cost` restent présentes mais **inertes**. Ne les réutilise pas, ne t'appuie
   pas dessus, et ne réintroduis pas de logique de crédits.
9. **La documentation existe déjà, en double par endroits.** `docs/` du dépôt et `../Reseau & Accès/`
   contiennent les mêmes schémas réseau. Avant d'écrire une procédure d'infra, **cherche-la** : elle a
   déjà été écrite une fois.

## 4. Conventions

- **Français** partout : commentaires, messages de commit, documentation, interface, messages
  d'erreur destinés à l'utilisateur. Les identifiants du code restent en anglais.
- Horaires **stockés en UTC ISO 8601**, affichés en `Europe/Paris`. Passe par `server/src/lib/time.js`.
- Pas d'erreur avalée silencieusement : `server/src/lib/errors.js`.
- Pas de dépendance nouvelle sans qu'elle soit demandée ou justifiée. Le projet en a peu, c'est voulu.
- Les secrets viennent de `/etc/lucie-cowork/lucie-cowork.env` en prod (**pas** de `.env` lu par
  l'application en production) ; en base ils sont chiffrés AES-256-GCM avec `APP_SECRET` — changer
  cette clé rend les secrets illisibles.
- Pas de pixel de traçage dans les e-mails : les ouvertures et les clics ne sont volontairement pas
  suivis (RGPD). Un `unsubscribed` ou un `spam` coupe la prospection, pas les e-mails de service.
- Écris ou mets à jour les tests de ce que tu touches, et **lance-les**. Un test qui échoue se
  rapporte avec sa sortie, jamais masqué. Et un test de sécurité qui ne devient pas rouge quand on
  retire la garde qu'il vérifie ne teste rien.

## 5. Git

- `origin` = `Lokyron/Cowork-Software-Cazalia`. `old-lucie` = l'ancien dépôt `Lokyron/Lucie-Cowork`,
  gardé pour l'historique : **ne jamais y pousser**.
- Branche par défaut `main`. **`beta` est le canal que l'updater installe en production** : un commit
  poussé sur `beta` part chez les clients à la prochaine mise à jour. Travaille sur une branche de
  sujet.
- Messages de commit en français, à l'impératif, sujet sous 72 caractères.
- **Ne commite et ne pousse que si le propriétaire le demande.**

## 6. En fin de session — pour celui qui reprend

Avant de rendre la main, mets à jour ce qui a bougé :

| Fichier | Quand |
|---|---|
| `DOCUMENTATION.md` | Changement de stack, d'arborescence, d'environnement, d'endpoint ; et le §8 pour toute dette créée ou résorbée |
| `BRIEF.md` | Changement de périmètre ou de modèle de données |
| `AGENTS.md` (ce fichier) | Nouvelle règle non négociable, ou **nouveau piège rencontré** — la section 3 est la plus précieuse de ce fichier, nourris-la |
| `../Infra local/` | Changement de reverse proxy, de SSL, d'intégration Stripe |

Et laisse un état clair : ce qui est fait, ce qui est en cours, ce qui est cassé, ce que tu n'as pas
pu vérifier.
