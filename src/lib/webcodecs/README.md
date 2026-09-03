# Le lecteur expérimental

Un lecteur vidéo qui lit les fichiers de la bibliothèque **sans rien demander au
serveur** : pas de transcodage, pas de session Jellyfin, pas de HLS. Le
navigateur télécharge le `.mkv` par plages d'octets et tout le reste se passe
dans l'onglet.

Il existe parce que le transcodage serveur coûte cher, démarre lentement et
dégrade l'image. Ici le fichier part du disque tel qu'il est.

---

## Les trois chemins

Le fichier décide, pas un réglage. `pathSelector.ts` les classe et **dit
toujours pourquoi** — il n'y a aucun repli silencieux, parce qu'un lecteur qui
descend d'un cran sans le dire ressemble à un lecteur qui marche.

### 1. Remultiplexage → lecteur natif *(le chemin normal)*

Le Matroska est **repaqueté** en MP4 fragmenté dans le navigateur, puis donné à
un vrai `<video>` via MediaSource. Aucun pixel, aucun échantillon audio ne passe
par JavaScript : le navigateur décode en matériel, compose l'image lui-même,
pilote son horloge audio, et **affiche le HDR nativement**.

Les échantillons dans Matroska sont déjà exactement ce que MP4 veut — unités
d'accès HEVC/AVC préfixées par leur longueur, trames AC-3/AAC telles quelles.
**Seul l'emballage diffère.** D'où un coût quasi nul : construire un groupe
d'images prend 15 à 56 ms, contre 2 500 ms pour le télécharger.

### 2. WebCodecs → canvas *(le repli)*

Décodage logiciel image par image, rendu sur un canvas, horloge audio tenue à la
main, conversion HDR→SDR dans un shader. Sert quand le navigateur refuse un
codec dans MediaSource mais sait le décoder autrement.

### 3. Refus explicite

Aucun des deux ne peut porter le fichier : on le dit, on nomme le codec, on
s'arrête.

---

## Le chemin de remultiplexage, en détail

```
byteSource ──▶ ebml/matroska ──▶ sampleReader ──▶ remuxer ──▶ mseSource ──▶ <video>
  plages         en-tête,          échantillons     fMP4        MediaSource
  HTTP           pistes, index     bruts            fragmenté
```

### `byteSource.ts` — lire un fichier de 40 Go par le petit bout

Lectures par plages HTTP, avec cache. Analyser un conteneur champ par champ,
c'est une lecture par champ — **129 000 pour un film à 15 000 points d'index**,
mesuré. Les éléments qu'on sait petits (Tracks, Cues) sont donc lus d'un coup et
adressés en mémoire par leurs offsets absolus.

### `ebml.ts` / `matroska.ts` — l'en-tête, jamais les clusters

On lit l'en-tête, les pistes et l'index. **On ne parcourt jamais les clusters** :
sur un fichier de 40 Go ça voudrait dire le lire en entier, alors que l'index à
la fin dit déjà où vit chaque image-clé.

> **Piège** : un point d'index contient un jeu de positions **par piste
> indexée**. Prendre la première venue donne l'endroit où le *son* peut
> reprendre, presque jamais une image-clé — d'où un saut sur six qui produisait
> un segment que le navigateur détient mais ne peut jamais afficher.

### `decodeOrder.ts` — reconstruire les temps de décodage

C'est la partie difficile. HEVC et AVC **réordonnent** : une image B est décodée
après celles qu'elle référence mais montrée entre elles. Matroska ne stocke que
le temps de *présentation* ; MP4 exige les deux.

La reconstruction tient sur un fait : les échantillons sont stockés en ordre de
décodage, et **l'ensemble des temps de décodage d'un groupe est l'ensemble de
ses temps de présentation, trié**. Trier les présentations d'un groupe et les
distribuer en ordre de décodage retrouve donc la ligne de temps exactement,
pour n'importe quelle profondeur de réordonnancement, sans rien savoir du codec.

**Ça ne vaut que pour un groupe fermé par des images-clés**, là où le
réordonnancement ne peut pas traverser. `I P B b b` avec présentations
`0 4 2 1 3` donne `0 1 2 3 4` ; les trois premiers seuls trient en `0 2 4` et
décalent l'image P d'une image. C'est pourquoi le découpage en fragments a lieu
**après** ce calcul, jamais avant.

