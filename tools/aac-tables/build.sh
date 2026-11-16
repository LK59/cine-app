#!/bin/sh
# Construit src/lib/lumenServer/audio/aacTables.ts : les livres de Huffman et les bandes de l'AAC, tirés
# de libavcodec/aactab.c de FFmpeg. Lumen serveur en a besoin pour lire un raw_data_block AAC jusqu'à ses
# éléments FIL (le SBR implicite, DECISIONS.md §159) — sans rien décoder.
#
#   sh tools/aac-tables/build.sh        (depuis la racine du dépôt ; Docker seulement)
#
# La même archive que tools/aac-wasm et tools/truehd-wasm (FFmpeg 7.1.5, même empreinte, vérifiée contre la
# signature de l'équipe FFmpeg). Le fichier écrit doit être identique à celui du dépôt : `git diff` le dit.
set -eu

FFMPEG=ffmpeg-7.1.5
SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

curl -sSL -o "$WORK/$FFMPEG.tar.xz" "https://ffmpeg.org/releases/$FFMPEG.tar.xz"
echo "$SHA256  $WORK/$FFMPEG.tar.xz" | sha256sum -c -
tar -xf "$WORK/$FFMPEG.tar.xz" -C "$WORK" "$FFMPEG/libavcodec/aactab.c"
cp "$HERE/generate.mjs" "$WORK/"

docker run --rm -u "$(id -u):$(id -g)" -v "$WORK":/work -w /work node:26-alpine \
  node generate.mjs "$FFMPEG/libavcodec/aactab.c" aacTables.ts

mkdir -p "$ROOT/src/lib/lumenServer/audio"
cp "$WORK/aacTables.ts" "$ROOT/src/lib/lumenServer/audio/aacTables.ts"
