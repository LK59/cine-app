# Pipeline des assets

Tout part de `manifest.json` (source unique : un bloc par texture, modèle ou ciel).
Rien ne s'installe sur la machine hôte : Node tourne dans Docker, le téléchargement
utilise seulement `python3` (bibliothèque standard).

Toutes les commandes se lancent depuis le dossier `immersion/` (la racine de ce projet).

## Tout reconstruire de zéro

```sh
# 1. L'image d'outils (KTX-Software 4.4.2 + gltf-transform 4.5.1 + sharp)
docker build -t immersion-assets-tools tools/assets

# 2. Télécharger les sources brutes dans assets-src/ (ignoré par git)
python3 -I tools/assets/fetch.py

# 3. Convertir vers public/assets/ (textures, modèles, ciels) + public/assets/manifest.json
tools/assets/build.sh --jobs 2

# 4. Planches-contact de relecture (tools/assets/previews/*.jpg)
docker run --rm --name immersion-assets-previews --cpus 6 --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/repo -e IMMERSION_ROOT=/repo immersion-assets-tools node /repo/tools/assets/previews.mjs

# 5. ASSETS.md (tableau des crédits, en français)
python3 -I tools/assets/gen-assets-md.py
```

Options de `build.sh` : `--only id,id` (certains assets), `--force` (refaire même si la
sortie existe), `--jobs N` (assets en parallèle, 2 par défaut ; ne pas dépasser ~6 cœurs).
Compter une dizaine de minutes pour tout.

## Formats produits

- Textures : `public/assets/textures/<id>/{color,normal,arm}.ktx2`
  - `color` : sRGB, ETC1S (BasisLZ), qualité 220 ;
  - `normal` : convention OpenGL, linéaire, UASTC + RDO + zstd (repli ETC1S q255 si > 2,5 Mo) ;
  - `arm` : occlusion (R), rugosité (V), métal (B), linéaire, ETC1S ;
  - mipmaps générés avec bouclage (`--mipmap-wrap wrap`) pour que la texture se répète sans couture.
- Modèles : `public/assets/models/<id>/<id>.gltf` + `.bin` + `.ktx2` séparés, géométrie meshopt,
  rien d'embarqué (le chargeur doit donc avoir un décodeur meshopt et un transcodeur KTX2).
  Chaîne : dedup, prune, weld, simplify (si `maxTriangles` est dépassé), resize, UASTC (normale, seulement si `normalCodec: "uastc"`),
  ETC1S (le reste, normale comprise par défaut, q255), meshopt.
- Ciels : `public/assets/hdri/<id>.hdr` (1k, éclairage) et `<id>_bg.jpg` (4096 px, qualité 80, fond visible).
  Un asset marqué `contactOnly` n'apparaît que sur la planche-contact.

`public/assets/manifest.json` liste chaque fichier produit avec sa taille (et les triangles des modèles).

## Options du manifeste

`id`, `kind` (`textures` | `model` | `hdri`), `source` (`polyhaven`), `slug`, `resolution`, `out`,
et selon le cas : `textureSize`, `maxTriangles`, `alphaMaps` (carte d'opacité à fondre dans la couleur),
`bgWidth`, `alternates` (autres choix, pour la planche-contact), `contactOnly`, `skip` (raison).

## Licences

Uniquement du CC0. Voir `ASSETS.md` à la racine.
