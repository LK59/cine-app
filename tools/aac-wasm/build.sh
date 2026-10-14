#!/bin/sh
# Construit src/lib/webcodecs/aac/aac-wasm.mjs : le décodeur AAC natif de FFmpeg, compilé en
# WebAssembly, en un seul fichier (le binaire y est inclus en base64).
#
#   sh tools/aac-wasm/build.sh        (depuis la racine du dépôt ; Docker seulement)
#
# Le jumeau de tools/truehd-wasm/build.sh, avec la même version de FFmpeg, la même empreinte
# d'archive (vérifiée contre la signature de l'équipe FFmpeg, clé FCF9 86EA 15E6 E293 A564 4F10
# B432 2F04 D676 58D8) et la même image emscripten. Un module à part plutôt qu'un ajout au TrueHD :
# le fichier TrueHD versionné, mesuré canal par canal contre ffmpeg, ne dépend pas de celui-ci.
#
# FFmpeg 7.1.5 depuis le 14/10/2026 (7.1.2 avant), en même temps que le TrueHD. Pour l'AAC, le diff
# des sources entre les deux ne touche que des chemins d'erreur : le use-after-free USAC (7.1.4 :
# tag_che_map vidé quand un élément est libéré), une trame sans fréquence refusée (7.1.5) et les
# contrôles de la configuration USAC. Ni l'extension de hauteur du PCE ni le HE-AAC 960 de la 8.x.
# Mesuré avant/après (ffmpeg-wasm-regress-bench.spec.ts) : même son, à l'octet, sur toutes les
# pistes AAC essayées, PCE compris.
#
# Empreinte du fichier versionné : voir la sortie de la dernière ligne, reportée dans DOC-TECH.md
# « Audio delivery ». Deux constructions complètes, le 14/10/2026, ont donné la même.
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
cp "$HERE/aac.c" "$HERE/compile.sh" "$WORK/"

docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e FFMPEG="$FFMPEG" \
  -v "$WORK":/work -w /work "$EMSDK" sh compile.sh

mkdir -p "$ROOT/src/lib/webcodecs/aac"
cp "$WORK/aac-wasm.mjs" "$ROOT/src/lib/webcodecs/aac/aac-wasm.mjs"
sha256sum "$ROOT/src/lib/webcodecs/aac/aac-wasm.mjs"
