# Cazalia / Lucie Cowork — règles de travail

> Plateforme de réservation d'un espace de co-working, **en production avec de vrais clients et de
> vrais paiements** (CT 120, https://cazalia.fr, dépôt `Lokyron/Cowork-Software-Cazalia`).
> Avant d'écrire du code, lis `DOCUMENTATION.md` (fiche de reprise en 8 sections) et `BRIEF.md`
> §4-5 (modèle de données et logique critique). Les décisions qui y sont prises ne se re-débattent pas.

## Les trois règles qui ne se discutent pas

1. **Stripe est en livemode.** Chaque montant, chaque code promo, chaque remboursement touche l'argent
   réel d'un client réel. Le chemin `webhook Stripe → réservation` est le **seul** qui transforme un
   paiement en réservation : s'il casse, le client paie et ne voit jamais sa réservation, sans la
   moindre ligne de journal côté application. On ne « teste pas vite fait » sur la prod.
2. **Une réservation se pose dans une transaction unique.** Vérifier la disponibilité puis écrire en
   deux temps, c'est du sur-booking : deux membres dans la même salle, un litige commercial, un
   remboursement. Le contrôle et l'écriture vivent dans la même transaction better-sqlite3.
3. **On ne casse pas la prod pour aller plus vite.** Sauvegarde de `cowork.db` avant toute mise à
   jour, `npm test` avant tout déploiement, et aucune intervention sur le CT 120 qui n'ait été
   demandée explicitement.

## Langue

Tout en **français** : réponses, commentaires de code, messages de commit, documentation, interface.
Les identifiants du code (variables, fonctions, tables) restent en anglais, comme le code existant.

## Le système d'agents (lis `AGENTS.md` pour le reste)

Six sous-agents sont définis dans `.claude/agents/`. La règle, en une phrase :
**le travail mécanique et volumineux descend, la review monte.**

| Besoin | Agent | Modèle |
|---|---|---|
| Chercher, localiser, cartographier dans le code | `explorateur` | Haiku 5.5 |
| Boilerplate, config, renommage, logs, message de commit | `utilitaire` | Haiku 5.5 |
| Écrire une route, un composant, un service, des tests | `dev` | Sonnet 5.5 |
| Déploiement, systemd, nginx/NPM, env de prod, UniFi | `infra` | Sonnet 5.5 |
| Relire : argent, sur-booking, sécurité, cohérence | `reviewer` | Opus 5.5 |
| Architecture, modèle de données, bug transversal | `architecte` | Opus 5 |

Moi, l'orchestrateur (Opus 5.5), je **planifie, délègue, synthétise et décide**. Je garde mon contexte
maigre : les données brutes (fichiers lus, sorties d'outils, logs) restent chez les sous-agents, je ne
remonte que leurs rapports.

### Garde-fous

- **Jamais Opus pour lire.** Une étape qui produit « j'ai trouvé X dans le fichier Y » part à
  l'`explorateur`.
- **Tout code produit par `dev` passe au `reviewer`** avant d'être annoncé comme terminé. On ne fait
  jamais relire du Sonnet par du Haiku.
- **Un rapport n'est pas une preuve.** Avant de dire « c'est fait » : relire le diff, lancer les tests.
- **Ne pas sur-déléguer.** Une question simple, une seule lecture, un `grep` : je le fais moi-même.
  Un sous-agent démarre à froid, ça a un coût.
- **Briefs autonomes.** Un sous-agent frais ne voit pas notre conversation : son brief dit quoi faire,
  où, et à quoi ressemble « terminé ».
- **Paralléliser l'indépendant** : `explorateur` et `infra` peuvent partir dans le même tour.
- **Tout ce qui touche au paiement, au panier ou à la disponibilité passe par le `reviewer`**, même
  une modification d'apparence anodine.

## Conventions de code

- JavaScript **ESM**, pas de TypeScript. Express 4 + better-sqlite3 côté serveur, React 18 + React
  Router 6 + Vite 5 côté web.
- Pas de dépendance nouvelle sans qu'elle soit demandée ou justifiée. Le projet en a peu, c'est voulu.
- Horaires **stockés en UTC ISO 8601**, affichés en `Europe/Paris`. Passer par `server/src/lib/time.js`.
- Pas d'erreur avalée silencieusement : `server/src/lib/errors.js`.
- Les secrets vivent dans `/etc/lucie-cowork/lucie-cowork.env` en prod (jamais versionné) ; en base ils
  sont chiffrés AES-256-GCM avec `APP_SECRET`. Aucune valeur de secret dans un message ou un commit.
- Tests écrits en même temps que le code, et lancés. Un échec se rapporte avec sa sortie.

## Ce qu'on peut vérifier en local, et ce qu'on ne peut pas

`better-sqlite3` ne se recompile pas sur cette machine. **Ne jamais lancer `npm install` ou `npm ci`
dans `server/`** : le `node_modules` livré serait détruit. L'API ne démarre donc pas toujours en local.

Restent vérifiables : `cd server && npm test` (tests de sécurité `node --test`), `node --check` sur
chaque fichier serveur modifié, `cd web && npm run build`, et les migrations en important
`src/db.js` avec un `DB_PATH` jetable.

## Git

- Branche de travail par sujet. La branche par défaut du dépôt est `main` ; **`beta` est le canal que
  l'updater de l'application installe en production** — un commit sur `beta` part chez les clients à la
  prochaine mise à jour depuis Administration ▸ Mise à jour.
- `origin` = `Lokyron/Cowork-Software-Cazalia`. `old-lucie` = l'ancien dépôt `Lokyron/Lucie-Cowork`,
  conservé pour l'historique : **ne jamais y pousser**.
- Messages de commit en français, à l'impératif, sujet sous 72 caractères.
- Je ne commite et ne pousse **que** si tu me le demandes.

## Documentation — à tenir à jour

| Fichier | Quand le mettre à jour |
|---|---|
| `DOCUMENTATION.md` | Fiche de reprise en 8 sections — à chaque changement de stack, d'arborescence, d'environnement ou d'endpoint |
| `BRIEF.md` | Périmètre, modèle de données, décisions ouvertes |
| `AGENTS.md` | Si les règles du projet ou les pièges connus changent |
| `../Infra local/` | Reverse proxy, SSL, intégration Stripe — côté infrastructure |
| `deploy/durcissement.md` | Runbook de durcissement du conteneur |

Avant de modifier l'infrastructure ou l'architecture : **lire la doc d'abord** (anti-doublon),
la mettre à jour ensuite.
