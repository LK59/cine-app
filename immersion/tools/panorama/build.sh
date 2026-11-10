#!/bin/sh
# Full render chain from the DEM mosaic (run from immersion/): 3 Cycles layers + coverage mask, post-processing, previews.
# Then: fit4.mjs, encode.sh and write_json.py — exact commands in README.md
set -e
d=assets-src/panorama/final; mkdir -p $d
tools/panorama/run.sh far 5 tools/panorama/render.py far $d/far.exr --samples ${FAR_SPP:-56}
tools/panorama/run.sh farc 5 tools/panorama/render.py far $d/far_cover.exr --mode cover
tools/panorama/run.sh mid 5 tools/panorama/render.py mid $d/mid.exr --samples ${NEAR_SPP:-64}
tools/panorama/run.sh near 5 tools/panorama/render.py near $d/near.exr --samples ${NEAR_SPP:-64}
tools/panorama/run.sh compose 5 tools/panorama/compose.py $d $d/out
mkdir -p tools/panorama/previews
tools/panorama/jpg.sh $d/out/previews/composite.png tools/panorama/previews/composite.jpg 4096 90
for v in main left right; do tools/panorama/jpg.sh $d/out/previews/${v}_view.png tools/panorama/previews/${v}_view.jpg 1600 92; done
