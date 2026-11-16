# 5. Convertir le son au serveur — « Lumen serveur », phase 2

Conception et prototype mesuré, le 16/11/2026. Aucun fichier du dépôt modifié. Le prototype vit hors du dépôt,
dans le dossier de ce document :

| Chemin | Contenu |
|---|---|
| `image/Dockerfile` | le ffmpeg minimal, épinglé, compilé pour Alpine (image `laterna-son-proto:7.1.5`) |
| `bench/bench.mjs` | grille de trames, segments construits séparément, jointures, déterminisme, niveaux, sauts, chemin réel |
| `bench/speed2.mjs` | coût d'un segment quand le décodeur reçoit exactement « pré-roulement + segment » |
| `bench/preroll-decodeur.mjs` | le pré-roulement dont chaque décodeur a besoin |
| `bench/tones.mjs` | l'ordre des canaux par tonalités marquées |
| `bench/wasm-vs-natif.mjs` | le décodeur TrueHD WebAssembly du lecteur contre le ffmpeg natif |
| `out/*/resultats.json`, `out2/` | les résultats bruts |

Pistes mesurées (lecture seule sur `/mnt/media/video`), fenêtre de 75 s à partir de 600 s :
- *Braveheart*, VO TrueHD Atmos 7.1, 24 bits (`thd71`) ;
- *Armageddon*, VO DTS-HD MA 5.1, 24 bits (`dtsma51`) ;
- *Lost in Translation*, VF DTS 5.1 (`dts51`).

Machine : i7-8700 (6 cœurs, 12 fils), partagée. Pendant les mesures, une lecture Jellyfin 1080p transcodée,
la porte de tests de l'autre agent et, par moments, X-Ray : charge moyenne de 13 à 31. Conteneurs `--cpus 4 -m 3g`.
**Les coûts ci-dessous sont donc prudents** ; les vitesses refaites au calme relatif (X-Ray en pause, charge 14 à
17) sont signalées « au calme ».

---

## 5.0 En bref

