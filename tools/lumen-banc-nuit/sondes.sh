#!/usr/bin/env bash
# Sondes courtes avant les essais à part de la nuit : ce que ce WebKit permet pour le son (pistes annoncées par
# `audioTracks`, Web Audio sur le HLS natif, avec playbin2 puis playbin3), une capture de son vérifiée, et un
# redémarrage de l'instance pendant une lecture (cas « tampon vide », 30 s observées).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${NUIT_WORK:-$HOME/xbench/lumen-serveur/nuit}"
MB=d4513bcf59bba90a23656f40ed816c3d
# Le lecteur actuel sur un son DTS (The Knick S01E01) : ce WebKit sait-il le réencoder (AudioEncoder) ?
DECODE=sw timeout 240 "$HERE/nav.sh" MODE=conso ITEM=579892073db7f5021e7ba6426cb163e5 PLAYER=actuel DURATION_S=30 WARM_S=5 LABEL=sonde-dts > "$WORK/out/sonde-dts.log" 2>&1
grep -v '^\[page\]' "$WORK/out/sonde-dts.log" | tail -2 | cut -c1-500
for pb in 0 1; do
  for player in serveur actuel; do
    extra=""; [ "$pb" = 1 ] && extra="WEBKIT_GST_USE_PLAYBIN3=1"
    NAV_EXTRA_ENV="$extra" DECODE=sw timeout 240 "$HERE/nav.sh" MODE=sonde-son ITEM=$MB PLAYER=$player LABEL="sonde-son-$player-pb$pb" > "$WORK/out/sonde-son-$player-pb$pb.log" 2>&1
    grep -v '^\[page\]' "$WORK/out/sonde-son-$player-pb$pb.log" | tail -2 | cut -c1-600
  done
done
# Une capture de son vérifiée (Maison Blanche, Lumen serveur), le même chemin que son.sh.
TITLES_ONLY=maison-blanche CASES_ONLY="serveur::2" timeout 600 "$HERE/son.sh" 2>&1 | tail -3
# Un redémarrage pendant la lecture.
REDEMARRAGE_PLAYERS=serveur REDEMARRAGE_CASES=faible OBSERVE_S=30 timeout 600 "$HERE/redemarrage.sh" 2>&1 | tail -5
