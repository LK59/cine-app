# Plugin Stream Deck de Laterna

Les lectures en cours sur le Stream Deck (DECISIONS.md §120) : combien, qui regarde quoi, et le détail
de chacune. Lecture seule.

## Actions

- **Lectures** — le nombre de lectures en cours (gris : aucune ; blanc ; orange : une lecture a un
  souci en ce moment). Appuyer ouvre la page des lectures : le profil « Laterna » livré avec le plugin
  (`profiles/Laterna.streamDeckProfile`, exporté de l'appli Stream Deck — huit « Case » et le
  « Bandeau » sur un Neo). Sur une autre page, la touche ← y ramène.
- **Case** — une touche de la page des lectures ; sa place sur l'appareil décide ce qu'elle montre.
  En liste : une lecture par touche (affiche, prénom, titre, progression), la dernière touche pour
  revenir (ou pour la page suivante au-delà de sept lectures). Sur une lecture : titre, qui et sur
  quoi, position, chemin et image, débit, incidents, son et sous-titres, retour.
- **Bandeau** — l'Infobar du Stream Deck Neo : le résumé de la page (Stream Deck 7.6 ou plus).

## Construire

Sans Node sur l'hôte, par Docker :

```sh
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/w -w /w node:24-alpine \
  sh -c 'npm ci && npx tsc --noEmit -p tsconfig.json && npx rollup -c \
         && npx streamdeck validate fr.laterna.streamdeck.sdPlugin \
         && npx streamdeck pack fr.laterna.streamdeck.sdPlugin --output dist --force'
```

Le paquet est `dist/fr.laterna.streamdeck.streamDeckPlugin` : un double-clic l'installe.

## Régler

Dans Laterna, Configuration → Administration → Stream Deck : nommer l'appareil, créer un jeton, le
copier (il n'est montré qu'une fois). Dans l'appli Stream Deck, ouvrir les réglages d'une touche
Laterna et y coller l'adresse et le jeton — ils valent pour toutes les touches du plugin.