### `mp4Muxer.ts` / `mp4SampleEntries.ts` — écrire le conteneur

`ftyp`/`moov` pour le segment d'initialisation, `moof`+`mdat` par fragment.

> **Piège** : un `trun` ne stocke **aucun** temps de décodage au-delà du
> premier — les suivants sont la somme des durées. La durée écrite est donc
> **l'écart au décodage suivant**, pas la durée d'image. Identique à cadence
> constante, invisible jusqu'à un fichier 23,976 ips.

> **Piège** : le coin bas-droit de la matrice unité est en virgule fixe
> **2.30**, pas 16.16. 1,0 s'écrit `0x40000000`.

### `remuxer.ts` — le cœur

Lit les échantillons, calcule la ligne de temps par groupe, découpe en
fragments, produit les segments et les sous-titres.

- **Segments** coupés sur un point d'accès aléatoire, au moins 2 s après le
  début du précédent.
- **Fragments** bornés à **1,2 Mo / 60 échantillons** (des *chunks* CMAF).
- **Sous-titres** : les lignes de **toutes** les pistes texte sont collectées en
  une passe — elles traversent de toute façon. Changer de langue est donc un
  simple filtre, sans relecture.

> **Piège majeur, et la cause de la plupart des plantages** : Matroska marque un
> bloc comme image-clé quand il ne référence aucun autre bloc. Un encodeur peut
> parfaitement émettre une image intra qui satisfait ça alors que **les images
> décodées après elle référencent des images d'avant**. Sur un fichier réel,
> **14 des 193 images-clés annoncées** sont dans ce cas — des `TRAIL_R`, pas des
> points d'accès. Démarrer là produit un décodage qui ne peut pas aboutir :
> ffmpeg dit « Could not find ref with POC -35 » et continue sans ces images,
> **Safari répond « media failed to decode » et ferme la MediaSource**.
>
> On lit donc la première unité NAL de tranche (en passant par-dessus le SEI de
> préfixe) et on n'accepte que `BLA`, `IDR` ou `CRA` — voir
> `isRandomAccessPoint` dans `codecConfig.ts`. Quand le point trouvé est après
> la cible, le lecteur **recule dans l'index** plutôt que d'atterrir en retard.

### `mseSource.ts` — nourrir l'élément

Le plus gros fichier, et le plus disputé : c'est là que vivent tous les
comportements de navigateur.

- **`BufferQueue`** : MediaSource n'autorise **qu'une opération à la fois par
  tampon**. Tout passe par une file — cinq points d'appel non sérialisés
  suffisaient à produire un `InvalidStateError` fatal.
- **Boucle de remplissage** : vise 30 s d'avance, avec un **plancher de 8 s**
  fetché quoi qu'il arrive. Obéir sans condition à `ManagedMediaSource.streaming`
  laissait le tampon vide pour toujours quand le système disait stop.
- **Chien de garde** : si la tête de lecture n'a rien sous elle et que rien
  n'arrive, on se replace. *Un tampon vide n'est pas un lecteur égaré* — les
  plages de l'élément sont l'**intersection** des deux tampons, donc vider
  l'audio les vide toutes, et lire ça comme « infiniment loin » déclenchait des
  reprises en boucle.
- **Atterrissage** : un saut qui produit du média après sa cible pose la tête
  **sur ce média** plutôt que sur du vide — un élément média fait pareil.
- **Pause / reprise** : la position est ré-affirmée **à l'instant de la pause**,
  ce qui vide la file audio pendant que rien n'est visible. Sans ça, iOS garde
  ~0,5 s de son en avance du matériel et le restitue d'un coup à la reprise. Mais
  **une seule fois** : recaler toutes les 80 ms produit un disque rayé.
- **Maintien réactif** : Safari joue l'image **en silence** quand le tampon audio
  est vide à la tête ; Chrome cale correctement. On ne retient donc l'image que
  si elle avance réellement sans son.
- **Perte de source** : iOS reprend ses ressources média en arrière-plan et
  ferme la MediaSource. Ce n'est pas une panne à signaler, c'est un pipeline à
  reconstruire — à la position courante, jusqu'à trois fois.

