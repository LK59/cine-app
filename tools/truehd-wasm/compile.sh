#!/bin/sh
# Lancé par build.sh dans l'image emscripten, dans /work. Rien d'autre que le décodeur
# TrueHD/MLP de FFmpeg n'est activé : ni format, ni filtre, ni découpeur, ni autre codec.
set -eu
# Construit dans le /tmp du conteneur : le dossier monté vient souvent d'un /tmp de l'hôte monté
# sans droit d'exécution, et FFmpeg exécute ses propres scripts pendant la construction.
B=/tmp/thd
mkdir -p "$B/build" "$B/out"
tar xf "$FFMPEG.tar.xz" -C "$B"
cd "$B/build"
emconfigure sh "../$FFMPEG/configure" \
  --prefix="$B/out" \
  --cc=emcc --cxx=em++ --ar=emar --nm=emnm --ranlib=emranlib \
  --target-os=none --arch=x86_32 --enable-cross-compile \
  --disable-asm --disable-inline-asm --disable-x86asm \
  --disable-everything --disable-autodetect \
  --disable-programs --disable-doc --disable-network --disable-pthreads --disable-w32threads --disable-os2threads \
  --disable-avdevice --disable-avformat --disable-avfilter --disable-swscale --disable-swresample --disable-postproc \
  --disable-debug --disable-runtime-cpudetect \
  --enable-decoder=truehd,mlp \
  --extra-cflags="-O3" --extra-ldflags="-O3"
emmake make -j"$(nproc)"
emmake make install
cd /work
# Navigateur et worker seulement : la variante « node » d'emscripten importe le module
# « module », que Next refuse d'empaqueter pour le navigateur (build cassé le 21/09/2026). Le
# binaire étant inclus en base64, rien d'autre n'en dépend. Node exécute ce fichier quand même —
# tests et banc —, faute d'assertions pour l'en empêcher (-O3), et c'est vérifié par
# webcodecs-truehd.test.ts.
emcc -O3 truehd.c -I"$B/out/include" "$B/out/lib/libavcodec.a" "$B/out/lib/libavutil.a" \
  -o truehd-wasm.mjs \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createTrueHd -s SINGLE_FILE=1 \
  -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=web,worker \
  -s EXPORTED_FUNCTIONS='["_thd_open","_thd_decode","_thd_reset","_thd_output","_thd_channels","_thd_sample_rate","_thd_errors","_thd_close","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32"]'
# emscripten cherche le dossier du script avec `new URL(".", …)`, que Next prend pour un fichier à
# empaqueter (« Can't resolve '.' », un avertissement à chaque build). Inutile ici : le binaire est
# inclus. Remplacé, et vérifié qu'il l'a été une fois exactement — une version d'emscripten qui
# changerait cette ligne doit faire échouer ce script, pas passer en silence.
test "$(grep -o 'new URL("\.",_scriptName)\.href' truehd-wasm.mjs | wc -l)" -eq 1
sed -i 's/new URL("\.",_scriptName)\.href/""/' truehd-wasm.mjs
test "$(grep -c 'new URL("\."' truehd-wasm.mjs)" -eq 0
