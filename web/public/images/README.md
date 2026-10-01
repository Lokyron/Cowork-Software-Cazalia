# Photos de la landing page

Dépose ici les photos du lieu. Tant qu'un fichier est absent, un cadre
« 📷 Photo à venir » s'affiche automatiquement à la place (aucune erreur).

Les fichiers sont servis tels quels par Vite/Nginx sous `/images/...`.

## Fichiers attendus

| Fichier | Emplacement sur le site | Format conseillé |
|---|---|---|
| `hero.jpg` | Grande image d'ambiance en haut de page | paysage, ≥ 1920×1080, < 500 Ko |
| `presentation.jpg` | Section « Le lieu » | paysage 4:3, ≥ 1200 px |
| `espace-1.jpg`, `espace-2.jpg`, … | Une par espace, dans l'ordre d'affichage | paysage 16:10, ≥ 1000 px |
| `galerie-1.jpg` … `galerie-6.jpg` | Grille de la galerie | carré 1:1, ≥ 800×800 |

## Conseils
- Privilégier le **JPEG** (ou WebP) optimisé pour le web pour des temps de chargement courts.
- Garder les noms exacts ci-dessus (sensibles à la casse).
- Après ajout des fichiers, relancer `npm run build` (ou copier dans `dist/images/` sur le serveur).

> Le nombre de cartes « espaces » suit les espaces créés en base : `espace-1.jpg`
> correspond au 1er espace listé, etc. Le texte (adresse, horaires, contact) se
> modifie dans `web/src/pages/Landing.jsx`.