1. **E-AC-3 se découpe sans jointure.** Avec au moins **une trame de pré-roulement**, un segment encodé seul est
   **identique à l'octet** au même passage d'un encodage continu : 1 877 trames sur 1 877, sur les trois pistes, en
   5.1 à 640 kb/s et en 2.0 à 256 kb/s. Sans pré-roulement, la première trame de chaque segment diffère (écart
   jusqu'à −7 dB : un clic). Conséquence : le contenu d'un segment est une fonction du fichier seul ; le cache, une
   conversion d'avance et une construction à froid après un saut donnent les mêmes octets.
2. **L'AAC ne se découpe jamais à l'identique** (1 à 2 % de trames identiques), à cause de l'état de son
   encodeur. Avec 4 trames de pré-roulement, l'écart aux jointures tombe à −43/−49 dB, sans clic mesurable. Il
   coûte en plus **5 à 7 fois le calcul de l'E-AC-3**, et l'encodeur AAC de FFmpeg obtient un rapport
   signal/bruit plus bas à 192 kb/s que l'E-AC-3 à 256 kb/s.
3. **Proposition : E-AC-3 partout.** 640 kb/s 5.1 pour toute source multicanal ; **2.0 à 256 kb/s pour la
   stéréo** (je conteste donc l'AAC-LC prévu pour la stéréo). L'AAC-LC 2.0 reste une option, à activer seulement si
   un téléviseur AirPlay tiers refuse l'E-AC-3. En option aussi, coupée par défaut : **FLAC sans perte** pour les
   sources sans perte, seule façon de garder un 7.1.
4. **Ne jamais placer les échantillons d'après les instants du conteneur.** Les blocs Matroska sont datés à la
   milliseconde. `ffmpeg -ss` sur le MKV atterrit à 16–48 échantillons de l'instant voulu en DTS. Une fois réaligné,
   le décodage est exact au bit. Les échantillons se placent donc par leur nombre, sur la trame fixe du codec, à
   partir du premier bloc de la piste.
5. **Le décodeur aussi a besoin d'un pré-roulement.** TrueHD est exact dès le premier échantillon (il se cale sur
   la synchronisation majeure suivante). DTS et DTS-HD MA sont faux pendant environ **4 096 échantillons**
   (85 ms ; jusqu'à −23 dB d'erreur au départ), puis exacts au bit. Je retiens 0,25 s.
6. **Le coût par séance, en continu**, en temps de calcul : TrueHD 7.1 → E-AC-3 ≈ 6 à 7 % d'un cœur, DTS-HD MA ≈ 3 %,
   DTS ≈ 1,5 %. Un segment de 6 s, du lancement de ffmpeg aux trames encodées, coûte au calme 220 ms (TrueHD),
   140 ms (DTS-HD MA) et 40 ms (DTS). Un processus ffmpeg occupe **5 à 13 Mo** de mémoire.
7. **L'outil** : un ffmpeg 7.1.5 lié statiquement, sans aucune bibliothèque externe sauf zlib, LGPL. Il pèse
   **4,1 Mo** et se compile en **112 s** sur 4 fils. FFmpeg 7.1.5 est la version déjà épinglée pour TrueHD et AAC en
   WebAssembly.
8. **L'Atmos d'une piste TrueHD est perdu** quelle que soit la cible : FFmpeg ne décode que le socle 7.1 et aucun
   encodeur libre n'écrit d'objets. Ce n'est pas une régression : le lecteur actuel le perd déjà.

---

## 5.1 Ce qu'il faut convertir

Rappel de `4-son-compat.md` §4.2. Il y a **655 fichiers** (6,2 %) avec au moins une piste non copiable :
- DTS : 302 fichiers, 363 pistes ;
- DTS-HD MA : 149 fichiers, 172 pistes ;
- Opus : 191 fichiers, 343 pistes ;
- TrueHD : 33 fichiers, 37 pistes ;
- MP2 : 6 ; PCM : 1.

Le recensement de §157 donne les refus restants **sous `cra`** : `son-codec` 3,6 %, `son-plus-court` 1,4 %,
`son-en-retard` 0,1 %. La conversion traite aussi ces deux derniers. La piste est convertie avec du silence devant
ou derrière, si bien qu'un rendu couvre toute la durée (règle 2.15).

**Hors conversion, à traiter à part** : `son-aac-sbr-implicite` (6,3 % sous `cra`, la première raison de refus).
Un HE-AAC à SBR implicite ne demande probablement pas de réencodage. Il suffit sans doute de réécrire
l'AudioSpecificConfig de l'init en signalisation explicite (règle 2.24), comme `aacPlan` réécrit déjà un PCE
(§62), après avoir vérifié la présence du SBR dans la première trame. C'est moins cher, et sans seconde génération.
À essayer avant de convertir ces pistes ; la conversion reste leur repli.

---

## 5.2 Les cibles

### Multicanal → E-AC-3 640 kb/s 5.1 : confirmé

| Mesure (fenêtre de 73 s) | TrueHD 7.1 | DTS-HD MA 5.1 | DTS 5.1 |
|---|---:|---:|---:|
| Rapport signal/bruit contre la source repliée | 42,0 dB | 32,1 dB | 38,6 dB |
| Niveau RMS par canal, source − sortie (L R C Ls Rs) | ±0,00 dB | ±0,01 dB | ±0,00 dB |
| LFE | −2,3 dB¹ | 0,00 dB | +0,1 dB |
| Encodage seul, temps de calcul | 0,67 s (110×) | 0,78 s (94×) | 0,77 s (95×) |
| Trames identiques segmenté / continu (P ≥ 1) | 1 877 / 1 877 | 1 877 / 1 877 | 1 877 / 1 877 |

¹ LFE quasi muet sur ce passage (−89 dBFS). L'encodeur coupe le LFE au-dessus de 120 Hz : c'est le filtre du codec.

Pourquoi cette cible :
- **c'est la seule qui se découpe sans jointure** (§5.4) ;
- elle coûte 1 % d'un cœur ;
- elle appartient à la même famille que 79 % des pistes de la bibliothèque, donc **un seul groupe `ec-3`** quand
  une VF copiée et une VO convertie se côtoient ;
- tous les appareils Apple la décodent, et la phase 1 la suppose déjà.

Une réserve de qualité : l'encodeur E-AC-3 de FFmpeg n'a pas les outils propres à l'E-AC-3 (SPX, AHT) ; c'est de
l'AC-3 dans la syntaxe E-AC-3. À 640 kb/s en 5.1, c'est la qualité d'un AC-3 de Blu-ray.

### Stéréo et mono → E-AC-3 256 kb/s 2.0 (contre l'AAC-LC prévu)

| Cible stéréo | Encodage seul, calcul (73 s) | Signal/bruit (thd / dtsma / dts) | Segments identiques au continu | Pire écart aux jointures (P = 4) |
|---|---:|---|---|---|
| **E-AC-3 256 kb/s** | 0,43–0,48 s (≈ 160×) | 40,3 / 29,2 / 37,2 dB | **oui** (P ≥ 1) | aucun (octets identiques) |
| AAC-LC 192 kb/s (FFmpeg) | 2,6–3,9 s (19–28×) | 31,5 / 22,3 / 34,7 dB | non (1–2 %) | −43 à −49 dB, rapport de clic ≤ 1,16 |

Le signal/bruit n'est pas une mesure perceptive, mais l'écart est constant et dans le même sens. L'AAC-LC exigé
par la spécification d'Apple (2.3, MUST) est une règle d'éditeur pour l'App Store, et AVPlayer lit sans lui
(4-son-compat.md). Je propose `LUMEN_AUDIO_STEREO=eac3` par défaut, et `aac` seulement si un récepteur réel le
demande.

Les sources mono partent en E-AC-3 1.0. La bibliothèque compte déjà 15 E-AC-3 mono copiés.

**Piège mesuré : l'AAC 5.1 de FFmpeg et la disposition `5.1(side)`.** Déclarée `5.1(side)`, l'entrée fait écrire
à l'encodeur AAC un **PCE** (`channel_config` 0) que ffmpeg lui-même relit comme « disposition inconnue ». C'est
exactement la famille de pistes que CoreAudio refuse (§62). Déclarée `5.1`, la même entrée donne `channel_config`
6, et l'ordre est juste (tonalités, §5.2.4). Si l'AAC multicanal sert un jour, l'entrée doit être étiquetée `5.1`.

### Le 7.1

L'encodeur E-AC-3 de FFmpeg n'écrit pas de sous-flux dépendant : un « 7.1 » demandé est replié en 5.1. Les choix :

| Choix | Pour | Contre |
|---|---|---|
| **Repli 5.1 en E-AC-3 (défaut)** | La règle de `fold` du navigateur : Ls+Lrs et Rs+Rrs à −3 dB chacun, le reste tel quel ; aucune jointure ; 640 kb/s | Les arrières ne sont plus discrets sur une installation 7.1 |
| **FLAC 7.1 sans perte (option, coupée)** | Exact au bit (vérifié : décodé = source, 24 bits) ; déterministe ; trames indépendantes, donc **aucune jointure par construction** ; 7.1 conservé ; FLAC multicanal cité par Apple (2.2, 2.5, 2.25), et la phase 1 copie déjà le FLAC | **3,0 Mb/s** (*Braveheart* 7.1) et **3,9 Mb/s** (*Armageddon* 5.1, 24 bits) au lieu de 0,64 ; 7.1 FLAC en HLS non prouvé sur iPhone et Apple TV |
| AAC 7.1 | — | `channel_config` 7 ambigu (avant large ou arrière), ou PCE : le cas de §62. Écarté |
| E-AC-3 7.1 | — | Aucun encodeur libre |
| LPCM | — | Absent du HLS d'Apple |

Le FLAC n'a de sens que pour une source sans perte : TrueHD, DTS-HD MA et PCM, soit environ 210 pistes. Il ajoute
2,4 à 3,3 Mb/s, ce qui pèse peu sur un 4K (40–60 Mb/s) mais beaucoup sur un 1080p en itinérance. D'où une option
d'instance, et non un défaut.

### L'Atmos

**L'Atmos d'une piste TrueHD est perdu.** Le décodeur TrueHD de FFmpeg rend le socle 7.1, sous-flux 2 au plus, et
ignore les objets du sous-flux 3. Aucun encodeur libre n'écrit d'E-AC-3 JOC. Un *Braveheart* converti sort donc
en 5.1 E-AC-3, ou en 7.1 FLAC, **sans hauteur**.

Ce n'est pas une fonction perdue : le lecteur actuel décode le même socle en WebAssembly et le réencode en AAC ou
en Opus 5.1. Les 681 pistes E-AC-3 Atmos, elles, sont **copiées** en phase 1 et gardent leurs objets
(`CHANNELS="16/JOC"`, §154). Dans un film qui a une VF E-AC-3 Atmos copiée et une VO TrueHD Atmos convertie,
seule la VF reste Atmos. L'étiquette de la piste convertie doit le dire : pas de « Atmos » dans `NAME`, puisque
`trackLabel` lit le codec servi.

### L'ordre des canaux

FFmpeg porte la disposition de bout en bout par **canaux nommés** (masques) : le décodeur nomme ses sorties,
`pan` les adresse par nom, et l'encodeur range son propre train binaire. Aucune permutation n'est écrite à la
main. `APPLE_AAC_ORDER` ne s'applique pas, car AudioToolbox n'encode rien au serveur.

Mesure par tonalités marquées, la méthode de DOC-TECH « Channel order » (`bench/tones.mjs`) : une sinusoïde par
canal source (FL 300, FR 400, FC 500, LFE 60, BL 700, BR 800, SL 900, SR 1000 Hz), la chaîne, puis le décodage par
ffmpeg et la fréquence dominante de chaque canal de sortie.

| Chaîne | Sortie décodée |
|---|---|
| 7.1 → `pan` (règle de `fold`) → E-AC-3 5.1 | FL 300, FR 400, FC 500, LFE 60, SL 700+900, SR 800+1000 ✔ |
| 5.1(side) → E-AC-3 5.1 | FL 300, FR 400, FC 500, LFE 60, SL 900, SR 1000 ✔ |
| 7.1 → FLAC 7.1 | les huit à leur place ✔ |
| 5.1 → AAC 5.1 (étiquette `5.1`) | ordre juste, `channel_config` 6 ✔ |
| 5.1(side) → AAC 5.1 | ordre juste, mais **PCE** (`channel_config` 0) ✘ |
| 5.1 → repli stéréo → AAC 2.0 | FL 300+500+900, FR 400+500+1000 ✔ |

Le repli 7.1 → 5.1 s'écrit avec les coefficients exacts de `fold` (`Math.SQRT1_2`) :
`pan=5.1(side)|FL=FL|FR=FR|FC=FC|LFE=LFE|SL=0.7071067811865476*SL+0.7071067811865476*BL|SR=…*SR+…*BR`.
Le passage serveur → page (repli, §5.7) ne change donc pas le mélange.

Reste à refaire **à l'oreille sur un appareil Apple**, comme pour chaque ordre de canaux ici : le décodeur E-AC-3
d'Apple sur ces trames. Le dépôt dit pourquoi : deux fois, raisonner sur l'ordre d'un autre a échoué.

### Sonie et saturation

L'encodeur écrit `dialnorm` −31 par défaut, ce qui n'atténue rien. Une piste AC-3 copiée garde le sien (par
exemple −27, que le décodeur applique). Passer d'une VF copiée à une VO convertie peut donc changer le niveau de
quelques dB. C'est ce que fait déjà le lecteur actuel (l'AAC n'a pas de dialnorm), et je propose de ne rien
prétendre (−31).

Le repli stéréo de `fold` dépasse 0 dBFS sur un mix fort : +2,2 dB de crête sur *Armageddon*, écrêté à
l'encodage. L'E-AC-3 5.1 n'est jamais replié au serveur (l'appareil s'en charge), donc la question ne se pose que
pour l'option AAC stéréo d'une source multicanal.

---

## 5.3 L'outil

### Le ffmpeg minimal (prototype : `image/Dockerfile`)

- **FFmpeg 7.1.5**, l'archive vérifiée par SHA-256 (`de668509…d558f`) : exactement la version et l'empreinte de
  `tools/truehd-wasm` et `tools/aac-wasm`. Trois raisons :
  - une seule version de FFmpeg dans le dépôt ;
  - le décodeur TrueHD du serveur est alors le même code que celui du navigateur, ce qui compte pour le repli
    (§5.7) ;
  - le correctif des masques de `mlpdec` (7.1.3) est inclus.

  Les branches 8 et 9 n'apportent rien à ces encodeurs qui nous serve. Une montée de version passera par le banc
  de §5.8, comme `ffmpeg-wasm-regress-bench`.
- **Alpine 3.24** (celle de `node:26-alpine`), gcc 15.2, `-O2`, assembleur x86 (nasm) activé, **lié
  statiquement** : aucune bibliothèque partagée, il se copie seul dans l'image.
- **Contenu** (`--disable-everything --disable-autodetect`, puis la liste) :
  - démultiplexeurs : matroska, mov, truehd, mlp, dts, dtshd, ac3, eac3, aac, mp3, ogg, flac, wav, pcm ;
  - décodeurs : truehd, mlp, dca, opus, mp2, mp3, flac, aac, ac3, eac3, pcm (s16/s24/s32/f32, bluray, dvd) ;
  - encodeurs : eac3, ac3, aac, flac, pcm ;
  - découpeurs : mlp, dca, ac3, aac, opus, flac, mpegaudio ;
  - filtres : aresample, aformat, pan, atrim, asetpts, apad, astats, channelmap ;
  - muxeurs : eac3, ac3, adts, flac, mp4, pcm, null, framemd5 ;
  - protocoles : file, pipe ;
  - **zlib** (statique) : des MKV compressent des pistes par zlib. Sans lui, ffmpeg dit « Unsupported encoding
    type » (vu sur *Braveheart* et *Armageddon*, sur des pistes de sous-titres).
- **Taille** : `ffmpeg` **4,08 Mo**. `ffprobe` (3,9 Mo) n'est pas nécessaire en production. Image de banc :
  +12 Mo sur `node:26-alpine`, ffprobe et GNU time compris.
- **Construction** : 112 s à `make -j4`, 123 s au total, en étage à part, gardé en cache tant que l'épinglage ne
  bouge pas. Sans cache (CI), ces deux minutes s'ajoutent à la publication.
- **Licence** : ni `--enable-gpl`, ni `--enable-nonfree`, ni libfdk, donc **LGPL 2.1 ou plus**. ffmpeg est un
  programme lancé à part, et le code de Laterna n'en dérive pas. Publier l'image oblige à offrir la source : le
  script de construction (URL, empreinte, options) plus une mention dans le README ou les licences tiennent lieu
  d'offre ; ou bien publier l'archive à côté.
- **Écarté** : `apk add ffmpeg`. Il tire une centaine de Mo de bibliothèques (x264, x265…), il est GPL, et sa
  version n'est pas épinglée.
- **Absent ou coupé** : l'image le porte toujours (4 Mo), mais rien ne l'appelle tant que l'option est coupée. Au
  démarrage, la capacité est détectée par trois choses :
  - `ffmpeg -version`, comparé à la version attendue ;
  - la présence des encodeurs ;
  - un encodage de 0,1 s de silence.

  Une instance qui retire le binaire, ou le monte autrement (`LUMEN_FFMPEG_PATH`), est vue comme sans conversion :
  le lecteur actuel convertit dans la page.

### L'alternative : FFmpeg en WebAssembly dans Node

| | ffmpeg natif (proposé) | WebAssembly dans `worker_threads` |
|---|---|---|
| Décodeurs | tous | TrueHD et AAC déjà construits et prouvés ; DTS et AC-3 par `@mediabunny/*` ; Opus et MP2 à ajouter |
| Encodeurs | E-AC-3, AAC, FLAC | **aucun aujourd'hui** : un module de plus, construit par emscripten (3 Go, 90 s), à prouver |
| Vitesse, TrueHD décodé seul (73 s, au calme) | 65× en temps réel, mais **3,2 s de calcul** (le programme ffmpeg tient plusieurs fils et convertit en s16 pour la sortie nulle) | 54× en temps réel, **1,6 s de calcul** |
| Encodeur E-AC-3 | SIMD (MDCT, `ac3dsp`) | sans SIMD, plus lent (non mesuré) |
| Déterminisme | par processeur : la détection du jeu d'instructions au lancement peut changer le chemin flottant, sans effet sur un cache local | identique sur toute machine (IEEE, pas de SIMD) |
| Exploitation | un processus par tâche (≈ 10 ms de lancement), 5–13 Mo, tué proprement ; binaire propre à l'architecture | dans le processus ; fils de calcul déjà empaquetés à part (`tools/lumen-worker`) ; mémoire comptée dans Node (2–3 Gio pour toute l'appli) ; multi-architecture gratuite |
| Coût de mise en place | un étage Dockerfile, quelques lignes de lancement | un module à écrire, construire, prouver et maintenir |

