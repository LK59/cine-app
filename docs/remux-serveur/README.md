# Lumen serveur — le remux côté serveur, servi en HLS

Conception du 16/11/2026. Étapes 1 (signalisation, §154), 2 (le moteur, §155), 3 (routes et sécurité, §156),
3b (recensement, découpes d'essai et banc Safari, §157) et 3c (`cra` la règle et l'index des Cues, §158 ;
comparatif avec le lecteur actuel ; cibles courtes) faites ; seule la page de banc `/lumen-test` les appelle.
Les quatre sections jointes détaillent chaque partie, avec références `chemin:ligne` et mesures ; ce document en
tire les décisions, l'architecture et l'ordre de travail.

| Section | Contenu |
|---|---|
| [1-remuxeur.md](1-remuxeur.md) | Le remuxeur dans Node, le découpage sans état, la signalisation vidéo, un prototype mesuré |
| [2-serveur.md](2-serveur.md) | Accès aux octets, routes et jeton, proxy, cadrage, CrowdSec, cache d'index, AirPlay, charge |
| [3-client.md](3-client.md) | Aiguillage, hôte, option par appareil, comportement point par point, repli, journal, activité |
| [4-son-compat.md](4-son-compat.md) | Ce que le HLS d'Apple accepte, recensement de la bibliothèque, conversion du son, sous-titres |

## Pourquoi

Lumen remuxe aujourd'hui dans la page et nourrit une MediaSource. Sur WebKit, cela coûte :

- une page qui doit rester éveillée pour lire : en arrière-plan, écran verrouillé ou en image dans l'image, le
  JavaScript est suspendu et le tampon se vide ;
- AirPlay impossible depuis une MediaSource (le téléviseur passe par un transcodage Jellyfin) ;
- les défauts propres à MediaSource : plafond de 105 Mo par tampon sur iPhone, données retirées par le système,
  reconstructions, fil principal occupé, changement de piste audio par reconstruction ;
- le décodage TrueHD en WebAssembly et le réencodage du son sur l'appareil.

Le même remuxeur, exécuté par le serveur, peut servir du HLS fMP4 **sans état** que Safari et AVPlayer lisent
nativement : la liste est calculée depuis l'index du fichier, chaque segment est un groupe d'images remuxé à la
demande. Pas de processus ffmpeg ni de séance côté serveur, contrairement au HLS de Jellyfin : un saut coûte un
segment. C'est aussi la source naturelle d'une future application iOS native (AVPlayer ne lit que HLS ou MP4) et
d'AirPlay.

Ce qu'il ne règle pas : dans une application web posée sur l'écran d'accueil d'iOS, l'image dans l'image reste
refusée par le système (WebKit bug 303885, rdar://121964774), et le son en arrière-plan y est instable (bug
198277). Ces deux-là ne viennent qu'avec un onglet Safari ou une application native.

## Ce que les mesures ont établi

- **Le remux sans état marche dans Node** avec les briques existantes (lecture MKV/MP4, `strayUnits`,
  `isRaslPicture`, correction hvcC, muxer). Prototype sur quatre vrais fichiers : un segment de 4 s produit seul en
  3 à 234 ms (2 à 77 ms de calcul), 0,4 à 19,9 Mo lus ; des segments produits séparément puis concaténés ne
  laissent ni trou ni discontinuité (vérifié par ffprobe/ffmpeg). Pas encore lu par Safari.
- **Seul état à figer : le délai de présentation** (décalage de composition), le même pour tout le fichier, calculé
  avec la liste et porté par l'adresse des segments.
- **Le conteneur voit les médias** (lecture seule). Lire le fichier directement est 1,3 à 2 fois plus rapide que le
  relais Jellyfin à chaud, équivalent à froid.
- **Bibliothèque (10 533 fichiers)** : la piste audio par défaut passe telle quelle dans 95,4 % des fichiers,
  toutes les pistes dans 93,2 % ; au moins une piste à convertir dans 6,2 % (DTS 302, Opus 191, DTS-HD MA 149,
  TrueHD 33, MP2 6, PCM 1). Vidéo : 80 % HEVC, 20 % H.264, aucun AV1 ; Dolby Vision profil 8.1 : 478, profil 5 : 2,
  profil 7 : 0. Conteneurs : 99,8 % MKV.
- **Convertir le son coûte peu** : TrueHD 7.1 → E-AC-3 5.1 à 38× le temps réel, DTS-HD MA → E-AC-3 à 35×
  (machine chargée), soit 3 à 6 % d'un cœur par séance.

## Décisions

1. **Un quatrième chemin, pour WebKit seulement**, choisi par `choosePlayer` (`src/lib/playerRoute.ts`) là où la
   route serait `"native"`, porté par un hôte à part (`LumenServerHost`) qui assemble les pièces partagées
   (`player/server/*`, `player/session/*`, `playerClose.ts`, `PlayerControls`). Lumen dans la page reste le
   défaut ; Chrome et Firefox ne changent pas.
2. **Une option par appareil, administrateur seul** : « Remuxage serveur » dans le groupe administrateur du
   panneau Compte, `localStorage["cine:lumen-serveur"]` sur le modèle du simulateur iPad. Lue une fois par séance,
   sans écriture : les empreintes du lecteur ne bougent pas.