---

## L'audio

`audioTranscode.ts`, et la décision dans `remuxer.ts`.

### Ce qui est livré, et comment

| Cas | Traitement |
|---|---|
| Le navigateur accepte le codec dans MediaSource | **copié tel quel**, bit-exact |
| Il le refuse mais on sait le décoder | **décodé puis ré-encodé** |
| Ni l'un ni l'autre | refus explicite |

Décodeurs logiciels : `@mediabunny/dts` et `@mediabunny/ac3` (libavcodec en
WASM, ~1,5 Mo et ~1,1 Mo, chargés paresseusement).

### Le codec de remplacement est **choisi**, pas supposé

Les deux moitiés doivent tenir : le navigateur doit savoir le **produire** *et*
le **reprendre** dans MediaSource. AAC d'abord, Opus ensuite.

- **Firefox n'encode pas l'AAC du tout**, mais encode l'Opus en stéréo *et* en
  5.1 et l'accepte dans MediaSource. Sans ce repli il perdait le chemin natif —
  et comme il ne décode pas le HEVC 10 bits en WebCodecs, il perdait la lecture
  tout court.
- **iOS n'accepte pas l'Opus** dans MediaSource, mais encode l'AAC en 5.1.

### Le codec est unifié par fichier

**La transition inter-codec n'existe pas.** Si les pistes d'un fichier ne peuvent
pas toutes être livrées telles quelles, **elles sont toutes ré-encodées**, décidé
à l'ouverture. Le codec est alors figé pour la vie de la MediaSource.

Ce n'est pas de la prudence, c'est un constat. Les **trois** façons de changer le
codec d'un tampon vivant ont été essayées sur l'appareil :

| Approche | Résultat mesuré |
|---|---|
| `changeType` | Safari accepte, puis « media failed to decode » — parfois 6 s plus tard, à la pause. Ferme la MediaSource. |
| Reconstruire la MediaSource | Détache l'élément ; Safari ne revient pas. |
| `removeSourceBuffer` + `addSourceBuffer` | **L'API marche, le résultat est inerte** : segments acceptés, plages qui grandissent, tête qui avance… et **aucun son**. Le premier saut ferme la source. |

Le code de la troisième est conservé derrière `TRUST_BUFFER_REBUILD = false`
(`pathSelector.ts`) — une ligne à basculer le jour où un navigateur tient parole.

**Coût assumé** : sur un fichier qui mélange les codecs, une piste AC-3 qui
aurait pu passer intacte est ré-encodée. Ça achète un changement de langue qui
ne peut pas casser la lecture.

