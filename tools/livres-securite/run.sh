#!/usr/bin/env bash
# Banc de sécurité du lecteur de livres — voir README.md à côté.
#
#   run.sh <dossier de résultats>
#
# Variables : BASE (instance jetable, option Livres allumée, sur l'hôte : http://localhost:<port>),
# CREDS (fichier user=/password= d'un compte de test), BOOK (identifiant Jellyfin du livre piégé),
# RAW (le chapitre brut écrit par make-epub.py), SPY_PORT (défaut 18999), PW_IMAGE.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
SPY_PORT="${SPY_PORT:-18999}"
PW_IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble}"
WORK="${LIVRES_WORK:-${TMPDIR:-/tmp}/livres-securite}"
mkdir -p "$WORK/pw"

# L'espion : une origine à part, qui écrit une ligne pour chaque requête reçue. Tout ce que le livre
# parviendrait à charger ou à exécuter y laisserait une trace.
docker rm -f livres-espion >/dev/null 2>&1 || true
docker run -d --name livres-espion --network host node:26-alpine node -e "
  require('http').createServer((q, s) => { console.log('HIT', q.method, q.url); s.end(); }).listen($SPY_PORT, '127.0.0.1');
" >/dev/null
trap 'docker rm -f livres-espion >/dev/null 2>&1 || true' EXIT

if [ ! -d "$WORK/pw/node_modules/playwright" ]; then
  docker run --rm --name livres-securite-npm -v "$WORK/pw:/w" -w /w "$PW_IMAGE" \
    sh -c "npm init -y >/dev/null && npm i --no-audit --no-fund playwright@1.63.0 >/dev/null"
fi

set +e
docker run --rm --name livres-securite-pw --network host --ipc host \
  -v "$WORK/pw/node_modules:/w/node_modules:ro" -v "$HERE:/tool:ro" -v "$CREDS:/creds.txt:ro" -v "$RAW:/raw.xhtml:ro" -v "$OUT:/out" \
  -e BASE="$BASE" -e BOOK="$BOOK" -e CREDS=/creds.txt -e RAW=/raw.xhtml -e SPY="http://127.0.0.1:$SPY_PORT" -e OUT=/out \
  -w /w "$PW_IMAGE" sh -c "cp /tool/securite.mjs /w/ && node /w/securite.mjs"
status=$?
set -e
docker logs livres-espion > "$OUT/espion.log" 2>&1
hits=$(grep -c '^HIT' "$OUT/espion.log" || true)
echo "espion : $hits requête(s) reçue(s)"
[ "$status" -eq 0 ] && [ "$hits" -eq 0 ]