3. **Le jeton dans le chemin** : `/api/lumen/{itemId}/{jeton}/{version}/master.m3u8` et des URI relatives dans
   les listes. Le laissez-passer de diffusion existant (`signCastToken`) est repris avec une portée `lumen` signée,
   **revérifiée par la route** : le proxy laisse passer un laissez-passer avant de regarder le rôle, donc
   `ADMIN_ONLY_READS` seul ne suffit pas. `assertVisible` avant de servir ; `shareGate` reçoit une entrée.
4. **Noms de fichiers en `.mp4`** pour l'init et les segments, jamais `.m4s` : la règle CrowdSec
   `http-crawl-non_statics` compte `.m4s` et `.m3u8` comme noms distincts (seau de 40) et ignore `.mp4`. Peu de
   noms de listes, et jamais de 404/403/400 sur une liste.
5. **Lecture directe du fichier** depuis le disque (traduction du chemin Jellyfin vers le conteneur, un réglage),
   avec le relais Jellyfin en repli derrière la même interface d'octets.
6. **Segments** : une cible de 4 s, jamais plus court qu'un groupe d'images, jamais coupé sur une CRA suivie de
   RASL. Le remux d'un segment devient une fonction pure « segment [clé A, clé B) avec délai D », **partagée avec
   le lecteur navigateur** pour que les deux ne divergent pas. Calcul dans des `worker_threads`, file bornée.
7. **Cache d'index** sur `globalThis`, borné en octets, clé chemin + taille + mtime + inode vérifiée par `stat`,
   demandes en vol partagées. Les adresses portent la version du fichier et du format.
8. **Son, phase 1** : seulement les pistes copiables (AAC, AC-3, E-AC-3 ; FLAC et ALAC après banc). Un fichier
   dont la piste choisie ne l'est pas reste sur Lumen dans la page. **Phase 2** : E-AC-3 640 kb/s 5.1 pour toute
   source multicanal, AAC-LC 2.0 pour la stéréo, par un ffmpeg minimal épinglé et compilé pour l'image (sans
   libfdk, non libre), segments sur une grille multiple de la trame avec pré-roulement, gardés dans `data/` sous un
   plafond LRU. Pas de conversion de toute la bibliothèque à l'avance (206 Go estimés).
9. **Pistes audio dans la liste maître** : changement par `audioTracks[i].enabled`, sans renégocier. Repli :
   nouvel élément, puis rechargement de la page.
10. **Sous-titres** par `<track>` et la route existante (synchro §141, passage rejoué §150 inclus). PGS et VobSub
    restent au lecteur serveur. Jellyfin ne liste pas les sous-titres image de façon fiable : les lire dans le fichier.
11. **Repli** : avant la première image (refus, code 4, 20 s sans image), retour à Lumen dans la page ; après,
    passage au lecteur serveur Jellyfin par le rechargement direct déjà en place. Une liste par page empêche les
    boucles. **Exclu** sur une page qui a déjà servi une MediaSource : WebKit y refuse le HLS natif (code 4).
12. **Journal** : `player: "lumen-serveur"`, `path: "remux-serveur"`, mêmes lignes que les autres lecteurs. La page
    ne voit rien des requêtes HLS de Safari : la route `/api/player/log` enrichit `stop`, `stall`, `error` et
    `fallback` avec le relevé serveur de la séance (`diag.*` sous les noms de Lumen, `srv.*` pour le nouveau).
    `seances.ts` et `parts.tsx` reconnaissent le lecteur.
13. **AirPlay coupé en phase 1** (`x-webkit-airplay="deny"`, « Diffuser » passe au lecteur serveur comme
    aujourd'hui). En phase 3, l'Apple TV lit la même liste signée, `castProgress` reçoit la position de chaque
    segment vidéo.

## À corriger ou trancher avant de servir

- **`dec3()`** (`src/lib/webcodecs/mp4SampleEntries.ts`) n'écrit ni l'extension JOC ni les sous-flux dépendants :
  681 pistes Atmos seraient annoncées en 5.1, et les E-AC-3 7.1 risquent de sortir en 5.1. À corriger d'abord.
  **Fait à l'étape 1** (DECISIONS §154) : `dec3` complet sous l'option `signalling: "hls"`, chemin MSE inchangé.
- **Dolby Vision 8.x en HLS** : entrée `hvc1` avec la boîte DV et `SUPPLEMENTAL-CODECS="dvh1.08.LL/db1p"` (le
  code écrit `dvh1`, la forme MediaSource). `VIDEO-RANGE` souvent absent du MKV : le lire dans le SPS ou reprendre
  `VideoRangeType` de Jellyfin. **Fait à l'étape 1** (§154) : `hvc1` + boîte DV, `hlsVideoSignal`, VUI lu dans le SPS.
- **Son qui commence après l'image** (§148, 63 pistes) : des segments audio vides ne se fabriquent pas en copie ;
  silence devant (phase 2) ou chemin actuel.
- **Vérifier l'index coûte cher** avec le lecteur actuel (0,5 à 1,2 Mo lus par point d'index) : un lecteur qui ne
  lit que les en-têtes des blocs, et le cache par version de fichier.
- **Groupes d'images longs** : *The Exorcist* a une image clé toutes les 10,4 s, des segments de 9 à 14 s et un
  saut 4K jusqu'à 20 Mo.

## Inconnues, à lever sur un appareil Apple

