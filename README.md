# Tournamake

Application web pour créer et suivre des tableaux de tournoi (2 à 32 joueurs).

## Fichiers
| Fichier      | Rôle                                                        |
|--------------|-------------------------------------------------------------|
| `index.html` | Structure de la page (le contenu des écrans est généré en JS) |
| `style.css`  | Tous les styles (thèmes clair/sombre, tableau, mobile)       |
| `app.js`     | Toute la logique, organisée en sections numérotées en tête de fichier |

## Où modifier quoi
- Nombre maximum de joueurs, tailles, clés de stockage : constantes en haut de `app.js`.
- Couleurs et thèmes : variables en haut de `style.css`.
- Règles du tournoi (placement des joueurs, vainqueurs, exemptés) : section « Logique du tournoi » de `app.js`.
- Textes des fenêtres de confirmation : fonction `getDialogContent()`.

## Données
- Le tournoi en cours est enregistré dans le `localStorage` du navigateur (clé `tournamake-v1`).
- L'export produit un fichier `tournamake_<nom>_<date>_<heure>.json` (format version 2).
  L'import accepte aussi les fichiers de la version 1.
