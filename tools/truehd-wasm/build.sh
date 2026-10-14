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
# Tout est figé : la version de FFmpeg et l'empreinte de son archive — relevée après vérification
# de la signature de l'équipe FFmpeg (clé FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8) —, et
# l'image emscripten.
#
# FFmpeg 7.1.5 depuis le 14/10/2026 (7.1.2 avant). Ce qu'il change ici, lu dans le diff des sources
# et non dans le Changelog : le correctif des masques de sous-flux de mlpdec (7.1.3, « don't depend
# on context channel layout when setting substream masks »). Ce module n'indique pas de disposition
# au décodeur : en 7.1.2, une piste TrueHD mono ou stéréo à un sous-flux ne rendait rien (masque
# vide, « invalid output channel »), et un TrueHD à deux sous-flux lisait le masque du 6 canaux à la
# première synchronisation. Mesuré avant/après sur les 65 pistes TrueHD de la bibliothèque
# (ffmpeg-wasm-regress-bench.spec.ts, DOC-TECH « Audio delivery ») : rien d'autre ne bouge. La
# branche 7.1 seulement — la 8 et la 9 changent bien plus que ce décodeur.
#
# Le résultat est reproductible à l'octet : deux constructions complètes, le 14/10/2026, ont donné
# la même empreinte, celle du fichier versionné (le 7.1.2 d'avant, reconstruit le même jour par ce
# script, retrouvait aussi la sienne, 1dc5424a…) —
#   b8d19dcd1aa7f221bf05fc7d29eb94b9c62e794d394e78d84aadd6271753fb71
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
cp "$HERE/truehd.c" "$HERE/compile.sh" "$WORK/"

# Dans le conteneur, avec l'utilisateur courant : le fichier produit lui appartient.
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e FFMPEG="$FFMPEG" \
  -v "$WORK":/work -w /work "$EMSDK" sh compile.sh

cp "$WORK/truehd-wasm.mjs" "$ROOT/src/lib/webcodecs/truehd/truehd-wasm.mjs"
sha256sum "$ROOT/src/lib/webcodecs/truehd/truehd-wasm.mjs"
