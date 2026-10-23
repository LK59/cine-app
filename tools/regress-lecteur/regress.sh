#!/usr/bin/env bash
# Banc anti-régression du lecteur en vrais navigateurs — voir README.md à côté.
#
#   regress.sh run <ref> <dossier de résultats>   construit, lance, joue, recueille, nettoie
#   regress.sh compare <résultats A> <résultats B> diff des lignes normalisées, sortie ≠ 0 si écart
#
# Étapes séparées, pour itérer :
#   regress.sh build <ref> | start <ref> | play <ref> <dossier> | stop <ref> | clean <ref>
#
# Variables : REGRESS_WORK (dossier de travail jetable, défaut $TMPDIR/regress-lecteur),
# REGRESS_ENV (.env de l'instance), REGRESS_DB (cine.db à recopier), REGRESS_MEDIA (bibliothèque,
# montée en lecture seule), REGRESS_CREDS (fichier user=/password= du compte de test),
# REGRESS_PORT (127.0.0.1 seulement, défaut 3098), REGRESS_NETWORK (défaut media_net),
# REGRESS_PROFILES (défaut « chromium firefox webkit iphone »), REGRESS_TITLES (titres.json).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${REGRESS_WORK:-${TMPDIR:-/tmp}/regress-lecteur}"
ENV_FILE="${REGRESS_ENV:-$REPO/.env}"
PROD_DB="${REGRESS_DB:-$REPO/data/cine.db}"
MEDIA="${REGRESS_MEDIA:-/mnt/media/video}"
CREDS="${REGRESS_CREDS:-}"
PORT="${REGRESS_PORT:-3098}"
NETWORK="${REGRESS_NETWORK:-media_net}"
PW_IMAGE="${REGRESS_PW_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble}"
PW_VERSION="${REGRESS_PW_VERSION:-1.63.0}"

# Le nom du conteneur et de l'image se lisent dans `docker ps` : une instance oubliée se retrouve.
slug() { git -C "$REPO" rev-parse --short=8 "$1^{commit}"; }
image_of() { echo "cine-app:regress-$1"; }
container_of() { echo "cine-regress-$1"; }

# Les fichiers écrits par l'application (1001) ne sont pas tous effaçables par l'utilisateur : un
# conteneur jetable les retire.
wipe_data() {
  local sha="$1"
  if [ -d "$WORK/data-$sha" ]; then
    docker run --rm --name "cine-regress-rm-$sha" -v "$WORK:/w" alpine:3.22 rm -rf "/w/data-$sha"
  fi
}

build() {
  local sha; sha="$(slug "$1")"
  local src="$WORK/src-$sha"
  rm -rf "$src"; mkdir -p "$src"
  # L'arbre du commit, et lui seul : ni la copie de travail, ni `data/`, ni `.env`.
  git -C "$REPO" archive "$sha" | tar -x -C "$src"
  docker build -q --build-arg BUILD_REF="$sha" -t "$(image_of "$sha")" "$src" >/dev/null
  rm -rf "$src"
  echo "image $(image_of "$sha")"
}

