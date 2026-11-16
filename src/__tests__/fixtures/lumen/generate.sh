#!/bin/sh
# Reconstruit les fichiers synthétiques lus par les tests de Lumen serveur (lumenServer-*.test.ts),
# pour que personne n'ait à les croire sur parole. Images et sons viennent des générateurs de ffmpeg
# (testsrc, sine) : le dépôt est public, aucun extrait de film n'y a sa place.
#
#   docker run --rm -v "$PWD/src/__tests__/fixtures/lumen":/o --entrypoint sh linuxserver/ffmpeg /o/generate.sh
#
# Les tests vérifient des propriétés (frontières, continuité, refus), pas des octets : un encodeur mis
# à jour peut changer les fichiers sans changer ce qu'ils démontrent.
set -e
cd /o
F="ffmpeg -hide_banner -loglevel error -y -fflags +bitexact -flags:v +bitexact -flags:a +bitexact"
V="-f lavfi -i testsrc=size=64x48:rate=24:duration=6"
A="-f lavfi -i sine=frequency=440:sample_rate=48000:duration=6"

# (a) HEVC à GOP ouvert : CRA suivies de RASL (x265 `open-gop`, le défaut), une IDR en tête. Trois pistes
#     audio : E-AC-3 stéréo et AC-3 5.1 (copiables), Opus (à convertir).
$F $V $A -f lavfi -i sine=frequency=660:sample_rate=48000:duration=6 -f lavfi -i sine=frequency=880:sample_rate=48000:duration=6 \
  -map 0:v -map 1:a -map 2:a -map 3:a \
  -c:v libx265 -preset ultrafast -crf 40 -x265-params keyint=24:min-keyint=24:scenecut=0:open-gop=1:bframes=3:log-level=error -pix_fmt yuv420p \
  -c:a:0 eac3 -b:a:0 32k -c:a:1 ac3 -ac:a:1 6 -b:a:1 96k -c:a:2 libopus -b:a:2 24k \
  -metadata:s:a:0 language=fre -metadata:s:a:1 language=eng -metadata:s:a:2 language=spa \
  hevc-cra.mkv

# (b) HEVC à GOP fermé (IDR seulement), un AAC stéréo.
$F $V $A -c:v libx265 -preset ultrafast -crf 40 -x265-params keyint=24:min-keyint=24:scenecut=0:open-gop=0:bframes=3:log-level=error -pix_fmt yuv420p \
  -c:a aac -b:a 32k -metadata:s:a:0 language=fre hevc-idr.mkv

# (b2) HEVC à GOP ouvert sans images B : des CRA sans aucune image de tête, donc des points de coupe.
$F $V $A -c:v libx265 -preset ultrafast -crf 40 -x265-params keyint=24:min-keyint=24:scenecut=0:open-gop=1:bframes=0:log-level=error -pix_fmt yuv420p \
  -c:a aac -b:a 32k hevc-cra-sans-rasl.mkv

# (c) H.264 ordinaire, IDR toutes les secondes, AAC stéréo.
X264="-c:v libx264 -preset ultrafast -crf 40 -x264-params keyint=24:min-keyint=24:scenecut=0:bframes=2 -pix_fmt yuv420p"
$F $V $A $X264 -c:a aac -b:a 32k -metadata:s:a:0 language=eng h264-aac.mkv

# (d) H.264 à GOP ouvert : une IDR en tête, puis des I derrière un point de reprise suivies d'images de
#     tête — l'équivalent H.264 des RASL. Aucune n'est un point de coupe.
$F $V $A -c:v libx264 -preset ultrafast -crf 40 -x264-params keyint=24:min-keyint=24:scenecut=0:bframes=2:open-gop=1 -pix_fmt yuv420p \
  -c:a aac -b:a 32k h264-opengop.mkv

# (e) Le son commence 3 s après l'image (§148).
$F $V -itsoffset 3 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=3 $X264 -c:a aac -b:a 32k h264-late.mkv

# (f) Le son s'arrête à 2 s, l'image à 6 s.
$F $V -f lavfi -i sine=frequency=440:sample_rate=48000:duration=2 $X264 -c:a aac -b:a 32k h264-short.mkv

# (g) Sans index : un Matroska écrit dans un tube n'a ni Cues ni tailles de grappe.
$F $V $A $X264 -c:a aac -b:a 32k -f matroska - > h264-nocues.mkv

# (h) MP4 : H.264 + AAC, index en tête, liste de montage (B-frames).
$F $V $A $X264 -c:a aac -b:a 32k -movflags +faststart -metadata:s:a:0 language=eng h264.mp4

chown 1000:1000 /o/*.mkv /o/*.mp4
ls -l /o
