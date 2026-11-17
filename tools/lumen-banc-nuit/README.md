# Banc de nuit : Lumen serveur contre le lecteur actuel, dans un WebKit Linux

Un banc autonome, sur la machine du serveur, sans réseau réel dans l'équation : une instance jetable de l'application,
un WebKit (WPE, celui de Playwright) dans un conteneur à part, la page de banc `/lumen-test` (docs/remux-serveur/,
étapes 3b à 3f) pilotée par Playwright. Il mesure ce que la page mesure (première image, image au saut, reprise,
attentes, gels, erreurs, chronologie) pour les deux lecteurs — **Lumen serveur** (la liste HLS lue nativement) et le
**lecteur actuel** (remux dans la page, MediaSource) —, sous trois profils réseau simulés et deux décodages (iGPU par
VA-API, ou logiciel), et la **consommation processeur** de chaque lecteur sur des lectures continues de 15 minutes,
côté navigateur (cgroup du conteneur, et par processus WebKit) comme côté serveur (cgroup de l'instance).

**Ce n'est pas un iPhone.** Le HLS natif de ce WebKit est celui de GStreamer (`hlsdemux`), pas AVFoundation : sa
politique de mise en tampon, de reprise après un saut et de choix des segments est la sienne. Ce banc dit ce que coûte
et comment se comporte chaque lecteur *dans un moteur WebKit*, de façon fine et répétable ; il ne remplace pas la page
jouée sur l'appareil.

## Ce qu'il a fallu pour que WebKit Linux lise le HLS

- Le WebKit de Playwright 1.63 (WPE 26.6, GStreamer 1.24 de l'image) répond `""` à
  `canPlayType("application/vnd.apple.mpegurl")` et refuse une liste (`MediaError` 4) : le HLS de GStreamer est
  **coupé par défaut** dans WebKitGTK/WPE. `WEBKIT_GST_ENABLE_HLS_SUPPORT=1` le rallume (`canPlayType` → `"maybe"`,
  `hlsdemux` de gst-plugins-bad lit la liste). `faisabilite.mjs` le vérifie sur des fichiers de synthèse.
- **MediaSource** et **ManagedMediaSource** existent ; H.264, HEVC (Main, Main 10), AAC, HE-AAC, AC-3, E-AC-3, Opus et
  FLAC sont acceptés (`isTypeSupported`) et décodés ; `dvh1` ne l'est pas (le lecteur actuel et Lumen serveur
  annoncent `hvc1` + boîte DV, lu comme du HEVC).
- **L'iGPU** : l'image du navigateur (`navigateur/Dockerfile`) ajoute le pilote iHD ; le greffon `va` de GStreamer
  (`vah264dec`, `vah265dec`) décode alors par VA-API sur l'UHD 630 si `/dev/dri/renderD128` est monté et les
  décodeurs mis en tête (`GST_PLUGIN_FEATURE_RANK`, `nav.sh`). Sans eux : `avdec_h264` / `avdec_h265` (libav, sur le
  processeur). Vérifié par `GST_DEBUG=GST_ELEMENT_FACTORY:4` (quel élément WebKit crée).
- Le son : aucun périphérique dans le conteneur, GStreamer choisit un `fakesink` synchronisé — le son est décodé et
  cadencé, pas joué.

## Les pièces

| Fichier | Rôle |
|---|---|
| `instance.sh` | image d'un commit (`git archive`), instance jetable (`CINE_BACKGROUND_JOBS=off`, données copiées par `regress-lecteur/prepare-data.py`, médias en lecture seule, `LUMEN_PATH_MAP`), session administrateur fabriquée par l'instance (`mint-session.mjs`) |
| `mint-session.mjs` | dans l'instance : AuthenticateByName du compte de test (identifiants par l'entrée standard, jeton rendu aussitôt), cookie signé par le secret de l'instance, ligne `sessions` |
| `navigateur/Dockerfile` | Playwright 1.63 + pilote iHD, outils GStreamer/VA, `intel_gpu_top`, `tc`, `ethtool` |
| `nav.sh` | un passage du navigateur (`lumen-nuit-nav`), décodage `va` ou `sw`, borné (`--cpus 4`) |
| `banc.mjs` | le pilote Playwright : `serie` (une passe de la page), `conso` (lecture continue mesurée), `coupure` (redémarrage du serveur) |
| `reseau.sh` | profils `tc netem` sur la boucle de l'espace réseau du banc : `aucun`, `5g`, `wifi-faible` |
| `sampler.py` | relevé sur l'hôte, toutes les 2 s : cgroups (navigateur, instance, Jellyfin, production), processus du navigateur, charge |
| `nuit.sh` | déroule un plan (`plan.exemple.txt`), lots de moins de deux heures, sessions Jellyfin et charge notées avant chaque étape |
| `redemarrage.sh` | redémarre l'instance pendant une lecture (tampon plein, tampon vide), puis la remplace par une image d'un autre format (410) |
| `panne.sh` | arrête l'instance juste avant un saut (le vrai cas « tampon vide »), la rend 10 s plus tard |
| `son.sh`, `verif-son.mjs` | le son réellement joué (Web Audio dans la page) comparé par corrélation au son de chaque piste du fichier (ffmpeg) : quelle piste joue, quand elle change, les trous |
| `sondes.sh` | sondes courtes : pistes annoncées, Web Audio sur HLS (playbin2/playbin3), son DTS du lecteur actuel, un redémarrage |
| `fils.py` | le temps processeur de chaque fil du processus web sur une fenêtre (décodeur, rendu, fil JavaScript…) |
| `analyse.py` | dépouillement : `essais.jsonl`, `sauts.jsonl`, `conso.jsonl`, `tableaux.md` |
| `ecarts.py`, `conso-resume.py` | l'écart serveur − actuel avec intervalle (rééchantillonnage), le résumé de consommation par titre |
| `sessions.sh` | les lectures en cours sur le Jellyfin de production (lecture seule, sans secret) |
| `faisabilite.mjs` | ce que le WebKit sait lire, sur des médias de synthèse |