**Recommandation : le natif.** Les encodeurs existent, et c'est là que le natif gagne (SIMD). Le processus séparé
isole une panne ou une fuite. La mesure montre qu'un décodeur WebAssembly n'est pas plus lent par octet décodé, si
bien que la voie WebAssembly reste un **plan B** crédible, pour une image multi-architecture ou si lancer des
processus devient un problème. Elle ne vaut pas, aujourd'hui, la construction d'un encodeur.

---

## 5.4 Le modèle d'exécution

### Un segment est une fonction du fichier

Comme un segment vidéo (§155), un segment son converti se reconstruit depuis le fichier seul, avec les mêmes
octets à chaque fois. Rien ne vit entre deux requêtes ; une conversion d'avance n'est qu'une optimisation. Le
serveur reste sans état : pas de processus de séance à garder vivant, un redéploiement en pleine lecture ne casse
rien.

### Le signal

Pour une piste et une cible, on définit le signal **x** sur toute la durée de l'image :
- **les échantillons décodés, placés par leur nombre** sur la trame fixe du codec source, ancrée au premier bloc de
  la piste (TrueHD 40 par unité d'accès à 48 kHz, DTS 512, E-AC-3 1 536, MP2 1 152, Opus d'après le TOC de chaque
  paquet). Le serveur les situe par le calcul, jamais par l'instant du bloc : la position d'un bloc = premier
  instant + arrondi((t − t₀) · fréquence / F) · F ;