start() {
  local sha; sha="$(slug "$1")"
  local data="$WORK/data-$sha"
  [ -f "$ENV_FILE" ] || { echo "pas de fichier d'environnement : $ENV_FILE" >&2; exit 2; }
  stop "$1"
  wipe_data "$sha"; mkdir -p "$data"
  python3 -I "$HERE/prepare-data.py" "$PROD_DB" "$data"
  # L'application tourne en 1001:1000 comme en production (accès aux dossiers de la bibliothèque) :
  # le dossier doit lui être inscriptible.
  chmod -R g+rwX "$data"; chmod g+s "$data" "$data/logs"
  docker run -d --name "$(container_of "$sha")" \
    --env-file "$ENV_FILE" \
    -e COOKIE_SECURE=false -e TZ=Europe/Paris \
    -e REPLIQUES_ENABLED=false -e REPLIQUES_NIGHTLY=false -e NEW_ACCOUNT_BLOCKED_TAGS= \
    -v "$MEDIA:$MEDIA:ro" -v "$data:/app/data" \
    --user 1001:1000 --network "$NETWORK" -p "127.0.0.1:$PORT:3000" \
    --memory 2g --security-opt no-new-privileges:true --cap-drop ALL \
    "$(image_of "$sha")" >/dev/null
  # Prête quand le catalogue répond (il est préchauffé au démarrage).
  for _ in $(seq 1 90); do
    if curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/ping"; then
      sleep 20  # le préchauffage du catalogue (selfWarm, catalogueWarm) avant la première ouverture
      echo "instance $(container_of "$sha") prête sur 127.0.0.1:$PORT"; return 0
    fi
    sleep 2
  done
  echo "l'instance ne répond pas" >&2; docker logs --tail 30 "$(container_of "$sha")" >&2; exit 1
}

play() {
  local sha; sha="$(slug "$1")"
  local out="$2"
  local data="$WORK/data-$sha"
  [ -n "$CREDS" ] && [ -f "$CREDS" ] || { echo "REGRESS_CREDS : fichier user=/password= du compte de test" >&2; exit 2; }
  mkdir -p "$out" "$WORK/pw"
  out="$(cd "$out" && pwd)"
  # Les dépendances de Playwright, installées une fois dans le dossier de travail.
  if [ ! -d "$WORK/pw/node_modules/playwright" ]; then
    docker run --rm --name "cine-regress-npm-$sha" -v "$WORK/pw:/w" -w /w "$PW_IMAGE" \
      sh -c "npm init -y >/dev/null && npm i --no-audit --no-fund playwright@$PW_VERSION >/dev/null"
  fi
  # `--network host` + localhost : un contexte sécurisé, sans lequel ni AudioEncoder ni OPFS n'existent.
  docker run --rm --name "cine-regress-pw-$sha" --network host --ipc host \
    -v "$WORK/pw/node_modules:/w/node_modules:ro" \
    -v "$HERE:/tool:ro" -v "$CREDS:/creds.txt:ro" -v "$data/logs:/logs:ro" -v "$out:/out" \
    -e BASE="http://localhost:$PORT" -e PROFILES="${REGRESS_PROFILES:-chromium firefox webkit iphone}" \
    -e TITLES="/tool/${REGRESS_TITLES:-titres.json}" -e ONLY="${REGRESS_ONLY:-}" \
    -w /w "$PW_IMAGE" sh -c "cp /tool/scenario.mjs /w/ && node /w/scenario.mjs"
  python3 -I "$HERE/normalise.py" "$out"
}

stop() {
  local sha; sha="$(slug "$1")"
  local name; name="$(container_of "$sha")"
  if [ -n "$(docker ps -aq -f "name=^${name}\$")" ]; then
    docker rm -f "$name" >/dev/null && echo "instance $name retirée"
  fi
}

clean() {
  local sha; sha="$(slug "$1")"
  stop "$1"
  wipe_data "$sha"
  if docker image inspect "$(image_of "$sha")" >/dev/null 2>&1; then
    docker rmi "$(image_of "$sha")" >/dev/null && echo "image $(image_of "$sha") retirée"
  fi
}

case "${1:-}" in
  build) build "$2" ;;
  start) start "$2" ;;
  play) play "$2" "$3" ;;
  stop) stop "$2" ;;
  clean) clean "$2" ;;
  run)
    # La référence gardée à part : le piège s'exécute là où la sortie a lieu, souvent dans une
    # fonction dont `$2` est autre chose.
    REF="$2"
    trap 'clean "$REF"' EXIT
    t0=$(date +%s)
    build "$2"; start "$2"; play "$2" "$3"
    echo "durée : $(( $(date +%s) - t0 )) s"
    ;;
  compare) python3 -I "$HERE/compare.py" "$2" "$3" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
