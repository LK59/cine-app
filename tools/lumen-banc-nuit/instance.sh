#!/usr/bin/env bash
# L'instance jetable du banc de nuit — voir README.md à côté.
#
#   instance.sh build <commit>   l'image cine-app:lumen-nuit-<commit> (git archive du commit seul)
#   instance.sh start <commit>   données jetables, instance démarrée, session administrateur fabriquée
#   instance.sh stop             déconnexion Jellyfin du compte de test, instance retirée
#   instance.sh clean            stop + dossier de données retiré
#
# Variables : NUIT_WORK (dossier de travail, défaut ~/xbench/lumen-serveur/nuit), NUIT_ENV (.env de la production, lu
# par --env-file seulement), NUIT_DB (cine.db de la production, ouverte en lecture seule), NUIT_CREDS (fichier
# JELLYFIN_TEST_USER= / JELLYFIN_TEST_PASSWORD= du compte de test — jamais l'administrateur), NUIT_MEDIA, NUIT_NETWORK,
# NUIT_CPUS (défaut 4), NUIT_MEM (défaut 3g), NUIT_PORT (127.0.0.1 seulement, défaut 3097, pour curl).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${NUIT_WORK:-$HOME/xbench/lumen-serveur/nuit}"
ENV_FILE="${NUIT_ENV:-/opt/stacks/cine-app/.env}"
PROD_DB="${NUIT_DB:-/opt/stacks/cine-app/data/cine.db}"
CREDS="${NUIT_CREDS:-}"
MEDIA="${NUIT_MEDIA:-/mnt/media/video}"
NETWORK="${NUIT_NETWORK:-media_net}"
NAME=lumen-nuit-app
DATA="$WORK/data"
SECRETS="$WORK/secrets"   # 700 : secret de session de l'instance, cookie, jeton Jellyfin du compte de test

image_of() { echo "cine-app:lumen-nuit-$1"; }

build() {
  local sha; sha="$(git -C "$REPO" rev-parse --short=8 "$1^{commit}")"
  local src="$WORK/build/src-$sha"
  rm -rf "$src"; mkdir -p "$src"
  git -C "$REPO" archive "$sha" | tar -x -C "$src"
  # SKIP_TESTS=1 : image jetable d'un commit de main dont le portail est passé ; le banc ne la déploie jamais.
  docker build -q --build-arg BUILD_REF="$sha" --build-arg SKIP_TESTS=1 -t "$(image_of "$sha")" "$src" >/dev/null
  rm -rf "$src"
  echo "image $(image_of "$sha")"
}

wipe_data() {
  [ -d "$DATA" ] && docker run --rm --name lumen-nuit-rm -v "$WORK:/w" alpine:3.22 rm -rf /w/data || true
}

