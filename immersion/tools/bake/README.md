# Cuisson de la lumière (lightmaps)

Le chalet est rendu avec une lumière **cuite** : Blender (Cycles, CPU) calcule l'éclairement diffus direct + indirect de
chaque surface, la page le lit comme `lightMap` (second jeu d'UV). Presque aucune lumière temps réel.

    tools/bake/bake.sh                                  # tout : salon, sud, nuit (+ sofa si le fichier existe), encodage, aperçus
    tools/bake/bake.sh --only nuit --samples 64          # un seul atlas
    tools/bake/bake.sh --only sofa --sofa assets-src/sofa/sofa_bake.glb
    tools/bake/bake.sh --layers nuit                     # une seule couche (les UV doivent rester ceux du passage précédent)
    tools/bake/bake.sh --calibrate                       # refait l'étalonnage seul (et l'affiche)
    tools/bake/bake.sh --exposure -1.5 --no-preview      # exposition des aperçus / pas d'aperçu

Depuis `immersion/`. Options : `--only a,b` (groupes `salon`, `sud`, `nuit`, `sofa`), `--sofa fichier.glb` (défaut
`assets-src/sofa/sofa_bake.glb`, utilisé s'il existe), `--samples N` (défaut 128, adaptatif), `--margin PX` (marge de
rangement, défaut 6 px à la taille de l'atlas), `--layers nuit,lampes` (défaut : les deux), `--calibrate`, `--exposure EV`, `--no-preview`.
Prérequis : les images Docker `immersion-blender` et `immersion-assets-tools` ; les entrées de `tools/bake/export.sh`
(`assets-src/bake/scene.json` + OBJ). Les conteneurs s'appellent `immersion-bake-*`, `--rm`, `--cpus 5`.

Durée (machine partagée, charge 30+) : voir le rapport de livraison ; ordre de grandeur 2 s par échantillon pour un atlas
2048², soit ~6 min pour `salon` à 192 échantillons, ~4 min pour `sud`, ~1,5 min pour `nuit`, ~1 min pour `sofa`, plus l'encodage.

## Ce que fait `bake.py`

1. **Géométrie.** Chaque OBJ est lu à la main (pas d'importeur) : sommet i = ligne `v` i, boucle i = sommet i, triangle k =
   boucles 3k..3k+2, sans fusion ni validation. Relecture par boucle, comparée aux lignes `v` (écart < 1e-4 m) et aux sondes
   de `scene.json` (≤ 1 mm) : le script s'arrête sinon. Le vrai canapé (`--sofa`) remplace les occluders de `salon`.
   Tous les groupes sont présents dans chaque cuisson (rebonds d'une pièce à l'autre), plus un sol de neige (albedo
   0,8/0,85/0,95, Y = −0,07, 600 m) non cuit.
2. **Repère.** glTF (X est, Y haut, Z sud) → Blender (Z haut) par `(x, y, z) → (x, −z, y)`, identique pour les positions et
   les directions de lumière (rotation propre : l'orientation des faces ne change pas).
3. **Dépliage.** Smart UV Project (66°) sur une copie soudée par position (la soupe de triangles n'a aucune topologie), densité
   uniforme (moyenne des îlots par aire 3D), îlots `metal` à moitié de densité linéaire, puis rangement de tous les maillages du
   groupe dans un seul atlas (`pack_islands`, marge 6 px). Les UV sont recopiés sur la soupe, boucle par boucle. Calque `lightmap`.
4. **Cuisson.** Cycles « Diffuse », Direct + Indirect, sans couleur, un matériau diffus d'albedo `albedo` par maillage (les
   rebonds portent la teinte), 4 rebonds diffus, marge « extend » 6 px, échantillonnage adaptatif, rayon indirect borné à 50.
5. **Débruitage.** OpenImageDenoise (nœud Denoise du compositeur, HDR, préfiltre précis) sur l'image flottante ; les pixels
   hors îlots et marges sont remis à zéro.
6. **Écriture.** `E / range` (range = 64), clampé 0..1, sRGB 8 bits, PNG haut en bas (`assets-src/bake/work/<g>.png`), puis
   `ktx create` (UASTC qualité 2 + RDO + zstd 18 + mipmaps, clamp) ; le lambda de RDO monte (1, 3, 6, 10, …) jusqu'au budget
   (2,3 Mo pour 2048², 0,7 Mo pour 1024²). `uv.bin` : Uint16 little-endian (u, v) par sommet de l'OBJ, maillages à la suite
   dans l'ordre de `scene.json`. `assemble.py` écrit `lightmaps.json`.

## Unités et étalonnage (`--calibrate`)

Le stocké vaut E/range, E étant l'éclairement en unités de la page (point : I·cosθ/d², soleil : S·cosθ, ciel : `irradiance`
sur une face tournée vers le haut). La valeur de la cuisson d'un blanc, `b`, vaut E/π : E = b·π. L'étalonnage cuit un plan
blanc de 4 m (256², 256 échantillons, sans adaptatif) avec une lumière ponctuelle d'intensité 1 à 1 m, un soleil d'intensité 1 en
incidence normale, le ciel seul d'éclairement 1, lit le texel central et en tire (le tout est linéaire) :

| | facteur Blender / unité de la page | vérification après correction |
|---|---|---|
| point | 12,56889 W par unité d'intensité (≈ 4π) | E = 1,0000 |
| soleil | 1,00000 (force Blender = intensité) | 1,0000 |
| ciel | 0,31831 (≈ 1/π, force du fond × couleur) | 1,0000 |

Ils sont écrits dans `assets-src/bake/work/calibration.json` (refait automatiquement s'il manque) et recopiés dans
`lightmaps.json` (`lights`). Le ciel est le fond uniforme `sky.color` × `sky.irradiance` × facteur, par canal.

## Orientation de l'image (flipY = false)

La page échantillonne avec `flipY = false` : v = 0 est la PREMIÈRE ligne (haut) du fichier. L'image de Blender a son origine
en bas à gauche. Donc : `v_page = 1 − v_blender` dans `uv.bin`, et le PNG est écrit de haut en bas (`np.flipud` des pixels de
Blender). À chaque cuisson, `verify_flip` relit le PNG écrit avec les UV de `uv.bin` (6 000 sommets) et l'image de Blender avec
`v_b = 1 − v` : écart moyen 0/255, contre 15 à 49/255 si le sens était inversé (le script s'arrête sinon). Les aperçus
reconstruisent les UV depuis `uv.bin` (v_b = 1 − v) et relisent le PNG, c'est-à-dire ce que la page recevra (hors transcodage KTX2).

Le canapé (`sofa`) garde son second jeu d'UV (`lightmap` / `TEXCOORD_1`), que l'importeur glTF de Blender convertit
(v_b = 1 − v_glTF) ; l'image est écrite de la même façon, donc relue par la page avec les UV d'origine du glTF. Il n'est pas redéplié.

## Aperçus (`tools/bake/previews/`)

`<g>_atlas.jpg` : chaque atlas, éclairci (99e centile à 0,8). `entree`, `balcon`, `cuisine`, `chambre`, `escalier` : 1600×900,
68° vertical, matériau d'émission = lightmap × albedo / π, aucune lumière, AgX, exposition −1,5 EV. Ce que la lightmap seule
montre : pas de reflets, pas de verre, pas de ciel (le noir des fenêtres est le fond), pas de texture.

## Fichiers

`assets-src/bake/work/` (ignoré par git) : PNG, `.bu.npy`, JSON par atlas, `calibration.json`. `public/assets/lightmaps/` :
`<g>.ktx2`, `<g>.uv.bin`, `lightmaps.json` seulement.

## Limites connues

- 8 bits sRGB de E/64 : les éclairements faibles (≈ 0,05) tombent à 2–3 niveaux ; le bleu de la lune sur un sol sombre est
  quantifié grossièrement (c'est le format demandé).
- Densité de texels ~25–33/m (3–4 cm) : tous les côtés de toutes les poutres reçoivent la même densité, visibles ou non.
- Le débruitage n'a pas de guide d'albedo/normale : de très fines ombres (3 px) peuvent être un peu adoucies.

## Le canapé : coutures adoucies

La lightmap du canapé passe par une dilatation des clairs (trois texels, `ffmpeg` de la machine) avant son
encodage : ses coutures, cuites presque noires sur un ou deux texels, dessinaient des traits sombres en
pointillé le long des coussins. Le PNG d'origine reste dans `assets-src/bake/work/sofa_brut.png`.

## Deux couches de lumière (nuit / lampes)

Chaque atlas est cuit deux fois sur les mêmes UV (dépliage et rangement faits une seule fois) :

| couche | lumières allumées | fichier |
|---|---|---|
| `nuit` | les lumières `"layer": "nuit"` de `scene.json` (la lune, les bougies) + le ciel | `<atlas>.ktx2` |
| `lampes` | les lumières `"layer": "lampes"` (lustre, lampadaires, suspensions, mezzanine, appliques, chevets), ciel éteint | `<atlas>_lampes.ktx2` |

Sans clé `layer` dans l'export : la lune et les noms qui commencent par `bougie` sont `nuit`, le reste `lampes`. Toute la géométrie
(occluders, canapé, sol de neige) est présente dans les deux cuissons ; une couche éteint les lumières de l'autre en mettant leur
énergie à zéro (`hide_render` n'était pas relu d'une cuisson à l'autre dans la même session de Blender). La page additionne les deux :
`E = E_nuit + k · E_lampes` (k = 1 plein feu, 0,15 « cinéma », 0 lampes éteintes).

**Portée par couche et par atlas**, tirée des données : 99,9e centile de l'éclairement (canal max, texels cuits) × 1,25, arrondi à la
puissance de deux supérieure, borné à [2, 128] ; au-dessus, écrêté. Le journal de cuisson donne le centile, la portée et le nombre de
texels écrêtés ; `lightmaps.json` donne les portées. Le fichier `uv.bin` est commun. `lightmaps.json` : `range` (ancien champ) = portée
de la couche nuit du premier atlas ; par atlas `texture` = couche nuit et `layers: { nuit: { texture, range }, lampes: { texture, range } }`
(aussi pour `sofa`). Budgets KTX2 : 1,8 Mo par 2048², 0,45 Mo par 1024² (0,7 Mo pour le canapé) (`assemble.py` signale un total au-dessus de 9 Mo).

Si l'on ne cuit qu'une couche (`--layers`), l'autre n'est conservée que si le dépliage est identique (empreinte des UV dans
`assets-src/bake/work/<atlas>.json`) ; sinon elle est retirée de `lightmaps.json` et son KTX2 supprimé.
Le canapé : les deux PNG sont dilatés (ffmpeg) avant l'encodage.

Aperçus : `<vue>.jpg` = nuit + lampes à pleine puissance ; `<vue>_cinema.jpg` = lampes à 15 % ; `<atlas>_atlas.jpg` et
`<atlas>_lampes_atlas.jpg`.
