#!/usr/bin/env bash
# Le serveur arrêté pendant qu'on saute (le cas « tampon vide » réel ; voir redemarrage.sh) : le pilote écrit
# `go-panne`, ce script arrête l'instance (`docker stop`, jamais la production), le pilote saute 2,5 s après, et
# l'instance revient PANNE_S secondes plus tard. Chaque lecteur.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${NUIT_WORK:-$HOME/xbench/lumen-serveur/nuit}"
ITEM="${1:-55027c51fd0cdeceec6062202c73a4db}"   # Notting Hill (HEVC 1080p), décodé par le processeur
PANNE_S="${PANNE_S:-10}"
M="$WORK/out/marks.jsonl"
H="$WORK/out/marks-hote.jsonl"
ready() { for _ in $(seq 1 120); do curl -fs -o /dev/null "http://127.0.0.1:${NUIT_PORT:-3097}/api/ping" && return 0; sleep 0.25; done; return 1; }
for player in serveur actuel; do
  LABEL="panne-$player-$(date +%H%M)"
  start=$(wc -l < "$M")
  DECODE=sw timeout 400 "$HERE/nav.sh" MODE=coupure ITEM="$ITEM" PLAYER="$player" CASES=panne OBSERVE_S=90 LABEL="$LABEL" > "$WORK/out/$LABEL.log" 2>&1 &
  nav=$!
  acted=0
  t_start=$(date +%s)
  while kill -0 "$nav" 2>/dev/null && [ $(( $(date +%s) - t_start )) -lt 420 ]; do
    if [ "$acted" = 0 ] && tail -n +"$((start + 1))" "$M" | grep "\"label\":\"$LABEL\"" | grep -q '"phase":"go-panne"'; then
      acted=1
      t0=$(date +%s%3N); docker stop -t 1 lumen-nuit-app >/dev/null; t1=$(date +%s%3N)
      sleep "$PANNE_S"; docker start lumen-nuit-app >/dev/null; ready; t2=$(date +%s%3N)
      echo "{\"t\":$t2,\"label\":\"$LABEL\",\"mode\":\"coupure\",\"phase\":\"serveur-panne\",\"downAt\":$t0,\"stoppedAt\":$t1,\"upAt\":$t2,\"downMs\":$((t2 - t0))}" >> "$H"
      echo "$(date +%T) $LABEL : serveur absent $((t2 - t0)) ms"
    fi
    sleep 0.2
  done
  wait "$nav" 2>/dev/null
  docker rm -f lumen-nuit-nav >/dev/null 2>&1
  # Quoi qu'il arrive, l'instance est rendue.
  [ -n "$(docker ps -q -f name=^lumen-nuit-app$)" ] || { docker start lumen-nuit-app >/dev/null; ready; }
done
