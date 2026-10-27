# Plugin Stream Deck de Laterna

Les lectures en cours sur le Stream Deck (DECISIONS.md §120) : combien, qui regarde quoi, et le détail
de chacune. Lecture seule — le plugin ne peut rien changer dans Laterna.

## Installer

Il faut l'appli Stream Deck **7.6 ou plus** (Windows 10+ ou macOS 13+) : l'Infobar du Neo en dépend.

1. Double-cliquer sur [`release/fr.laterna.streamdeck.streamDeckPlugin`](release/fr.laterna.streamdeck.streamDeckPlugin).
   L'appli propose d'installer le profil « Laterna » livré avec le plugin : accepter.
2. Dans Laterna : *Gestion → Configuration → Administration → Stream Deck*. Nommer l'appareil,
   créer un jeton, le copier — il n'est montré qu'une fois. Un jeton par appareil ; il se révoque au
   même endroit.
3. Dans l'appli Stream Deck, catégorie **Laterna** : poser **Lectures** sur une page, ouvrir ses
   réglages, y coller l'adresse de Laterna et le jeton. Ils valent pour toutes les touches du plugin.

Une mise à jour s'installe de la même façon, par-dessus : les réglages sont gardés.

## Utiliser

- **Lectures** — le nombre de lectures en cours : gris quand personne ne regarde, blanc sinon,
  orange quand une lecture a un souci en ce moment (une attente, une erreur ou une reconstruction
  récentes ; le lecteur serveur est un chemin comme un autre, jamais un souci). Appuyer bascule
  sur la page des lectures.
- **La page des lectures** (profil « Laterna », huit touches **Case** et le **Bandeau** sur l'Infobar) :
  une lecture par touche — affiche, prénom, titre, progression ; une pastille orange pour un souci,
  ⏸ pour une pause. La dernière touche ramène à la page d'avant, ou passe à la suite au-delà de
  sept lectures. L'Infobar résume.
- **Une lecture**, appuyée, se détaille sur les huit touches :

  | 1 | 2 | 3 | 4 |
  |---|---|---|---|
  | titre et affiche | qui, appareil, application | position et % | chemin (Appareil, Serveur, Télé, Jellyfin) et image |
  | débit | incidents | son et sous-titres | ← retour |

  L'affiche ouvre l'Activité de Laterna dans le navigateur. Une lecture qui s'arrête ramène à la liste.

Tout se relit toutes les cinq secondes, tant qu'une touche Laterna est à l'écran. Les touches disent
quand ça ne passe pas : « Réglages » (adresse ou jeton manquants), « Jeton refusé », « Hors ligne ».

## Ce que le plugin contient

- `src/plugin.ts` — tout le plugin : la lecture de `/api/streamdeck/plays` avec le jeton, le dessin
  des touches (SVG) et de l'Infobar, la navigation entre la liste et le détail.
- `fr.laterna.streamdeck.sdPlugin/` — le dossier installé : `manifest.json`, la page de réglages
  (`ui/settings.html`), le gabarit de l'Infobar (`layouts/infobar.json`), les icônes (tirées de
  `tools/brand/`), et le profil `profiles/Laterna.streamDeckProfile`.
- **Le profil** a été créé dans l'appli Stream Deck puis exporté : son format n'est pas documenté, il
  ne se fabrique pas à la main. Pour le changer, le refaire dans l'appli (huit **Case** sur un Neo,
  **Bandeau** sur l'Infobar), l'exporter, et remplacer le fichier.

## Construire une nouvelle version

Sans Node sur l'hôte, par Docker, depuis ce dossier :

```sh
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/w -w /w node:24-alpine \
  sh -c 'npm ci && npx tsc --noEmit -p tsconfig.json && npx rollup -c \
         && npx streamdeck validate fr.laterna.streamdeck.sdPlugin \
         && npx streamdeck pack fr.laterna.streamdeck.sdPlugin --output dist --force'
cp dist/fr.laterna.streamdeck.streamDeckPlugin release/
```

Monter d'abord la version à deux endroits : `Version` dans `manifest.json` (`1.1.0.0`) et `version`
dans `package.json` (`1.1.0`). Le paquet de `release/` est celui qu'on installe : il se commite avec
les sources de la version qu'il contient.
