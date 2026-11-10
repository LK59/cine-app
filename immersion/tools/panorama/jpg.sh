#!/bin/sh
# usage: tools/panorama/jpg.sh in.png out.jpg [width] [quality]   (from immersion/)
exec docker run --rm --name "immersion-pano-jpg-$$" --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/work -w /work --entrypoint node immersion-assets-tools -e '
const sharp=require("sharp");let s=sharp(process.argv[1]);const w=+process.argv[3];if(w)s=s.resize(w);
s.removeAlpha().jpeg({quality:+(process.argv[4]||90)}).toFile(process.argv[2]).then(()=>0)' "$@"
