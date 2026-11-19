#!/bin/sh
# Rebuilds ARCHITECTURE.svg from the « Application map » section of DOC-TECH.md.
#
#   tools/architecture/build.sh            # writes ARCHITECTURE.svg at the repository root
#   PREVIEW=/some/dir tools/architecture/build.sh  # also writes overview.png and zoom.png there
#   (ZOOM="x y w h" picks the zoomed region, in the drawing's units; default: zone 1)
#
# Everything runs in the mermaid-cli image (Node + Chromium + mmdc): nothing to install on the host.
# Steps: extract the diagrams (extract.mjs) → render each with mmdc (mermaid.json: theme, text labels
# rather than HTML, so the SVG shows in any viewer) → assemble the page (assemble.mjs).
set -eu

IMAGE=minlag/mermaid-cli:11.12.0
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TOOL="$ROOT/tools/architecture"
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
chmod 777 "$BUILD"

run() { # run <name> <entrypoint> args…
  name=$1; entry=$2; shift 2
  docker run --rm --name "arch-$name-$$" -u "$(id -u):$(id -g)" \
    -v "$ROOT":/repo:ro -v "$BUILD":/build --entrypoint "$entry" "$IMAGE" "$@"
}

run extract node /repo/tools/architecture/extract.mjs /repo/DOC-TECH.md /build

for mmd in "$BUILD"/*.mmd; do
  n=$(basename "$mmd" .mmd)
  # A diagram that does not parse fails here, with mmdc's message.
  run "mmdc-$n" /home/mermaidcli/node_modules/.bin/mmdc -q -p /puppeteer-config.json \
    -c /repo/tools/architecture/mermaid.json -I "z$n" -i "/build/$n.mmd" -o "/build/$n.svg"
done

run assemble node /repo/tools/architecture/assemble.mjs /build /repo/package.json /build/ARCHITECTURE.svg
cp "$BUILD/ARCHITECTURE.svg" "$ROOT/ARCHITECTURE.svg"

if [ -n "${PREVIEW:-}" ]; then
  mkdir -p "$PREVIEW"
  run preview node /repo/tools/architecture/preview.mjs /build/ARCHITECTURE.svg /build/overview.png 2000
  run preview-zoom node /repo/tools/architecture/preview.mjs /build/ARCHITECTURE.svg /build/zoom.png 2400 ${ZOOM:-80 470 4000 2400}
  cp "$BUILD/overview.png" "$BUILD/zoom.png" "$PREVIEW/"
  echo "previews: $PREVIEW/overview.png, $PREVIEW/zoom.png"
fi
