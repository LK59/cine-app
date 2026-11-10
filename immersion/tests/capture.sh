#!/usr/bin/env bash
# Captures du chalet (voir capture.mjs). Conteneur jetable ; le processeur graphique de la machine
# est utilisé quand /dev/dri existe. Exemple : QUALITY=medium tests/capture.sh entree tv
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble}"
GPU=()
GL="swiftshader"
if [ -e /dev/dri/renderD128 ] && [ "${IMMERSION_GL:-egl}" = "egl" ]; then
  GPU=(--device /dev/dri --group-add "$(stat -c '%g' /dev/dri/renderD128)")
  GL="egl"
fi
mkdir -p "$ROOT/captures"
if [ ! -d "$HERE/node_modules/@playwright/test" ]; then
  docker run --rm --name immersion-pw-npm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$HERE:/w" -w /w "$IMAGE" npm install --no-audit --no-fund >/dev/null
fi
exec docker run --rm --name "immersion-capture-$$" --network host --ipc host --cpus "${PW_CPUS:-4}" "${GPU[@]}" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e BASE="${BASE:-http://localhost:5198}" -e IMMERSION_GL="$GL" \
  -e QUALITY="${QUALITY:-high}" -e SIZE="${SIZE:-1600x900}" -e CAPTURES=/immersion/captures \
  -v "$ROOT:/immersion" -w /immersion/tests "$IMAGE" node capture.mjs "$@"
