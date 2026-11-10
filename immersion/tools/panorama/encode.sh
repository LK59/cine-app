#!/bin/sh
# usage: tools/panorama/encode.sh <dir with far.png mid.png near.png> <outdir> [far_lambda] [mid_lambda]   (from immersion/)
# UASTC (RDO) + zstd, sRGB, with mipmaps, in the immersion-assets-tools image.
in=$1; out=$2; fl=${3:-1.0}; ml=${4:-1.0}
mkdir -p "$out"
enc() { # name format lambda
  docker run --rm --name "immersion-pano-ktx-$1" --cpus 3 --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/work -w /work \
    --entrypoint ktx immersion-assets-tools create --format "$2" --assign-tf srgb --generate-mipmap --threads 3 \
    --encode uastc --uastc-quality 2 --uastc-rdo --uastc-rdo-l "$3" --zstd 19 "$in/$1.png" "$out/$1.ktx2"
}
enc far R8G8B8_SRGB "$fl" &
enc mid R8G8B8A8_SRGB "$ml" &
enc near R8G8B8A8_SRGB "$ml" &
wait
ls -l "$out"/*.ktx2
