# Canapé en U (Blender en ligne de commande)

Modèle original, entièrement généré par script. Aucune texture, aucune source tierce.
Sortie : `public/assets/models/sofa/sofa.gltf` + `sofa.bin` (géométrie meshopt) + `sofa.json`.

Meshes (un seul matériau chacun, l'application pose ses matériaux d'après le nom) :
`sofa_frame`, `sofa_cushions`, `pillows_a` (5), `pillows_b` (4). Repère glTF : X est, Y haut, Z sud.
UV0 à l'échelle du monde : 1 unité = 1 m de tissu. Pas de tangentes, pas de couleurs de sommet.

Toutes les commandes se lancent depuis `immersion/`. Prérequis : les images Docker
`immersion-blender` (`docker build -t immersion-blender tools/blender`) et
`immersion-assets-tools` (`docker build -t immersion-assets-tools tools/assets`).

```sh
# 1. Construire la géométrie (≈ 20 s) : assets-src/sofa/sofa_raw.gltf (+ .bin, .blend, stats.json)
docker run --rm --name immersion-sofa-build --cpus 5 --user $(id -u):$(id -g) -e HOME=/tmp \
  -v "$PWD":/work immersion-blender -b --python tools/sofa/build_sofa.py -- assets-src/sofa

# 2. Optimiser (dedup, prune, weld, meshopt) et vérifier : écrit public/assets/models/sofa/*
#    L'argument est la hauteur d'assise (affichée par l'étape 1 sur la ligne SEATTOP, moyenne).
sh tools/sofa/finalize.sh 0.482

# 3. Aperçus Cycles (CPU, ≈ 2,5 min chacun à 64 échantillons) : tools/sofa/previews/*.jpg
docker run --rm --name immersion-sofa-render --cpus 5 --user $(id -u):$(id -g) -e HOME=/tmp \
  -v "$PWD":/work immersion-blender -b --python tools/sofa/render_sofa.py -- \
  assets-src/sofa/sofa_raw.gltf tools/sofa/previews front,three_quarter,close_cushions,top 64
```

## Fichiers

- `build_sofa.py` : tout le modèle. Les cotes réglables sont des constantes en tête de fichier.
- `optimize.mjs` : retire les textures de remplissage (voir plus bas), dedup/prune/weld/reorder,
  quantifie NORMAL et TEXCOORD_0 (les positions restent en float32, donc aucun nœud ne porte de
  transformation), compresse en `EXT_meshopt_compression`.
- `verify.mjs` : relit le fichier final, affiche triangles et boîte englobante par mesh (repère glTF)
  et écrit `sofa.json`.
- `finalize.sh` : enchaîne `optimize.mjs` et `verify.mjs` dans `immersion-assets-tools`.
- `render_sofa.py` : aperçus (lin procédural, lumière chaude, sol neutre). `top.jpg` porte une grille de 1 m.

## Technique

- Coussins : boîte arrondie sur un maillage non uniforme (lignes serrées dans les arrondis),
  projection ellipsoïdale des coins, puis déformations déterministes : gonflement pondéré par face
  (dessus bombé, bords comprimés), affaissement du bord avant, fossette et « oreilles » des coussins
  de dossier, plis rayonnant des coins, ondulation basse fréquence, gauchissement du contour.
  Chaque coussin a sa graine. Passepoil : tube de 5 faces le long de la boucle de crête de la face visible.
- Coque : profil arrondi balayé le long du U (bords bombés), terminaisons en dôme. Accoudoirs : boîtes arrondies. Socle en retrait.
- Coussins décoratifs : deux feuilles jointes par une arête vive, bords tirés vers l'intérieur, coins
  qui tombent ; posés par un petit solveur de contact (recherche par `BVHTree`) : le coussin est lâché
  verticalement, puis rapproché du dossier jusqu'au dernier endroit où il touche encore l'assise.
- Pas de simulation de tissu : le résultat est reproductible bit à bit (graine `SEED`).
- Blender n'écrit TEXCOORD_0 que si le matériau échantillonne une texture : chaque matériau de
  remplissage a donc un nœud image de 1 px, que `optimize.mjs` retire ensuite.
- Le script vérifie qu'aucun coussin du même type ne traverse son voisin (`SAME-KIND CUSHION OVERLAPS`).
