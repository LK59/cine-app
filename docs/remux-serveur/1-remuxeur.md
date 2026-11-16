# 1. Le cœur du remux serveur (« Lumen serveur »)

Recherche et conception seulement : aucun fichier du dépôt n'a été modifié. Les chemins `src/…` sont
relatifs à `/opt/stacks/cine-app`, les numéros de ligne sont ceux du commit `bea33981` (10.44.7).
Convention : **[mesuré]** = relevé dans cette étude sur de vrais fichiers ; **[estimé]** = raisonnement
ou ordre de grandeur non mesuré ; **[à vérifier]** = question qui ne se tranche que sur un appareil Apple.

---

## 1.1 Le remuxeur actuel : structure et ordre des appels

### La chaîne

```
ByteSource ─▶ openMediaFile ─▶ MatroskaFile (pistes, index) ─▶ Remuxer.open ─▶ plan() ─▶ nextSegment()…
(plages)      (mediaFile.ts)    même forme pour MKV et MP4       (remuxer.ts)    init      fragments moof+mdat
```

1. **Ouverture du fichier** — `openMediaFile(source, key)` (`src/lib/webcodecs/mediaFile.ts:32`) :
   reconnaît le conteneur à ses 12 premiers octets, appelle `parseMatroska` (`matroska.ts:387`) ou
   `parseMp4` (`mp4Demux.ts`), puis `completeParameterSets` (`mediaFile.ts:84`), la **correction hvcC** :
   un `hvcC` sans VPS/SPS/PPS (`hevcRecordHasParameterSets`, `codecConfig.ts:528`) est complété depuis la
   première image clé (`hevcParameterSets` `:549`, `hevcRecordWithParameterSets` `:576`). L'en-tête est
   gardé en mémoire sous `mediaHeaderKey` (URL + ETag, `mediaFile.ts:60`, `rememberedHeaders.ts`).
2. **Description** — `MatroskaFile` (`matroska.ts:93`) : pistes (`MatroskaTrack` `:44`, avec `codecPrivate`,
   `video.colour`, `dolbyVision {type, record}`), **index** `cues: CuePoint[]` (`{track, timeUs, clusterOffset}`,
   `:78`, triés `:609` ; seule `CueClusterPosition` est lue, `:633`). Pour un MP4, les points d'accès sont les
   échantillons synchrones vidéo, à l'offset minimal des échantillons décodés à partir de la clé
   (`mp4Demux.ts:808-819`). Lecture des échantillons : `createSampleReader` (`mediaFile.ts:131`) →
   `SampleReader` (Matroska, un `read` par élément/bloc) ou `Mp4SampleReader` (ordre de décodage multi-pistes).
3. **Ouverture du remuxeur** — `Remuxer.open(source, file, video, audio, dims, dolbyVision, startSeconds, options)`
   (`remuxer.ts:863`) : décide la livraison audio (`audioDelivery` `:457` → `naturalDelivery` `:273` →
   `containerAccepts`), ouvre un `AudioTranscoder` si la piste doit être ré-encodée, sonde le début de piste
   (`probeTrackStart` `:595`, §148 son en retard), décrit l'audio (`describeAudio` `:617` : AC-3/E-AC-3 décrits
   depuis une trame), construit l'entrée vidéo `videoSampleEntry` (`mp4SampleEntries.ts:145` : `hvc1`/`avc1`/`av01`,
   ou `dvh1` + `dvcC/dvvC` via `dolbyVisionSampleEntry` `:92`, plus `colr/mdcv/clli` via `colourBoxes` `:118`).
4. **Init** — `plan()` (`remuxer.ts:1002`) : types MIME + `initSegment(info, durée)` **une init par piste**
   (`mp4Muxer.ts:123` : `ftyp iso5/iso6/mp41`, `moov` avec `mvhd` durée 0, `mehd` v1, `trex`). Échelle de temps
   1 000 000 pour la vidéo **et** l'audio (`remuxer.ts:42`).
