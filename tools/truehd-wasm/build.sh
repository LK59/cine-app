#!/bin/sh
# Construit src/lib/webcodecs/truehd/truehd-wasm.mjs : le décodeur TrueHD/MLP de FFmpeg, compilé
# en WebAssembly, en un seul fichier (le binaire y est inclus en base64).
#
#   sh tools/truehd-wasm/build.sh        (depuis la racine du dépôt ; Docker seulement)
#
# Pourquoi le résultat est versionné plutôt que construit à chaque image : la chaîne emscripten
# pèse 3 Go et quatre-vingt-dix secondes, pour un fichier qui ne change que si l'on change de
# version de FFmpeg. Ce script est là pour qu'on puisse le refaire à l'identique, et vérifier que
# le fichier du dépôt vient bien d'ici.
#
# Tout est figé : la version de FFmpeg et l'empreinte de son archive — relevée le 21/09/2026 après
# vérification de la signature de l'équipe FFmpeg (clé FCF9 86EA 15E6 E293 A564 4F10 B432 2F04
# D676 58D8) —, et l'image emscripten.
#
# Le résultat est reproductible à l'octet : deux constructions complètes, le 21/09/2026, ont donné
# la même empreinte, celle du fichier versionné —
#   1dc5424a8bb5119cdedf4626fc787c525a4c5e10e9e615975e7afbc528f87318
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
cp "$HERE/truehd.c" "$HERE/compile.sh" "$WORK/"

# Dans le conteneur, avec l'utilisateur courant : le fichier produit lui appartient.
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e FFMPEG="$FFMPEG" \
  -v "$WORK":/work -w /work "$EMSDK" sh compile.sh

cp "$WORK/truehd-wasm.mjs" "$ROOT/src/lib/webcodecs/truehd/truehd-wasm.mjs"
sha256sum "$ROOT/src/lib/webcodecs/truehd/truehd-wasm.mjs"