start() {
  local sha; sha="$(git -C "$REPO" rev-parse --short=8 "$1^{commit}")"
  [ -n "$CREDS" ] && [ -f "$CREDS" ] || { echo "NUIT_CREDS : fichier du compte de test" >&2; exit 2; }
  stop_container
  if [ ! -f "$DATA/cine.db" ]; then
    wipe_data; mkdir -p "$DATA"
    python3 -I "$REPO/tools/regress-lecteur/prepare-data.py" "$PROD_DB" "$DATA"
    chmod -R g+rwX "$DATA"; chmod g+s "$DATA" "$DATA/logs"
  fi
  (umask 077; mkdir -p "$SECRETS"; [ -f "$SECRETS/session-secret" ] || head -c 48 /dev/urandom | base64 | tr -d '\n/+=' > "$SECRETS/session-secret")
  # L'espace réseau du banc appartient à un conteneur qui ne fait rien (`lumen-nuit-netns`) : l'instance et le
  # navigateur s'y joignent (`--network container:`), le navigateur lit http://localhost:3000 — un contexte sécurisé
  # sans relais —, et l'instance peut redémarrer (essai de redémarrage) sans emporter le réseau du navigateur.
  if [ -z "$(docker ps -q -f name=^lumen-nuit-netns$)" ]; then
    docker rm -f lumen-nuit-netns >/dev/null 2>&1 || true
    docker run -d --name lumen-nuit-netns --network "$NETWORK" -p "127.0.0.1:${NUIT_PORT:-3097}:3000" \
      --cpus 0.1 --memory 16m alpine:3.22 sleep infinity >/dev/null
  fi
  # Mêmes neutralisations que regress.sh (§145) ; un secret de session propre à l'instance : un cookie fabriqué ici
  # ne vaut rien contre la production.
  docker run -d --name "$NAME" \
    --env-file "$ENV_FILE" \
    -e SESSION_SECRET="$(cat "$SECRETS/session-secret")" \
    -e COOKIE_SECURE=false -e TZ=Europe/Paris \
    -e REPLIQUES_ENABLED=false -e REPLIQUES_NIGHTLY=false -e NEW_ACCOUNT_BLOCKED_TAGS= \
    -e CINE_BACKGROUND_JOBS=off -e REQUEST_HIDE_ACCOUNT= -e XRAY_ENABLED=off \
    -e LUMEN_PATH_MAP=/media=/mnt/media/video -e UV_THREADPOOL_SIZE=8 \
    -v "$MEDIA:/mnt/media/video:ro" -v "$DATA:/app/data" \
    --user 1001:1000 --network container:lumen-nuit-netns \
    --cpus "${NUIT_CPUS:-4}" --memory "${NUIT_MEM:-3g}" --security-opt no-new-privileges:true --cap-drop ALL \
    "${NUIT_IMAGE:-$(image_of "$sha")}" >/dev/null
  for _ in $(seq 1 90); do
    if curl -fs -o /dev/null "http://127.0.0.1:${NUIT_PORT:-3097}/api/ping"; then
      sleep 20
      mint
      echo "instance $NAME prête (${NUIT_IMAGE:-$(image_of "$sha")})"; return 0
    fi
    sleep 2
  done
  echo "l'instance ne répond pas" >&2; docker logs --tail 30 "$NAME" >&2; exit 1
}

# La session administrateur, fabriquée par l'instance elle-même (même algorithme que src/lib/auth.ts — HMAC-SHA256 du
# corps, jeton Jellyfin chiffré AES-GCM par une clé dérivée de SESSION_SECRET — et la ligne `sessions` de sa base) ;
# l'identité Jellyfin est celle du compte de test, ouverte par AuthenticateByName. Les identifiants passent par
# l'entrée standard, le cookie sort dans $SECRETS/cookie (600) : rien n'est affiché.
mint() {
  cp "$HERE/mint-session.mjs" "$DATA/.mint.mjs"
  (umask 077; docker exec -i "$NAME" node /app/data/.mint.mjs < "$CREDS" > "$SECRETS/cookie.tmp" 2>"$WORK/mint.err") || true
  mv "$SECRETS/cookie.tmp" "$SECRETS/cookie"
  [ -s "$SECRETS/cookie" ] || { echo "session non fabriquée (voir $WORK/mint.err)" >&2; exit 1; }
  echo "session administrateur fabriquée (compte Jellyfin de test)"
}

stop_container() {
  if [ -n "$(docker ps -aq -f "name=^${NAME}\$")" ]; then
    # La déconnexion rend à Jellyfin l'appareil inscrit par AuthenticateByName.
    if [ -s "$SECRETS/cookie" ] && [ -n "$(docker ps -q -f "name=^${NAME}\$")" ]; then
      docker exec -i "$NAME" node /app/data/.mint.mjs --logout < "$CREDS" >/dev/null 2>>"$WORK/mint.err" || true
    fi
    docker rm -f "$NAME" >/dev/null && echo "instance $NAME retirée"
  fi
}

case "${1:-}" in
  build) build "$2" ;;
  start) start "$2" ;;
  mint) mint ;;
  stop) stop_container ;;
  clean) stop_container; docker rm -f lumen-nuit-netns >/dev/null 2>&1 || true; wipe_data; rm -rf "$SECRETS" ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