5. **Fragments** — `nextSegment()` (`remuxer.ts:1210`) → `readUntilSettled()` (`:1236`) lit jusqu'à ce qu'un
   fragment soit « réglé » (profondeur de réordonnancement, `settled` `:1330`), puis `buildVideo()` (`:1511`),
   puis l'audio (`buildAudio` `:1611` copié, ou `buildTranscodedAudio` `:1378`), puis les sous-titres.
   - Coupe de groupe : nouvelle image d'accès aléatoire **et** ≥ `SEGMENT_US` = 2 s (`:45`, `:1298`).
   - `strayUnits` (`codecConfig.ts:334`) : un bloc sans tranche (VPS/SPS/PPS/RPU seuls, *Dirty Dancing*) est
     rendu aux images voisines par `putBack` (`remuxer.ts:778`, appel `:1254`) : unités suffixes (RPU, SEI
     suffixe) à l'image d'avant, le reste à l'image d'après (`strayAhead`).
   - Accès aléatoire vérifié : `startsHere` = `isKey && isRandomAccessPoint` (`codecConfig.ts:191` : HEVC
     BLA/IDR/CRA ; AVC IDR ou I + SEI recovery point). Après un saut, `needKeyframe` (`remuxer.ts:1280`) jette ce
     qui précède la première vraie clé, et `backUp()` (`:1483`) recule de 12 s si l'index ment.
   - RASL : après la clé de reprise, `dropLeading` (`:1260`) écarte les images `isRaslPicture` (`codecConfig.ts:231`,
     types 8/9) — **seulement** juste après un saut ou une ouverture, jamais en lecture continue.
   - Temps de décodage : `deriveDurations` + `assignDecodeTimes` (`decodeOrder.ts:113`, `:59`) sur **le groupe
     entier lu jusque-là**, ancré sur sa plus petite présentation (`groupAnchorUs ??=`, `remuxer.ts:1531`) : les
     instants de décodage sont absolus, rien n'est enchaîné d'un groupe à l'autre.
   - Décalage de composition : `presentationDelayUs` = délai mesuré sur **le premier groupe construit par ce
     remuxeur** + 3 images (`DELAY_MARGIN_FRAMES` `:109`, mesure `:1541`), ajouté à tous les décalages vidéo
     (bornés à ≥ 0, compteur `clampedSamples`) et à tous les instants audio : tout le flux est décalé d'autant.
   - Fragments CMAF : `fragmentise` (`:1596`) / `planFragments` (`:694`) bornent à 1,2 Mo / 60 échantillons
     (Safari MSE refusait un fragment de 5,5 Mo). `mfhd` = compteur `this.sequence` incrémenté (`:1606`).
   - Audio copié (`buildAudio` `:1611`) : blocs lacés regroupés par horodatage, durée de trame = écart au bloc
     suivant ÷ nombre de trames, réancrée sur chaque bloc, chevauchements écartés (`audioEndUs`).
   - `mediaSegment` (`mp4Muxer.ts:159`) : `moof(mfhd, traf(tfhd default-base-is-moof, tfdt v1, trun v1 signé))`
     + `mdat` ; durée écrite = écart au décodage suivant ; drapeaux d'échantillon binaires
     (`sampleFlags` `:148` : clé = `0x02000000`, sinon `0x01010000`).
6. **Saut** — `seekTo(seconds)` (`remuxer.ts:1116`) remet tout l'état à zéro et repositionne le lecteur sur
   `clusterOffsetForTime` (`matroska.ts:664`).

### Ce qui dépend du navigateur, et ce qui tourne tel quel dans Node

| Tourne tel quel dans Node [mesuré : chargé et exécuté dans `node:26-alpine`] | Dépend du navigateur |
|---|---|
| `mediaFile.ts`, `matroska.ts`, `ebml.ts`, `sampleReader.ts`, `mp4Demux.ts` (+ `rememberedHeaders`, `unreadableZone`) | `HttpByteSource` (`byteSource.ts:528`) : `fetch`, `navigator.onLine`, visibilité, OPFS (`resumeCache/`), réserve RAM |
| `codecConfig.ts` (`strayUnits`, `isRaslPicture`, `isRandomAccessPoint`, `hevcCodecString`, `dolbyVisionInfo`, `withCappedLightLevels`, correction hvcC) | `containerAccepts` / `playabilityOf` (`mseSupport.ts:26`) = `MediaSource.isTypeSupported` — appelé au cœur de `naturalDelivery`, `assertContainerTakes` |
| `decodeOrder.ts`, `mp4Muxer.ts`, `mp4SampleEntries.ts` | `AudioTranscoder` (`audioTranscode.ts`) : `AudioEncoder` WebCodecs (`:183`, `:573`), absent de Node |
| `audioLeadGap.ts`, `trace.ts`, `playbackDiagnosis.diagNow` | `browserEngine.ts` (`opusCopyConsidered` `:52`, `geckoEngine` `:36`, `appleWebKit` `:73`) lit `navigator.userAgent` |
| Décodeurs WASM : `@mediabunny/ac3`/`dts`, `truehd-wasm.mjs`, `aac-wasm.mjs` (les bancs les font déjà tourner dans Node) | `aacPceProbe.ts` (`localStorage`, `document.createElement("audio")`), Worker TrueHD (`truehdDecoder.ts:150`, repli fil principal possible) |

Les bancs `cout.spec.ts`, `bench.spec.ts` font déjà tourner `Remuxer` entier dans Node en simulant
`window.ManagedMediaSource = { isTypeSupported: () => true }` (`cout.spec.ts:26-28`). Pour le serveur, il ne faut
pas de simulation : la question « Safari prend-il ce codec ? » doit devenir un **paramètre** (table des codecs
HLS de Safari, ou réponse transmise par le client), pas un appel global.

**Conclusion structurelle.** Les briques bas niveau (démux, réparations d'unités NAL, ordre de décodage,
muxer, entrées d'échantillon) sont réutilisables sans changement. La classe `Remuxer`, elle, ne l'est pas
telle quelle : c'est un **lecteur en flux à état** (curseur de lecture, groupe en cours, `emitted`, `sequence`,
`presentationDelayUs` mesuré à la première construction, `audioEndUs`, transcodeur positionné), pensé pour
« le prochain morceau ». Le serveur sans état a besoin d'une autre forme : **une fonction pure
« segment [clé A, clé B) avec un délai D donné »**. Il faut l'extraire de `readUntilSettled`/`buildVideo`/
`buildAudio` plutôt que de l'écrire à côté (règle « une décision, un endroit » de CLAUDE.md ; idéalement le
lecteur navigateur l'appellerait un jour, sans bouger ses empreintes).

---

