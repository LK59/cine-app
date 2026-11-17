# ffmpeg-video — le ffmpeg vidéo minimal de la version allégée

Le binaire que l'image de Laterna porte à `/usr/local/bin/ffmpeg-video` pour la version allégée de Lumen serveur
(DECISIONS.md §195, `src/lib/lumenServer/light/`) : décoder un Matroska HEVC ou H.264 par le iGPU Intel, le réduire,
le réencoder en HEVC par le iGPU. Construit par l'étape `ffmpeg-video` du `Dockerfile`, qui lance `build.sh` dans
`alpine:3.24` (l'Alpine de `node:26-alpine`), puis copié seul dans l'image finale. Rien ne l'appelle tant que
l'option « Version allégée » est coupée (défaut), ni sans `/dev/dri` donné au conteneur.

Il remplace le paquet Alpine `ffmpeg` (FFmpeg 8.1.3), qui avait servi à prouver la version allégée : celui-ci tirait
tous les codecs et leurs bibliothèques (x264, x265, dav1d, aom, svt-av1, libplacebo, vulkan, mesa…) — l'image passait
de 631 à 870 Mo pour quatre fonctions.

## Version et source

| | |
|---|---|
| FFmpeg | **7.1.5** — la même que le ffmpeg du son (`tools/ffmpeg-lumen`) et les modules WebAssembly ; elle a `hevc_vaapi`, `scale_vaapi`, `-fps_mode` (5.1) et `-stats_enc_pre` (6.1) |
| Version annoncée | `7.1.5-lumen-video-1` (`--extra-version`) |
| Archive | `https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz` |
| SHA-256 | `de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f` (signature de l'équipe FFmpeg, clé `FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8`) |
| Liaison | dynamique à musl, `libva.so.2`, `libva-drm.so.2`, `libdrm.so.2` : libva n'existe pas en statique sur Alpine |
| À l'exécution | paquets Alpine `libva`, `libdrm`, `intel-media-driver` (le pilote iHD, indispensable) |
| Taille | ~5 Mo (`strip`) |

**La version annoncée entre dans l'identité des échelons** (`cid`, `light/rungs.ts`, avec le pilote et les règles) :
un autre binaire donne d'autres adresses, jamais deux constructions sous le même nom. Monter `EXTRA_VERSION`
(`lumen-video-2`, …) à chaque changement de `build.sh` qui peut changer des octets encodés.

## Options de compilation

Tout est coupé (`--disable-everything --disable-autodetect`), puis seulement :

- **VAAPI** (`--enable-vaapi`) : accélérateurs `hevc_vaapi` et `h264_vaapi` (décodage par le iGPU), encodeur
  `hevc_vaapi` ;
- **démultiplexeur** : matroska (la version allégée ne sert que les Matroska) ; **découpeurs** : hevc, h264 ;
  **décodeurs** : hevc, h264 (les accélérateurs s'y greffent) ;
- **filtres** : scale_vaapi, hwupload, hwdownload, format, scale, null, testsrc2 ; swscale pour les conversions de la
  mire de la détection ;
- **muxeur** : hevc (flux Annex B sur la sortie standard ; le fMP4 est fait par le muxeur du dépôt) ;
  **bsf** : hevc_mp4toannexb ;
- avdevice avec le seul périphérique `lavfi` (`-f lavfi -i testsrc2`, la mire de la détection) ;
- **protocoles** : file, pipe.

Ni `ffplay`, ni `ffprobe`, ni réseau, ni swresample, ni aucun encodeur logiciel. La ligne exacte est dans l'image :
`/usr/local/share/ffmpeg-video/SOURCE.txt` (sortie de `ffmpeg -buildconf`, empreinte du binaire).

## Licence

Ni `--enable-gpl`, ni `--enable-nonfree` : **LGPL 2.1 ou plus**, comme le ffmpeg du son. libva et libdrm sont sous
licence MIT, le pilote iHD sous MIT et BSD. ffmpeg est un programme à part, lancé par `spawn` sans shell ; le code de
Laterna n'en dérive pas. L'offre de source tient dans l'image : le texte de la licence
(`/usr/local/share/ffmpeg-video/COPYING.LGPLv2.1`), l'adresse de l'archive, son empreinte et la configuration
(`SOURCE.txt`), et ce script, qui la reconstruit à l'identique.

## Le reconstruire à la main

```sh
docker build --target ffmpeg-video -t lumen-ffmpeg-video .
docker run --rm lumen-ffmpeg-video cat /opt/ffmpeg-video/share/ffmpeg-video/SOURCE.txt
```

## Le prouver

`src/__tests__/lumen-light-bench.spec.ts` sur un vrai fichier, dans un conteneur jetable de l'image construite, avec
le iGPU (`--device /dev/dri --group-add <gid render>`) : images = origine, instants contigus, une IDR par segment,
HDR gardé, décodage sans erreur, codec annoncé = init. La vérification elle-même (ffprobe, décodage complet) demande
un ffmpeg complet à côté (`apk add ffmpeg` dans le conteneur jetable seulement).
