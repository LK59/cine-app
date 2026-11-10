#!/bin/sh
# Lance build.mjs dans l'image immersion-assets-tools. Arguments passés tels quels (--only id,id --force --jobs N).
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
docker run --rm --name immersion-assets-build --cpus 6 -v "$ROOT":/repo -w /repo \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e IMMERSION_ROOT=/repo \
  immersion-assets-tools node /repo/tools/assets/build.mjs "$@"
