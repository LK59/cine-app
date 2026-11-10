# Assets de l'Immersion

Tout ce qui est listé ici est sous licence **CC0 1.0** (domaine public) : on peut l'utiliser, le modifier et le redistribuer sans condition, même pour un usage commercial. La mention de l'auteur n'est pas obligatoire, mais on la garde par courtoisie.

Les sources sont toutes sur [Poly Haven](https://polyhaven.com), qui publie uniquement du CC0. Aucun autre site ni aucune autre licence.

Ce fichier est généré : ne pas l'éditer à la main. Il vient de `tools/assets/manifest.json` et des fiches `assets-src/*/info.json`. Pour le refaire : `python3 -I tools/assets/gen-assets-md.py`. Les commandes pour tout reconstruire sont dans `tools/assets/README.md`.

Poids total de `public/assets/` : **28.3 Mo**.

## Textures (15)

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
| Metal Plate 02 (`metal_black`) | [metal_plate_02](https://polyhaven.com/a/metal_plate_02) | Rob Tuytel | CC0 1.0 | Fer forgé noir (cadres, pieds, accessoires). | `textures/metal_black/` : color, normal, arm (.ktx2), 0.5 Mo |
| Pine Bark (`bark`) | [pine_bark](https://polyhaven.com/a/pine_bark) | Dimitrios Savva | CC0 1.0 | Écorce de conifère (troncs dehors). | `textures/bark/` : color, normal, arm (.ktx2), 0.7 Mo |

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
- `metal_black` : [black_painted_planks](https://polyhaven.com/a/black_painted_planks), [worn_shutter](https://polyhaven.com/a/worn_shutter)
- `bark` : [knotted_pine_bark](https://polyhaven.com/a/knotted_pine_bark), [japanese_cedar_bark](https://polyhaven.com/a/japanese_cedar_bark)

## Modèles 3D (19)

| Nom | Source | Auteur(s) | Licence | Usage | Fichiers produits |
|---|---|---|---|---|---|
| Modern Coffee Table 01 (`modern_coffee_table_01`) | [modern_coffee_table_01](https://polyhaven.com/a/modern_coffee_table_01) | Amin | CC0 1.0 | Table basse du salon. | `models/modern_coffee_table_01/modern_coffee_table_01.gltf` + .bin + 3 .ktx2, 4504 triangles, 0.5 Mo |
| Modern Coffee Table 02 (`modern_coffee_table_02`) | [modern_coffee_table_02](https://polyhaven.com/a/modern_coffee_table_02) | Amin | CC0 1.0 | Table basse (variante). | `models/modern_coffee_table_02/modern_coffee_table_02.gltf` + .bin + 6 .ktx2, 13645 triangles, 1.1 Mo |
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
| Ottoman 01 (`Ottoman_01`) | [Ottoman_01](https://polyhaven.com/a/Ottoman_01) | Caspian Fortune | CC0 1.0 | Pouf. | `models/Ottoman_01/Ottoman_01.gltf` + .bin + 3 .ktx2, 4240 triangles, 0.7 Mo |
| Hanging Picture Frame 02 (`hanging_picture_frame_02`) | [hanging_picture_frame_02](https://polyhaven.com/a/hanging_picture_frame_02) | James Ray Cock | CC0 1.0 | Cadre accroché au mur. | `models/hanging_picture_frame_02/hanging_picture_frame_02.gltf` + .bin + 6 .ktx2, 3678 triangles, 0.3 Mo |
| Bar Chair Round 01 (`bar_chair_round_01`) | [bar_chair_round_01](https://polyhaven.com/a/bar_chair_round_01) | Dairon Sanchez | CC0 1.0 | Tabouret de bar rond. | `models/bar_chair_round_01/bar_chair_round_01.gltf` + .bin + 3 .ktx2, 14373 triangles, 1.1 Mo |
| Vintage Day Bed (`vintage_day_bed`) | [vintage_day_bed](https://polyhaven.com/a/vintage_day_bed) | Aron Łyczek | CC0 1.0 | Banquette-lit ancienne. | `models/vintage_day_bed/vintage_day_bed.gltf` + .bin + 3 .ktx2, 2715 triangles, 0.7 Mo |
| Classic Nightstand 01 (`ClassicNightstand_01`) | [ClassicNightstand_01](https://polyhaven.com/a/ClassicNightstand_01) | Kirill Sannikov | CC0 1.0 | Table de chevet. | `models/ClassicNightstand_01/ClassicNightstand_01.gltf` + .bin + 3 .ktx2, 2002 triangles, 0.2 Mo |
| Wooden Lantern 01 (`wooden_lantern_01`) | [wooden_lantern_01](https://polyhaven.com/a/wooden_lantern_01) | James Ray Cock | CC0 1.0 | Lanterne en bois. | `models/wooden_lantern_01/wooden_lantern_01.gltf` + .bin + 6 .ktx2, 7600 triangles, 0.5 Mo |

Géométrie compressée en meshopt, textures en KTX2 (aucune ressource embarquée). La page doit donc fournir un décodeur meshopt et un transcodeur KTX2.

## Ciels (HDRI) (5)

| Nom | Source | Auteur(s) | Licence | Usage | Fichiers produits |
|---|---|---|---|---|---|
| Qwantani Night (Pure Sky) (`qwantani_night_puresky`) | [qwantani_night_puresky](https://polyhaven.com/a/qwantani_night_puresky) | Greg Zaal, Jarod Guest | CC0 1.0 | Ciel de nuit étoilé (candidat principal). | `hdri/qwantani_night_puresky.hdr`, `hdri/qwantani_night_puresky_bg.jpg`, 1.7 Mo |
| Kloppenheim 02 (Pure Sky) (`kloppenheim_02_puresky`) | [kloppenheim_02_puresky](https://polyhaven.com/a/kloppenheim_02_puresky) | Greg Zaal, Jarod Guest | CC0 1.0 | Ciel clair de fin de soirée. | `hdri/kloppenheim_02_puresky.hdr`, `hdri/kloppenheim_02_puresky_bg.jpg`, 1.6 Mo |
| Qwantani Moonrise (Pure Sky) (`qwantani_moonrise_puresky`) | [qwantani_moonrise_puresky](https://polyhaven.com/a/qwantani_moonrise_puresky) | Greg Zaal, Jarod Guest | CC0 1.0 | Lever de lune. | non construit |
| Rogland Clear Night (`rogland_clear_night`) | [rogland_clear_night](https://polyhaven.com/a/rogland_clear_night) | Greg Zaal | CC0 1.0 | Nuit claire avec horizon. | non construit |
| Moonlit Golf (`moonlit_golf`) | [moonlit_golf](https://polyhaven.com/a/moonlit_golf) | Greg Zaal | CC0 1.0 | Paysage de nuit éclairé par la lune. | non construit |

Le `.hdr` (1k) sert à l'éclairage. Le `_bg.jpg` (4096 px de large) sert de ciel visible.
