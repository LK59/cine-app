#!/usr/bin/env bash
# Exporte la géométrie du chalet et ses lumières vers assets-src/bake/ (voir export.ts).
# Vite compile le script (mêmes sources que la page) dans node_modules/.cache — là où Node retrouve three —, puis Node l.exécute.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
docker run --rm --name immersion-bake-export --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$ROOT":/w -w /w node:26-alpine sh -c '
  npx vite build --ssr tools/bake/export.ts --outDir node_modules/.cache/bake-export --logLevel warn --emptyOutDir &&
  node node_modules/.cache/bake-export/export.js'