- **des zéros partout ailleurs** : avant le premier son (§148 réglé par construction, silence exact à l'échantillon)
  et après la fin d'une piste plus courte que le film ;
- **replié** vers la disposition cible par `pan` (§5.2.4).

Ce que la mesure a montré :
- `ffmpeg -ss` sur le MKV place le DTS à **16–48 échantillons** près (DTS-HD MA de −32 à +16) : instants des blocs
  à la milliseconde ;
- la même chose depuis une copie MP4 ne fait pas mieux (−8 à +72), car la copie a gardé les durées arrondies ;
- TrueHD tombe juste ;
- une fois réalignés, tous les échantillons sont **identiques au bit** au décodage continu.

Le décodage est donc exact, et seul le placement doit venir de nous.

### La grille et les frontières

- Trame cible **N** = 1 536 échantillons (E-AC-3, 32 ms à 48 kHz). La trame *k* porte l'instant *k·N*, sur une
  grille ancrée à 0.
- Le segment son *n* contient **les trames dont l'instant tombe dans [Sₙ, Sₙ₊₁)**, où Sₙ sont les frontières des
  segments vidéo. C'est la règle de §155 pour l'audio copié.
- Les EXTINF restent ceux de la vidéo, les mêmes pour toutes les listes. La durée réelle d'un segment son s'en
  écarte de moins d'une trame (c'est déjà le cas en copie : −27 à +28 ms, banc §155).

### Les jointures : le pré-roulement

Pour construire le segment *n* dont les trames vont de *aₙ* à *aₙ₊₁*, ffmpeg reçoit x sur [(aₙ − P)·N + d,
aₙ₊₁·N + d + 3N). Ici d est le délai de l'encodeur (256 en E-AC-3, 1 024 en AAC) et P le nombre de trames de
pré-roulement. Il encode ; on garde les trames P … P + (aₙ₊₁ − aₙ) − 1 et on jette le reste.

Mesuré sur 10 segments consécutifs construits chacun par son propre processus. Les frontières vidéo sont prises
toutes les 6,006 s (144 images à 23,976), décalées de la grille :

| Cible | P = 0 | P = 1 | P = 2, 3, 6 |
|---|---|---|---|
| E-AC-3 640 5.1 | la 1ʳᵉ trame de chaque segment diffère ; écart près de la jointure −7 (dtsma) à −21 dB | **1 877/1 877 trames identiques**, décodé identique, aucun clic | identiques |
| E-AC-3 256 2.0 | idem, −4,9 à −22 dB | **identiques** | identiques |
| AAC 192 2.0 | −3 à −20 dB aux jointures | −27 à −29 dB | P = 4 : −43 à −49 dB, rapport de clic (énergie de la dérivée seconde sur ±2 ms, segmenté/continu) ≤ 1,16 |
| AAC 384 5.1 | −4 à −17 dB | — | P = 8 : −30 à −49 dB |

Pourquoi l'E-AC-3 tombe juste : l'encodeur AC-3 de FFmpeg n'a pas de commutation de blocs ni de réservoir de bits.
Il décide chaque trame seule, et son seul état est le recouvrement de la MDCT (256 échantillons). Une trame de
pré-roulement le remplit à l'identique.

L'AAC porte un modèle psychoacoustique et un réservoir de bits : ses trames dépendent de tout ce qui précède, pas
seulement du pré-roulement.

