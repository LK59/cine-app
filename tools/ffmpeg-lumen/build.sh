#!/bin/sh
# Construit le ffmpeg minimal de Lumen serveur (conversion du son, phase 2 — docs/remux-serveur/5-conversion-son.md,
# DECISIONS.md §161). Lancé par l'étape `ffmpeg-lumen` du Dockerfile, dans `alpine:3.24` ; il installe
# `/opt/ffmpeg/bin/ffmpeg` et l'offre de source à côté (`/opt/ffmpeg/share/ffmpeg-lumen/`).
#
#   sh build.sh            (dans un conteneur Alpine, en root : il installe ses outils par apk)
#
# Tout est figé, comme pour tools/truehd-wasm et tools/aac-wasm : la version de FFmpeg et l'empreinte de son
# archive — la même, 7.1.5, vérifiée contre la signature de l'équipe FFmpeg (clé FCF9 86EA 15E6 E293 A564 4F10
# B432 2F04 D676 58D8). Une seule version de FFmpeg dans le dépôt : le décodeur TrueHD du serveur est alors le
# même code que celui que le navigateur exécute en WebAssembly, ce qui compte pour le repli vers l'appareil.
#
# Licence : ni --enable-gpl, ni --enable-nonfree, ni libfdk — LGPL 2.1 ou plus. ffmpeg est un programme lancé à
# part (spawn, sans shell) ; le code de Laterna n'en dérive pas. L'offre de source tient dans l'image : ce
# script, l'URL de l'archive et son empreinte, et la ligne de configuration exacte (`-buildconf`).
set -eu

FFMPEG=ffmpeg-7.1.5
SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
URL="https://ffmpeg.org/releases/$FFMPEG.tar.xz"
JOBS=${JOBS:-4}

apk add --no-cache build-base nasm curl xz zlib-dev zlib-static >/dev/null

WORK=/src
mkdir -p "$WORK" && cd "$WORK"
curl -sSL -o ffmpeg.tar.xz "$URL"
echo "$SHA256  ffmpeg.tar.xz" | sha256sum -c -
tar xf ffmpeg.tar.xz && rm ffmpeg.tar.xz && cd "$FFMPEG"

# Ce que Lumen serveur décode : tout ce qui n'est pas copiable (DTS et DTS-HD, TrueHD, Opus, MP2, MP3 ; PCM pour
# plus tard), et AAC, AC-3, E-AC-3, FLAC pour le banc ; ce qu'il encode : E-AC-3 (la cible), AC-3, AAC et FLAC
# (l'option sans perte et la stéréo AAC, laissées pour plus tard) ; ce dont le banc mesure : astats, framemd5,
# f32le. `adelay` et `apad` posent les zéros devant et derrière une piste qui ne couvre pas l'image (règle 2.15).
# zlib (statique) : des MKV compressent des pistes par zlib ; sans lui, « Unsupported encoding type ».
# Statique (`-static`) : aucune bibliothèque partagée, le binaire se copie seul dans l'image finale.
./configure \
  --prefix=/opt/ffmpeg \
  --pkg-config-flags=--static --extra-ldflags=-static --extra-cflags=-O2 \
  --disable-shared --enable-static \
  --disable-everything --disable-autodetect --enable-zlib --disable-network --disable-doc --disable-debug \
  --disable-ffplay --disable-ffprobe --disable-avdevice --disable-swscale --disable-postproc \
  --enable-swresample \
  --enable-protocol=file,pipe \
  --enable-demuxer=matroska,mov,truehd,mlp,dts,dtshd,ac3,eac3,aac,mp3,ogg,flac,wav,pcm_f32le,pcm_s16le,pcm_s24le,pcm_s32le \
  --enable-decoder=truehd,mlp,dca,opus,mp2,mp2float,mp3,mp3float,flac,aac,ac3,eac3,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le,pcm_bluray,pcm_dvd \
  --enable-encoder=eac3,ac3,aac,flac,pcm_f32le,pcm_s16le,pcm_s32le \
  --enable-parser=mlp,dca,ac3,aac,opus,flac,mpegaudio \
  --enable-muxer=eac3,ac3,adts,mp4,flac,wav,pcm_f32le,pcm_s16le,pcm_s32le,null,framemd5,md5 \
  --enable-filter=aresample,aformat,anull,atrim,asetpts,pan,astats,apad,adelay,ashowinfo,channelmap \
  >/dev/null
make -j"$JOBS" >/dev/null
make install >/dev/null
strip /opt/ffmpeg/bin/ffmpeg

# L'offre de source (LGPL 2.1, §6) : où trouver l'archive, son empreinte, et comment elle a été configurée.
mkdir -p /opt/ffmpeg/share/ffmpeg-lumen
cp COPYING.LGPLv2.1 /opt/ffmpeg/share/ffmpeg-lumen/
{
  echo "FFmpeg $FFMPEG, compilé pour Laterna (Lumen serveur, conversion du son)."
  echo "Licence : LGPL 2.1 ou plus (COPYING.LGPLv2.1). Aucun composant GPL ni non libre."
  echo "Source : $URL"
  echo "SHA-256 : $SHA256"
  echo "Script de construction : tools/ffmpeg-lumen/build.sh du dépôt de Laterna."
  echo "Configuration :"
  /opt/ffmpeg/bin/ffmpeg -hide_banner -buildconf
} > /opt/ffmpeg/share/ffmpeg-lumen/SOURCE.txt
sha256sum /opt/ffmpeg/bin/ffmpeg | tee -a /opt/ffmpeg/share/ffmpeg-lumen/SOURCE.txt
