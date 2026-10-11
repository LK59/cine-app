#!/bin/sh
# Ordre de sortie des décodeurs audio des navigateurs (WebCodecs, via mediabunny — le chemin du
# lecteur), mesuré dans de vrais Chromium et Firefox sans écran. Chaque canal porte sa fréquence et
# son niveau : L −13, R −17, C −21, LFE −25, Ls −29, Rs −33 dB (RMS) ; le rang où ressort chaque
# niveau dit l'ordre du décodeur. Voir DECISIONS.md §68.
#
#   sh tools/channel-order-bench/run.sh
#
# Il faut un ffmpeg (celui du conteneur jellyfin ici) et l'image Playwright. Rien n'est écrit hors
# d'un dossier temporaire.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
FFMPEG=${FFMPEG:-"docker exec -i jellyfin /usr/lib/jellyfin-ffmpeg/ffmpeg"}
TONES="0.3162*sin(2*PI*440*t)|0.1995*sin(2*PI*550*t)|0.1259*sin(2*PI*660*t)|0.0794*sin(2*PI*60*t)|0.0501*sin(2*PI*770*t)|0.0316*sin(2*PI*880*t)"
$FFMPEG -v error -f lavfi -i "aevalsrc=$TONES:s=48000:d=12:c=5.1" -c:a libopus -b:a 256k -mapping_family 1 -f matroska - > "$WORK/opus51.mkv"
$FFMPEG -v error -f lavfi -i "aevalsrc=0.3162*sin(2*PI*440*t)|0.1995*sin(2*PI*550*t)|0.1259*sin(2*PI*660*t):s=48000:d=12:c=3.0" -c:a libopus -b:a 256k -mapping_family 1 -f matroska - > "$WORK/opus30.mkv"
$FFMPEG -v error -f lavfi -i "aevalsrc=$TONES:s=48000:d=12:c=5.1" -c:a aac -b:a 384k -f matroska - > "$WORK/aac51.mkv"
cp "$HERE/index.html" "$HERE/run.mjs" "$WORK/"
cp "$HERE/../../node_modules/mediabunny/dist/bundles/mediabunny.mjs" "$WORK/"
chmod -R a+rX "$WORK"
docker run --rm -v "$WORK":/w -w /tmp -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 mcr.microsoft.com/playwright:v1.63.0-noble \
  sh -c "npm init -y >/dev/null && npm i -s playwright@1.63.0 >/dev/null 2>&1 && cp /w/run.mjs . && node run.mjs"
rm -rf "$WORK"