**Retenu : P = 2 pour l'E-AC-3** (64 ms, marge d'une trame). Pour l'AAC (option), P = 4, et **chaque segment encodé
par son propre encodeur**. Sinon ses octets dépendraient de l'endroit où la tâche a commencé, et le cache servirait
deux versions d'un même segment.

### Le pré-roulement du décodeur

Mesuré en repartant pile au bloc (copie MP4 de la fenêtre, `bench/preroll-decodeur.mjs`, 5 départs par piste) :
- **TrueHD** : exact dès le premier échantillon rendu. Le décodeur ignore tout jusqu'à la synchronisation majeure
  suivante (88 ms au pire dans la bibliothèque, d'après `truehd.c`) ; il faut seulement lui fournir des blocs
  depuis avant elle ;
- **DTS et DTS-HD MA** : erreur jusqu'à −23 dB dans les 256 premiers échantillons, encore −45 à −65 dB jusqu'à
  1 024, −65 à −99 dB jusqu'à 4 096, **exact au bit au-delà**. C'est l'historique du banc de filtres et de la
  prédiction ADPCM du cœur DTS, dont l'extension sans perte dépend.

**Retenu : 0,25 s de pré-roulement du décodeur**, plus les 2 trames de l'encodeur.

### Le délai de l'encodeur, `tfdt` et liste d'édition

L'entrée commence à un instant T ≡ d (mod N). La trame *j* sortie de l'encodeur porte alors l'instant T − d + j·N,
pile sur la grille, et **décodée, elle rend x à cet instant**. Le banc le vérifie : décalage de 0 échantillon entre
le décodage placé à ses instants et la source, pour l'E-AC-3 comme pour l'AAC.

Donc :
- **`tfdt` = k·N** (plus le délai de présentation D, commun à toutes les pistes, §155) ;
- **aucune liste d'édition** et aucun `iTunSMPB` : l'amorce AAC de 1 024 échantillons et le recouvrement E-AC-3 de
  256 ne tombent que sur des trames de pré-roulement jetées ;
- le premier segment ne contient que des trames d'instant ≥ 0, le pré-roulement d'avant 0 étant des zéros. C'est
  conforme à « les trames d'avant l'origine ne sont pas écrites » (§155).

À vérifier sur l'appareil (§5.8) : qu'aucun décodeur d'Apple ne retranche de lui-même un délai qu'aucune liste
d'édition n'annonce. Un écart constant d'une trame (21 à 32 ms) resterait dans la tolérance de synchronisation,
mais il doit être mesuré, pas supposé.

### Ce que fait le serveur pour un segment

1. **Node lit les blocs son** par l'index (`mkvBlocks.ts`, comme pour l'audio copié). Il les écrit en flux
   élémentaire sur l'entrée de ffmpeg (`-f truehd`, `-f dts`, `-f mp2`, PCM brut), en commençant 0,25 s + 2 trames
   avant le segment.
   - L'Opus n'a pas de flux élémentaire autodélimité : il faut l'envelopper (un petit écrivain Ogg, ~60 lignes),
     ou laisser ffmpeg lire le MKV par `-ss`. Pour l'Opus, les instants à la milliseconde sont exacts (trames de
     20 ms).
2. ffmpeg décode. `atrim=start_sample=…` est calculé par Node depuis la position du premier bloc sur la grille, pas
   depuis un instant du conteneur. Puis `pan`, puis l'encodeur, et il écrit le **flux brut** E-AC-3 sur sa sortie.
