#!/usr/bin/env bash
# Un passage du navigateur : le conteneur `lumen-nuit-nav` (WebKit WPE de Playwright + pilote VA-API), dans l'espace
# réseau de l'instance, borné en processeur, puis retiré. Tout le reste passe par l'environnement à banc.mjs.
#
#   DECODE=va|sw nav.sh MODE=serie PASS=courte ORDER=serveur LABEL=…
#   DECODE=va    nav.sh MODE=conso ITEM=… PLAYER=actuel DURATION_S=900 LABEL=…
#
# `va` : /dev/dri/renderD128 monté, les décodeurs VA de GStreamer en tête (vah264dec, vah265dec) ;
# `sw` : pas de périphérique, ces décodeurs écartés — avdec_h264/avdec_h265 (libav) décodent sur le processeur.
# WEBKIT_GST_ENABLE_HLS_SUPPORT=1 : sans lui, le WebKit GStreamer de Playwright 1.63 répond "" à
# canPlayType("application/vnd.apple.mpegurl") et refuse la liste (code 4) — le HLS y est coupé par défaut.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${NUIT_WORK:-$HOME/xbench/lumen-serveur/nuit}"
DECODE="${DECODE:-va}"
if [ "$DECODE" = va ]; then
  DEV=(--device /dev/dri/renderD128 --group-add "$(getent group render | cut -d: -f3)")
  RANK="vah264dec:MAX,vah265dec:MAX,vaapih264dec:NONE,vaapih265dec:NONE"
elif [ "$DECODE" = vaapi ]; then
  # L'ancien greffon gstreamer-vaapi au lieu de `va` : `va` (GStreamer 1.24) fuit ses surfaces dans ce WebKit
  # (objets GEM de l'i915, comptés en `shmem` dans le cgroup : ~20–35 Mo/s en 4K, le conteneur tué en 90 s).
  DEV=(--device /dev/dri/renderD128 --group-add "$(getent group render | cut -d: -f3)")
  RANK="vaapih264dec:MAX,vaapih265dec:MAX,vah264dec:NONE,vah265dec:NONE"
else
  DEV=()
  RANK="vah264dec:NONE,vah265dec:NONE,vaav1dec:NONE,vavp9dec:NONE,vaapih264dec:NONE,vaapih265dec:NONE,vaapidecodebin:NONE"
fi
envs=()
for kv in "$@" ${NAV_EXTRA_ENV:-}; do envs+=(-e "$kv"); done
mkdir -p "$WORK/out"
docker rm -f lumen-nuit-nav >/dev/null 2>&1 || true
exec docker run --rm --name lumen-nuit-nav --network container:lumen-nuit-netns --ipc private --shm-size 1g \
  --cpus "${NAV_CPUS:-4}" --memory "${NAV_MEM:-8g}" "${DEV[@]}" \
  -e WEBKIT_GST_ENABLE_HLS_SUPPORT=1 -e GST_PLUGIN_FEATURE_RANK="$RANK" -e DECODE="$DECODE" -e HEADED="${HEADED:-}" "${envs[@]}" \
  -v "$WORK/${NAV_PW:-pw}/node_modules:/w/node_modules:ro" -v "$HERE:/tool:ro" -v "$WORK/secrets/cookie:/secrets/cookie:ro" -v "$WORK/out:/out" \
  -w /w "${NAV_IMAGE:-lumen-nuit-webkit:1}" sh -c 'cp /tool/banc.mjs /w/ && if [ "${HEADED:-}" = 1 ]; then exec xvfb-run -a -s "-screen 0 1920x1080x24" node /w/banc.mjs; else exec node /w/banc.mjs; fi'
