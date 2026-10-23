# Icônes et écrans de lancement

Toutes les images de marque de `public/` sont produites par `generate.mjs` depuis les SVG de ce
dossier. Aucune n'est retouchée à la main : pour changer le logo, changer les SVG puis relancer.

```sh
docker run --rm --name cine-logo-brand -v "$PWD":/app -v "$PWD/node_modules":/app/node_modules \
  -w /app node:24-alpine node tools/brand/generate.mjs
```

(Depuis la racine du dépôt ; `sharp` est celui de l'application. Sans `node_modules` sur l'hôte,
monter celui d'une copie qui l'a, ou lancer la commande dans l'image de l'application.)

| Source | Produit |
|---|---|
| `icon.svg` | `public/icon.svg`, `icon-192.png`, `icon-512.png`, le logo des 42 `splash/apple-splash-*.png` |
| `icon-flat.svg` (carré plein, sans coins) | `public/icon-flat.svg`, `apple-touch-icon.png` (180, opaque) |
| `icon-maskable.svg` (dessin dans la zone sûre de 80 %) | `icon-maskable-512.png` (opaque) |
| `icon-32.svg` | `public/favicon.svg`, `favicon-32.png` |
| `icon-16.svg`, `icon-48.svg` | variantes de petite taille, gardées pour une sortie de 16 px ou de 48 à 95 px (aucune aujourd'hui) |
| `badge.svg` (silhouette blanche) | `badge-96.png`, le badge des notifications Android |

Les écrans de lancement gardent les noms et les dimensions des fichiers déjà présents dans
`public/splash/` (le script régénère chacun d'eux) : fond `#0a0a0c`, l'icône seule au centre, 28 %
du petit côté. Le glyphe sans fond utilisé dans l'interface est le composant `BrandMark`
(`src/components/BrandMark.tsx`), qui reprend le faisceau et la barre de `icon.svg`.
