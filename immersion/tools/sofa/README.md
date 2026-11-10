# Canapé en U (Blender en ligne de commande)

Modèle original, entièrement généré par script. Aucune texture, aucune source tierce.
Sortie : `public/assets/models/sofa/sofa.gltf` + `sofa.bin` (géométrie meshopt) + `sofa.json`.

Meshes (un seul matériau chacun, l'application pose ses matériaux d'après le nom) :
`sofa_frame`, `sofa_cushions`, `pillows_a` (5), `pillows_b` (4), `plaid` (plaid en laine, frange aux deux bouts courts ; le matériau doit être double face pour la frange). Repère glTF : X est, Y haut, Z sud.
UV0 à l'échelle du monde : 1 unité = 1 m de tissu (plaid : U = longueur développée du drapé, V = largeur, sans déformation). UV1 (`TEXCOORD_1`) : atlas de lightmap unique, non chevauchant, partagé par tous les meshes (marge 8 px à 1024, ≈ 63 % rempli). Pas de tangentes, pas de couleurs de sommet.
`assets-src/sofa/sofa_bake.glb` : copie non compressée (mêmes sommets, même ordre que `sofa.gltf`) pour cuire la lightmap.

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
- Plis : creux rayonnant des coins (2 à 4 par coin), plis de tirage le long du bord avant, creux d'assise décentré,
  plis horizontaux des dossiers là où ils fléchissent, ondulation basse fréquence ; chaque coussin a sa graine.
- Coussins décoratifs : oreilles pincées, creux « karaté » ou fossette sur certains, deux écrasés, couture (tube) sur l'arête.
- Plaid : colonnes de profil lues par lancers de rayons sur les coussins (hauteur vue du dessus, dilatée), lissées et poussées hors du
  canapé, puis plis sortants uniquement ; deux feuilles qui se rejoignent au bord, frange en peigne. `PLAID_ZC` règle sa position.
- UV1 : coutures (coin de chaque coussin, dessous des tubes, bord des feuilles), dépliage, échelle moyenne par aire 3D, empaquetage concave
  (`LIGHTMAP_MARGIN`), le plaid et les coussins décoratifs gardent leur paramétrage propre (aucun chevauchement).
- Le script vérifie qu'aucun coussin du même type ne traverse son voisin (`SAME-KIND CUSHION OVERLAPS`).