3. Node découpe les trames (en-tête `0x0B77`, `frmsiz`), garde les siennes et les mélange par `mediaSegment` avec
   `tfdt` = k·N + D. L'init porte un `dec3` décrit depuis les trames produites (`describeEac3`, `signalling:
   "hls"`, §154).

Le chemin réel avec `ffmpeg -ss` directement sur le MKV a aussi été mesuré (§5.6). ffmpeg y repart du point d'index
**vidéo** précédent : il relit 15 à 28 Mo pour 6 s de son, et place mal les échantillons. Ce chemin est donc
écarté.

### Une tâche d'avance et un segment à froid donnent les mêmes octets

Grâce à l'identité mesurée, **une tâche longue** (un processus qui convertit 60 s d'affilée pour l'avance) produit
exactement les octets de **10 segments construits chacun à froid** après un saut. On peut donc :
- **convertir d'avance par tâches de 60 s** : un lancement de processus pour 10 segments ;
- **construire un segment seul** quand Safari demande un segment pas encore fait (un saut) ;

et le cache reste cohérent, quel que soit le chemin qui a écrit un segment. Il n'y a de jointure nulle part, pas
même au point où une tâche commence.

### Après un saut

AVPlayer repart d'un décodeur vide sur la première trame du segment demandé. Les 256 premiers échantillons
(5,3 ms) n'ont pas leur recouvrement : c'est le cas de tout HLS E-AC-3, et des pistes E-AC-3 copiées de la phase 1.
Côté serveur, un segment demandé hors ordre (k, puis k − 5, puis k + 20) donne les mêmes octets que dans l'ordre :
c'est le déterminisme.

### Déterminisme

- Même segment construit deux fois, deux processus : **identique** pour toutes les cibles (E-AC-3, AAC, FLAC).
- Encodage continu refait : identique.
- FLAC : décodé = source au bit (24 bits, 7.1 et 5.1), deux encodages identiques.

Limite : sur un autre processeur, ffmpeg peut prendre un autre chemin SIMD et changer des bits. C'est sans effet,
puisque le cache est local, mais la clé du cache porte l'identité du binaire.

---

## 5.5 Le cache

- **Où** : `DATA_DIR/lumen-audio/` par défaut, sur le NVMe de `data/`. Réglable par `LUMEN_AUDIO_CACHE_DIR`, pour
  un disque de données, le même que celui envisagé pour l'index ; le compose doit alors le monter. Hors de la
  sauvegarde quotidienne, comme les caches régénérables.
- **Volume** : 640 kb/s font 288 Mo par heure, soit 576 Mo pour un film de 2 h. Le 256 kb/s stéréo d'un épisode de
  45 min fait 86 Mo. Le FLAC fait 1,35 à 1,75 Go par heure.
- **Plafond LRU** : `LUMEN_AUDIO_CACHE_GB` = 10 par défaut (≈ 35 h de films en 5.1). On évince le moins récemment
  lu ; la date de lecture est tenue en mémoire sur `globalThis` et relue au démarrage d'après les `mtime` (touchés
  à la lecture au plus une fois par heure). Balayage toutes les 10 min, et suppressions par lots sous un budget de
  temps : la règle de `db.ts` pour la boucle d'événements vaut ici aussi.
- **Clé** :
  ```
  <lumenVersionOf(fichier)>/<piste>/<cible>-<version de conversion>/<n>.ec3
  ```
  - `lumenVersionOf` : chemin, taille, mtime, inode (§156) ;
  - `<piste>` : le `TrackNumber` Matroska ;
  - `<cible>` : codec, débit, disposition, repli, P et pré-roulement du décodeur, en clair (`eac3-640-51-p2`) ;
  - `<version de conversion>` : `LUMEN_AUDIO_VERSION` (règles de grille et de placement) + version de ffmpeg + 8
    chiffres du SHA-256 du binaire.

  Changer l'un d'eux change l'adresse : jamais d'octets d'une autre version.
- **Granularité** : un fichier par segment (~0,5 Mo), écrit de façon atomique (temporaire puis renommage), servi
  avec sa longueur (`lengthHeader`, §131). Toute erreur de lecture vaut une absence, et le segment se reconstruit.
- **Requêtes en vol partagées** : une même clé, une seule tâche. C'est la règle des segments de §156.
- **Avance** : à l'appui sur Lire (`prepare`), le segment de reprise passe d'abord, en priorité haute. Ensuite, une
  tâche de 60 s à la fois, en priorité basse (`nice 15`), garde **120 s d'avance** sur le dernier segment demandé
  (`LUMEN_AUDIO_LEAD_S`), jamais plus de 5 min.
  - Rien derrière la tête de lecture.
  - Arrêt 2 min après la dernière requête de la séance.
  - Une tâche d'avance cède sa place (tuée, reprise plus tard) à une demande sous la tête.
  - Jamais lancée par `CINE_BACKGROUND_JOBS=off` (banc) en dehors d'une requête réelle.
- **Pas de conversion de toute la bibliothèque** : 206 Go pour 6 % des fichiers (4-son-compat.md).

---

## 5.6 La charge

### Mesures

Vitesse en temps réel ; le calcul est en temps processeur. Charge 13–31, et 14–17 « au calme ».

| | TrueHD 7.1 | DTS-HD MA 5.1 | DTS 5.1 |
|---|---:|---:|---:|
| Décodage seul + repli, temps de calcul | 17–17,5× (5,7 % d'un cœur) | 40–46× (2,4 %) | 120–153× (0,7 %) |
| Encodage E-AC-3 640 5.1, calcul | 110–123× (0,9 %) | 94–142× | 95–150× |
| Encodage E-AC-3 256 2.0, calcul | ≈ 160× (0,6 %) | ≈ 150× | ≈ 170× |
| Encodage AAC 192 2.0, calcul | 26–29× (3,6 %) | 19–26× | 20–41× |
| Encodage AAC 384 5.1, calcul | 12× (8 %) | 10× | 11× |
| FLAC sans perte (décodage + encodage) | 28× | 35× | — |
| **Segment 6 s → E-AC-3, blocs exacts, au calme** | **220 ms** (27×) | **140 ms** (43×) | **40 ms** (150×) |
| Segment 4 s / 10 s, au calme | 250 / 310 ms | 120 / 250 ms | 30 / 60 ms |
| Segment 6 s, sous charge 23–31 | 420 ms | 290 ms | 110 ms |
| Segment 6 s par `ffmpeg -ss` sur le MKV (écarté) | 430–580 ms, 17 Mo lus | 420–440 ms, 27 Mo lus | 70–90 ms, 6 Mo lus |
| Pic mémoire d'un processus ffmpeg | 11 Mo | 7,6 Mo | 5,5 Mo |
| Lancement d'un processus ffmpeg | ≈ 10 ms | | |

Ce qu'en dit la comparaison avec 4-son-compat.md (« 38× », « 35× ») : ces chiffres étaient des temps réels avec
plusieurs fils. En **temps de calcul**, le TrueHD coûte **≈ 6,5 % d'un cœur par séance** en continu (décodage
5,7 %, encodage 0,9 %), le DTS-HD MA ≈ 3 %, le DTS ≈ 1,5 %. **Le décodage TrueHD pèse six fois l'encodage.**

### Combien de séances

- **Régime établi** : une séance TrueHD demande 0,065 cœur. Avec un plafond de 2 processus ffmpeg simultanés
  (`LUMEN_AUDIO_MAX_JOBS`), le débit est d'environ 2 × 27 = 54 s de son par seconde au calme, et la moitié sous
  forte charge. Cela suffit pour **15 à 25 séances TrueHD simultanées** avant que l'avance ne fonde. Le foyer en a
  rarement plus de cinq. Le DTS coûte quatre à quinze fois moins.
- **Le vrai coût est la rafale** :
  - un démarrage ou un saut demande un segment en 0,04 à 0,6 s, plus l'attente dans la file ;
  - plusieurs sauts en rafale (une Apple TV qui remplit son tampon) font une file. La priorité « sous la tête »
    passe devant l'avance.
- **Le disque** :
  - lire les blocs son d'un segment revient à lire les amas Matroska où ils sont entrelacés avec l'image ;
  - quand le segment vidéo du même instant vient d'être construit, ces octets sont dans le cache de pages ;
  - l'avance de 120 s lit 120 s du film à l'avance (300 Mo à 1 Go en 4K), ce qui chauffe aussi le cache pour les
    segments vidéo à venir.

  Les pages lues comptent dans la mémoire du conteneur, mais se récupèrent sans tuer personne.
- **La concurrence** :
  - Jellyfin (transcodages) et la lecture passent devant : `nice 10` pour la demande sous la tête, `nice 15` pour
    l'avance ;
  - X-Ray cède déjà sa place à la lecture (`scanWaitsForPlayback`), et la conversion d'une séance en est une ;
  - les fils de remux vidéo (`pool.ts`, 3 constructions) et ffmpeg ne partagent pas de file. Ce qui les borne
    ensemble est le nombre de séances admises (§5.7).

---

## 5.7 Le repli vers le client

Le lecteur actuel (Lumen dans la page) sait déjà tout convertir dans la page : TrueHD et AAC en WebAssembly, DTS
par mediabunny, réencodage AAC ou Opus. Le repli ne perd donc aucune fonction. Il coûte à l'appareil ce que la
phase 2 voulait lui épargner, et rouvre les défauts de MediaSource.

### 1. Au départ : choisir le serveur ou la page

`prepare` / `eligibility` rendent pour le son `copie`, `conversion` ou un refus stable. Les deux nouvelles raisons
de refus mènent au lecteur actuel, comme `son-codec` aujourd'hui :
- **`son-conversion-coupee`** : option coupée pour ce compte, ou ffmpeg absent ou non conforme ;
- **`son-serveur-occupe`** : l'admission refuse.

L'admission dit oui seulement si :
- le nombre de séances qui convertissent reste sous `LUMEN_AUDIO_MAX_SESSIONS` (4 par défaut) ;
- l'attente dans la file de conversion, au 90ᵉ centile sur 60 s, reste sous 1 s ;
- la charge de la machine (charge moyenne sur nombre de fils) reste sous un seuil.

Le titre compte aussi. Une piste TrueHD sur un iPhone, c'est le cas où le serveur rend le plus de service (décodage
WebAssembly et réencodage sur le téléphone, tampon de 105 Mo) : à charge égale, ce sont ces séances-là qu'on admet.
Une admission refusée n'abîme aucune séance en cours : **on refuse les nouvelles avant de dégrader les
anciennes.**

### 2. En cours de lecture, avant que la saturation ne se voie

Le serveur connaît l'avance de chaque séance : les secondes converties au-delà du dernier segment demandé. Une
séance dont l'avance tombe sous 30 s alors que la file s'allonge passe à l'état « tension ».

La page ne voit pas les requêtes HLS de Safari. Elle l'apprend par la **réponse du battement de progression**, qui
part toutes les 30 s pendant la lecture et porte déjà l'état de maintenance (`noteMaintenanceState`) : le champ
`lumen.son` vaut `ok`, `tension` ou `client`. Aucun aller-retour de plus pour la radio. Un `waiting` de plus de
3 s pendant la lecture déclenche aussi une lecture immédiate de cet état (`GET …/eligibility`, qui ne répond
jamais 404).

### 3. La bascule HLS → MediaSource, préparée

WebKit refuse un HLS natif après une MediaSource dans la même page, mais accepte l'inverse : la bascule se fait
donc dans ce sens, et sans retour.

1. À l'état `tension`, la page construit le lecteur actuel (`RemuxPlayback`) sur un **second `<video>` caché et
   muet**, à t₀ = position + 8 s. Le tampon HLS de Safari tient déjà ce passage.
2. Quand ce `<video>` a `readyState ≥ 3` à t₀ et que la lecture HLS atteint t₀, la page montre le nouveau, le met
   en lecture, met l'ancien en pause et le libère (`removeAttribute("src")`, `load()`).
3. La coupure attendue est de quelques images et d'un redémarrage du son, de l'ordre de 50 à 200 ms : **à mesurer**.

Si le second lecteur n'est pas prêt en 20 s, ou si le tampon HLS s'épuise avant, la page bascule sans préparation à
la position courante, comme une reconstruction (1 à 2 s). La séance reste ensuite en MediaSource jusqu'à sa fin.
Ligne `fallback` avec `why: "son-serveur-occupe"`, `handover: "préparé" | "brut"` et `gapMs`.

Risques à éprouver : deux `<video>` sur un iPhone pendant une seconde, dont l'un en 4K, et la session audio de
WebKit.

### 4. Le serveur ne répond « occupé » à un segment qu'en dernier recours

Un segment demandé sous la tête attend sa construction, prioritaire et devant toute avance. Si un budget dur est
dépassé (8 s), la route répond 503 `Retry-After: 1`, la convention de §156. Ce que Safari fait d'un 503 en pleine
lecture n'est pas connu (README, « Reste incertain »). La page voit le `waiting` et suit le point 3. Le but est que
ce cas n'arrive pas, parce que les points 1 et 2 l'ont devancé.

---

## 5.8 Les preuves à exiger avant le déploiement

**Un banc `lumen-audio-bench.spec.ts`** (sauté sans `LUMEN_AUDIO_FILES`), sur le modèle de ce prototype, par piste
et par cible, sur au moins un TrueHD 7.1, un DTS-HD MA, un DTS, un Opus 2.0 et un Opus 3.0, un MP2, un PCM, une
piste §148 en retard et une piste plus courte que le film.

1. **Niveaux par canal** contre `ffmpeg astats` sur la source décodée et repliée par le même `pan`. Tolérance :
   0,05 dB sur L R C Ls Rs ; LFE expliqué (filtre à 120 Hz). Prototype : ±0,01 dB.
2. **Jointures** : 10 segments consécutifs, chacun construit par son propre processus, plus une tâche de 60 s. Les
   trames doivent être identiques au bit à l'encodage continu (E-AC-3), et le décodage de la concaténation
   identique. Pour une cible sans identité (AAC) : écart aux jointures sous −40 dB, rapport de clic sous 1,5.
3. **Déterminisme** : même segment deux fois, deux processus, et après redémarrage, avec le même SHA-256 des trames
   **et du segment fMP4**.
4. **Placement** : décodé à son `tfdt` contre la source, à 0 échantillon, à 10 positions dont le premier segment ;
   pour une piste §148, silence puis premier échantillon réel à la bonne position ; pour une piste courte, silence
   jusqu'à la fin.
5. **Synchronisation image-son** :
   - au serveur : convertir une piste E-AC-3 **copiable** par la chaîne de conversion et comparer, par
     intercorrélation, son décodage à celui de la copie : 0 échantillon d'écart ;
   - sur l'appareil : un fichier synthétique éclair + bip, généré par le banc, joué sur `/lumen-test`, avec l'écart
     relevé à la caméra ou par `requestVideoFrameCallback`.
6. **Après un saut** : segments demandés hors ordre, mêmes octets. Sur iPhone et Mac, le parcours de sauts de
   `/lumen-test` avec une piste convertie : son revenu à la bonne place, aucun clic, et changement de piste par
   `audioTracks` entre une VF copiée et une VO convertie (deux groupes ou un seul groupe `ec-3`).
7. **Ordre des canaux** : les tonalités de `bench/tones.mjs` dans le banc, puis **à l'oreille** sur un appareil
   Apple relié à du 5.1.
8. **Charge** : N séances simultanées, plus X-Ray, plus un transcodage Jellyfin. Mesurer le 95ᵉ centile du temps de
   réponse du segment sous la tête, l'attente dans la file et la mémoire du conteneur.
9. **Le lecteur actuel inchangé** : rien sous `src/lib/webcodecs/` ne bouge ; empreintes du lecteur et
   `remux-hash-bench` identiques.
10. **Acceptation par Apple** : E-AC-3 2.0 et 1.0 en HLS sur iPhone, Mac et (phase AirPlay) Apple TV ; FLAC 7.1 si
    l'option est retenue.

Le banc a besoin de ffmpeg. Il tourne dans l'image construite, pas dans `node:26-alpine` nu de la porte. Les tests
unitaires (grille, découpe des trames, clé du cache, admission) n'ont pas besoin de ffmpeg et vont dans la suite.

---

## 5.9 Les options de configuration

Toutes nouvelles, toutes coupées ou neutres par défaut. Ordre de lecture : réglage de l'application → `.env` →
défaut (§48).

| Option | Défaut | Rôle |
|---|---|---|
| `LUMEN_AUDIO_CONVERT` | `off` | Audience (`off` / `admins` / `tous`, `featureAudience.ts`) de la conversion du son au serveur |
| `LUMEN_FFMPEG_PATH` | `/usr/local/bin/ffmpeg` | Vide = pas de conversion. Capacité détectée au démarrage |
| `LUMEN_AUDIO_STEREO` | `eac3` | `eac3` (256 kb/s 2.0) ou `aac` (AAC-LC 192 kb/s) pour les sources stéréo |
| `LUMEN_AUDIO_LOSSLESS` | `off` | `flac` : FLAC sans perte pour TrueHD, DTS-HD MA et PCM (7.1 gardé, 3 à 4 Mb/s) |
| `LUMEN_AUDIO_MAX_JOBS` | `2` | Processus ffmpeg simultanés |
| `LUMEN_AUDIO_MAX_SESSIONS` | `4` | Séances admises à la conversion |
| `LUMEN_AUDIO_LEAD_S` | `120` | Avance de conversion sur la tête de lecture |
| `LUMEN_AUDIO_CACHE_DIR` | `DATA_DIR/lumen-audio` | Emplacement du cache (`.env` seulement : un volume) |
| `LUMEN_AUDIO_CACHE_GB` | `10` | Plafond du cache |

**Dans la Configuration**, une carte « Conversion du son » (marquée « Lab bêta », comme §143), près des réglages
de Lumen serveur :
- une ligne d'état : « ffmpeg 7.1.5 détecté : E-AC-3, AAC, FLAC » ou « Conversion indisponible sur ce serveur : le
  son est converti par l'appareil » ;
- l'audience et la cible stéréo, l'option sans perte ;
- l'occupation du cache ;
- les séances qui convertissent maintenant ;
- sur 24 h : segments convertis, temps médian et pire, replis vers l'appareil.

Le texte se traduit dans les quatre langues, sans vocabulaire d'infrastructure.

---

## 5.10 L'ordre de travail

Chaque étape est déployable seule, l'option coupée. Aucune ne touche au lecteur actuel.

0. **Prototype hors dépôt** (fait, ce document).
1. **L'outil.**
   - Un étage `ffmpeg` dans le `Dockerfile`, épinglé, SHA-256 vérifié, et le script `tools/ffmpeg-server/build.sh`
     qui le reconstruit à l'identique.
   - La détection de capacité (`src/lib/lumenServer/audio/ffmpeg.ts`) et son affichage dans la Configuration.
   - Rien ne l'appelle encore. Tests : lecture de `-version` et `-encoders`.
2. **Le convertisseur, fonction pure** (`audio/grid.ts`, `audio/convert.ts`).
   - La grille, le placement par nombre d'échantillons et le silence §148.
   - Le flux élémentaire vers ffmpeg et la découpe des trames E-AC-3.
   - Le segment fMP4 et le `dec3`.
   - Le banc `lumen-audio-bench.spec.ts` (§5.8, points 1 à 4 et 7). Aucun appelant.
3. **Le cache et la file** : priorités, `nice`, tâches de 60 s, requêtes en vol partagées, plafond LRU. Pas de
   route encore.
4. **Les routes.**
   - `eligibility` rend `conversion` au lieu de `son-codec` quand l'audience le permet.
   - Les listes déclarent les rendus convertis, et `/lumen-test` les joue.
   - Le protocole sur iPhone et Mac (§5.8, points 5, 6 et 10).
   - Administrateur seul, comme toutes les routes `/api/lumen`.
5. **Admission et repli au départ** : `son-serveur-occupe` et `son-conversion-coupee`, l'état dans la réponse du
   battement, les champs `srv.*` de la conversion.
6. **Bascule préparée HLS → MediaSource** en cours de lecture. Elle dépend de l'hôte client de Lumen serveur
   (étape 4 du README, `LumenServerHost`).
7. **Les extensions** :
   - pistes §148 et pistes courtes ;
   - option FLAC ;
   - `LUMEN_AUDIO_STEREO=aac` si un récepteur l'exige ;
   - réécriture SBR explicite (§5.1), hors conversion.
8. **Ouverture à `tous`**, après une période de mesure (le relevé `srv.*` et les lignes `fallback`).

Les étapes 2 et 6 sont les plus délicates : une erreur de placement ou de bascule ne s'entend qu'à la lecture.

---

## 5.11 Ce qu'il faut trancher

1. **La stéréo en E-AC-3 256 kb/s plutôt qu'en AAC-LC.** Recommandé : sans jointure, déterministe, 6 fois moins de
   calcul, meilleur rapport signal/bruit mesuré, et aucune exigence nouvelle pour les appareils.
2. **Le 7.1** : repli 5.1 par défaut. L'option FLAC sans perte (+2,4 à 3,3 Mb/s, 7.1 gardé) vaut-elle d'être
   construite, et pour quels écrans ?
3. **Le cache** : sur `data/` (NVMe) ou sur le disque de données envisagé pour l'index ; et le plafond (10 Go
   proposés).
4. **ffmpeg toujours dans l'image** (+4 Mo, LGPL, offre de source à publier), ou seulement dans une variante.
5. **Les plafonds** : 2 processus, 4 séances ; `nice` 10 pour la demande sous la tête, 15 pour l'avance.
6. **Les pistes §148 en E-AC-3 ou AC-3** : réencodées en entier (seconde génération), ou silence encodé aux
   paramètres exacts de la piste puis copie bit à bit. La seconde est plus fidèle, mais à prouver sur Apple ; §148
   l'avait écartée pour le navigateur, faute d'encodeur, mais le serveur en a un.
7. **La bascule en cours de lecture** : préparée avec deux `<video>` (moins de coupure, plus de risques sur
   iPhone), ou brute (1 à 2 s de coupure, rien de neuf).
