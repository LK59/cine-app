#!/bin/sh
# Construit src/lib/webcodecs/aac/aac-wasm.mjs : le décodeur AAC natif de FFmpeg, compilé en
# WebAssembly, en un seul fichier (le binaire y est inclus en base64).
#
#   sh tools/aac-wasm/build.sh        (depuis la racine du dépôt ; Docker seulement)
#
# Le jumeau de tools/truehd-wasm/build.sh, avec la même version de FFmpeg, la même empreinte
# d'archive (vérifiée le 21/09/2026 contre la signature de l'équipe FFmpeg, clé FCF9 86EA 15E6 E293
# A564 4F10 B432 2F04 D676 58D8) et la même image emscripten. Un module à part plutôt qu'un ajout
# au TrueHD : le fichier TrueHD versionné, mesuré canal par canal contre ffmpeg, reste identique à
# l'octet — aucun risque pour ce qui marche déjà.
#
# Empreinte du fichier versionné, relevée à sa construction (11/10/2026) : voir la sortie de la
# dernière ligne, reportée dans DOC-TECH.md « Audio delivery ».
set -eu

FFMPEG=ffmpeg-7.1.2
SHA256=089bc60fb59d6aecc5d994ff530fd0dcb3ee39aa55867849a2bbc4e555f9c304
EMSDK=emscripten/emsdk:4.0.15

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

curl -sSL -o "$WORK/$FFMPEG.tar.xz" "https://ffmpeg.org/releases/$FFMPEG.tar.xz"
echo "$SHA256  $WORK/$FFMPEG.tar.xz" | sha256sum -c -
cp "$HERE/aac.c" "$HERE/compile.sh" "$WORK/"

docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e FFMPEG="$FFMPEG" \
  -v "$WORK":/work -w /work "$EMSDK" sh compile.sh

mkdir -p "$ROOT/src/lib/webcodecs/aac"
cp "$WORK/aac-wasm.mjs" "$ROOT/src/lib/webcodecs/aac/aac-wasm.mjs"
sha256sum "$ROOT/src/lib/webcodecs/aac/aac-wasm.mjs"