RASL après un saut ; décalages de composition négatifs ; placement de `currentTime` ; segments audio vides ou
`EXT-X-GAP` ; FLAC, ALAC et Opus en HLS ; segments qui ne commencent pas sur une IDR ; `audioTracks` entre groupes
de codecs différents ; une Apple TV face à une liste VOD de 1 800 segments, à un 502 pendant un redéploiement et à
une rafale de segments après un saut.

## Ce qu'on perd, et ce qui se compense

Le cache de reprise sur l'appareil (médiane 1,5 s contre 2,0 s depuis le réseau), `MemoryReserve`, le plafond HDR,
les mesures fines du navigateur et la connexion lente §78. Compensation : préparer le fichier côté serveur dès
l'appui sur Lire (en-tête, index et segment de reprise en cache). Précharger depuis la page ne sert pas, le
chargeur de Safari ne partage pas ce cache de façon fiable.

## Charge

12 cœurs, mémoire large mais cine-app limité à 2 Gio. Un segment 4K occupe 20 à 45 Mo pendant sa construction,
environ le double au pic : file bornée, `worker_threads`, `UV_THREADPOOL_SIZE` à 8. Le disque est partagé avec
X-Ray (premier octet jusqu'à 186 ms pendant son analyse). Un déploiement en pleine séance ne casse rien si la
version du format est stable et la découpe déterministe.

## Étape 2 — le moteur (fait le 16/11/2026, DECISIONS §155)

`src/lib/lumenServer/` : appelable depuis Node, sans état entre les requêtes, appelé par rien en production.

| Pièce | Fichier | Ce qu'elle fait |
|---|---|---|
| Lecteur d'index léger | `mkvBlocks.ts`, `lumenIndex.ts` | Cues (Matroska) ou `stss`/`stts`/`ctts` (MP4), chaque clé vérifiée dans l'image par sa tête (`sketchPicture` : quelques dizaines d'octets, pas l'image) ; CRA à RASL et I H.264 à images de tête repérées |
| Découpe | `plan.ts`, `selectCuts` | Cible 4 s, jamais sous un groupe, jamais sur une clé refusée ; ne vérifie que les candidates dont elle a besoin, par lots de 16 lectures en vol |
| Segments | `segment.ts` | (fichier, piste, N, plan) → moof+mdat ; `strayUnits`, `isRandomAccessPoint`, `deriveDurations`/`assignDecodeTimes`, `mediaSegment` |
| Listes | `playlists.ts` | Maître (une variante par groupe audio, attributs de `hlsSignal.ts`), média (VOD, EXT-X-MAP, mêmes EXTINF partout) |
| Éligibilité | `eligibility.ts` | `ok` ou une raison stable |
| Cache d'index | `indexCache.ts` | `globalThis`, 32 Mo, clé chemin + taille + mtime + inode, demandes en vol partagées |
| Octets | `fileSource.ts`, `paths.ts` | Le fichier en lecture seule, derrière `ByteSource` ; `LUMEN_PATH_MAP` (vide = coupé) |
| Calcul | `pool.ts`, `jobs.ts`, `worker.ts`, `engine.ts` | File bornée (3 constructions, 256 Mo estimés, 24 en attente), `worker_threads` ou sur place |

**Écarts à la conception, et pourquoi.**
- **Noms `.m4s`** (`v/12.m4s`, `a3/12.m4s`) et non `.mp4` : décision du 16/11/2026, contre la décision 4.
- **D n'est pas dans l'adresse** : il se recalcule à l'identique depuis le fichier (premier groupe, formule du
  remuxeur), et la version du format est portée par l'adresse. Rien à faire confiance de ce que le client renvoie.
- **La fonction de segment n'est pas partagée avec le lecteur navigateur** : la consigne de l'étape interdisait de
  toucher au remuxeur. Elle appelle les mêmes briques ; deux écarts voulus (§155). La mise en commun reste à faire.
- **FLAC copié** : la spécification d'Apple le cite (2.2, 2.5, 2.25). AC-3/E-AC-3 hors 48 kHz et AAC à PCE refusés.
- **La règle RASL coûte des fichiers** : *Ted Lasso* S02E01 (segment de 51,9 s) et *2 Guns* (120 s) sont refusés
  `segment-trop-long`. Le moteur les traite pourtant sans faute (banc ci-dessous) : c'est Safari qui décidera.
- **L'index à froid coûte 3 à 14 s** sur le disque partagé (une lecture par point vérifié, plus trois derrière une
  CRA). L'étape 3 doit le lancer à l'appui sur Lire, ou le garder sur disque (`DATA_DIR`, comme `book-index.json`).
- **Le fil de calcul est empaqueté à part** : Next n'émet pas d'entrée `worker_threads` côté serveur, et le code
  TypeScript aux alias `@/` ne se charge pas tel quel. `tools/lumen-worker/build.mjs` (rolldown, déjà installé par
  vite) en fait un module ESM de 184 Ko qui tourne dans Node nu — c'est lui que le banc a utilisé. L'étape 3
  l'appellera dans le Dockerfile et passera son chemin à `workerExecutor`.

