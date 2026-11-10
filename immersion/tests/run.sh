#!/usr/bin/env bash
# Lance les scénarios Playwright du mode Immersion dans un conteneur jetable.
#
#   tests/run.sh                       tous les scénarios, contre http://localhost:3097
#   tests/run.sh e2e/02-monde.spec.ts  un seul fichier
#   BASE=http://localhost:5199 tests/run.sh
#
# Le compte de test vient de immersion/.env (IMMERSION_TEST_USER / IMMERSION_TEST_PASSWORD).
# Le processeur graphique de la machine est passé au conteneur quand /dev/dri existe.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble}"
NAME="immersion-pw-$$"
[ -f "$ROOT/.env" ] || { echo "immersion/.env manquant (compte de test)" >&2; exit 2; }

GPU=()
GL="swiftshader"
if [ -e /dev/dri/renderD128 ] && [ "${IMMERSION_GL:-egl}" = "egl" ]; then
  GPU=(--device /dev/dri --group-add "$(stat -c '%g' /dev/dri/renderD128)")
  GL="egl"
fi

mkdir -p "$ROOT/captures" "$ROOT/test-results"
if [ ! -d "$HERE/node_modules/@playwright/test" ]; then
  docker run --rm --name "$NAME-npm" --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$HERE:/w" -w /w "$IMAGE" npm install --no-audit --no-fund >/dev/null
fi
exec docker run --rm --name "$NAME" --network host --ipc host --cpus "${PW_CPUS:-6}" "${GPU[@]}" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp --env-file "$ROOT/.env" \
  -e BASE="${BASE:-http://localhost:3097}" -e IMMERSION_GL="$GL" -e CAPTURES=/immersion/captures \
  -v "$ROOT:/immersion" -w /immersion/tests "$IMAGE" npx playwright test "$@"
