# 4. Son, compatibilité Apple et recensement — « Lumen serveur »

Recherche, mesures en lecture seule, conception. Aucun fichier du dépôt modifié. Le 16/11/2026.

Données brutes et scripts, dans ce même dossier :
- `recensement-brut.json` — une ligne par élément Jellyfin (10 533 films et épisodes + 77 collections ignorées), chaque flux avec codec, profil, canaux, fréquence, langue, drapeaux, plage dynamique, profil Dolby Vision. Une seule requête paginée à `/Items` (clé serveur, lecture seule).
- `census.js` (la requête, exécutée par `docker exec -i cine-app node -`), `analyse.py` (les comptes ci-dessous).
- `ffprobe-echantillon.tsv` — 80 fichiers tirés au hasard (40 films, 40 épisodes) relus par `ffprobe` pour contrôler Jellyfin.
- `mesure/` — les sorties des conversions de 60 s (`*.out`) et les journaux ffmpeg (`*.err`).

---

## 4.1 Ce que le HLS fMP4 natif d'Apple accepte en audio

Source principale : la [HLS Authoring Specification for Apple Devices](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices) (numéros de règle entre parenthèses), la [fiche technique de l'Apple TV 4K](https://www.apple.com/apple-tv-4k/specs/), et le brouillon [draft-pantos-hls-rfc8216bis-22](https://datatracker.ietf.org/doc/html/draft-pantos-hls-rfc8216bis) pour la syntaxe des listes.

| Format | Accepté (Safari iOS/macOS, AVPlayer, tvOS) | Canaux | `CODECS` | Notes |
|---|---|---|---|---|
| AAC-LC | **Oui** | stéréo et multicanal (2.2, 2.5) | `mp4a.40.2` | La spec ne recommande l'AAC que jusqu'au 5.1 (table 2.9) ; 7.1 non cité. |
| HE-AAC v1 | **Oui** | stéréo et multicanal (2.5) | `mp4a.40.5` | En fMP4, signalisation **explicite** du SBR obligatoire (2.24). À éviter au-delà de 64 kb/s (2.4). |
| HE-AAC v2 | Oui | stéréo seulement (2.2) | `mp4a.40.29` | |
| xHE-AAC | Oui | stéréo | `mp4a.40.42` | Absent de la bibliothèque. |
| AC-3 | **Oui** | jusqu'au 5.1 (2.5) | `ac-3` | 384 kb/s recommandé en 5.1. |
| E-AC-3 | **Oui** | jusqu'au 7.1 (2.5, 2.9 ; Apple TV : « E-AC-3 7.1 ») | `ec-3` | `ec+3` est déprécié. |
| E-AC-3 + Atmos (JOC) | **Oui** | `CHANNELS="16/JOC"` | `ec-3` | Le nombre doit égaler `complexity_index_type_a` du `dec3` ; `JOC` en capitales. tvOS : une seule qualité Atmos (2.8). |
| FLAC | **Oui** | stéréo et multicanal (2.2, 2.5) | `fLaC` | fMP4 obligatoire (2.25). |
| ALAC | Oui | stéréo et multicanal | `alac` | fMP4 obligatoire. Absent de la bibliothèque. |
| MP3 | Probable | stéréo | `mp4a.40.34` | Seulement cité dans la table des chaînes CODECS ; l'Apple TV lit le MP3. Non garanti en fMP4 HLS : à tester. |
| Opus | **Non officiellement** | — | (`Opus`) | Absent de la spec et des fiches techniques. Rapports de développeurs : lu par AVPlayer en MP4 depuis iOS 17, pas avant ([forum 759210](https://developer.apple.com/forums/thread/759210), [forum 759236](https://developer.apple.com/forums/thread/759236), [forum 681675](https://developer.apple.com/forums/thread/681675)). Rien sur tvOS / AirPlay. **À convertir.** |
| PCM (LPCM) | Non en HLS | — | — | Absent de la spec (l'Apple TV lit WAV/AIFF en fichiers, pas en HLS). À convertir. |
| MP2 | Non | — | — | À convertir. |
| **DTS** (cœur, HRA, MA, :X) | **Non** | — | — | Absent de la spec, de la fiche Apple TV ; aucun décodeur DTS sur les appareils Apple. |
| **TrueHD** (avec ou sans Atmos) | **Non** | — | — | Idem. |

Contraintes de liste à respecter :
- **Pistes audio séparées** : multicanal et langues alternatives MUST être des rendus `EXT-X-MEDIA TYPE=AUDIO` séparés (9.6, 9.7) ; `LANGUAGE` obligatoire (8.10) ; un segment ne porte qu'un flux audio (2.17).
- **Un groupe par couple codec × nombre de canaux**, chaque groupe contenant toutes les langues (annexe). `CHANNELS` : premier paramètre = nombre maximal de canaux indépendants (`"2"`, `"6"`, `"8"`, `"16/JOC"`).
- Le `CODECS` de chaque `EXT-X-STREAM-INF` liste **tous** les formats de tous les rendus du groupe référencé (rfc8216bis §4.4.6.1.1, 9.1).
- Un rendu alternatif doit couvrir **toute la durée** du contenu (2.15) — conséquence directe pour les pistes dont le son commence tard (§148, plus bas).
- La spec veut une **stéréo AAC** toujours présente (2.3, MUST) et un AC-3 si un appareil cible ne lit pas l'E-AC-3 (2.6). C'est une règle d'éditeur (App Store) ; AVPlayer lit sans. Tous les appareils Apple encore en service lisent l'E-AC-3 ; la stéréo AAC n'a d'intérêt réel que pour les récepteurs AirPlay tiers (téléviseurs) dont on ignore les décodeurs.
- tvOS (donc AirPlay vers Apple TV) : pas de variante audio seule dans la liste principale (9.20). AirPlay 2 : la disposition des canaux ne devrait pas changer dans un flux (2.10).
- `ludt` / `dialnorm` : sonie recommandée (2.18–2.21). Une piste Dolby copiée porte son `dialnorm` ; un encodage de notre part devrait garder la valeur d'origine ou ne rien prétendre.

Vidéo (pour mémoire, mêmes sources) : HEVC en fMP4 obligatoire (1.5), `hvc1` plutôt que `hev1` (1.10), `VIDEO-RANGE` obligatoire hors SDR (9.16), Dolby Vision profil 5, ou 8.1 déclaré en `SUPPLEMENTAL-CODECS="dvh1.08.xx/db1p"` avec `CODECS` HEVC (section « Supplemental codecs »). L'Apple TV 4K annonce « Dolby Vision (Profile 8.1 and 5), HDR10, HDR10+, HLG » et l'AV1.

---

## 4.2 Recensement de la bibliothèque

10 533 fichiers (672 films, 9 861 épisodes), 20 843 pistes audio, 7 967 heures. Classement d'une piste :
- **passe** : AAC-LC 1/2/6 canaux, HE-AAC 2/6, AC-3 48 kHz, E-AC-3 (dont Atmos), FLAC ;
- **doute** (passe probablement, à tester avant de le promettre) : AC-3 à 32 ou 44,1 kHz, AC-3 5 canaux (4.1), AAC 7.1 (les pistes à PCE de §62), MP3 ;
- **à convertir** : DTS (toutes variantes), TrueHD, Opus, MP2, PCM, codec illisible.

### Contrôle de la source

Sur 80 fichiers relus par `ffprobe`, **les pistes audio et vidéo de Jellyfin sont exactes à 100 %** (codecs, ordre, nombre). **Les sous-titres ne le sont pas** : Jellyfin n'expose aucun sous-titre image (PGS, VobSub) — l'échantillon en contient 51 (43 PGS, 8 VobSub) dans 21 fichiers sur 80, que l'API ne liste pas — et marque `IsExternal: false` des `.srt` posés à côté du fichier (*Armageddon* : deux `.srt` « internes » selon Jellyfin, quatre PGS dans le MKV). Les chiffres de sous-titres viennent donc de l'échantillon, pas de l'API. Le lecteur de Laterna lit les pistes dans le fichier (`mediaFile.ts`), ce qu'il faudra faire côté serveur aussi.

### Piste par défaut et toutes les pistes (par fichier)

| | Films (672) | Épisodes (9 861) | Total (10 533) |
|---|---:|---:|---:|
| Piste par défaut **passe** | 600 (89,3 %) | 9 447 (95,8 %) | **10 047 (95,4 %)** |
| Piste par défaut en doute | 2 (0,3 %) | 50 (0,5 %) | 52 (0,5 %) |
| Piste par défaut à convertir | 70 (10,4 %) | 364 (3,7 %) | 434 (4,1 %) |
| … dont une autre piste passe | 13 (1,9 %) | 227 (2,3 %) | 240 (2,3 %) |
| **Toutes** les pistes passent | 568 (84,5 %) | 9 249 (93,8 %) | **9 817 (93,2 %)** |
| Toutes passent ou en doute | 579 (86,2 %) | 9 299 (94,3 %) | 9 878 (93,8 %) |
| **Au moins une piste à convertir** | 93 (13,8 %) | 562 (5,7 %) | **655 (6,2 %)** |

### Selon la langue du compte (la piste effectivement ouverte)

| Langue demandée | Films : passe / doute / à convertir / pas de piste | Épisodes : passe / doute / à convertir / pas de piste |
|---|---|---|
| Français | 584 / 2 / 59 / 27 → **90,5 %** des films ayant une VF | 9 429 / 49 / 138 / 245 → **98,1 %** |
| Anglais | 429 / 8 / 57 / 178 → **86,8 %** des films ayant une VO anglaise | 7 935 / 0 / 414 / 1 512 → **95,0 %** |

La VO des films est le cas le moins couvert en phase 1 : les remux Blu-ray portent leur VO en DTS-HD MA ou TrueHD et leur VF en AC-3/E-AC-3.

### Fichiers ayant au moins une piste à convertir, par codec

| Codec à convertir | Films | Épisodes | Total fichiers | Pistes | Canaux des pistes |
|---|---:|---:|---:|---:|---|
| DTS (cœur) | 31 (4,6 %) | 271 (2,7 %) | 302 (2,9 %) | 363 | 2.0 ×135, 5.1 ×228 |
| DTS-HD MA | 57 (8,5 %) | 92 (0,9 %) | 149 (1,4 %) | 172 | 2.0 ×9, 5.1 ×157, 6.1 ×2, 7.1 ×4 |
| DTS-HD HRA | 1 | 0 | 1 | 1 | 7.1 |
| TrueHD + Atmos | 28 (4,2 %) | 0 | 28 (0,3 %) | 31 | 7.1 |
| TrueHD | 5 (0,7 %) | 0 | 5 | 6 | 5.1 |
| Opus | 0 | 191 (1,9 %) | 191 (1,8 %) | 343 | 2.0 ×304, 3.0 ×38, 5.1 ×1 |
| MP2 | 0 | 6 | 6 | 6 | 2.0 |
| PCM s16le | 0 | 1 | 1 | 1 | 2.0 |
| Codec illisible (Jellyfin `null`) | 0 | 1 | 1 | 1 | 2.0 |
| **FLAC** | — | — | — | (15 pistes, **passent**) | 1.0, 2.0, 5.1 |
| **AAC à PCE** | — | — | — | voir doute | |

Pistes en doute (fichiers) : AC-3 32 kHz 36 (épisodes), MP3 11, AAC 7.1 à PCE 7 (les VO anglaises de *Forrest Gump*, *Deadpool*, *Walter Mitty*, *Once Upon a Time in Hollywood*, *Rocketman*, *Toy Story* — §62 : CoreAudio les décode en MSE, à vérifier en HLS et sur Apple TV), AC-3 44,1 kHz 6, AC-3 4.1 1.

**AAC à PCE** : Jellyfin ne dit pas si un AAC porte un PCE. D'après §62, deux formes existent ici : le 7.1 `MP/-/PP/1` ci-dessus (CoreAudio le décode) et le 5.1 de *Elle s'appelle Ruby* (CoreAudio échoue — « InternalAudioDecoderCocoa decoding failed ») : celui-là est **à convertir** ou à réécrire. Le repérage doit se faire à l'ouverture, avec `aacPlan` (`aacConfig.ts`) qui lit déjà l'AudioSpecificConfig.

**Son qui commence tard** (§148, 63 pistes de 44 films, dont 34 au-delà de 2 s) : la règle 2.15 veut un rendu couvrant toute la durée ; une piste copiée qui commence à 30 s n'a pas de segments avant. Ces pistes sont **à convertir** (silence devant, comme `withLeadSilence`), même en phase 1, ou à exclure de la phase 1. Le décompte ci-dessus ne les retire pas (Jellyfin ne les voit pas).

### Pistes par codec (20 843)

| Codec | Pistes | | Codec | Pistes |
|---|---:|---|---|---:|
| E-AC-3 | 9 511 (dont 25 en 7.1, 15 en mono) | | DTS | 363 |
| AC-3 | 6 136 (+36 à 32 kHz, +6 à 44,1 kHz) | | Opus | 343 |
| AAC-LC | 2 436 (dont 80 en 5.1, 6 en 7.1) | | DTS-HD MA | 172 |
| HE-AAC | 1 079 (dont 528 en 5.1, 1 en 7.1) | | TrueHD (dont Atmos 31) | 37 |
| E-AC-3 + Atmos | 681 | | FLAC | 15 |
| | | | MP3 / MP2 / PCM / autre | 11 / 6 / 1 / 1+1 HRA |

### Vidéo et conteneurs

| | Films | Épisodes | Total |
|---|---:|---:|---:|
| HEVC | 541 (80,5 %) | 7 917 (80,3 %) | **8 458 (80,3 %)** |
| H.264 | 131 (19,5 %) | 1 944 (19,7 %) | 2 075 (19,7 %) |
| **AV1** | 0 | 0 | **0** |
| SDR | 422 | 9 429 | 9 851 (93,5 %) |
| HDR10 | 71 | 99 | 170 |
| HDR10+ | 15 | 17 | 32 |
| Dolby Vision **8.1** (+HDR10) | 122 | 182 | 304 |
| Dolby Vision **8.1** (+HDR10+) | 40 | 134 | 174 |
| Dolby Vision **5** | 2 | 0 | 2 |
| Dolby Vision **7** (couche d'amélioration) | 0 | 0 | **0** |
| 2160p / 1080p / 720p / SD | 283 / 363 / 21 / 5 | 506 / 8 566 / 614 / 175 | 789 / 8 929 / 635 / 180 |
| **MKV** | 667 | 9 849 | **10 516 (99,8 %)** |
| MP4 | 5 | 12 | 17 |

HEVC Main (8 bits) : 4 242 ; Main 10 : 4 216 (3 534 SDR). Tous les profils DV présents sont lisibles par Apple (8.1 en `SUPPLEMENTAL-CODECS`, 5 en `dvh1.05.xx`). Ni AV1 ni DV 7 : rien à écarter côté image.

### Sous-titres

API Jellyfin (incomplète, voir plus haut) : 30 534 pistes texte — SRT 27 362 (dont 5 781 déclarées externes), ASS 3 118 (dans 942 fichiers), WebVTT 48, mov_text 6 ; 4 140 drapeaux `forced`, 4 679 forcés par drapeau ou par titre. Échantillon `ffprobe` (pistes internes) : SRT 170, **PGS 43, VobSub 8**, ASS 6 ; **12 films sur 40 et 9 épisodes sur 40** portent des sous-titres images.

---

## 4.3 Convertir le son au serveur (phase 2)

### Les moyens disponibles

| Option | État constaté | Verdict |
|---|---|---|
| ffmpeg dans `cine-app` | **Absent** (`which ffmpeg` vide). Image Alpine (musl), Node 26, 2 Go de mémoire (`mem_limit`), aucune limite de CPU. Les médias y sont montés en lecture (`/mnt/media/video`). | À ajouter si choisi. |
| ffmpeg de Jellyfin | `/usr/lib/jellyfin-ffmpeg/ffmpeg` **8.1.3-Jellyfin**, 222 Mo, 69 bibliothèques partagées, Ubuntu 26.04 (glibc), `--enable-libfdk-aac`. | **Non réutilisable** tel quel : binaire glibc dans une image musl, et l'appeler dans l'autre conteneur demande le socket Docker (inacceptable). Utile seulement comme banc de mesure. |
| Jellyfin lui-même | Il sait faire un HLS vidéo copiée + son transcodé (c'est le lecteur serveur actuel). | Possible comme source de son seul (à tester : `/Audio/{id}/…` sur un élément vidéo ?), mais ses segments ont sa propre chronologie et il relance ffmpeg à chaque saut : l'alignement avec nos segments vidéo est un risque, et on retombe sur ses défauts. Non recommandé. |
| ffmpeg ajouté à l'image | `apk add ffmpeg` (Alpine, beaucoup de dépendances, plusieurs dizaines de Mo) ou **un ffmpeg minimal compilé** : démultiplexeurs matroska/mov, décodeurs truehd, dca, opus, mp2, pcm, aac, flac, (e)ac3 ; encodeurs eac3, ac3, aac ; muxeurs mp4/adts/eac3 ; aucune bibliothèque externe. | **Recommandé** pour le coût et la simplicité : quelques Mo, reproductible sur le modèle de `tools/truehd-wasm/build.sh` (FFmpeg épinglé, SHA-256). **Sans libfdk-aac** : non libre, interdit dans une image publiée sur GHCR. |
| WebAssembly dans Node | `truehd-wasm.mjs` et `aac-wasm.mjs` tournent déjà dans Node (bancs) ; `@mediabunny/dts` et `@mediabunny/ac3` aussi. Pas d'Opus (WebCodecs n'existe pas dans Node) et **aucun encodeur** : Node n'a pas d'`AudioEncoder`. | Faisable en ajoutant les encodeurs `eac3`/`ac3`/`aac` de FFmpeg à un module wasm construit par le même script ; atout : **les mêmes décodeurs octet pour octet** que le navigateur (prouvés par `ffmpeg-wasm-regress-bench`), et `fold`/`orderFor` réutilisés. Coût : un module de plus à prouver, plus lent que le natif (ordre de grandeur 1,5 à 3×, non mesuré), dans `worker_threads` pour ne jamais tenir la boucle d'événements. |

### Mesure (ffmpeg de Jellyfin, 60 s depuis 600 s, sortie dans `mesure/`)

Machine : i7-8700 (6 cœurs / 12 fils), charge moyenne 6 à 8 pendant la mesure (balayage X-Ray en cours) — chiffres prudents. `rtime` inclut la lecture disque des 60 s du fichier entier (vidéo comprise).

| Source → cible | Temps réel | CPU (user+sys) | **Facteur de vitesse** | Taille 60 s |
|---|---:|---:|---:|---:|
| *Braveheart* TrueHD Atmos 7.1, décodage seul | 1,34 s | 3,6 s | 45× | — |
| → E-AC-3 640 kb/s 5.1 (natif) | 1,57 s | 3,5 s | **38×** | 4,80 Mo |
| → AC-3 640 kb/s 5.1 (natif) | 1,76 s | 3,6 s | 34× | 4,80 Mo |
| → AAC 384 kb/s 5.1 (natif `aac`) | 3,53 s | 6,1 s | 17× | 2,90 Mo |
| → AAC 384 kb/s 5.1 (`libfdk_aac`) | 2,36 s | 4,7 s | 25× | 2,88 Mo |
| → AAC 512 kb/s 7.1 (`libfdk_aac`) | 2,59 s | 4,9 s | 23× | 3,84 Mo |
| → E-AC-3 « 7.1 » demandé | 1,11 s | 2,8 s | — | **replié en 5.1(side)** : l'encodeur E-AC-3 de FFmpeg ne fait pas de 7.1 |
| *Armageddon* DTS-HD MA 5.1, décodage seul | 1,55 s | 1,5 s | 39× | — |
| → E-AC-3 640 kb/s 5.1 | 1,71 s | 1,9 s | **35×** | 4,80 Mo |
| → AAC 384 kb/s 5.1 (natif) | 8,18 s | 9,3 s | 7× | 2,90 Mo |

Lecture : convertir une piste coûte **3 à 6 % d'un cœur en temps réel** vers l'(E-)AC-3, le double vers l'AAC natif (dont le coût varie fortement selon le contenu : ×2,5 entre les deux films). Un film de 2 h entier : ~3 min de calcul vers E-AC-3. Le décodage TrueHD pèse autant que l'encodage.

### Les jointures quand on encode segment par segment

Un encodeur à transformée (AAC : MDCT de 2 048 échantillons, trames de 1 024 ; AC-3/E-AC-3 : blocs de 256 dans des trames de 1 536) a :
- une **amorce** (*priming*) : les premiers échantillons de sortie sont le retard de l'encodeur (`initial_padding` : 1 024 pour `aac` de FFmpeg, 256 pour `ac3`/`eac3` ; Apple compte 2 112 pour son AAC) ;
- un **recouvrement** : chaque trame décodée s'ajoute à la moitié de la précédente (annulation du repliement temporel). Une trame venue d'un autre encodeur, ou d'une fenêtre (longue/courte) différente, n'annule pas exactement : clic ou souffle bref à la jointure.

Encoder chaque segment par un encodeur neuf crée donc une jointure à chaque segment. Ce qui marche :
1. **Grille fixe depuis 0** : les segments audio ont une durée multiple exacte de la trame (ex. 1 536 × 188 = 288 768 échantillons = 6,016 s pour l'E-AC-3 ; 1 024 × 282 = 6,016 s pour l'AAC), leurs bornes ne dépendent que du fichier. Les segments audio n'ont pas à coïncider avec les segments vidéo (rendu séparé), seulement à couvrir la même durée.
2. **Pré-roulement** : l'encodeur qui commence le segment *k* démarre quelques trames plus tôt (≥ 2 trames + son retard), on jette ce qui précède la borne et on date le reste au `tfdt` exact (borne − rien, retard compensé à l'échantillon). Le contenu d'un segment devient une fonction déterministe du fichier : deux séances produisent les mêmes octets, donc **cachables**.
3. **Encodage continu entre deux sauts** : la jointure n'existe alors qu'au point où une tâche de conversion commence (un saut, ou la rencontre d'une plage déjà en cache). Après un saut, AVPlayer repart de toute façon d'un décodeur vide — c'est la situation de tout HLS AAC.

Le résidu (jointure entre deux tâches) se mesure comme ailleurs dans ce dépôt : décoder par ffmpeg la concaténation des segments et la comparer à un encodage continu, au voisinage des bornes (écart RMS par canal). À faire avant de choisir la longueur du pré-roulement.

### Encodage continu par séance, ou piste entière en cache disque

| | Continu par séance | Piste entière en fond, gardée sur disque |
|---|---|---|
| Premier son | Dès la première trame convertie (~0,2 s pour 6 s à 35×) | Idem si la conversion commence à la position demandée |
| Saut | Nouvelle tâche, jointure au point de départ | Plage déjà faite servie telle quelle |
| CPU | Recommence à chaque séance | Une fois par piste et par cible |
| Disque | Nul ou petit | 640 kb/s : **576 Mo par 2 h** ; 384 kb/s : 346 Mo |
| Toute la bibliothèque | — | 715 h de pistes à convertir (924 pistes) : **206 Go** à 640 kb/s, 123 Go à 384 kb/s ; films seuls (307 h) : 88 / 53 Go. Le disque a 174 Go libres. |

**Recommandation** : un hybride. À l'ouverture, une tâche convertit depuis le segment demandé jusqu'à la fin, à 30–40× le temps réel, en priorité basse (`nice`), puis complète le début ; chaque segment, déterministe par la grille, est écrit dans `data/` (seul volume inscriptible ; ex. `data/lumen-audio/<etag>/<piste>-<cible>/<n>.m4s`), sous un **plafond LRU** (ex. 20 Go) et une clé qui comprend l'`ETag` Jellyfin du fichier, l'index de piste, la cible et la version de l'encodeur (comme `resumeCache` et `subtitle_sync`). Pas de conversion de toute la bibliothèque à l'avance : 206 Go pour 6 % des fichiers, la plupart jamais revus. Une tâche par (fichier, piste, cible) à la fois, partagée entre séances ; abandonnée si plus personne ne la lit. Jamais pendant `CINE_BACKGROUND_JOBS=off` au-delà de la séance en cours.

### Format cible

| Cible | Pour | Contre |
|---|---|---|
| **E-AC-3 640 kb/s 5.1** | 38× le temps réel ; même famille que 79 % des pistes de la bibliothèque (E-AC-3/AC-3) : **un seul groupe `ec-3`/6 canaux** pour la VF copiée et la VO convertie ; un téléviseur AirPlay 2 relié à une barre de son en ARC peut la lui transmettre compressée (le 5.1 LPCM ne passe pas par l'ARC) ; l'Apple TV et tous les iPhone/Mac la décodent. | 5.1 au plus (encodeur FFmpeg) : une source 7.1 est repliée ; l'Atmos est perdu dans tous les cas (aucun encodeur JOC libre). Plus lourd que l'AAC sur un lien lent (iPhone en itinérance). |
| AC-3 640 kb/s 5.1 | Universel (barres de son anciennes, ARC) | Plafond 640, moins efficace que l'E-AC-3 à débit égal ; rien qu'Apple ne lise déjà en E-AC-3. |
| AAC 384 kb/s 5.1 | Plus léger, codec natif d'Apple ; la spec préfère l'AAC pour le non-Dolby (2.26) | Encodeur natif de FFmpeg 2 à 5× plus lent et de qualité moindre ; `libfdk_aac` interdit dans l'image publiée ; un second groupe audio (`mp4a`) dans un film mêlant VF Dolby copiée et VO convertie. Une barre de son derrière un téléviseur reçoit au mieux de la stéréo. |
| AAC 2.0 | Stéréo d'appoint exigée par la spec (2.3) ; sources stéréo (DTS 2.0, Opus 2.0, MP2, PCM) | — |

Proposition : **E-AC-3 640 kb/s 5.1 pour toute source multicanal** (TrueHD, DTS, DTS-HD, Opus 3.0/5.1 → 5.1 par `fold`, déjà prouvé), **AAC-LC 2.0 ~192 kb/s pour toute source stéréo ou mono** (304 Opus, 144 DTS 2.0, 6 MP2, 1 PCM). Une stéréo AAC d'appoint pour chaque film n'est à ajouter que si un téléviseur AirPlay tiers refuse l'E-AC-3 (à observer, pas à supposer). À l'Apple TV, peu importe : elle décode tout et sort du LPCM (ou du Dolby MAT pour l'Atmos) selon son réglage « Format audio ».

L'ordre des canaux n'est plus celui du navigateur : FFmpeg natif prend l'ordre standard et range lui-même (pas d'AudioToolbox au serveur). La table `APPLE_AAC_ORDER` ne s'applique pas ; la mesure par tonalités marquées (DOC-TECH « Channel order ») doit être refaite sur la sortie serveur.

---

## 4.4 Sous-titres en HLS

Règles Apple (même spec) : WebVTT (ou IMSC1 en fMP4 ; **tvOS et AirPlay 2 : WebVTT seulement**, 5.2), fichiers texte avec `X-TIMESTAMP-MAP` (5.3), liste qui couvre toute la durée (5.5), `LANGUAGE` obligatoire (4.7), `CODECS` peut porter `wvtt` (5.10).

- **Un seul segment** : permis en VOD (« subtitles can be authored as a single segment for all cues across the entire asset duration », annexe ; 5.7). C'est le plus simple : un `.vtt` par piste, une liste d'un segment de la durée du film. La route actuelle du lecteur serveur produit déjà du WebVTT (avec `&sync=` pour §141) : à réutiliser. `X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000` si nos `tfdt` vidéo partent de 0 (90 kHz obligatoire, rfc8216bis §3.1.4) ; à aligner sur le décalage réel si le remuxeur décale la chronologie (B-frames, `strayUnits`).
- **Forcés** : `FORCED=YES` + `AUTOSELECT=YES` (5.11) ; `FORCED` n'existe que pour `TYPE=SUBTITLES`. Apple exige que la piste **complète** d'une langue contienne aussi les répliques forcées (5.8) — à vérifier ou à fusionner, sinon un spectateur qui choisit « Français » perd les inscriptions traduites. Apple affiche un forcé de lui-même quand la langue du son correspond (sans choix de l'utilisateur) : c'est la règle actuelle de Laterna, mais décidée par le système, plus par `chooseAudioTrack`.
- **Notre cas** : 4 140 pistes avec drapeau `forced`, 539 de plus forcées seulement par leur titre (« forcés ») : `FORCED=YES` doit suivre la même règle que `trackLabel`/le lecteur (drapeau **ou** titre), sinon elles s'affichent comme des complets.
- **ASS** (3 118 pistes, 942 fichiers) : converties en WebVTT, styles et positions perdus — comme dans le lecteur serveur aujourd'hui.
- **PGS / VobSub** : impossibles en HLS (ni WebVTT ni IMSC1 texte). Un spectateur qui en choisit un part au lecteur serveur (incrustation par Jellyfin). Selon l'échantillon, ~30 % des films et ~22 % des épisodes en portent, souvent à côté d'une piste texte ; **Jellyfin ne les liste pas** : la liste doit venir du fichier.
- Les sous-titres générés (§ « Generated subtitles ») et le sous-titrage du passage rejoué (§150) sont dessinés par la page, pas par AVPlayer ; sur Apple TV en AirPlay ils n'existeront que s'ils sont dans la liste HLS.

---

## 4.5 Risques et inconnues

1. **Atmos copié mal déclaré.** `dec3()` (`src/lib/webcodecs/mp4SampleEntries.ts`) écrit « aucun sous-flux dépendant » et aucune extension JOC. En MSE sur Safari ça joue (5.1, sans les objets). En HLS, `CHANNELS="16/JOC"` exige `complexity_index_type_a` dans le `dec3` : sans le lire dans le flux, 681 pistes Atmos E-AC-3 seront annoncées en 5.1. Les 25 pistes **E-AC-3 7.1** (sous-flux dépendant) risquent d'être décodées en 5.1 seulement, ou refusées si `CHANNELS="8"` contredit le `dec3`. À corriger avant la phase 1 pour ces pistes, ou les annoncer `"6"`.
2. **Pistes en doute non prouvées** : AC-3 à 32/44,1 kHz (42), AAC 7.1 à PCE (7), MP3 (11), HE-AAC à SBR implicite (la spec exige l'explicite en fMP4 ; Jellyfin dit « HE-AAC » sans dire lequel — 1 079 pistes concernées si implicite). Un banc par cas sur iPhone, Mac et Apple TV avant de les promettre.
3. **Opus** : non documenté par Apple, lu par AVPlayer « depuis iOS 17 » selon des forums, rien sur tvOS. Le traiter comme à convertir.
4. **Son qui commence tard** (§148) : la règle 2.15 l'interdit en rendu copié ; il faut du silence, donc une conversion, pour 63 pistes de 44 films.
5. **Jointures** : le résidu d'une grille + pré-roulement n'est pas mesuré ici ; décider la longueur du pré-roulement par un banc (concaténation décodée contre encodage continu).
6. **Mémoire et CPU partagés** : `cine-app` a 2 Go ; un ffmpeg par piste en conversion (≈ 30 Mo mesurés en `maxrss` côté démultiplexage) passe, plusieurs films à la fois aussi ; mais le serveur porte déjà Jellyfin et X-Ray (charge 6–8 sur 12 fils pendant la mesure). Priorité basse et une seule tâche par piste.
7. **Lecture disque** : convertir une piste lit **tout le fichier** (le son est entrelacé avec l'image) : un film 4K de 60 Go lu entier en 3 min, c'est ~330 Mo/s ; à brider, et à faire coexister avec la lecture de la même séance.
8. **AirPlay vers des téléviseurs tiers** : leurs décodeurs HLS ne sont pas documentés (E-AC-3 probable, AAC stéréo certain). La stéréo AAC « MUST » de la spec est le filet ; à ajouter si une TV refuse.
9. **Changement de piste** : en HLS, AVPlayer change de rendu lui-même (`audioTracks`), sans la reconstruction de `RemuxPlayback`. Une piste à convertir n'aura ses segments qu'après la tâche : le premier changement vers elle attend le premier segment (~0,2 s à 35×, plus la lecture disque).
10. **Sous-titres** : Jellyfin omet les PGS/VobSub et marque mal les externes — tout recensement ou menu côté serveur doit lire le fichier. La fusion forcés → complets (5.8) n'est pas faite aujourd'hui.
11. **Licence** : `libfdk_aac` est la meilleure AAC disponible mais non redistribuable ; l'image GHCR ne peut contenir que les encodeurs natifs de FFmpeg.
12. **Cache disque** : le seul volume est `data/` (174 Go libres sur la partition) ; sans plafond, la conversion à la demande peut le remplir. Plafond LRU et nettoyage par `ETag` obligatoires, et rien dans la sauvegarde quotidienne.