## 1.2 Découpage en segments sans état

### Prototype mesuré

Un prototype (prototype hors dépôt, dépôt monté en lecture seule, chargé par `jiti`) produit le
segment N **seul**, à partir d'un lecteur neuf positionné sur le `clusterOffset` de sa clé, avec les fonctions
existantes (`openMediaFile`, `createSampleReader`, `strayUnits`, `isRandomAccessPoint`, `isRaslPicture`,
`deriveDurations`, `assignDecodeTimes`, `videoSampleEntry`, `audioSampleEntryFor`, `initSegment`, `mediaSegment`).
Les segments produits indépendamment ont été concaténés (init + N + N+1 + …) et relus par `ffprobe`/`ffmpeg`
(image `linuxserver/ffmpeg`) — voir 1.4.

### Construire la liste depuis l'index

- **Points de coupe** = points d'index de la piste vidéo (`cue.track === video.number`, jamais ceux de l'audio,
  cf. `clusterOffsetForTime`). EXTINF du segment k = `t(clé de k+1) − t(clé de k)`, le dernier =
  `durée − t(dernière clé)`. Tout se calcule sans lire un octet de média.
- **Mais l'index ment parfois** : `isRandomAccessPoint` existe parce que 14 « clés » sur 193 d'un fichier étaient
  des `TRAIL_R`. Une liste sans état ne peut pas « reculer » au moment du segment (le segment précédent aurait déjà
  livré ces images) : **la vérification doit se faire à la construction de la liste**, et son résultat être gardé
  (cache par fichier : chemin + taille + mtime, ou ETag Jellyfin).
- **Coût de la vérification** [mesuré, avec le `SampleReader` existant, qui lit chaque bloc en entier] :
  Ted Lasso S02E01 (1,5 Go, 705 clés) : 10,8 s, 872 Mo lus (on lisait aussi les images suivant chaque CRA pour
  compter les RASL) ; Exorcist (8,9 Go) : 72 ms/clé ; Retour vers le futur II : 35 ms/clé ; MP4 *Forsaken* :
  8 ms/clé (1 505 clés, 125 Mo). **Trop cher tel quel.** Il faut un lecteur d'en-têtes de blocs qui ne lit que
  l'en-tête EBML du bloc + les ~16 premiers octets de sa charge (type NAL), puis saute : ~10 petites lectures par
  clé (la clé et ses images de tête) [estimé : 7 000 lectures de quelques Ko pour un épisode, < 1–2 s à chaud,
  quelques secondes à froid sur le mergerfs à trois disques]. À faire une fois par fichier, en tâche de fond ou
  à la première demande de liste, et garder.
- **Granularité** [mesuré, regroupement glouton « nouvelle coupe dès que ≥ cible depuis la précédente »] :

  | Fichier | GOP | cible 2 s | cible 4 s | cible 6 s |
  |---|---|---|---|---|
  | Ted Lasso S02E01 (HEVC 4K DV8, CRA) | 1–10 s | 493 seg., méd. 3,5 s, max 11,7 | 337, méd. 5,6, p95 10,0, max 14,0 | 257, méd. 7,4, max 15,5 |
  | The Exorcist (HEVC DV8, IDR) | ~10,4 s fixe | 1 053, méd. 6,7, max 12,4 | 860, méd. 9,3, max 14,4 | 729, méd. 10,4, max 16,4 |
  | Retour vers le futur II (HEVC DV8, IDR) | ≤ 10,4 s | 1 105, méd. 4,8 | 841, méd. 7,3, max 14,4 | 693, méd. 9,3 |
  | Forsaken (MP4, IDR) | ≤ 5 s | 1 505, méd. 4,2, max 5,0 | 1 120, méd. 5,0, max 9,0 | 710, méd. 8,5 |

  **Recommandation : cible 4 s (un segment = un ou plusieurs GOP entiers, coupe à la première clé vérifiée ≥ 4 s
  après la précédente).** Ce qu'on ne peut pas faire, c'est descendre sous le GOP : sur *L'Exorciste*, un
  segment fait au moins 10,4 s quoi qu'on vise, donc `EXT-X-TARGETDURATION` vaudra 14–17 s pour ces fichiers
  (permis, au-dessus des 6 s conseillées par Apple). Un saut y coûte jusqu'à un segment entier : 13–20 Mo en
  4K [mesuré : #286 et #287 de L'Exorciste, 15,0 et 19,9 Mo lus] — exactement ce que paie déjà le chemin MSE,
  qui doit lui aussi partir de la clé. **[à vérifier]** AVPlayer attend-il le segment complet avant la première
  image ? Si oui, la latence d'un saut sur un GOP de 10 s est celle de 15–20 Mo, sans le découpage en fragments
  CMAF que le lecteur MSE livre au fil de l'eau.
- **BANDWIDTH sans lire** [estimé] : les offsets de grappe de l'index donnent les octets par segment (toutes
  pistes confondues, donc par excès) : `max((offset[k+1] − offset[k]) × 8 / EXTINF)` pour `BANDWIDTH`,
  la moyenne pour `AVERAGE-BANDWIDTH`.

### Produire le segment N indépendamment

Règles (toutes appliquées par le prototype) :

1. **Lecture** : lecteur neuf sur `clusterOffset` de la clé de N ; on jette ce qui précède la première image
   vérifiée ; on s'arrête à la première image `startsHere` dont la présentation est ≥ `t(clé de N+1)` ; on ne
   garde que les blocs vidéo/audio de la plage.
