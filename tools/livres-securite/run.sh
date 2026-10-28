#!/usr/bin/env bash
# Banc de sécurité du lecteur de livres — voir README.md à côté.
#
#   run.sh <dossier de résultats>
#
# Variables : BASE (instance jetable, option Livres allumée, sur l'hôte : http://localhost:<port>),
# CREDS (fichier user=/password= d'un compte de test), BOOK (identifiant Jellyfin du livre piégé),
# RAW (le chapitre brut écrit par make-epub.py), SPY_PORT (défaut 18999), PW_IMAGE ; EPUB (le livre
# piégé, posé comme copie de l'appareil de BOOK — ou du premier livre de l'accueil si BOOK est vide —
# quand il n'est pas dans Jellyfin), MODES (défaut « page,cadre » : la page /livres seule, et le cadre
# que le cinéma pose sur lui-même).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
SPY_PORT="${SPY_PORT:-18999}"
# Le préfixe des conteneurs (défaut « livres ») : deux bancs sur la même machine ne se marchent pas dessus.
PREFIX="${CONTAINER_PREFIX:-livres}"
PW_IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble}"
WORK="${LIVRES_WORK:-${TMPDIR:-/tmp}/livres-securite}"
mkdir -p "$WORK/pw"

# L'espion : une origine à part, qui écrit une ligne pour chaque requête reçue. Tout ce que le livre
# parviendrait à charger ou à exécuter y laisserait une trace.
docker rm -f "$PREFIX-espion" >/dev/null 2>&1 || true
docker run -d --name "$PREFIX-espion" --network host node:26-alpine node -e "
  require('http').createServer((q, s) => { console.log('HIT', q.method, q.url); s.end(); }).listen($SPY_PORT, '127.0.0.1');
" >/dev/null
trap 'docker rm -f "$PREFIX-espion" >/dev/null 2>&1 || true' EXIT

if [ ! -d "$WORK/pw/node_modules/playwright" ]; then
  docker run --rm --name "$PREFIX-securite-npm" -v "$WORK/pw:/w" -w /w "$PW_IMAGE" \
    sh -c "npm init -y >/dev/null && npm i --no-audit --no-fund playwright@1.63.0 >/dev/null"
fi

PLANT=()
if [ -n "${EPUB:-}" ]; then PLANT=(-v "$EPUB:/piege.epub:ro" -e EPUB=/piege.epub); fi

set +e
docker run --rm --name "$PREFIX-securite-pw" --network host --ipc host \
  -v "$WORK/pw/node_modules:/w/node_modules:ro" -v "$HERE:/tool:ro" -v "$CREDS:/creds.txt:ro" -v "$RAW:/raw.xhtml:ro" -v "$OUT:/out" \
  "${PLANT[@]}" -e MODES="${MODES:-page,cadre}" \
  -e BASE="$BASE" -e BOOK="${BOOK:-}" -e CREDS=/creds.txt -e RAW=/raw.xhtml -e SPY="http://127.0.0.1:$SPY_PORT" -e OUT=/out \
  -w /w "$PW_IMAGE" sh -c "cp /tool/securite.mjs /w/ && node /w/securite.mjs"
status=$?
set -e
docker logs "$PREFIX-espion" > "$OUT/espion.log" 2>&1
hits=$(grep -c '^HIT' "$OUT/espion.log" || true)
echo "espion : $hits requête(s) reçue(s)"
[ "$status" -eq 0 ] && [ "$hits" -eq 0 ]
