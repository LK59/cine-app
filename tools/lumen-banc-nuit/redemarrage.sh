#!/usr/bin/env bash
# Résistance au redémarrage du serveur (demande de Louis du 16/11) — chaque lecteur, tampon plein puis tampon vide ;
# puis, pour Lumen serveur, une instance revenue avec un autre format (LUMEN_FORMAT_VERSION 4 : l'image
# cine-app:lumen-nuit-v4, construite depuis le même commit avec cette seule constante changée) — chaque adresse en
# cours répond alors 410. Le pilote (banc.mjs MODE=coupure) écrit `go-<cas>` dans marks.jsonl ; ce script le guette
# et agit : `docker restart` de l'instance jetable (jamais la production), ou son remplacement par l'autre image.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${NUIT_WORK:-$HOME/xbench/lumen-serveur/nuit}"
ITEM="${1:-55027c51fd0cdeceec6062202c73a4db}"   # Notting Hill (HEVC 1080p, AC-3 5.1) — décodé par le processeur : sans fuite
REF="${2:-df87a946}"
M="$WORK/out/marks.jsonl"
ready() { for _ in $(seq 1 120); do curl -fs -o /dev/null "http://127.0.0.1:${NUIT_PORT:-3097}/api/ping" && return 0; sleep 0.25; done; return 1; }
act() {   # $1 = cas
  local t0; t0=$(date +%s%3N)
  case "$1" in
    pleine|faible) docker restart -t 1 lumen-nuit-app >/dev/null ;;
    version) docker rm -f lumen-nuit-app >/dev/null; NUIT_CREDS="${NUIT_CREDS:-$WORK/secrets/creds.env}" NUIT_IMAGE=cine-app:lumen-nuit-v4 "$HERE/instance.sh" start "$REF" >/dev/null 2>&1 & ;;
  esac
  ready; local t1; t1=$(date +%s%3N)
  echo "{\"t\":$t1,\"label\":\"$LABEL\",\"mode\":\"coupure\",\"phase\":\"serveur-$1\",\"downAt\":$t0,\"upAt\":$t1,\"downMs\":$((t1 - t0))}" >> "$M"
  echo "$(date +%T) $LABEL cas $1 : serveur rendu en $((t1 - t0)) ms"
}
for player in ${REDEMARRAGE_PLAYERS:-serveur actuel}; do
  cases="pleine,faible"; [ "$player" = serveur ] && cases="pleine,faible,version"
  cases="${REDEMARRAGE_CASES:-$cases}"
  LABEL="coupure-$player-$(date +%H%M)"
  start=$(wc -l < "$M")
  DECODE=sw "$HERE/nav.sh" MODE=coupure ITEM="$ITEM" PLAYER="$player" CASES="$cases" OBSERVE_S="${OBSERVE_S:-90}" LABEL="$LABEL" > "$WORK/out/$LABEL.log" 2>&1 &
  nav=$!
  while kill -0 "$nav" 2>/dev/null; do
    line=$(tail -n +"$((start + 1))" "$M" | grep "\"label\":\"$LABEL\"" | grep -o '"phase":"go-[a-z]*"' | tail -1)
    for c in pleine faible version; do
      if [ "$line" = "\"phase\":\"go-$c\"" ] && ! grep -q "\"label\":\"$LABEL\",\"mode\":\"coupure\",\"phase\":\"serveur-$c\"" "$M"; then act "$c"; fi
    done
    sleep 0.2
  done
  # L'instance du format de la règle, quoi qu'il soit arrivé.
  if [[ "$cases" == *version* ]]; then NUIT_CREDS="${NUIT_CREDS:-$WORK/secrets/creds.env}" "$HERE/instance.sh" start "$REF" | tail -1; fi
done