2. **Groupes** : le segment est coupé en GOP à chaque clé vérifiée ; chaque GOP passe seul dans
   `deriveDurations` + `assignDecodeTimes`, ancré sur **sa propre plus petite présentation** — c'est déjà le
   comportement de `buildVideo` (`remuxer.ts:1531`) et c'est ce qui rend l'opération sans état : le DTS de
   départ du segment N ne dépend que de N. Le groupe doit être lu **entier** avant d'en calculer les DTS
   (`decodeOrder.ts` : la propriété « DTS = PTS triés » ne tient que sur un groupe fermé). Le flux par
   fragments réglés du `Remuxer` (profondeur de réordonnancement) devient inutile : le segment est lu jusqu'au
   bout de toute façon avant d'être envoyé.
3. **`baseMediaDecodeTime` (`tfdt`)** = DTS du premier échantillon de chaque fragment, absolu (µs depuis le début
   du fichier, échelle 1 000 000) ; les DTS sont continus d'un segment à l'autre parce que la fin d'un GOP
   (`endDecodeTime`) tombe sur la plus petite présentation du GOP suivant. [mesuré : fin de #1 = début de #2 à la
   microseconde près sur les quatre fichiers, p. ex. Ted Lasso 19,9370 → 19,9370].
4. **Décalage de composition — le seul état à figer.** Le `Remuxer` mesure son délai sur le premier groupe
   *qu'il construit* : un segment produit seul mesurerait un délai différent selon son GOP, et les segments
   ne se raccorderaient plus (décalage A/V et trous). Il faut **un délai D par fichier**, identique pour tous les
   segments, toutes les pistes (vidéo, chaque audio, sous-titres) :
   - calculé à la construction de la liste sur le premier GOP (même formule : délai mesuré + 3 images)
     [mesuré : 84 ms + 3 × 41,7 = **210 ms** sur Ted Lasso, L'Exorciste, RVLF II ; 208,3 ms sur le MP4 ;
     **0 échantillon borné** sur 9 segments × 4 fichiers], gardé avec la liste, et **porté dans l'adresse des
     segments** (`…/seg/N.m4s?d=210000`) : le serveur n'a alors rien à retenir entre deux requêtes ;
   - ou D = 0 en écrivant des décalages négatifs (`trun` v1 le permet déjà, `mp4Muxer.ts:201`) : présentation =
     instant source exact, plus rien à porter. **[à vérifier]** que Safari HLS accepte un `trun` v1 à décalages
     négatifs sans liste d'édition ; le chemin MSE ne l'a jamais exercé (il borne à ≥ 0).
   Conséquence à reporter ailleurs (lecteur, reprise, sous-titres) : la position lue par `<video>` = instant
   fichier + D. **[à vérifier]** comment AVPlayer place le zéro de `currentTime` d'une liste fMP4 dont le
   premier PTS vaut D.
5. **B-frames** : les décalages de composition sont ceux d'`assignDecodeTimes` + D, bornés à 0 (compteur gardé
   comme `clampedSamples`) ; un GOP réordonnant plus profondément que le premier serait borné (une image
   montrée une trame trop tôt) — mesuré à 0.
6. **`mfhd`** : le compteur ne peut plus être une variable d'instance. Prendre `N × 1000 + rang du fragment + 1`
   (strictement croissant d'un segment à l'autre, calculable seul). Le prototype a utilisé `N × 100 + k + 1`,
   accepté par ffmpeg. Safari ne s'en sert pas pour placer les échantillons (c'est `tfdt`) [estimé].
7. **Fragments** : garder `planFragments` (1,2 Mo / 60 échantillons) — plusieurs `moof`+`mdat` par segment sont
   permis en HLS fMP4 ; la borne venait d'un refus de Safari MSE, inutile de découvrir si le démultiplexeur HLS
   a la même limite.
8. **Drapeaux d'échantillon** : `isKeyframe` = `startsHere` (pas la parole du conteneur), comme aujourd'hui.

### RASL : garder ou non ?

[mesuré] Ted Lasso S02E01 : 704 CRA + 1 IDR ; **23 CRA sont suivies de RASL (49 images)**. L'Exorciste,
RVLF II, le MP4 : 100 % IDR, aucune RASL. Expérience sur Ted Lasso, segments #1 et #2 (le #2 commence sur une
CRA suivie de 2 RASL) :

