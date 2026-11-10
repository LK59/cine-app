# Panorama de montagne de nuit (décor lointain)

Trois couches équirectangulaires (far / mid / near) rendues une seule fois avec Blender (Cycles, CPU) à partir
du modèle numérique de surface **Copernicus DEM GLO-30**, puis encodées en KTX2. Licence et mention
obligatoire : voir `ASSETS.md` (section « Autres assets ») et `tools/assets/extra-assets.json`.

Point de vue : replat de la Flégère (nord de la vallée de Chamonix), 45.9140 N, 6.8200 E, ~1823 m, caméra à 4 m
du sol, direction principale 152° (vers le massif du Mont-Blanc, vallée ~900 m plus bas). Tous les réglages
(point de vue, cap, lune, couleurs, couches, résolutions) sont en tête de `params.py`.

Toutes les commandes se lancent depuis `immersion/`. Aucun Node ni Python sur l'hôte n'est requis, hormis
`python3 -I` pour deux petits scripts ; tout le reste tourne dans Docker (conteneurs `immersion-blender-*` /
`immersion-pano-*`, `--rm`, 5 cœurs).

```sh
# 0. Images Docker (Blender 4.5 LTS ; l'image d'outils KTX2 est celle de tools/assets)
docker build -t immersion-blender tools/blender
docker build -t immersion-assets-tools tools/assets          # si absente

# 1. Données d'altitude : 4 tuiles 1°x1° (sans identifiant), ~165 Mo, dans assets-src/ (non versionné)
mkdir -p assets-src/panorama/dem && cd assets-src/panorama/dem
for t in N45_00_E006 N45_00_E007 N46_00_E006 N46_00_E007; do
  curl -fsSO "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_${t}_00_DEM/Copernicus_DSM_COG_10_${t}_00_DEM.tif"; done
curl -fsSO https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N45_00_E006_00_DEM/INFO/eula_F.pdf   # la licence
cd ../../..

# 2. Mosaïque float32 (7200 x 7200) lue avec tifffile dans le Python de Blender
tools/panorama/run.sh mosaic 4 tools/panorama/mosaic.py

# 2b. (facultatif) l'analyse numérique qui a choisi le point de vue
tools/panorama/run.sh vp 5 tools/panorama/viewpoint.py

# 3. Rendu des trois couches + masque de couverture, post-traitement (ciel, étoiles, ton, alpha), aperçus
#    (~35 min sur 5 cœurs ; FAR_SPP / NEAR_SPP règlent les échantillons)
tools/panorama/build.sh

# 4. KTX2 (UASTC + RDO + zstd, sRGB, mipmaps) et panorama.json
# hauteurs ramenées à un multiple de 4 (exigé par les textures compressées : sinon la couche s'affiche noire)
docker run --rm --name immersion-pano-fit --cpus 3 --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/work -w /work \
  --entrypoint node immersion-assets-tools tools/panorama/fit4.mjs assets-src/panorama/final/out assets-src/panorama/final/fit4
tools/panorama/encode.sh assets-src/panorama/final/fit4 public/assets/panorama 1.5 1.0
python3 -I tools/panorama/write_json.py
python3 -I tools/assets/gen-assets-md.py
```

Fichiers : `mosaic.py` (tuiles -> tableau), `viewpoint.py` (recherche du point de vue), `render.py` (scène Blender :
anneaux de terrain 3 / 10 / 30 / 160 m de pas avec micro-relief procédural, matériau neige / roche / forêt, brume
dans le shader, lumières du village, découpe par distance), `compose.py` (ciel + étoiles + halo de lune en post,
mappage de tons, couleurs prolongées sous l'alpha, PNG 8 bits, contrôle de composition, vues en perspective),
`encode.sh`, `write_json.py`, `jpg.sh`, `run.sh`.

Choix à connaître :
- Convention des images : la direction principale est au centre, l'azimut croît vers la droite, rangée du haut = +32°
  (vérifié avec des repères à des directions connues). Hauteur de -28° à +32°.
- Découpe par distance : dans le shader, un rayon caméra hors de [de, à] devient transparent et traverse. La couche
  far ne contient donc pas le terrain proche ; sous les pixels masqués, le décor est rempli d'une couleur de brume
  (masque de couverture `far_cover`), jamais du ciel.
- Ciel, étoiles et halo de lune ne sont pas rendus par Cycles (le débruiteur effacerait les étoiles) mais calculés
  dans `compose.py`. Le disque de la lune (élévation 38°) est au-dessus du cadrage (+32°) : seul son halo entre
  dans l'image.
- Rien n'est plus proche que 120 m : l'application dessine son propre premier plan.