**Banc** (`lumen-engine-bench.spec.ts`, 16/11/2026, `--cpus 4 -m 3g`, X-Ray en pause) : deux fenêtres (90 s du
début, 30 s à 60 % du film) et le plus long segment avec ses voisins, vidéo et chaque piste servie, chaque segment
produit seul par un vrai `worker_threads`. Partout : **0 erreur de décodage** (ffmpeg 8.1.3, décodage complet),
**0 trou d'image, 0 discontinuité audio, 0 raccord `tfdt`**, durée des listes lue par le démultiplexeur HLS de
ffmpeg égale à la somme des EXTINF, durée produite de chaque segment vidéo égale à son EXTINF (écart 0 ms ; son :
−27 à +28 ms, moins d'une trame).

| Fichier | Index froid | Segments (méd./max) | Verdict | Vidéo ms méd./max | Lu max | Pic RSS max |
|---|---|---|---|---|---|---|
| *Jane the Virgin* S01E01, H.264 + 2 AAC | 5,6 s¹ | 384 (6 / 6 s) | ok | 15 / 36 | 5,4 Mo | 20 Mo |
| *Forsaken*, MP4 HEVC + E-AC-3 5.1 | 10,0 s¹ | 1 120 (5 / 9 s) | ok | 5 / 86 | 6,7 Mo | 22 Mo |
| *The Exorcist*, 4K DV 8.1, GOP 10 s, Atmos | 3,1 s | 860 (9,3 / 14,4 s) | ok (piste 5 refusée : finit 6 s avant l'image) | 43 / 172 | 39 Mo | 100 Mo |
| *Ted Lasso* S02E01, 4K DV 8.1, Atmos ×3, CRA+RASL | 6,1 s | 322 (5,5 / 51,9 s) | `segment-trop-long` | 39 / 349 | 52 Mo | 116 Mo |
| *2 Guns*, 4K DV 8.1, E-AC-3 7.1 (cœur AC-3) | 13,7 s | 834 (6,1 / 120 s) | `segment-trop-long` | 49 / 265 | 48 Mo | 86 Mo |

¹ avant la vérification paresseuse (tous les points lus, un à la fois) ; à chaud ensuite : 103 et 258 ms.
Signalisation vue au banc : `CHANNELS="16/JOC"` pour l'Atmos, `"8"` pour l'E-AC-3 7.1, `SUPPLEMENTAL-CODECS=
"dvh1.08.06/db1p"` + `VIDEO-RANGE=PQ` pour le DV 8.1. Sorties gardées hors du dépôt.

**Validation des listes.** `mediastreamvalidator` n'existe que sur macOS, et aucun équivalent Linux ne lit le HLS
fMP4 (muxinc/hlstools vise le MPEG-TS). Les règles d'Apple sont donc vérifiées une à une par
`lumenServer-playlists.test.ts` (1.32, 7.7, 8.1, 8.2, 8.10, 8.20, 9.1, 9.2, 9.11, 9.14, 9.15, 9.16), et le banc
fait lire listes et maître par le démultiplexeur HLS de ffmpeg. À repasser par `mediastreamvalidator` sur un Mac.

**Reste incertain avant Safari** (en plus des inconnues ci-dessous) : une CRA sans RASL et une I H.264 à point de
reprise en tête de segment (Apple écrit « MUST start with an IDR », 7.4) ; des segments de 14 s et un
TARGETDURATION de 15 ; le BANDWIDTH Matroska, majoré (toutes les pistes audio comptées) ; le NAME et le DEFAULT de
groupes audio de codecs différents (une variante par groupe).

## Étape 3 — routes et sécurité (fait le 16/11/2026, DECISIONS §156)

**Ce que l'étape 4 appellera.**

| Requête | Réponse |
|---|---|
| `POST /api/lumen/{id}/prepare` `{ audio?, position?, s? }` | à l'appui sur Lire : lance l'index puis, en arrière-plan, le segment de reprise (vidéo + piste) gardé 2 min ; répond tout de suite le verdict ci-dessous (202 `pending` si l'index n'est pas prêt) |
| `GET /api/lumen/{id}/eligibility?audio=N&s=…&wait=ms` | `{ ok: true, master, version, audioTrack, audio[], segments, durationS, targetS }`, ou `{ ok: false, reason, detail, audio[] }` (raison stable, `LumenRefusalReason`), ou 202 `{ pending: true, reason: "index-en-cours" }` |
| `GET /api/lumen/{id}/{version}/{s}/master.m3u8?audio=N` | la liste maître ; les URI relatives (`v.m3u8`, `a2.m3u8`, `init-v.mp4`, `v/12.m4s`…) héritent de `{version}/{s}` |
| `lumenPlaybackFields(s, user)` | les champs `srv.*` du relevé serveur, à ajouter aux lignes `stop`, `stall`, `error`, `fallback` |

`s` : l'identifiant de séance de la page (`[A-Za-z0-9_-]{4,64}`), sinon le serveur en tire un. `audio` : le
numéro de piste **dans le fichier** (Matroska `TrackNumber`), celui que la description du lecteur porte déjà.
Statuts : 410 adresse périmée ou inconnue (corps : `version` actuelle), 409 fichier non servi (`reason`), 503
`Retry-After: 1` occupé, 500 vraie erreur (`server.log`, une fois par minute). Jamais 404/400 pour une absence.

**Sécurité vérifiée.** Cookie administrateur exigé par chaque route (`lumenAccess`) et par le proxy
(`ADMIN_ONLY_READS`) ; compte ordinaire 403, lien de partage 403, sans session 401 ; un `castToken` sans cookie
reçoit 401 au proxy (`castItemOf` ne connaît pas `/api/lumen`) et à la route (qui ne lit aucun jeton) ;
`assertVisible` posé. Un test parcourt `src/app/api/lumen/` et échoue si une route oublie `lumenAccess` ou lit un jeton.

**Mesures** (16/11/2026, X-Ray en pause, instance jetable de l'image construite, `CINE_BACKGROUND_JOBS=off`).
- **Index à froid**, fichiers hors du cache de pages (fincore 0 sur la branche) : *The Prestige* 25,2 s
  (224 Mo lus), *Pearl Harbor* 22,7 s (108 Mo), *Black Monday* S02E10 4K 2,0 s (11 Mo). Avec le cache disque :
  246 ms pour la première requête après un redémarrage (fils lancés compris), ~20 ms ensuite (route entière).
- **Éligibilité** : *The Prestige* et *Pearl Harbor* (HEVC à GOP ouvert, 162 et 138 CRA à RASL) sont refusés
  `segment-trop-long` (208,5 s pour le premier) — la règle RASL coûte plus que les deux fichiers du banc de
  l'étape 2 ; à recenser avant l'étape 4. *The Exorcist* et *Black Monday* : `ok`.
- **Bout en bout** (*Black Monday* 4K HEVC + 2 AC-3 5.1) : maître 480 o en clair avec sa longueur, liste vidéo
  445 segments en 626 o brotli, segments 4K de 4,5 à 7 Mo construits en 20–28 ms ; ffprobe lit le maître par HTTP
  (cookie), ffmpeg décode 16 s du début et 12 s après un saut à 1 200 s sans une erreur, et les segments
  enregistrés recollés (init + 149..151) décodent sans erreur.
- **Mémoire sous rafale** (*The Exorcist* 4K DV, 20 segments vidéo distincts en même temps, 160–190 Mo servis,
  tous 200, file de 3) : RSS 282 Mo au repos, **pics de 534, 966, 661 et 621 Mo** sur quatre rafales, retour
  à ~450 Mo après vingt secondes. Le surplus vient du ramasse-miettes (tampons transférés libérés en retard),
  pas d'une fuite. Attente dans la file jusqu'à 2,8 s pour le dernier de la rafale.

**Au déploiement** : `LUMEN_PATH_MAP=/media=/mnt/media/video`, `UV_THREADPOOL_SIZE=8` (les lectures des fils de
calcul partagent les 4 fils de libuv du processus avec la compression des listes), `mem_limit` relevé à 3 Gio
pendant les essais (un pic à 966 Mo au-dessus d'un repos de ~300 Mo, en plus du reste de l'application).

**Reste incertain.** Ce que Safari et AVPlayer font d'un 410 ou d'un 503 en pleine lecture ; `http-crawl-non_statics`
sur une Apple TV qui remplit son tampon (noms `.m4s`) ; la mémoire réelle quand plusieurs lectures 4K et une
analyse X-Ray tournent ensemble ; le comportement d'un `s` partagé entre deux onglets.

## Étape 3b — recensement et banc Safari (16/11/2026, DECISIONS §157)

**La question.** La règle de découpe (`idr`, §155) refuse de couper sur une CRA suivie de RASL. Un HEVC à GOP
ouvert (défaut de x265) n'a souvent qu'une IDR en tête puis des CRA : ses segments durent des minutes et le
fichier est refusé (`segment-trop-long`). Safari et AVFoundation savent-ils démarrer un segment HLS sur une CRA
en jetant ses RASL, comme la norme le prévoit (H.265 §8.1.3) ? Sous MediaSource, non ; en HLS natif, inconnu.

**Le recensement** (`lumen-census-bench.spec.ts`, 300 fichiers, `--cpus 2 -m 2g`, médias en lecture seule, un
fichier à la fois, lots de 7 minutes séparés de 2 minutes de pause, X-Ray en pause, aucune lecture 4K en cours
au début de chaque lot). Chaque fichier passe par `buildLumenIndex` puis `lumenEligibility` (piste audio par
défaut du fichier) sous `idr` puis sous `cra`. Échantillon stratifié (au plus deux épisodes par série),
extrapolé aux 10 533 fichiers par le poids de chaque strate, intervalle à 95 % :

| Strate | Fichiers | Tirés | Servis `idr` | Servis `cra` | GOP ouvert | Plus long segment, médiane `idr` / `cra` |
|---|---|---|---|---|---|---|
| Épisodes HEVC HD | 7 411 | 110 | 53 % | 90 % | 49 % | 15,6 / 12,9 s |
| Épisodes H.264 | 1 944 | 50 | 80 % | 80 % | 0 % | 7,3 / 7,3 s |
| Épisodes HEVC 4K | 506 | 35 | 49 % | 100 % | 54 % | 37,3 / 13,6 s |
| Films HEVC 4K | 283 | 40 | 32 % | 82 % | 62 % | 89,9 / 14,3 s |
| Films HEVC HD | 258 | 35 | 49 % | 77 % | 51 % | 39,0 / 14,0 s |
| Films H.264 | 131 | 30 | 83 % | 83 % | 0 % | 13,9 / 13,9 s |

- **Servable avec la piste par défaut : 57 % ± 7 sous `idr`, 88 % ± 5 sous `cra`** (+31 points ± 6, soit
  ~3 200 fichiers). Vidéo et découpe seules : 64 % ± 7 → 99,8 % ± 0,2.
- **GOP ouvert** (au moins une CRA à RASL vue) : **40 % ± 7** de la bibliothèque, aucun H.264 ; **93 %** d'entre
  eux (108 sur 116) sont refusés sous `idr`. Parmi leurs clés vérifiées, 15 % sont des CRA à RASL (médiane ;
  6 à 35 %) : x265 en pose une à chaque intervalle de clés, et presque aucune IDR (*Don't Look Up* : 1 IDR,
  1 069 CRA).
- **Plus long segment par fichier** : sous `idr`, médiane 13,9 s mais p90 120 s, 109 fichiers au-delà de 30 s,
  le pire 3 516 s (un épisode entier en un segment) ; sous `cra`, médiane 13,8 s, p90 14,3 s, 3 fichiers au-delà
  de 30 s — deux trous dans les Cues (*Don't Look Up* 297 s, un H.264 à 136 s) et *BlackBerry* (105 s).
- **Raisons sous `idr`** (extrapolées) : `segment-trop-long` 35,5 %, `son-aac-sbr-implicite` 3,3 %, `son-codec`
  2,0 % (DTS, Opus), `son-plus-court` 1,4 %, `son-frequence` 0,4 %, `son-en-retard` 0,1 %. **Sous `cra`** :
  `son-aac-sbr-implicite` 6,3 %, `son-codec` 3,6 %, `son-plus-court` 1,4 %, `son-frequence` 0,4 %,
  `segment-trop-long` 0,2 %, `son-en-retard` 0,1 % — ce qui reste est le son (phase 2), plus la découpe.
- **Par codec** (échantillon) : HEVC 180 fichiers (93 servis `idr`, 159 `cra`, 89 à GOP ouvert), HEVC DV 8.1
  40 (12 → 35, 27 à GOP ouvert), H.264 80 (65 → 65, aucun). Son par défaut : E-AC-3 138, AC-3 87, AAC 37
  copiables ; AAC à SBR implicite 17, DTS 12, Opus 2 refusés.
- **Coût de l'index à froid** (sous `idr`) : médiane 3,1 s, p90 12,2 s, pire 39,7 s ; 17 Mo lus en médiane,
  694 Mo au pire. Sous `cra`, la seconde lecture tombe dans le cache de pages (non mesurée à froid).

**Les découpes d'essai** : `cra` (les RASL gardées dans le segment qu'ouvre leur CRA) et `cra-leading` (`cra`,
et `is_leading` dans les `sample_flags` : RASL 1, RADL 3, autre 2). Choisies par `?cut=`, portées par la
version de l'adresse (`1c1-…`, `1l1-…`), administrateur seul ; sans rien demander, rien ne change. Le chemin
MediaSource du lecteur ne change pas d'un octet : `remux-hash-bench.spec.ts` (init et 36 segments par fichier,
du début et après deux sauts) donne les mêmes empreintes avant et après sur *Ghosted*, *Ted Lasso* S02E01 et un
épisode H.264, et les empreintes du lecteur sont inchangées.

**La page `/lumen-test`** (panneau Compte → groupe administrateur → « Banc Lumen serveur ») : un titre (huit
proposés, ou un identifiant Jellyfin), une découpe, une piste ; « Préparer » donne le verdict (segments, plus
long segment, CRA à RASL), « Lire » joue la liste maître en HLS natif. Elle mesure le temps jusqu'à la première
image (`requestVideoFrameCallback`, sinon `playing`), chaque saut (`seeked`, puis le temps qui avance de
0,3 s : la reprise ; 20 s sans reprise = manqué), les blocages hors saut, les erreurs (`MediaError`), les pistes
de `video.audioTracks` et un changement de piste (rechargement, `waiting`, et « Entendez-vous la nouvelle
piste ? »), et `getVideoPlaybackQuality`. « Envoyer les résultats » écrit une ligne `kind: "lumen-test"` dans
`startup.log`, où le serveur joint pour chaque lecture ses `srv.*`, les segments son par piste et la trace des
derniers segments remis (lesquels Safari a demandés après chaque saut).

**« Tout enchaîner »** (en tête de la page) déroule le protocole ci-dessous d'un seul appui — 14 essais, ~30 minutes
estimées (plus si des index sont à construire à froid) — dans **un seul `<video>`** dont seule la source change :
l'appui lève pour cet élément la restriction du son de WebKit, et les `play()` suivants passent ; un `play()` refusé
malgré tout (`NotAllowedError`) affiche « Touchez pour continuer » et attend. Un verrou d'écran est demandé pendant
la série et redemandé au retour au premier plan (`useWakeLock`). Chaque essai : préparer, lire, attendre la première
image (sans image en 20 s : échec noté, essai suivant), 10 s de lecture, le ou les parcours, le tour des pistes
audio s'il est prévu (un changement par piste par `audioTracks`, 8 s d'observation chacun : reprise, `waiting`,
erreurs, gels), puis une ligne `kind: "lumen-test"` marquée `auto: { serie, trial, rank, of, status }`. Un essai
qui échoue n'arrête pas la série ; une ligne non envoyée (réseau, 5xx, 429) attend le prochain envoi ; « Arrêter »
ferme l'essai en cours, envoie sa ligne et s'arrête. La page relève en plus ce que l'œil voyait seul :
- **les gels** (`FreezeWatch`, `src/components/lumenTest/autoSeries.ts`) : `requestVideoFrameCallback` compte les
  images *présentées* ; si `currentTime` avance de plus d'une seconde sans image nouvelle — vérifié toutes les 2 s,
  et rejugé depuis la cible à chaque saut —, un gel est noté (`freezes` : position de la dernière image, durée
  estimée, `afterSeek`, `until`). Page cachée ou vidéo sortie de la vue : pas de jugement. Sans
  `requestVideoFrameCallback`, pas de `framesPresented` ni de gels : non cherchés, et non absents ;
- **le décodage de l'essai** : `getVideoPlaybackQuality()` à la première image et à la fin (`qualityStart`,
  `quality`, `qualityDelta` : images, perdues, corrompues) ; les `MediaError` (code et message) comme avant.

