# ffmpeg-lumen — le ffmpeg minimal de la conversion du son

Le binaire `ffmpeg` que l'image de Laterna porte (`/usr/local/bin/ffmpeg`) pour la conversion du son de Lumen
serveur (DECISIONS.md §161 à §163, `docs/remux-serveur/5-conversion-son.md`). Construit par l'étape `ffmpeg-lumen`
du `Dockerfile`, qui lance `build.sh` dans `alpine:3.24` (l'Alpine de `node:26-alpine`), puis copié seul dans l'image
finale. Rien d'autre ne l'appelle tant que l'option « Conversion du son » est coupée (défaut).

## Version et source

| | |
|---|---|
| FFmpeg | **7.1.5** — la version déjà épinglée par `tools/truehd-wasm` et `tools/aac-wasm` : le décodeur TrueHD du serveur est le même code que celui que le navigateur exécute en WebAssembly |
| Archive | `https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz` |
| SHA-256 | `de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f` (relevée après vérification de la signature de l'équipe FFmpeg, clé `FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8`) |
| Compilateur | gcc 15.2 d'Alpine 3.24, `-O2`, assembleur x86 (nasm) |
| Liaison | statique (`--extra-ldflags=-static`) : aucune bibliothèque partagée, le binaire se copie seul |
| Taille | 4,1 Mo (`strip`) |
| Construction | ~2 min sur 4 fils ; gardée en cache par BuildKit tant que `build.sh` ne change pas |

Une montée de version passe par le banc `lumen-audio-bench.spec.ts` (jointures identiques à l'octet, déterminisme,
niveaux par canal, placement à l'échantillon) avant et après, comme `ffmpeg-wasm-regress-bench` pour les modules
WebAssembly. La conversion vérifie au démarrage que le binaire dit `ffmpeg version 7.1.5` : une autre version est vue
comme « conversion indisponible » (`EXPECTED_FFMPEG_VERSION`, `src/lib/lumenServer/audio/ffmpeg.ts`).

## Options de compilation

Tout est coupé (`--disable-everything --disable-autodetect`), puis seulement :

- **démultiplexeurs** : matroska, mov, truehd, mlp, dts, dtshd, ac3, eac3, aac, mp3, ogg, flac, wav, pcm (f32le,
  s16le, s24le, s32le) ;
- **décodeurs** : truehd, mlp, dca (DTS, DTS-HD), opus, mp2, mp3, flac, aac, ac3, eac3, pcm ;
- **encodeurs** : eac3 (la cible), ac3, aac, flac (laissés pour l'option sans perte et la stéréo AAC, plus tard), pcm ;
- **découpeurs** : mlp, dca, ac3, aac, opus, flac, mpegaudio ;
- **filtres** : aresample, aformat, anull, atrim, asetpts, pan, astats, apad, adelay, ashowinfo, channelmap ;
- **muxeurs** : eac3, ac3, adts, mp4, flac, wav, pcm, null, framemd5, md5 ;
- **protocoles** : file, pipe ; **zlib** (statique) — des MKV compressent des pistes par zlib.

Ni `ffplay`, ni `ffprobe`, ni avdevice, ni swscale, ni réseau. La ligne exacte est dans l'image :
`/usr/local/share/ffmpeg-lumen/SOURCE.txt` (sortie de `ffmpeg -buildconf`, empreinte du binaire).

## Licence

Ni `--enable-gpl`, ni `--enable-nonfree`, ni libfdk : **LGPL 2.1 ou plus**. ffmpeg est un programme à part, lancé par
`spawn` sans shell ; le code de Laterna n'en dérive pas. L'offre de source tient dans l'image : le texte de la licence
(`/usr/local/share/ffmpeg-lumen/COPYING.LGPLv2.1`), l'adresse de l'archive, son empreinte et la configuration
(`SOURCE.txt`), et ce script, qui la reconstruit à l'identique. Les sources de FFmpeg 7.1.5 sont aussi sur
<https://ffmpeg.org/releases/> et <https://git.ffmpeg.org/ffmpeg.git> (étiquette `n7.1.5`).

## Le reconstruire à la main

```sh
docker build --target ffmpeg-lumen -t lumen-ffmpeg .
docker run --rm lumen-ffmpeg cat /opt/ffmpeg/share/ffmpeg-lumen/SOURCE.txt
```

## Comment Laterna s'en sert

- **Détection** au démarrage et à la demande (Configuration → Lecture → « Conversion du son ») : `-version`, les
  listes d'encodeurs, décodeurs, démultiplexeurs et filtres, et un encodage de 0,1 s de silence par cible. Un binaire
  absent, d'une autre version ou incomplet : la conversion est indisponible, le son est converti par l'appareil.
- **Lancement** : `spawn` avec un tableau d'arguments, jamais de shell ; aucun chemin de fichier en argument (le flux
  arrive par l'entrée standard, les trames repartent par la sortie standard, `-protocol_whitelist pipe`) ; un
  environnement vide ; `nice` 10 pour un segment demandé, 15 pour l'avance ; un délai maximal puis `SIGKILL` ; un
  nombre de processus borné (`LUMEN_AUDIO_MAX_JOBS`). ffmpeg n'écrit rien sur le disque.
- `LUMEN_FFMPEG_PATH` (déploiement) : un autre binaire, ou vide pour couper la conversion sur cette instance.
