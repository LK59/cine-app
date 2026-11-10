#!/bin/sh
# Optimise assets-src/sofa/sofa_raw.gltf -> public/assets/models/sofa/sofa.gltf (+ sofa.bin), meshopt.
# Run from immersion/ :  sh tools/sofa/finalize.sh <seatHeight>
set -e
SEAT="${1:-0}"
OUT=public/assets/models/sofa
mkdir -p "$OUT" assets-src/sofa/tmp
rm -f "$OUT"/sofa.gltf "$OUT"/sofa.bin
run() { docker run --rm --name immersion-sofa-gt --cpus 5 --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/work immersion-assets-tools "$@"; }
run sh -c '
set -e
cd /work/assets-src/sofa
gltf-transform dedup sofa_raw.gltf tmp/a.gltf
gltf-transform prune tmp/a.gltf tmp/b.gltf
gltf-transform weld tmp/b.gltf tmp/c.gltf
gltf-transform meshopt tmp/c.gltf /work/public/assets/models/sofa/sofa.gltf --level high --quantize-position 14 --quantize-normal 10 --quantize-texcoord 14
cd /work
ls -l public/assets/models/sofa
gltf-transform inspect public/assets/models/sofa/sofa.gltf
node tools/sofa/verify.mjs public/assets/models/sofa/sofa.gltf '"$SEAT"'
'