> **Piège** : `decoderConfig.description` est *spécifié* comme
> l'AudioSpecificConfig nu, et Chrome le rend ainsi — mais **Safari rend tout le
> contenu de l'`esds`**. L'emballer une seconde fois donnait `mp4a.40.0` (les
> cinq premiers bits lus étaient l'octet de tag `0x03`) et **fermait la
> MediaSource**. On déballe donc l'arbre de descripteurs, et on lit ce qui est
> réellement sorti au lieu d'écrire ce qu'on a demandé.

---

## Diagnostic

Sans console sur un téléphone, **aucune de ces pannes n'était diagnosticable par
le raisonnement**. Trois outils, tous nés de ça :

- **`trace.ts`** — un déroulé horodaté de l'ouverture d'un fichier : flux ouvert,
  en-tête et pistes, chemin retenu et refus, décodeur et encodeur, MediaSource,
  segments d'init, premiers segments et ce que le tampon en a fait, chaque saut
  **et qui l'a demandé**, chaque reprise **et ce qu'elle a vu**, l'échec de
  l'élément et la fermeture de la source **à l'instant où ils arrivent**.
- **`ExperimentalPlayerReport.tsx`** — le déroulé, l'état du pipeline, les
  capacités mesurées de l'appareil et le fichier vu du serveur, en un bloc de
  texte copiable. Sur l'écran d'erreur, sous le spinner au bout de 20 s, et dans
  le panneau technique. **L'URL du flux en est exclue** : elle porte un jeton.
- **`capabilities.ts`** — ce que l'appareil accepte, *demandé* et non supposé :
  DTS dans MediaSource, encodage AAC et Opus en 2 et 6 canaux, AAC/Opus dans
  MediaSource, `AudioData`.

> **Leçon** : `video.error` (code + message) et `MediaSource.readyState` portent
> la raison d'un échec. L'événement `error` d'un `SourceBuffer` ne porte rien.

---

## Le banc de vérification

`bench.spec.ts` à la racine — ignoré par `npm test`, lancé délibérément :

```bash
docker run --rm -v "$PWD":/app -v /tmp/bench:/bench -v /mnt/media/video:/media:ro -w /app \
  -e BENCH_FILE="/media/tv/…/fichier.mkv" -e BENCH_FROM=1951 -e BENCH_COUNT=6 \
  -e BENCH_OUT=/bench/out -e BENCH_EXPECT_START=1943.3 \
  node:24-alpine sh -c "npx vitest run bench.spec.ts"
```

Puis, sur une machine avec ffmpeg : décoder `<out>.video.mp4` en exigeant zéro
erreur, et comparer **la suite des écarts entre horodatages de présentation** à
la lecture ffprobe de la source.

> **Les écarts, pas les horodatages.** Une comparaison terme à terme absorbe le
> décalage de présentation (5 images à 40 ms = les 200 ms de délai) et affiche
> fièrement « décalage constant : 0 ms » en ne mesurant rien.

C'est cette méthode qui a trouvé les quatre bugs d'origine, que les tests
synthétiques passaient tous. `raps.spec.ts` mesure de son côté la proportion de
fausses images-clés d'un fichier et ce que les refuser coûte.

---

## Limites connues

- **Pas de qualité adaptative.** Le fichier est lu tel quel : à réserver au
  réseau local.
- **Le démarrage attend le groupe d'images entier** (~5 Mo, ~2,5 s sur un lien
  ordinaire) parce que le temps de décodage du premier échantillon est la plus
  petite présentation de tout le groupe. *Idée à faire* : livrer chaque fragment
  dès qu'il est construit, en s'appuyant sur la profondeur de réordonnancement
  bornée qu'on mesure déjà. Gain estimé ~1,5 à 2 s par saut ; risque : ça rouvre
  le calcul de la ligne de temps, et l'audio est découpé contre la fin du groupe.
- **Les fausses images-clés coûtent un saut sur quatre-vingts** sur le fichier
  concerné (aucun sur les autres) : on relit alors quelques secondes d'images que
  personne ne voit.
- **Sous-titres image** (PGS, VobSub) non rendus — ils ne sont pas proposés dans
  le menu plutôt que d'y figurer sans rien faire.

---

## Carte des fichiers

| Fichier | Rôle |
|---|---|
| `byteSource.ts` | Lectures par plages HTTP, avec cache et fenêtres en mémoire |
| `ebml.ts`, `matroskaIds.ts` | Le format EBML, en-têtes et identifiants |
| `matroska.ts` | En-tête, pistes, index ; recherche de cluster par temps |
| `sampleReader.ts` | Les échantillons bruts, en ordre de décodage |
| `decodeOrder.ts` | Reconstruction des temps de décodage et des durées |
| `mp4Boxes.ts`, `mp4Muxer.ts`, `mp4SampleEntries.ts` | Écriture du fMP4 |
| `codecConfig.ts` | Chaînes de codec, et **ce qu'une image est réellement** |
| `remuxer.ts` | Le cœur : segments, fragments, sous-titres, pistes audio |
| `mseSource.ts` | MediaSource, tampons, sauts, pause/reprise, reprises |
| `remuxPlayback.ts` | Assemblage : fichier en entrée, `<video>` qui joue en sortie |
| `pathSelector.ts` | Quel chemin, et **pourquoi** |
| `audioTranscode.ts`, `softwareAudio.ts` | Décodage et ré-encodage audio |
| `capabilities.ts` | Ce que l'appareil accepte, mesuré |
| `trace.ts` | Le déroulé horodaté |
| `engine.ts`, `renderer.ts`, `audioOutput.ts`, `hdrMath.ts`, `mediaFacade.ts` | Le chemin WebCodecs → canvas |