## L'espace réseau

Un conteneur qui ne fait rien (`lumen-nuit-netns`, sur `media_net` pour joindre Jellyfin) porte l'espace réseau ;
l'instance et le navigateur s'y joignent (`--network container:lumen-nuit-netns`). Le navigateur lit
`http://localhost:3000` : un contexte sécurisé (sans lui, ni `AudioEncoder` ni OPFS), sans relais qui coûterait du
processeur. Tout le trafic navigateur ↔ instance passe par `lo`, et lui seul : c'est là que `reseau.sh` pose `netem`
(l'instance parle à Jellyfin par son autre interface). L'instance peut redémarrer sans emporter le réseau du navigateur.

## Lancer

```sh
W=~/xbench/lumen-serveur/nuit; mkdir -p $W/secrets && chmod 700 $W/secrets
(umask 077; cp <fichier JELLYFIN_TEST_USER=/JELLYFIN_TEST_PASSWORD=> $W/secrets/creds.env)
docker build -t lumen-nuit-webkit:1 tools/lumen-banc-nuit/navigateur
docker run --rm -v $W/pw:/w -w /w mcr.microsoft.com/playwright:v1.63.0-noble sh -c "npm init -y && npm i playwright@1.63.0"
tools/lumen-banc-nuit/instance.sh build <commit>
python3 -I tools/lumen-banc-nuit/sampler.py $W/out/samples.jsonl 2 &
NUIT_CREDS=$W/secrets/creds.env NUIT_FIN=$(date -d 06:55 +%s) tools/lumen-banc-nuit/nuit.sh tools/lumen-banc-nuit/plan.exemple.txt
python3 -I tools/lumen-banc-nuit/analyse.py $W
tools/lumen-banc-nuit/instance.sh clean     # et arrêter sampler.py ; `shred -u` sur creds.env
```

Avant une nuit : mettre X-Ray en pause (son planificateur partage l'iGPU et le disque), et le relancer après.
Le compte Jellyfin est **le compte de test**, jamais celui d'une personne ni l'administrateur de `.env`.

## Mesurer la consommation

- **Le cgroup** du conteneur du navigateur (`cpu.stat` `usage_usec`) entre les deux bornes que le pilote écrit
  (`marks.jsonl`, après la première image et 20 s de chauffe), rapporté à la durée lue : CPU-secondes par heure de
  lecture. Il ne compte que ce conteneur : juste malgré la charge des voisins. La charge (`loadavg`) est notée, une
  mesure prise au-dessus de 6 est signalée.
- **Par processus** (`/proc/<pid>/stat` des processus du cgroup) : `WPEWebProcess` (la page : JavaScript, remux,
  MediaSource, décodage GStreamer), `WPENetworkProcess` (les requêtes), le pilote Node de Playwright — retiré du
  total « WebKit ».
- **Le serveur** : le cgroup de l'instance (Next et ses fils de calcul). Pour le lecteur actuel, une part du coût
  serveur est dans Jellyfin (il relaie le fichier par `/api/jellyfin/stream`) : le cgroup de Jellyfin est relevé
  aussi, mais il porte les lectures de toute la maison — à lire comme un ordre de grandeur.
- **L'iGPU** : `intel_gpu_top` (conteneur privilégié, compteurs seulement), global à la machine — Jellyfin peut
  transcoder en même temps (`sessions.sh` le dit avant chaque mesure).

## Limites connues (nuit du 16-17/11/2026)

- **Le greffon `va` de GStreamer 1.24 fuit dans ce WebKit** : 20 à 100 Mo/s de `shmem` (objets GEM de l'i915) en 4K,
  pour les deux lecteurs ; le conteneur est tué vers sa limite mémoire en une à trois minutes. D'où `MODE=essai` (un
  navigateur par essai) et `NAV_MEM=8g`. Ni `WEBKIT_GST_DMABUF_SINK_DISABLED=1`, ni `gstreamer-vaapi` (`DECODE=vaapi` :
  WebKit l'écarte, retour au logiciel), ni le WebKit de Playwright 1.55 n'y changent rien. En VA-API, le compositeur sans
  écran ne présente que 8 à 13 images/s.
- **Le décodage logiciel ne tient pas la 4K** (1 à 1,5 image/s sur 4 cœurs) ; il tient le 1080p à cadence pleine.
- **Le lecteur actuel ne joue pas un son DTS dans ce WebKit** (aucune image en 90 s).
- **Le HLS de GStreamer fige la page** (fil principal bloqué) quand une liste ou un segment échoue — serveur arrêté
  pendant un saut, ou adresse en 410 après un changement de format ; le pilote borne chaque passage (`timeout`).
- **Un changement de piste `audioTracks` en HLS de GStreamer** joue la nouvelle langue décalée de ~15 s (vu par
  `verif-son.mjs`) ; la plupart des listes n'annoncent d'ailleurs qu'une piste.
- `intel_gpu_top` lit l'iGPU entier : sans valeur pour un lecteur quand d'autres s'en servent.

- Le HLS de GStreamer n'expose **qu'une piste son** dans `video.audioTracks` (les rendus `EXT-X-MEDIA` ne sont pas
  proposés au choix) : le tour des pistes et le changement de piste de la passe « son multiplexé » ne se jouent pas
  ici. `getVideoPlaybackQuality()` y compte mal les images (bien moins que `requestVideoFrameCallback`).
- `netem` sur `lo` : un même délai par sens, le débit partagé par les deux sens (les requêtes pèsent peu).