Ce que la page ne voit pas — une image *présentée* mais abîmée (verte, en blocs), et si le son a vraiment changé —
fait l'objet de deux questions en fin de série, envoyées avec chaque essai résumé dans une dernière ligne
(`auto.summary`, `trials`, `answers`). Lire une série : `jq 'select(.kind=="lumen-test" and .auto.serie=="…")'`
sur `startup.log`. Le mode manuel reste tel quel, pour refaire un essai à la main.

**Protocole, sur l'iPhone (dans l'application installée, puis dans un onglet Safari ; puis le Mac si possible).**
« Tout enchaîner » le déroule ; à la main, pour chaque lecture : Préparer, Lire, attendre la première image, « Lancer le parcours » (10 sauts), regarder
l'image à chaque reprise — **une image verte, grise, en blocs ou figée pendant que le son continue** est ce que
la page ne voit pas : la noter —, puis Arrêter. « Envoyer les résultats » après chaque titre (12 lectures au plus
gardées).

1. *À la Maison Blanche* S03E01 (H.264) — `idr` : le témoin. Temps de première image et de saut de référence.
2. *Black Monday* S02E10 (HEVC 4K, IDR seules) — `idr` puis `cra` : mêmes segments ; seule l'absence
   d'`EXT-X-INDEPENDENT-SEGMENTS` change. Si `cra` se comporte autrement, c'est la balise.
