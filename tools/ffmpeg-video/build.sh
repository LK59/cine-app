#!/bin/sh
# Construit le ffmpeg vidéo minimal de la version allégée de Lumen serveur (DECISIONS.md §195, `src/lib/lumenServer/light/`).
# Lancé par l'étape `ffmpeg-video` du Dockerfile, dans `alpine:3.24` ; il installe `/opt/ffmpeg-video/bin/ffmpeg` et
# l'offre de source à côté (`/opt/ffmpeg-video/share/ffmpeg-video/`).
#
#   sh build.sh            (dans un conteneur Alpine, en root : il installe ses outils par apk)
#
# Pourquoi pas le paquet Alpine `ffmpeg` (le choix du 17/11/2026, pour prouver la version allégée) : il tire tous les
# codecs et leurs bibliothèques (x264, x265, dav1d, aom, svt-av1, libplacebo, vulkan, mesa…) — l'image passait de
# 631 à 870 Mo pour quatre fonctions. Ici, seulement ce que `encoder.ts` lance : lire un Matroska, décoder HEVC et
# H.264 par le iGPU (VAAPI), réduire (`scale_vaapi`), encoder en HEVC (`hevc_vaapi`), écrire un flux HEVC brut ; et
# pour la détection, une mire (`-f lavfi testsrc2`) montée sur le iGPU (`format`, `hwupload`).
#
# La même FFmpeg que le ffmpeg du son (tools/ffmpeg-lumen) : 7.1.5, archive vérifiée par SHA-256 (signature de
# l'équipe FFmpeg, clé FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8). Elle a tout ce qu'il faut : `hevc_vaapi`,
# `scale_vaapi`, `-fps_mode` (5.1), `-stats_enc_pre` (6.1).
#
# libva n'existe pas en statique sur Alpine : le binaire est lié dynamiquement à musl, libva et libva-drm — l'image
# finale installe `libva` et le pilote `intel-media-driver` (iHD), indispensable, et rien d'autre.
#
# `--extra-version` : la version que dit le binaire (« 7.1.5-lumen-video-1 ») entre dans l'identité des échelons
# (`cid`, `light/rungs.ts`). À monter (`-2`, …) à chaque changement de ce script qui peut changer des octets encodés :
# de nouvelles adresses, jamais un mélange de deux constructions sous le même nom.
#
# Licence : ni --enable-gpl, ni --enable-nonfree — LGPL 2.1 ou plus, comme le ffmpeg du son. Lancé à part (spawn,
# sans shell) ; le code de Laterna n'en dérive pas. L'offre de source tient dans l'image (`SOURCE.txt`).
set -eu

FFMPEG=ffmpeg-7.1.5
SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
URL="https://ffmpeg.org/releases/$FFMPEG.tar.xz"
EXTRA_VERSION=lumen-video-1
JOBS=${JOBS:-4}

apk add --no-cache build-base nasm curl xz pkgconf libva-dev libdrm-dev >/dev/null

WORK=/src
mkdir -p "$WORK" && cd "$WORK"
curl -sSL -o ffmpeg.tar.xz "$URL"
echo "$SHA256  ffmpeg.tar.xz" | sha256sum -c -
tar xf ffmpeg.tar.xz && rm ffmpeg.tar.xz && cd "$FFMPEG"

# - VAAPI (libva, libva-drm) : le décodage matériel (`hevc_vaapi`, `h264_vaapi` comme accélérateurs), l'encodeur
#   `hevc_vaapi`, le filtre `scale_vaapi` ; `hwupload` monte la mire de la détection sur le iGPU.
# - swscale et `scale`/`format` : la mire de la détection (RGB) convertie en P010 avant `hwupload` ; ffmpeg insère
#   lui-même `scale` pour ces conversions.
# - avdevice et `lavfi` seulement : `-f lavfi -i testsrc2` (la mire). Aucun périphérique de capture. Ses images
#   arrivent emballées (`wrapped_avframe`) : sans ce décodeur, « no decoder found for: wrapped_avframe ».
# - Matroska seul en entrée : la version allégée ne sert que les Matroska (§195 — un MP4 a des listes d'édition).
# - En sortie, un flux HEVC brut (`hevc`, Annex B) ; le muxeur fMP4 est celui du dépôt.
./configure \
  --prefix=/opt/ffmpeg-video \
  --extra-version="$EXTRA_VERSION" \
  --extra-cflags=-O2 \
  --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug \
  --disable-ffplay --disable-ffprobe --disable-postproc --disable-swresample \
  --enable-vaapi \
  --enable-avdevice --enable-indev=lavfi \
  --enable-swscale \
  --enable-protocol=file,pipe \
  --enable-demuxer=matroska \
  --enable-parser=hevc,h264 \
  --enable-decoder=hevc,h264,wrapped_avframe \
  --enable-hwaccel=hevc_vaapi,h264_vaapi \
  --enable-encoder=hevc_vaapi \
  --enable-bsf=hevc_mp4toannexb \
  --enable-muxer=hevc \
  --enable-filter=scale_vaapi,hwupload,hwdownload,format,scale,null,testsrc2 \
  >/dev/null
make -j"$JOBS" >/dev/null
make install >/dev/null
strip /opt/ffmpeg-video/bin/ffmpeg

# L'offre de source (LGPL 2.1, §6) : où trouver l'archive, son empreinte, et comment elle a été configurée.
mkdir -p /opt/ffmpeg-video/share/ffmpeg-video
cp COPYING.LGPLv2.1 /opt/ffmpeg-video/share/ffmpeg-video/
{
  echo "FFmpeg $FFMPEG ($EXTRA_VERSION), compilé pour Laterna (Lumen serveur, version allégée)."
  echo "Licence : LGPL 2.1 ou plus (COPYING.LGPLv2.1). Aucun composant GPL ni non libre."
  echo "Source : $URL"
  echo "SHA-256 : $SHA256"
  echo "Script de construction : tools/ffmpeg-video/build.sh du dépôt de Laterna."
  echo "Liaison : dynamique à musl, libva, libva-drm (paquets Alpine libva, libdrm) ; pilote intel-media-driver."
  echo "Configuration :"
  /opt/ffmpeg-video/bin/ffmpeg -hide_banner -buildconf
} > /opt/ffmpeg-video/share/ffmpeg-video/SOURCE.txt
sha256sum /opt/ffmpeg-video/bin/ffmpeg | tee -a /opt/ffmpeg-video/share/ffmpeg-video/SOURCE.txt
