#!/bin/sh
# Un MP4 fragmenté de la forme que Jellyfin livre à ses transcodages progressifs (mesuré le
# 19/10/2026 : `-movflags frag_keyframe+empty_moov+delay_moov`, HEVC `hev1` + AAC, fragments
# image et son mêlés) — en tout petit : 3 s de mire 160×90, une image clé par seconde.
# Pour `offline-fmp4.test.ts`. Avec l'image de Jellyfin, qui embarque son FFmpeg :
#   docker run --rm -v "$PWD/src/__tests__/fixtures/offline":/o --entrypoint sh lscr.io/linuxserver/jellyfin:latest /o/generate.sh
set -e
/usr/lib/jellyfin-ffmpeg/ffmpeg -v error -f lavfi -i testsrc=size=160x90:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 3 -c:v libx265 -x265-params log-level=error:keyint=24:min-keyint=24:scenecut=0 -tag:v hev1 -pix_fmt yuv420p \
  -c:a aac -ac 2 -b:a 64k -movflags frag_keyframe+empty_moov+delay_moov -f mp4 -y /o/jellyfin-like.mp4