3. *American Housewife* (GOP ouvert court, servi sous les deux) — `idr`, `cra`, `cra-leading` : la comparaison
   directe sur un même fichier ; « Départ à » 600 s en plus du parcours.
4. ***Ghosted*** (DV 8.1, Atmos, GOP ouvert) — `cra` puis `cra-leading`, **deux parcours de 20 sauts chacun** :
   erreurs (code 3 = décodage), sauts manqués, images figées ou corrompues après la reprise. Puis « Piste audio
   suivante » et répondre à la question.
5. ***Pearl Harbor*** (HEVC 1080p, GOP ouvert, 132 CRA à RASL vues) — même chose que *Ghosted* : le second
   HEVC à GOP ouvert de la comparaison `cra` / `cra-leading`, sans Dolby Vision.
6. *Ted Lasso* S02E01 (DV 8.1, trois Atmos) — `cra` (refusé sous `idr`) : parcours, puis changement de piste entre
   les trois Atmos.
7. *Le Prestige* — Préparer seulement, sous `idr` puis `cra` : le verdict passe de `segment-trop-long` (208 s) à
   `son-codec` (DTS) ; il ne se lit pas avant la conversion du son.
8. *Alien : Romulus* (E-AC-3 7.1 par défaut) — `idr` : le son 7.1 en HLS natif (sur l'iPhone, réduit par le
   système ; sur un Mac relié à un ampli, vérifier les 8 canaux).

