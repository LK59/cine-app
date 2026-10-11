#!/bin/sh
# Lancé par build.sh dans l'image emscripten, dans /work. Rien d'autre que le décodeur AAC natif de
# FFmpeg n'est activé : ni format, ni filtre, ni découpeur, ni autre codec. Mêmes options que le
# décodeur TrueHD (tools/truehd-wasm/compile.sh), dont celui-ci est le jumeau.
set -eu
B=/tmp/aac
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
  --enable-decoder=aac \
  --extra-cflags="-O3" --extra-ldflags="-O3"
emmake make -j"$(nproc)"
emmake make install
cd /work
# Navigateur et worker seulement, comme le TrueHD : la variante « node » d'emscripten importe le
# module « module », que Next refuse d'empaqueter pour le navigateur. Node l'exécute quand même
# (tests, banc).
emcc -O3 aac.c -I"$B/out/include" "$B/out/lib/libavcodec.a" "$B/out/lib/libavutil.a" \
  -o aac-wasm.mjs \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createAac -s SINGLE_FILE=1 \
  -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=web,worker \
  -s EXPORTED_FUNCTIONS='["_aac_open","_aac_decode","_aac_reset","_aac_output","_aac_channels","_aac_sample_rate","_aac_errors","_aac_layout_lo","_aac_layout_hi","_aac_close","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32"]'
# Même retouche que pour le TrueHD (voir tools/truehd-wasm/compile.sh) : `new URL(".", …)` fait
# avertir Next à chaque build, et le binaire est inclus. Exactement une occurrence, sinon échec.
test "$(grep -o 'new URL("\.",_scriptName)\.href' aac-wasm.mjs | wc -l)" -eq 1
sed -i 's/new URL("\.",_scriptName)\.href/""/' aac-wasm.mjs
test "$(grep -c 'new URL("\."' aac-wasm.mjs)" -eq 0
