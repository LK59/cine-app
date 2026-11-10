# Assets de l'Immersion

Tout ce qui est listé dans les sections Poly Haven est sous licence **CC0 1.0** (domaine public) : on peut l'utiliser, le modifier et le redistribuer sans condition, même pour un usage commercial. La mention de l'auteur n'est pas obligatoire, mais on la garde par courtoisie.

Les textures et les modèles viennent de [Poly Haven](https://polyhaven.com), qui publie uniquement du CC0. Le reste est décrit dans la section « Autres assets » en bas : le panorama de montagne (une licence différente, avec une mention obligatoire), le canapé (création du projet) et les polices (OFL).

Ce fichier est généré : ne pas l'éditer à la main. Il vient de `tools/assets/manifest.json` et des fiches `assets-src/*/info.json`. Pour le refaire : `python3 -I tools/assets/gen-assets-md.py`. Les commandes pour tout reconstruire sont dans `tools/assets/README.md`.

Poids total de `public/assets/` : **21.3 Mo**.

## Textures (13)

| Nom | Source | Auteur(s) | Licence | Usage | Fichiers produits |
|---|---|---|---|---|---|
| Old Wooden Floor 02 (`wood_floor`) | [old_wooden_floor_02](https://polyhaven.com/a/old_wooden_floor_02) | Charlotte Baglioni, Jenelle van Heerden | CC0 1.0 | Parquet : sol du grand salon (planches longues, brun foncé verni). | `textures/wood_floor/` : color, normal, arm (.ktx2), 3.1 Mo |
| Dark Wood (`wood_beam`) | [dark_wood](https://polyhaven.com/a/dark_wood) | Dario Barresi, Dimitrios Savva, Rico Cilliers | CC0 1.0 | Grosses poutres du toit et poteaux (fil du bois dans un seul sens). | `textures/wood_beam/` : color, normal, arm (.ktx2), 2.5 Mo |
| Wooden Planks (`wood_planks_ceiling`) | [wooden_planks](https://polyhaven.com/a/wooden_planks) | Dario Barresi, Charlotte Baglioni | CC0 1.0 | Plafond et lambris des murs (lames chaudes). | `textures/wood_planks_ceiling/` : color, normal, arm (.ktx2), 0.4 Mo |
| Rustic Stone Wall 02 (`stone_wall`) | [rustic_stone_wall_02](https://polyhaven.com/a/rustic_stone_wall_02) | Amal Kumar | CC0 1.0 | Mur en pierre autour du grand écran. | `textures/stone_wall/` : color, normal, arm (.ktx2), 2.7 Mo |
| Slate Floor 02 (`stone_slab`) | [slate_floor_02](https://polyhaven.com/a/slate_floor_02) | Dimitrios Savva | CC0 1.0 | Dessus du banc devant la cheminée (dalle de schiste). | `textures/stone_slab/` : color, normal, arm (.ktx2), 0.5 Mo |
| Hessian 380 (`fabric_sofa`) | [hessian_380](https://polyhaven.com/a/hessian_380) | colormass, Rico Cilliers | CC0 1.0 | Tissu beige des canapés. | `textures/fabric_sofa/` : color, normal, arm (.ktx2), 0.7 Mo |
| Poly Wool Herringbone (`fabric_pillow`) | [poly_wool_herringbone](https://polyhaven.com/a/poly_wool_herringbone) | colormass, Rico Cilliers | CC0 1.0 | Coussins (tissu plus sombre, à chevrons). | `textures/fabric_pillow/` : color, normal, arm (.ktx2), 0.7 Mo |
| Curly Teddy Natural (`rug`) | [curly_teddy_natural](https://polyhaven.com/a/curly_teddy_natural) | colormass, Rico Cilliers | CC0 1.0 | Tapis de laine beige. | `textures/rug/` : color, normal, arm (.ktx2), 0.7 Mo |
| Beige Wall 002 (`plaster`) | [beige_wall_002](https://polyhaven.com/a/beige_wall_002) | Dimitrios Savva, Rico Cilliers | CC0 1.0 | Murs en plâtre crème, légèrement rugueux. | `textures/plaster/` : color, normal, arm (.ktx2), 0.2 Mo |
| Snow 02 (`snow`) | [snow_02](https://polyhaven.com/a/snow_02) | Rob Tuytel | CC0 1.0 | Neige fraîche au sol dehors. | `textures/snow/` : color, normal, arm (.ktx2), 0.6 Mo |
| Brown Leather (`leather`) | [brown_leather](https://polyhaven.com/a/brown_leather) | Rob Tuytel | CC0 1.0 | Cuir brun (fauteuils, détails). | `textures/leather/` : color, normal, arm (.ktx2), 0.7 Mo |
| Granite Tile (`counter_stone`) | [granite_tile](https://polyhaven.com/a/granite_tile) | Charlotte Baglioni | CC0 1.0 | Plan de travail de la cuisine (granit sombre). | `textures/counter_stone/` : color, normal, arm (.ktx2), 0.5 Mo |
| Jogging Melange (`linen_white`) | [jogging_melange](https://polyhaven.com/a/jogging_melange) | colormass, Rico Cilliers | CC0 1.0 | Linge de lit blanc / crème. | `textures/linen_white/` : color, normal, arm (.ktx2), 0.6 Mo |

Chaque texture existe en trois cartes : `color` (sRGB), `normal` (convention OpenGL) et `arm` (occlusion en rouge, rugosité en vert, métal en bleu).

Alternatives écartées (au cas où on change d'avis) :

- `wood_floor` : [plank_flooring_04](https://polyhaven.com/a/plank_flooring_04), [old_wooden_floor_03](https://polyhaven.com/a/old_wooden_floor_03)
- `wood_beam` : [stained_pine](https://polyhaven.com/a/stained_pine), [rough_wood](https://polyhaven.com/a/rough_wood)
- `wood_planks_ceiling` : [wood_planks](https://polyhaven.com/a/wood_planks), [coated_pine_02](https://polyhaven.com/a/coated_pine_02)
- `stone_wall` : [stacked_stone_wall](https://polyhaven.com/a/stacked_stone_wall), [rock_wall_08](https://polyhaven.com/a/rock_wall_08)
- `stone_slab` : [slate_floor](https://polyhaven.com/a/slate_floor), [stone_tiles_02](https://polyhaven.com/a/stone_tiles_02)
- `fabric_sofa` : [curly_teddy_natural](https://polyhaven.com/a/curly_teddy_natural), [polar_fleece](https://polyhaven.com/a/polar_fleece)
- `fabric_pillow` : [knitted_fleece](https://polyhaven.com/a/knitted_fleece), [wool_boucle](https://polyhaven.com/a/wool_boucle)
- `rug` : [hessian_230](https://polyhaven.com/a/hessian_230), [polar_fleece](https://polyhaven.com/a/polar_fleece)
- `plaster` : [plastered_wall_04](https://polyhaven.com/a/plastered_wall_04), [white_stucco](https://polyhaven.com/a/white_stucco)
- `snow` : [snow_01](https://polyhaven.com/a/snow_01), [snow_floor](https://polyhaven.com/a/snow_floor)
- `leather` : [fabric_leather_01](https://polyhaven.com/a/fabric_leather_01), [leather_red_02](https://polyhaven.com/a/leather_red_02)
- `counter_stone` : [granite_tile_03](https://polyhaven.com/a/granite_tile_03), [granite_tile_04](https://polyhaven.com/a/granite_tile_04)
- `linen_white` : [terlenka](https://polyhaven.com/a/terlenka), [curly_teddy_natural](https://polyhaven.com/a/curly_teddy_natural)

## Modèles 3D (15)

| Nom | Source | Auteur(s) | Licence | Usage | Fichiers produits |
|---|---|---|---|---|---|
| Side Table 01 (`side_table_01`) | [side_table_01](https://polyhaven.com/a/side_table_01) | James Ray Cock | CC0 1.0 | Table d'appoint à côté des canapés. | `models/side_table_01/side_table_01.gltf` + .bin + 3 .ktx2, 2756 triangles, 0.2 Mo |
| Potted Plant 01 (`potted_plant_01`) | [potted_plant_01](https://polyhaven.com/a/potted_plant_01) | Rico Cilliers | CC0 1.0 | Plante en pot. | `models/potted_plant_01/potted_plant_01.gltf` + .bin + 6 .ktx2, 7775 triangles, 0.6 Mo |
| Potted Plant 02 (`potted_plant_02`) | [potted_plant_02](https://polyhaven.com/a/potted_plant_02) | Rico Cilliers | CC0 1.0 | Plante en pot (variante). | `models/potted_plant_02/potted_plant_02.gltf` + .bin + 6 .ktx2, 7830 triangles, 0.5 Mo |
| Ceramic Vase 01 (`ceramic_vase_01`) | [ceramic_vase_01](https://polyhaven.com/a/ceramic_vase_01) | James Ray Cock | CC0 1.0 | Vase en céramique. | `models/ceramic_vase_01/ceramic_vase_01.gltf` + .bin + 3 .ktx2, 7598 triangles, 0.2 Mo |
| Ceramic Vase 03 (`ceramic_vase_03`) | [ceramic_vase_03](https://polyhaven.com/a/ceramic_vase_03) | James Ray Cock | CC0 1.0 | Vase en céramique (variante). | `models/ceramic_vase_03/ceramic_vase_03.gltf` + .bin + 3 .ktx2, 7598 triangles, 0.3 Mo |
| Wooden Bowl 01 (`wooden_bowl_01`) | [wooden_bowl_01](https://polyhaven.com/a/wooden_bowl_01) | Oliver Harries | CC0 1.0 | Bol en bois décoratif. | `models/wooden_bowl_01/wooden_bowl_01.gltf` + .bin + 3 .ktx2, 7600 triangles, 0.3 Mo |
| Lantern 01 (`Lantern_01`) | [Lantern_01](https://polyhaven.com/a/Lantern_01) | Rajil Jose Macatangay | CC0 1.0 | Lanterne en laiton. | `models/Lantern_01/Lantern_01.gltf` + .bin + 3 .ktx2, 7634 triangles, 0.3 Mo |
| Wooden Candlestick (`wooden_candlestick`) | [wooden_candlestick](https://polyhaven.com/a/wooden_candlestick) | Josh Dean | CC0 1.0 | Bougeoir en bois. | `models/wooden_candlestick/wooden_candlestick.gltf` + .bin + 3 .ktx2, 7599 triangles, 0.3 Mo |
| Mantel Clock 01 (`mantel_clock_01`) | [mantel_clock_01](https://polyhaven.com/a/mantel_clock_01) | Yann Kervran, Rico Cilliers | CC0 1.0 | Horloge posée sur la cheminée. | `models/mantel_clock_01/mantel_clock_01.gltf` + .bin + 3 .ktx2, 7597 triangles, 0.3 Mo |
| Modern Arm Chair 01 (`modern_arm_chair_01`) | [modern_arm_chair_01](https://polyhaven.com/a/modern_arm_chair_01) | Vibrant Nordic | CC0 1.0 | Fauteuil moderne. | `models/modern_arm_chair_01/modern_arm_chair_01.gltf` + .bin + 6 .ktx2, 8916 triangles, 1.0 Mo |
| Mid Century Lounge Chair (`mid_century_lounge_chair`) | [mid_century_lounge_chair](https://polyhaven.com/a/mid_century_lounge_chair) | Kuutti Siitonen | CC0 1.0 | Fauteuil lounge des années 50. | `models/mid_century_lounge_chair/mid_century_lounge_chair.gltf` + .bin + 3 .ktx2, 6148 triangles, 0.7 Mo |
| Hanging Picture Frame 02 (`hanging_picture_frame_02`) | [hanging_picture_frame_02](https://polyhaven.com/a/hanging_picture_frame_02) | James Ray Cock | CC0 1.0 | Cadre accroché au mur. | `models/hanging_picture_frame_02/hanging_picture_frame_02.gltf` + .bin + 6 .ktx2, 3678 triangles, 0.3 Mo |
| Bar Chair Round 01 (`bar_chair_round_01`) | [bar_chair_round_01](https://polyhaven.com/a/bar_chair_round_01) | Dairon Sanchez | CC0 1.0 | Tabouret de bar rond. | `models/bar_chair_round_01/bar_chair_round_01.gltf` + .bin + 3 .ktx2, 14373 triangles, 1.1 Mo |
| Vintage Day Bed (`vintage_day_bed`) | [vintage_day_bed](https://polyhaven.com/a/vintage_day_bed) | Aron Łyczek | CC0 1.0 | Banquette-lit ancienne. | `models/vintage_day_bed/vintage_day_bed.gltf` + .bin + 3 .ktx2, 2715 triangles, 0.7 Mo |
| Wooden Lantern 01 (`wooden_lantern_01`) | [wooden_lantern_01](https://polyhaven.com/a/wooden_lantern_01) | James Ray Cock | CC0 1.0 | Lanterne en bois. | `models/wooden_lantern_01/wooden_lantern_01.gltf` + .bin + 6 .ktx2, 7600 triangles, 0.5 Mo |

Géométrie compressée en meshopt, textures en KTX2 (aucune ressource embarquée). La page doit donc fournir un décodeur meshopt et un transcodeur KTX2.

## Ciels (HDRI) (0)

| Nom | Source | Auteur(s) | Licence | Usage | Fichiers produits |
|---|---|---|---|---|---|

Le `.hdr` (1k) sert à l'éclairage. Le `_bg.jpg` (4096 px de large) sert de ciel visible.

## Autres assets (hors Poly Haven)

Ces assets ne sont pas CC0. Chacun a sa licence et, quand elle l'exige, une mention à reproduire à l'identique.

### Panorama alpin de nuit (Chamonix, vue vers le massif du Mont-Blanc) (`panorama`)

- Contenu : Images rendues avec Blender (Cycles) à partir du modèle numérique de surface Copernicus DEM GLO-30 (30 m) : trois couches équirectangulaires (far, mid, near) en KTX2. Le relief est celui des données, le ciel, la neige, la forêt, la lune et les lumières du village sont procéduraux. Ce n'est donc pas un fichier de la source mais une image rendue, dérivée (adaptée) de ces données.
- Source : Copernicus DEM GLO-30 (COP-DEM-GLO-30), tuiles N45_00_E006, N45_00_E007, N46_00_E006, N46_00_E007, https://copernicus-dem-30m.s3.amazonaws.com/ (jeu de données public AWS « Copernicus DEM », sans identifiant)
- Licence : [Licence Copernicus WorldDEM-30 (instance COP-DEM-GLO-30-F : « Full, Free & Open »)](https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N45_00_E006_00_DEM/INFO/eula_F.pdf)
- Ce que la licence permet et demande : Droits non exclusifs, gratuits, mondiaux et sans limite de durée : reproduction, distribution, communication au public, adaptation, modification et combinaison avec d'autres données (article 4). Obligations (article 6) : citer la source avec la mention ci-dessous quand les données sont adaptées, ajouter la phrase de non-responsabilité, ne pas laisser croire à un soutien officiel, et imposer ces obligations aux utilisateurs suivants. Aucun droit sur les marques ou logos du fournisseur.
- Mention obligatoire (à reproduire telle quelle, en anglais) : « produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved »
- Phrase de non-responsabilité obligatoire : « The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30 »
- Dérivé : Image rendue (adaptation) : pas une redistribution des données d'altitude. Les tuiles brutes restent dans assets-src/ (non versionné).
- Usage : Décor lointain vu par la grande baie : trois couches (far, mid, near) pour la parallaxe.
- Fichiers : `public/assets/panorama/far.ktx2`, `public/assets/panorama/mid.ktx2`, `public/assets/panorama/near.ktx2`, `public/assets/panorama/panorama.json`, 4.5 Mo

### Canapé d'angle en U avec coussins (sofa_frame, sofa_cushions, pillows_a, pillows_b) (`sofa`)

- Contenu : Modèle 3D original, généré par script (Blender en ligne de commande, géométrie calculée en numpy) : coque, accoudoirs et socle, 24 coussins d'assise et de dossier avec passepoil, 9 coussins décoratifs. Aucune texture (UV0 à l'échelle du monde : 1 unité = 1 m de tissu).
- Source : original — generated by tools/sofa/build_sofa.py, tools/sofa/README.md (dans ce dépôt)
- Licence : [same as the repository](LICENSE (à la racine du dépôt))
- Ce que la licence permet et demande : Création originale du projet : aucune source tierce, la licence est celle du dépôt.
- Mention obligatoire (à reproduire telle quelle, en anglais) : « Aucune mention obligatoire. »
- Phrase de non-responsabilité obligatoire : « Aucune. »
- Dérivé : Non : aucun modèle ou donnée tiers n'est utilisé.
- Usage : Le grand canapé en U du salon, face au grand écran (gabarit exact : voir public/assets/models/sofa/sofa.json).
- Fichiers : `public/assets/models/sofa/sofa.bin`, `public/assets/models/sofa/sofa.gltf`, `public/assets/models/sofa/sofa.json`, 1.6 Mo

### Polices Inter et Outfit (sous-ensembles latins, WOFF2) (`fonts`)

- Contenu : Deux polices variables servies par la page elle-même (aucune requête vers un service de polices) : Inter pour les textes, Outfit pour le logo et les titres.
- Source : Inter (Rasmus Andersson) ; Outfit (The Outfit Project Authors), https://github.com/rsms/inter ; https://github.com/Outfitio/Outfit-Fonts
- Licence : [SIL Open Font License 1.1](public/fonts/OFL-Inter.txt, public/fonts/OFL-Outfit.txt (dans ce dépôt))
- Ce que la licence permet et demande : Utilisation, copie, intégration et redistribution libres, y compris avec un logiciel, tant que la licence et les mentions de droits accompagnent les fichiers et que les polices ne sont pas vendues seules.
- Mention obligatoire (à reproduire telle quelle, en anglais) : « Les deux fichiers de licence sont servis à côté des polices. »
- Phrase de non-responsabilité obligatoire : « Aucune. »
- Dérivé : Sous-ensembles non modifiés.
- Usage : L'interface du mode : accueil, menu, réglages, panneau.
- Fichiers : `public/fonts/OFL-Inter.txt`, `public/fonts/OFL-Outfit.txt`, `public/fonts/inter-latin-ext.woff2`, `public/fonts/inter-latin.woff2`, `public/fonts/outfit-latin.woff2`, 0.2 Mo

### Musique d'ambiance de la chaîne hi-fi : « Lobby Time », « Bossa Antigua » (Kevin MacLeod) (`music`)

- Contenu : Deux morceaux de jazz calme, ré-encodés en AAC mono 64 kb/s (niveau normalisé, métadonnées retirées) à partir des MP3 publiés par l'auteur. Joués en boucle par la chaîne hi-fi du chalet, à faible niveau.
- Source : Kevin MacLeod — incompetech.com (ISRC USUAN1600054, USUAN1700069), https://incompetech.com/music/royalty-free/ (fichiers : mp3-royaltyfree/Lobby Time.mp3, mp3-royaltyfree/Bossa Antigua.mp3)
- Licence : [Creative Commons Attribution 4.0 International (CC BY 4.0) — la licence « Creative Commons » gratuite du site, qui demande de créditer la musique](https://creativecommons.org/licenses/by/4.0/ ; conditions du site : https://incompetech.com/music/royalty-free/licenses/)
- Ce que la licence permet et demande : Utilisation, copie, adaptation et redistribution libres, y compris à but commercial, à condition de créditer l'auteur, d'indiquer la licence et de signaler les modifications. Ici : conversion en mono et ré-encodage.
- Mention obligatoire (à reproduire telle quelle, en anglais) : « « Lobby Time », « Bossa Antigua » — Kevin MacLeod (incompetech.com). Licensed under Creative Commons: By Attribution 4.0 License, http://creativecommons.org/licenses/by/4.0/ — mention reprise dans les réglages du mode. »
- Phrase de non-responsabilité obligatoire : « Aucune. »
- Dérivé : Oui : mono, AAC 64 kb/s, niveau normalisé. Les MP3 d'origine restent dans assets-src/music/ (non versionné).
- Usage : Le fond musical que les platines du salon et de la chambre mettent en marche ; il se tait pendant un film.
- Fichiers : `public/assets/music/bossa-antigua.mp4`, `public/assets/music/lobby-time.mp4`, 3.9 Mo