**Ce qui tranchera** : `cra` ou `cra-leading` sans erreur, sans saut manqué et sans image corrompue sur *Ghosted*
et *Pearl Harbor*, sur iPhone et Mac → la découpe retenue devient la règle (`LUMEN_FORMAT_VERSION` monte, §157).
`cra-leading` seule passe → c'est `is_leading` qui manquait. Les deux échouent → la règle `idr` reste, et ces
fichiers attendent un autre chemin (une IDR forcée par réencodage, ou le lecteur actuel).

**Résultat** (Louis, 16/11/2026, iPhone, application installée, 14 essais, 253 sauts) : 0 erreur, 0 gel, 0 image
corrompue, aucune image abîmée vue ; *Ghosted* et *Pearl Harbor* passent en `cra` comme en `cra-leading` (le HLS
natif jette lui-même les RASL ; `is_leading` n'apporte rien). Première image en 0,5 à 1,3 s. Un saut montre
l'image à la bonne position (`seekedMs`) en 0,62 s médiane (p90 1,05 s), mais la lecture ne repart (`advanceMs`)
qu'en 1,5 s médiane (p90 2,0 s) ; le serveur n'y est pour rien (construction 257 ms au pire, attente 19 ms au
pire). → `cra` devient la règle (étape 3c).

## Étape 3c — `cra` la règle, l'index des Cues, le comparatif (17/11/2026, DECISIONS §158)

**La règle.** `LUMEN_FORMAT_VERSION` passe à 2 : sans rien demander, la découpe est `cra` (toute clé de l'index,
RASL gardées), et son index se lit dans les Cues seules (`trustedCuts`) — seule la première clé est lue. `idr`
(`?cut=idr`, version `2i1-…`) et `cra-leading` (`2l1-…`) restent des essais. Un segment de plus de 30 s ne vient
plus que d'un trou dans l'index : `index-troue`. Les listes de la règle ne disent plus
`EXT-X-INDEPENDENT-SEGMENTS`. Détail, risques acceptés (Cues qui mentent : 3 fichiers sur 300) et sources :
DECISIONS §158.

**L'index à froid** (17/11/2026, fichiers retirés du cache de pages — `dd iflag=nocache` sur la branche et sur
mergerfs, `fincore` à 0 —, X-Ray en pause, un vrai fil de calcul, `--cpus 2 -m 2g`) :

