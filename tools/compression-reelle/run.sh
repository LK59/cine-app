#!/bin/sh
# Le cadrage des réponses sur un vrai serveur Next (DECISIONS.md §131) — voir compression-reelle.spec.ts.
#
#   tools/compression-reelle/run.sh            # construit et essaie le dépôt tel qu'il est
#   tools/compression-reelle/run.sh <dossier>  # construit un autre arbre (ex. `git archive` d'un commit
#                                              # plus ancien) avec les dépendances et le spec du dépôt
#
# Tout se passe dans un conteneur jetable (`cine-compression-reelle`), sur une copie : ni `.next` ni
# `node_modules` du dépôt ne sont écrits, aucun port n'est publié, et le DATA_DIR est un dossier
# temporaire du conteneur — jamais data/ de la production. Les dépendances doivent être installées
# dans le dépôt (`npm ci`, sous Alpine : better-sqlite3 est natif). ~3 minutes, surtout `next build`.
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
SRC=$(cd "${1:-$REPO}" && pwd)
docker run --rm --name cine-compression-reelle -e HOME=/tmp -v "$REPO":/repo:ro -v "$SRC":/src:ro node:26-alpine sh -c '
  set -e
  mkdir -p /build
  # Une copie : le /tmp de certains hôtes est monté noexec, et un build ne doit rien laisser dans la source.
  cd /src && tar --exclude=./node_modules --exclude=./.next --exclude=./.next-dev --exclude=./data --exclude=./.git -cf - . | tar -xf - -C /build
  cp -a /repo/node_modules /build/node_modules
  cp /repo/compression-reelle.spec.ts /build/compression-reelle.spec.ts
  cd /build
  echo "[compression-reelle] next $(node -p "require(\"next/package.json\").version") — build de $(node -p "require(\"./package.json\").version")"
  if ! npx next build >/tmp/build.log 2>&1; then tail -60 /tmp/build.log; exit 1; fi
  # Ce que fait le Dockerfile : la sortie standalone, ses fichiers statiques, le point d entrée.
  cp -a public .next/standalone/
  cp -a .next/static .next/standalone/.next/
  cp -a server-boot .next/standalone/
  cp -a node_modules/better-sqlite3 node_modules/web-push .next/standalone/node_modules/ 2>/dev/null || true
  NEXT_REEL_DIR=/build/.next/standalone npx vitest run --exclude ".next/**" compression-reelle.spec.ts
'