| Variante | Lecture continue (#1 puis #2) | #2 seul (= après un saut) |
|---|---|---|
| RASL **gardées** | 380 images, **aucun trou** | ffmpeg les écarte lui-même (140 images, pas d'erreur de référence) |
| RASL **écartées** dans tout segment | 378 images, **trou de 125 ms** (20,105 → 20,230 s) | 140 images |

Un segment est demandé à la suite *ou* après un saut, et le serveur sans état ne sait pas lequel. Donc :

- Écarter les RASL partout = une saccade de 2–3 images à chaque frontière CRA+RASL en lecture continue. Non.
- Les garder partout = continuité parfaite, mais après un saut le décodeur doit les écarter lui-même. C'est
  **exactement** ce que Safari MSE ne faisait pas (*Ted Lasso*, « Media failed to decode »). **[à vérifier]**
  si le pipeline HLS natif (AVPlayer/VideoToolbox) le fait, ce qui est probable mais non prouvé.
- **Recommandation : ne jamais couper un segment sur une CRA suivie de RASL.** La vérification de la liste les
  repère déjà (il suffit de lire les en-têtes NAL des 2–3 images après chaque CRA) ; une telle CRA reste à
  l'intérieur d'un segment, où ses RASL ont leurs références. Coût : quelques segments plus longs (23 coupes
  sur 705 points d'index, ici). Les segments commencent alors tous sur IDR, BLA ou CRA sans image de tête
  dépendante : ils sont réellement indépendants, `EXT-X-INDEPENDENT-SEGMENTS` devient vrai, et la question
  Safari ne se pose plus. En complément (défense) : marquer les RASL `is_leading = 1` dans `sample_flags`
  (aujourd'hui toujours 0, `mp4Muxer.ts:148`) — gratuit, et c'est la façon ISO BMFF de dire « non décodable
  après accès aléatoire ».

### `strayUnits`

Reste valable sans changement et ne crée pas d'état : un bloc sans image juste avant la clé de N+1 porte des
unités suffixes (RPU de l'image précédente → rendues à la dernière image de N) et des unités préfixes (VPS/SPS/PPS
→ pour la clé de N+1, donc jetées par N et relues par N+1). Les deux segments font la même chose de leur côté
de la frontière. Seul point d'attention : le segment N doit lire **jusqu'à** la clé de N+1 (pas s'arrêter au
dernier bloc vidéo connu), pour rattraper le RPU suffixe d'un bloc égaré. Le prototype le fait.

### Le son aligné sur la vidéo

Forme HLS proposée : **audio démultiplexé** — une liste par piste audio (`EXT-X-MEDIA TYPE=AUDIO`), une init
par piste. C'est déjà ce que produit le muxer (une init par piste, `initSegment(track)`), et cela donne le
changement de piste natif de Safari sans reconstruire quoi que ce soit (là où le chemin MSE reconstruit tout).

- **Frontières** : le segment audio k couvre les trames dont l'instant ∈ `[t(clé k), t(clé k+1))` — les mêmes
  frontières que la vidéo, en temps fichier, + D. Chaque trame appartient à exactement un segment, choisie par
  son propre instant : pas de chevauchement, pas de trou. [mesuré : trois segments audio produits seuls puis
  concaténés, E-AC-3 5.1 / mono / stéréo et MP4 : **0 discontinuité** sur 809, 978, 978, 469 paquets].
- **Où sont ces trames dans le fichier** : en Matroska, dans la grappe de la clé et les suivantes (horodatages
  croissants par grappe) ; [mesuré : 0 trame antérieure trouvée dans la grappe de départ, MKV]. En MP4
  (entrelacement libre) le point d'accès commence à l'offset minimal de toutes pistes : on y trouve 2–3 trames
  du segment précédent [mesuré], qu'on jette ; et il faut continuer à lire après la dernière image jusqu'à la
  première trame ≥ fin (le prototype le fait ; à borner).
- **Durée de trame** : `buildAudio` la déduit de l'écart au bloc suivant, et pour la dernière série du segment,
  de la durée mesurée avant — c'est déterministe dans le segment, donc acceptable. Mieux : lire **un bloc de
  plus** après la fin pour mesurer l'écart réel (sans le garder), ou prendre la durée du codec quand elle est
  fixe (AAC 1024, AC-3 1536 échantillons ; **pas** E-AC-3, dont une trame peut porter 1, 2, 3 ou 6 blocs).
  Le prototype a supposé 1536 pour E-AC-3 : correct sur ces fichiers, faux en général.
- **Vidéo et audio n'ont pas exactement les mêmes bornes de présentation** : la vidéo de N commence à la plus
  petite présentation de son GOP (avant la clé si images de tête), l'audio à l'instant de la clé [mesuré :
  83 ms d'écart sur Ted Lasso]. Sans conséquence en audio démultiplexé (les deux listes sont placées par `tfdt`).
- **Son ré-encodé** (DTS, TrueHD, PCM, Opus multicanal… et AAC à PCE) : **pas d'`AudioEncoder` dans Node.**
  Décoder est possible (les décodeurs WASM tournent déjà dans Node dans les bancs), encoder ne l'est pas sans
  nouveau composant : un encodeur WASM à construire (FFmpeg `ac3`/`eac3` — Safari prend l'AC-3 multicanal en
  HLS, et l'ordre des canaux redevient le nôtre — ou `aac`), compilé comme `tools/aac-wasm/build.sh`. Et sans
  état, chaque segment doit redécoder depuis un peu avant sa frontière (pré-roulement, TrueHD : depuis une
  synchro majeure ; AAC/AC-3 : chevauchement MDCT) et encoder sur une grille de trames fixe (trame k à
  `k × 1536` échantillons de l'origine de la piste) pour que deux segments voisins tombent sur la même grille.
  **Recommandation v1 : ne servir en Lumen serveur que les pistes copiées** (AAC, AC-3, E-AC-3 dont Atmos JOC,
  et FLAC/ALAC **[à vérifier]** en HLS) et laisser les autres au lecteur serveur actuel ou à la piste suivante.
- **Son qui commence après l'image (§148)** et **piste plus courte que le film** : un segment audio sans aucune
  trame ne peut pas être fabriqué (`mediaSegment` lève sur une liste vide, `mp4Muxer.ts:165`). Il faudrait du
  silence (une trame AAC silencieuse se fabrique ; l'AC-3 silencieux à la main a été écarté au §148) ou
  `EXT-X-GAP` **[à vérifier]** dans Safari VOD. Les mêmes 44 films du recensement du 12/11 sont concernés.

### Fichiers sans index

- **Matroska sans Cues** : « lisible, pas de saut » aujourd'hui. Pour une liste HLS il faut un index : le
  construire une fois en parcourant les grappes de premier niveau (taille connue → une petite lecture par
  grappe : horodatage de grappe + en-tête du premier bloc + type NAL), puis le garder. [estimé : 2 000 à 7 000
  petites lectures pour un film, quelques secondes]. Ce parcours donne aussi les clés internes aux grappes si on
  lit l'en-tête de chaque `SimpleBlock` vidéo (drapeau clé) — plus cher, mais c'est aussi la parade aux index
  **clairsemés** (muxers qui n'indexent qu'une clé par grappe ou par N Mo). Grappes de taille inconnue (fichier
  issu d'un enregistrement en direct) : il faudrait tout lire → lecteur serveur actuel.
- **MP4** : l'index est `stss` ; un MP4 sans `stss` a tous ses échantillons synchrones. Le MP4 fragmenté est déjà
  refusé (`mp4Demux`) → lecteur serveur.
- Nombre de fichiers concernés dans la bibliothèque : **[à mesurer]** (`audit.spec.ts` pose déjà les questions du
  lecteur à chaque fichier ; ajouter « Cues vidéo présents, densité »).

---

## 1.3 Signalisation HLS de la vidéo

Ce que le code sait déjà en tirer :

- **HEVC** : `hevcCodecString(hvcC)` (`codecConfig.ts:43`) → `hvc1.<espace><profil>.<compat>.<L|H><niveau>.<contraintes>`
  [mesuré : Ted Lasso `hvc1.2.4.H153.90` — tier **High**]. Entrée `hvc1` avec jeux de paramètres dans `hvcC`
  (garanti par la correction hvcC) : c'est la forme qu'exige HLS (pas `hev1`). Les jeux de paramètres restent
  aussi dans le flux à chaque clé ; Safari MSE l'accepte, **[à vérifier]** en HLS (probable).
- **AVC** : `avcCodecString` (`:124`) → `avc1.PPCCLL`. Clés I + SEI recovery point (*Supernatural*) acceptées par
  `isRandomAccessPoint` ; **[à vérifier]** qu'un segment HLS indépendant peut commencer sur une telle image
  (Apple demande en principe une IDR en tête de segment).
- **AV1** : `av1CodecString` (`:500`) → `av01…` ; Safari HLS seulement sur matériel AV1 (A17 Pro, M3 et +).
- **Dolby Vision** : `dolbyVisionInfo(record)` (`:103`) donne profil, niveau, `compatibilityId` (= `dv_bl_signal_compatibility_id`)
  et `dvh1.PP.LL`. `planDolbyVision` (`pathSelector.ts:112`) décide aujourd'hui *pour MSE* : `dvh1` si le
  navigateur l'accepte, sinon HDR10, sinon (profil 5 / `DOVI`) lecteur serveur. Pour HLS :

  | Cas | Entrée d'échantillon | CODECS | SUPPLEMENTAL-CODECS | VIDEO-RANGE |
  |---|---|---|---|---|
  | DV 8.1 (compat 1, base HDR10) | `hvc1` + `hvcC` + `dvcC`/`dvvC` recopié | `hvc1.2.4.L153.B0` (base) | `dvh1.08.LL/db1p` | `PQ` |
  | DV 8.4 (compat 4, base HLG) | idem | `hvc1…` | `dvh1.08.LL/db4h` | `HLG` |
  | DV 8.2 (compat 2, base SDR) | idem | `hvc1…` | `dvh1.08.LL/db2g` | `SDR` |
  | DV 5 (IPT-PQ, pas de base) | `dvh1` + `hvcC` + `dvcC` (= `dolbyVisionSampleEntry` actuel) | `dvh1.05.LL` | — | `PQ` |
  | DV 7 (BL + EL + RPU, Blu-ray UHD) | `hvc1`, **sans** boîte DV | `hvc1…` | — (Apple ne lit pas le profil 7) | `PQ` |
  | DV 10 (AV1) | non géré (`DOLBY_VISION_CODECS`, `pathSelector.ts:110`) → base AV1 | `av01…` | (`dav1.10.LL/db1p` plus tard) | `PQ` |
  | HDR10 / HDR10+ | `hvc1` (+ `colr/mdcv/clli`) | `hvc1…` | — | `PQ` |
  | HLG | `hvc1` | `hvc1…` | — | `HLG` |

  Écart avec le code actuel : pour 8.x le remuxeur écrit une entrée **`dvh1`** (`mp4SampleEntries.ts:100`), la
  forme MSE. En HLS avec `SUPPLEMENTAL-CODECS`, la forme compatible est **`hvc1` + boîte DV** : un appareil sans
  Dolby Vision lit la base HDR10, un appareil DV lit le DV. Petite variante de `videoSampleEntry` à ajouter (la
  boîte DV recopiée telle quelle, la règle CLAUDE.md « rien d'inventé dans une boîte » est respectée).
  Le profil 5 devient lisible nativement sur les appareils Apple DV — ceux qui partent aujourd'hui au lecteur
  serveur — mais **n'a pas de repli** sur un appareil sans DV : il faut le savoir avant de proposer ce chemin.
  Profil 7 : la base est du HDR10 ; les unités de la couche d'amélioration (type NAL 63 / `nuh_layer_id` > 0) et
  le RPU (type 62) devraient être ignorés par un décodeur Main 10, mais il vaut mieux les retirer au remux
  (même mécanique que `withCappedLightLevels`, `codecConfig.ts:382`) : 10–20 % d'octets en moins **[estimé]**.
  Une conversion 7 → 8.1 (réécriture du RPU, façon `dovi_tool`) est un autre chantier.
- **VIDEO-RANGE** : depuis `video.colour.transferCharacteristics` (16 = PQ, 18 = HLG). **Insuffisant** :
  [mesuré] L'Exorciste et RVLF II (DV 8.1) n'ont **aucun** élément `Colour` dans le Matroska — l'information
  n'est que dans le VUI du SPS. Il faut soit lire `transfer_characteristics` dans le SPS du `hvcC` (petit
  analyseur de VUI à écrire, absent aujourd'hui), soit prendre `VideoRangeType` de Jellyfin (déjà utilisé par
  `planDolbyVision`). Le VUI est la source la plus sûre (« ce qu'une boîte porte vient du fichier »).
- **RESOLUTION** : `video.width/height` (ou le SPS) ; **FRAME-RATE** : durée de trame typique
  (`deriveDurations` du premier GOP, déjà calculée pour D).
- `withCappedLightLevels` (plafond HDR pour Chrome/Windows) : sans objet pour Safari, à ne pas appliquer.

---

## 1.4 Mesures (réelles, lecture seule)

Conditions : `node:26-alpine`, `--cpus 2 -m 3g`, hôte chargé (charge ~8 sur 12 cœurs), dépôt en `:ro`,
`/mnt/media/video` en `:ro`, source = `readSync` sur le fichier (comme `cout.spec.ts`), sorties dans le
scratchpad. Le cache de pages n'a pas été vidé : la colonne « disque » est probablement à chaud pour les
segments du début (la vérification venait de lire ces zones) et à froid pour les segments lointains.

**En-tête** : Ted Lasso (MKV 1,5 Go) 72 ms, 43 lectures, 0,1 Mo.

**Un segment produit seul (cible 4 s)** :

| Fichier | Segments mesurés | Temps total | dont disque | dont calcul | Lu | Produit |
|---|---|---|---|---|---|---|
| Ted Lasso S02E01, HEVC 4K DV8 + E-AC-3 5.1 | 9 + 8 | 8 – 120 ms | 2 – 87 ms | 6 – 66 ms | 1,5 – 10,6 Mo | 0,7 – 6,5 Mo vidéo + 0,3 – 1,1 Mo audio |
| The Exorcist, HEVC 4K DV8 + E-AC-3 mono | 9 | 4 – 234 ms | 1 – 199 ms | 3 – 54 ms | 1,0 – 19,9 Mo | ≤ 14,4 Mo |
| Retour vers le futur II, HEVC 4K DV8 + E-AC-3 2.0 | 9 | 3 – 205 ms | 1 – 148 ms | 2 – 77 ms | 0,4 – 13,1 Mo | ≤ 10,3 Mo |
| Forsaken (MP4), 1080p + E-AC-3 5.1 | 9 | 9 – 116 ms | 2 – 80 ms | 7 – 41 ms | 0,5 – 3,3 Mo | ≤ 2,7 Mo |

- Lectures : 170 à 1 600 `read` par segment (une par élément/bloc avec le `SampleReader`) : une source fichier
  avec un petit cache de lecture par blocs de 1 Mio (comme `HttpByteSource`) les ramènerait à une dizaine.
- Le calcul est de l'ordre de 5–15 ms par seconde de 4K **[mesuré, ordre de grandeur]** : léger, mais
  *synchrone* par morceaux — à faire dans un `worker_threads` pour ne pas tenir la boucle d'événements de Next
  (CLAUDE.md compte chaque centaine de ms de boucle bloquée).
- **Mémoire** : processus 115 – 250 Mo RSS (dont `jiti`/babel pour le prototype), **Δ RSS par segment
  −50 à +55 Mo** (transitoire : entrée + sortie en mémoire). Pire cas estimé d'une requête : ~2 × la taille du
  segment (≈ 40 Mo pour un GOP 4K de 14 s). À plafonner par un nombre de constructions simultanées.

**Validation de la sortie** (ffprobe/ffmpeg 8 sur init + segments produits **séparément**) :
- Vidéo : Ted Lasso #0+#1+#2 → 620 images, PTS 0,210 → 26,027 s, aucun trou, aucune erreur de décodage ;
  L'Exorciste et RVLF II → 750 images chacun, aucun trou ; MP4 → 360 images ; Ted Lasso #113 seul → 144 images,
  sans erreur. Profil `Main 10`, transfert `smpte2084` reconnu.
- Audio : 0 discontinuité entre segments produits indépendamment (4 fichiers).
- RASL : voir 1.2 (trou de 125 ms si on les écarte partout ; ffmpeg les écarte seul après un saut ; avertissement
  « Multiple Dolby Vision RPUs found in one AU » quand il saute ces RASL — bénin chez ffmpeg, **[à vérifier]** chez Apple).

Rien de ceci ne prouve que **Safari** lit ces segments : la prochaine étape de mesure est de servir init +
segments + une liste statique depuis une instance jetable et d'ouvrir `<video src=…m3u8>` sur un iPhone et un Mac
(lecture continue, saut au milieu d'un GOP, saut sur une CRA+RASL, changement de piste audio).

---

## 1.5 Risques et inconnues

1. **RASL en HLS natif après un saut** [à vérifier] — contourné par « ne jamais couper sur une CRA à RASL »,
   qui demande la vérification de liste.
2. **Coût de la vérification de l'index** — 0,5 à 1,2 Mo lus par clé avec le lecteur actuel [mesuré] ; il faut un
   lecteur d'en-têtes de blocs, et un cache durable par version de fichier (un fichier remplacé au même chemin
   doit invalider la liste : taille + mtime ou ETag Jellyfin, comme `mediaHeaderKey`).
3. **Le délai D est un état** : à figer par fichier et à porter dans l'URL des segments (ou D = 0 avec décalages
   négatifs, à vérifier sur Safari). Toute erreur ici = désynchronisation A/V ou trous entre segments.
4. **Segments longs sur les GOP longs** (10–25 s dans cette bibliothèque) : `TARGETDURATION` élevé, sauts à
   15–20 Mo en 4K. Couper un GOP en plusieurs segments (segments non indépendants) **[à vérifier]** dans les
   règles d'Apple ; l'HLS bas-latence (`EXT-X-PART`) n'est pas fait pour la VOD.
5. **Son ré-encodé sans `AudioEncoder`** — DTS, TrueHD, Opus multicanal, AAC à PCE : nouveau composant (encodeur
   WASM) et problème de raccord sans état (pré-roulement, grille de trames). v1 : pistes copiées seulement.
6. **Son absent au début ou à la fin d'une piste** (§148) : segment audio vide impossible → silence fabriqué ou
   `EXT-X-GAP` [à vérifier].
7. **Codecs audio acceptés par Safari en HLS** : AAC, AC-3, E-AC-3 certains ; FLAC, ALAC, Opus [à vérifier]. La
   décision « copie ou non » dépend aujourd'hui de `MediaSource.isTypeSupported` (`mseSupport.ts:26`) : il faut
   une table côté serveur ou la réponse du client (le client peut appeler `canPlayType` pour chaque codec et
   l'envoyer avec la demande de liste — « demander au navigateur, jamais une liste », règle de CLAUDE.md).
8. **VIDEO-RANGE absent du Matroska** (L'Exorciste, RVLF II) : lecture du VUI à écrire, ou `VideoRangeType` Jellyfin.
9. **Dolby Vision** : entrée `hvc1` + boîte DV pour 8.x (nouveau, pas éprouvé sur Safari) ; profil 5 sans repli ;
   profil 7 à nettoyer ; HEVC tier High (`H153`) dans la chaîne CODECS [à vérifier si Apple le déclare lisible].
10. **Placement de l'horloge** : `currentTime` d'AVPlayer vs instant fichier + D — touche la reprise, la
    progression envoyée à Jellyfin, les sous-titres (WebVTT avec `X-TIMESTAMP-MAP` à aligner sur D) [à vérifier].
11. **Index clairsemés ou absents**, grappes de taille inconnue, MP4 fragmentés : parcours de grappes une fois par
    fichier, ou repli lecteur serveur. Nombre de fichiers concernés [à mesurer].
12. **Charge serveur** : calcul ~5–15 ms par seconde de 4K, mais lectures disque sur un mergerfs à trois disques
    (latence froide jusqu'à ~200 ms par segment mesurée) ; mémoire ~2 × la taille du segment par construction
    en cours ; worker_threads et un plafond de constructions simultanées. Safari peut demander vidéo et audio en
    parallèle, et précharger plusieurs segments.
13. **Zones illisibles (§93)** : le lecteur strict (`unreadable: "throw"`) lève `UnreadableZone` ; un segment
    serveur doit répondre une erreur que Safari traite proprement (et pas un 404 en rafale — règle CrowdSec de
    CLAUDE.md : un 404 par segment en rafale peut faire bannir l'adresse).
14. **Divergence avec le lecteur navigateur** : une deuxième implémentation de « segmenter un GOP » dériverait.
    Extraire une fonction pure partagée, et prouver que les octets du chemin MSE ne bougent pas (empreintes
    `src/__tests__/empreinte/`, `bench.spec.ts`).

---

## Annexe — reproduire la mesure

```sh
S=<scratchpad>; docker run --rm --name lumen-proto --cpus 2 -m 3g \
  -v /opt/stacks/cine-app:/app:ro -v /mnt/media/video:/media:ro \
  -v $S/proto:/proto:ro -v $S/out/x:/out \
  -e F="/media/tv/…/episode.mkv" -e TARGET_S=4 -e VERIFY_MS=20000 [-e RASL=1] \
  node:26-alpine node /proto/run.mjs
# puis : cat init-v.mp4 v-0.m4s v-1.m4s > c.mp4 ; ffprobe/ffmpeg (image linuxserver/ffmpeg)
```