| Fichier | `idr` (format 1) | `cra` vérifiée (format 1) | `cra`, index des Cues |
|---|---|---|---|
| *The Prestige* | 28,6 s · 13 656 lectures · 214 Mo | 25,1 s · 6 827 · 107 Mo | **0,17 s · 113 · 2,0 Mo** |
| *Pearl Harbor* | 25,8 s · 6 583 · 103 Mo | 23,8 s · 6 229 · 98 Mo | **0,20 s · 32 · 0,9 Mo** |
| *Black Monday* S02E10 4K | 2,2 s · 662 · 10 Mo | 2,2 s · 662 · 10 Mo | **0,14 s · 148 · 2,3 Mo** |

Mêmes coupes que la vérification sous `cra` (1 048, 1 639, 445 segments ; plus long 14,3, 14,4, 4,0 s). Le cache
disque des index (§156) reste utile pour l'essai `idr`, plus guère pour la règle.

## Ordre de travail

1. **Preuve sur appareil** : une instance jetable sert la liste et les segments d'un fichier copiable ; on l'ouvre
   dans Safari sur iPhone et Mac. Mesures : lancement à froid et en reprise, sauts, écran verrouillé, image dans
   l'image dans un onglet, comparés à Lumen dans la page. On continue ou on s'arrête là.
2. **Socle** : fonction de segment partagée avec le lecteur navigateur (empreintes inchangées), lecteur d'index
   léger, cache d'index, correctif `dec3()`, signalisation Dolby Vision. **Fait** (§154, §155), sauf le partage
   de la fonction de segment avec le lecteur navigateur (voir « Étape 2 »).
3. **Routes et sécurité** : `/api/lumen/…`, `assertVisible`, workers. **Fait** (§156) ; le jeton à portée
   `lumen` attend l'étape AirPlay, `shareGate` n'a pas d'entrée (lien refusé), les noms restent `.m4s`.
4. **Client** : option du Compte, route `"lumen"`, `LumenServerHost`, repli, journal, page d'activité.
5. **AirPlay** : liste signée vers l'Apple TV, `castProgress` par segment.
6. **Son converti** : ffmpeg minimal, grille de segments, cache disque.
7. **Débit adaptatif à la volée** : la liste maître déclare d'emblée des variantes allégées (1080p ~6 Mb/s, 720p
   ~3 Mb/s) à côté de l'originale remuxée ; le lecteur mesure son débit et bascule à une frontière de segment, sans
   coupure. Une variante n'est fabriquée (ffmpeg sur le GPU intégré) qu'au premier segment demandé, ou préchauffée
   quand les segments partent plus lentement. Images clés forcées aux frontières des segments remuxés pour que les
   variantes soient alignées ; son commun à toutes. Le flux n'est jamais remplacé sous la même liste : un en-tête qui
   change sans être annoncé est une erreur de décodage. Remplacerait à terme la bascule avec coupure de la §78.
   **Préchauffage piloté par la marge du tampon** : avec ~30 s d'avance, un débit mesuré sous le seuil *de façon
   durable* (fenêtre de tolérance et hystérésis : une micro-coupure ou une baisse courte ne déclenche rien) lance la
   fabrication de la variante ; dès que son premier segment est prêt, la bascule est faite à une frontière, et le
   tampon se remplit avec la version réduite. Une dernière mesure juste avant : si le débit est revenu, on reste sur
   l'originale ; on y remonte dès qu'il le permet. Dans Safari, la bascule reste la décision du lecteur (aucune API) :
   le serveur la rend possible et immédiate ; dans l'application native, `preferredPeakBitRate` la pilote exactement.
   **Options nouvelles, coupées par défaut** (toutes les instances n'ont pas de GPU) : le transcodage passe par
   Laterna lui-même, avec `/dev/dri` monté dans le conteneur et un ffmpeg VAAPI/QSV ; capacité détectée au démarrage et
   montrée dans la Configuration. Le même moteur ouvre ensuite d'autres variantes : HDR → SDR pour un écran SDR,
   sous-titres image incrustés (PGS sans le lecteur Jellyfin), une source que l'appareil ne décode pas (AV1 sur un
   ancien iPhone), un mode économie de données, des téléchargements hors ligne allégés.
8. **Application iOS native** : coquille, AVPlayer sur ces mêmes listes, image dans l'image, arrière-plan.

Les étapes 2 (fonction de segment) et 6 (jointures du son) sont les plus délicates : une erreur ne se voit qu'à la
lecture.
