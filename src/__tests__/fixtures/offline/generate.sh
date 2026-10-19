#!/bin/sh
# Un MP4 fragmenté de la forme que Jellyfin livre à ses transcodages progressifs (mesuré le
# 19/10/2026 : `-movflags frag_keyframe+empty_moov+delay_moov`, HEVC `hev1` + AAC, fragments
# image et son mêlés) — en tout petit : 3 s de mire 160×90, une image clé par seconde.
# Pour `offline-fmp4.test.ts`. Avec l'image de Jellyfin, qui embarque son FFmpeg :
#   docker run --rm --device /dev/dri:/dev/dri -v "$PWD/src/__tests__/fixtures/offline":/o --entrypoint sh lscr.io/linuxserver/jellyfin:latest /o/generate.sh
set -e
/usr/lib/jellyfin-ffmpeg/ffmpeg -v error -f lavfi -i testsrc=size=160x90:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 3 -c:v libx265 -x265-params log-level=error:keyint=24:min-keyint=24:scenecut=0 -tag:v hev1 -pix_fmt yuv420p \
  -c:a aac -ac 2 -b:a 64k -movflags frag_keyframe+empty_moov+delay_moov -f mp4 -y /o/jellyfin-like.mp4

# Le H.264 que Jellyfin prépare pour un navigateur sans HEVC : `h264_qsv` et ses images forcées
# toutes les 5 s (`-force_key_frames "expr:gte(t,n_forced*5)"`, les réglages de Jellyfin), qui
# sortent en tranches I non IDR sans SEI de point de reprise, non marquées « sync » — un seul
# fragment de 16 s, comme les groupes de plusieurs minutes relevés en vrai (voir `fmp4.ts`, « Le
# fragment trop long »). `-g 1000` étire le groupe au-delà du film ; Jellyfin laisse le défaut de
# QSV (250 images).
# Deux pièges. Il faut un GPU Intel (`--device /dev/dri`) : c'est l'encodeur matériel qui fait
# cette forme, libx264 ne la reproduit pas (ses images forcées sont des IDR). Et QSV doit recevoir
# des images *décodées* : une image sortie d'un filtre `lavfi` porte le drapeau « clé », et QSV fait
# alors une IDR de chaque image forcée — d'où la source intermédiaire, une seule image clé en 16 s.
/usr/lib/jellyfin-ffmpeg/ffmpeg -v error -f lavfi -i testsrc=size=160x96:rate=24000/1001 -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 16 -c:v libx264 -x264-params keyint=1000:min-keyint=1000:scenecut=0:log-level=error -pix_fmt yuv420p -c:a flac -y /tmp/h264-source.mkv
/usr/lib/jellyfin-ffmpeg/ffmpeg -v error -init_hw_device vaapi=va:,vendor_id=0x8086,driver=iHD -init_hw_device qsv=qs@va -filter_hw_device qs \
  -i /tmp/h264-source.mkv -vf format=nv12,hwupload=extra_hw_frames=24,format=qsv \
  -c:v h264_qsv -force_key_frames "expr:gte(t,n_forced*5)" -g 1000 -preset veryfast -mbbrc 1 -b:v 40k -maxrate 40001 -bufsize 160000 \
  -c:a aac -ac 2 -b:a 24k -f mp4 -movflags frag_keyframe+empty_moov+delay_moov -y /o/jellyfin-h264-qsv.mp4
