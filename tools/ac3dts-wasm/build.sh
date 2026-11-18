#!/bin/sh
# Construit src/lib/webcodecs/ac3dts/ac3dts-wasm.mjs : les décodeurs AC-3, E-AC3 et DTS de FFmpeg
# 7.1.5, en WebAssembly — essai demux-son du 19/11/2026, sur le modèle exact de tools/truehd-wasm
# (même FFmpeg vérifié, même image emscripten).
set -eu

FFMPEG=ffmpeg-7.1.5
SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
EMSDK=emscripten/emsdk:4.0.15

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

curl -sSL -o "$WORK/$FFMPEG.tar.xz" "https://ffmpeg.org/releases/$FFMPEG.tar.xz"
echo "$SHA256  $WORK/$FFMPEG.tar.xz" | sha256sum -c -
cp "$HERE/ac3dts.c" "$HERE/compile.sh" "$WORK/"

# Dans le conteneur, avec l'utilisateur courant : le fichier produit lui appartient.
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e FFMPEG="$FFMPEG" \
  -v "$WORK":/work -w /work "$EMSDK" sh compile.sh

cp "$WORK/ac3dts-wasm.mjs" "$ROOT/src/lib/webcodecs/ac3dts/ac3dts-wasm.mjs"
sha256sum "$ROOT/src/lib/webcodecs/ac3dts/ac3dts-wasm.mjs"
