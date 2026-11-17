# Lumen serveur — le remux côté serveur, servi en HLS

Conception du 16/11/2026. Étapes 1 (signalisation, §154), 2 (le moteur, §155), 3 (routes et sécurité, §156),
3b (recensement, découpes d'essai et banc Safari, §157), 3c (`cra` la règle et l'index des Cues, §158 ;
comparatif avec le lecteur actuel ; cibles courtes), 3d (le son copié réparé : SBR implicite, silence, §159), 3e (la
chronologie, §160) et la **phase 2** (la conversion du son, §161 à §163, option coupée par défaut) faites ; l'étape 4
(le vrai lecteur, §180) et l'étape 4b (piste entre codecs, AirPlay, sous-titres générés, bandes noires, panneau,
§185 à §189) derrière l'option d'appareil de l'administrateur.
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
  silence devant (phase 2) ou chemin actuel. **Fait à l'étape 3d** (§159) : trames de silence aux paramètres de la
  piste, construites en copie, devant comme derrière.
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

**Le comparatif avec le lecteur actuel.** Le banc du 16/11 laissait une question : un saut serveur ne repart
qu'en 1,5 s médiane, et player.log dit ~0,43 s par saut pour le lecteur actuel — mais pas avec la même mesure.
La page `/lumen-test` joue désormais un **second lecteur**, celui de production (Lumen dans la page : remux,
MediaSource), dans le même `<video>`, sur le même titre, la même piste audio (numéro Matroska, le même espace que
la liste du serveur) et les mêmes sauts, mesuré par le même code : première image, `seekedMs` et `advanceMs`,
attentes, gels (`requestVideoFrameCallback`), `getVideoPlaybackQuality`, erreurs. Il est ouvert par ses API
publiques, comme l'hôte natif (`currentPlayer.ts` : `fetchDirectInfo`, `probePlaybackPath`, `probe.start`,
`openingHold`, `destroy`) ; un saut est `currentTime`, auquel `MseSource` répond seul. Rien du moteur ni des hôtes
n'a changé, les empreintes non plus. Ce que l'hôte fait et que le banc ne fait pas, exprès : ni cache de reprise
sur l'appareil (le serveur n'en a pas non plus), ni réserve en mémoire, ni repli vers le lecteur serveur (une
erreur du moteur est un résultat), ni ligne dans player.log.

- **Les mêmes sauts** : une graine par série (`seed`, portée par chaque ligne), et pour chaque titre et chaque
  parcours des positions tirées de la graine, du titre, du rang du parcours et de la durée du verdict serveur
  (`seekPositions`) — demandée par les deux essais.
- **L'ordre** : tous les essais serveur, puis tous ceux du lecteur actuel. WebKit refuse un HLS natif dans une
  page qui a servi une MediaSource ; recharger entre les deux permettrait d'alterner, mais ferait perdre à
  l'élément le droit de jouer avec le son donné par l'appui (un second appui au milieu de la série). Le prix : le
  lecteur actuel lit des positions que le serveur vient de lire, sur un cache de pages plus chaud — l'avantage
  est pour lui, borné par le coût disque d'un segment (257 ms au pire au banc du 16/11).
- **Les lignes** portent `player: "serveur" | "actuel"` (dans `auto` et dans chaque lecture), `pass`
  (`complète` ou `courte`) et `seed` ; le lecteur actuel y ajoute `engine` (vidéo, piste, son copié ou réencodé)
  et `openedAudio`, sans relevé serveur. La ligne récapitulative porte le tableau (`comparison`).
- **L'écran de fin** : un tableau côte à côte, par titre — première image, puis `seekedMs` et `advanceMs`,
  médiane/p90, pour chaque lecteur.

**Protocole, sur l'iPhone (application installée, puis un onglet Safari ; puis le Mac).**
- **« Comparatif rapide »** (~11 min, 9 essais) : *À la Maison Blanche* (H.264), *Black Monday* (HEVC 4K à IDR,
  et sa cible de 2 s), *Ghosted* (HEVC à GOP ouvert, DV 4K Atmos), *Ted Lasso* (DV 4K, trois Atmos), 10 sauts
  chacun, sans tour des pistes, par Lumen serveur puis par le lecteur actuel ; lignes marquées `pass: "courte"`.
  À lancer d'abord.
- **« Tout enchaîner »** (~27 min estimées, 20 essais) : les titres de l'étape 3b — les quatre ci-dessus, plus
  *American Housewife*, *Pearl Harbor* et *Alien : Romulus* —, plus *Notting Hill* ; 10 sauts chacun (20 pour
  *Ghosted* et *Pearl Harbor*) ; la cible de 2 s (serveur) sur *À la Maison Blanche*, *Black Monday* et *Notting
  Hill* ; le tour des pistes sur *Ted Lasso* côté serveur ; *Le Prestige* préparé seulement (DTS, refusé par le
  serveur) ; puis le lecteur actuel sur chaque titre lu. Compter 30 à 35 minutes réelles.
- Lire une série : `jq 'select(.kind=="lumen-test" and .auto.serie=="…")'` sur `startup.log` ; le tableau est dans
  la dernière ligne (`.comparison`).

**Les segments plus courts.** Une cible d'essai se choisit par l'adresse (`?target=2`, `{ target: 2 }` ; 2, 3 ou
6 s, 4 par défaut) : la coupe tombe sur la première clé au moins à la cible de la précédente, et la cible est dans
la version de format (`2t2-…`), donc dans chaque cache. La série complète joue en cible 2 s, serveur seul, les
titres dont les clés sont rapprochées d'après le recensement — *Black Monday* (une clé toutes les 2,0 s),
*Coup de foudre à Notting Hill* (HEVC 1080p, 1,0 s), *À la Maison Blanche* (2,6 s) —, chacun à côté de sa cible
de 4 s, sur les mêmes positions ; le comparatif rapide, *Black Monday* seul. La mesure qui compte : `advanceMs`.

**Entre `seeked` et la reprise** (banc de Louis du 16/11, `scripts/analyse-saut.mjs` hors dépôt : les 20 sauts
dont la trace serveur a gardé la rafale, recoupés avec la table des segments de chaque fichier).
- `advanceMs` compte, par construction, **300 ms de lecture** (le temps doit avancer de 0,3 s) : sur les 253
  sauts, `advanceMs − seekedMs` vaut 850 ms en médiane (p10 588, p90 1 128), donc ~550 ms d'arrêt réel après
  `seeked`. `playing` arrive en même temps que `seeked` (écart médian 0) : Safari se dit en lecture alors que
  l'horloge ne bouge pas encore. L'écart croît avec le débit : ~620 ms sur *À la Maison Blanche* et *American
  Housewife* (1080p, 1 à 4 Mo par segment), ~900 ms sur *Ghosted*, *Pearl Harbor*, *Alien : Romulus*.
- **Safari ne repart pas sur le segment du saut** : à `seeked`, 2 segments vidéo remis (médiane ; 1 à 3) ; à la
  reprise, **5** (médiane ; 3 à 11), soit ~35 s de film devant la position (12 à 76 s) et ~31 Mo (9 à 53 Mo). La
  reprise suit de ~90 ms (médiane) la remise d'un segment : c'est l'arrivée d'un segment qui la déclenche. Après
  la reprise, Safari continue d'en demander (2 à 21 dans les 3 s).
- Ce n'est ni un nombre fixe de segments, ni une durée, ni un poids : *Black Monday* (4 s, 6 à 9 Mo par segment)
  repart après 4 ou 5 segments, 12 à 19 s, 29 à 39 Mo ; *American Housewife* (1 Mo) après 7 à 11, 35 à 66 s,
  9 à 17 Mo ; *Alien : Romulus* (10 s, 10 Mo) après 3 à 5, 40 à 51 s, 31 à 53 Mo. Lecture la plus simple : le
  lecteur d'Apple remplit aussi vite que le lien le permet et ne repart que lorsqu'il juge la lecture tenable
  (« likely to keep up » d'AVFoundation, qui pèse débit mesuré et réserve) — **une réserve qu'il exige, pas la
  taille d'un segment**. Des segments de 2 s raccourcissent l'arrivée de la première image ; la réserve, elle,
  ne devrait pas suivre si elle se compte en temps ou en débit — c'est ce que l'essai en cible 2 s tranchera.
- Limites de cette lecture : la trace ne datait que la remise au réseau côté serveur (`e`), pas l'arrivée sur
  l'iPhone — les quantités « avant la reprise » sont des majorants — ; elle ne gardait que 80 segments par
  lecture (les derniers sauts seulement) ; et l'instant du geste est estimé par l'arrivée de la première requête.
  Depuis l'étape 3c, la trace garde 200 segments et porte le poids remis (`k`, en Ko).

## Étape 3d — le son copié réparé : SBR, silence, 32 kHz (17/11/2026, DECISIONS §159)

Les refus restants de l'étape 3c étaient presque tous du son ; trois se réparent **sans réencoder une trame**
(les trames du fichier restent copiées à l'octet). Code : `src/lib/lumenServer/audio/`.

**Le SBR « implicite »** (`son-aac-sbr-implicite`, 6,3 % : la première raison). Le refus venait d'un test sur
l'en-tête seul (AAC-LC à mi-fréquence du conteneur). Le flux est désormais **parcouru** (`readRawDataBlock` : chaque
élément de canaux lu jusqu'au dernier bit de ses données spectrales, livres de Huffman de FFmpeg 7.1.5 tirés par
`tools/aac-tables/`) pour trouver l'élément FIL `EXT_SBR_DATA` derrière chaque élément de canaux, comme le fait
FFmpeg ; le lecteur actuel, lui, ne le cherche pas (le décodeur du navigateur s'en charge). Trouvé sur les huit
premières trames, la configuration de l'init est réécrite en **signalisation hiérarchique** (`2B 11 88 00`,
`mp4a.40.5`, 48 kHz) : le premier type d'objet de l'init est alors celui que dit `CODECS`, sans l'ambiguïté de la
forme rétrocompatible. Constat du recensement : **les 34 pistes concernées de l'échantillon** (sur 300 fichiers)
portaient déjà une signalisation **explicite rétrocompatible** (`13 30 56 E5 98` : LC, puis l'extension 0x2B7 qui
dit « SBR présent, 48 kHz ») — conforme à la règle 2.24, mais lue `mp4a.40.2` par quiconque prend le premier type
d'objet ; aucune n'était implicite au sens strict. Les deux formes sont ramenées à la hiérarchique. Reste refusé :
un cœur mono (`son-aac-ps-implicite`, stéréo paramétrique indécidable sans décoder le SBR), un flux illisible ou
contradictoire.

**Le silence** (`son-en-retard` §148, `son-plus-court`) : des trames de silence **aux paramètres exacts de la
piste**, construites par le code — AC-3/E-AC-3 : syncinfo et `bsi()` recopiés bit pour bit d'une vraie trame,
six blocs sans mantisse (`csnroffst` = `fsnroffst` = 0), `crc1`/`crc2` ; AAC-LC : chaque élément vide puis END —,
placées sur la grille des trames ancrée sur la piste (L − k·F devant, E + j·F derrière), une trame appartenant au
segment de son instant (§155), comme la conversion de phase 2 (5-conversion-son.md §5.4) le fera par ffmpeg. Pas de
table pré-encodée (une combinaison manquante, ou un autre débit au milieu de la piste) ni de trame reprise de la
piste (rien ne garantit qu'il en existe une à zéro numérique). Reste refusé : E-AC-3 Atmos (JOC — le silence sans
charge JOC n'est pas vérifiable ici), E-AC-3 à dépendants, HE-AAC, FLAC.

**AC-3/E-AC-3 à 32 et 44,1 kHz** (`son-frequence`) : la HLS Authoring Specification ne nomme aucune fréquence ;
servis si la trame dit ce que dit le conteneur. À confirmer sur un appareil.

**Le banc sur de vrais fichiers** (`lumen-son-bench.spec.ts`, 17/11/2026, X-Ray en pause, `lumen-banc:etape2`,
ffmpeg 8.1.3 ; fenêtres de 40 s de segments son construits chacun seul, recollés derrière leur init) :

| Fichier | Piste | Réparation | Décodage (`crccheck+bitstream+explode`) | Son réel contre la référence¹ | Silence | Clic² | RMS par canal |
|---|---|---|---|---|---|---|---|
| *Glass* (film 4K) | HE-AAC 5.1 | SBR → hiérarchique | sans erreur, « HE-AAC » 48 kHz | **0** d'écart sur 4,6 M échantillons | — | — | identiques |
| *Le Dictateur* (film) | HE-AAC 2.0 | SBR | sans erreur | **0** (4,2 M) | — | — | identiques |
| *The Pitt* S01E04 | HE-AAC 5.1 | SBR | sans erreur | **0** (4,5 M) | — | — | identiques |
| *Skins* S05E05 | HE-AAC 2.0 | SBR | sans erreur | **0** (4,3 M) | — | — | identiques |
| *Seven Deadly Sins* S02E01 | HE-AAC 2.0 | SBR | sans erreur | **0** (4,5 M) | — | — | identiques |
| *The Circle* | AC-3 5.1, VF à 30,0 s | 938 trames devant | sans erreur | **0** (2,4 M) | zéros exacts | 0,006 | identiques |
| *Minuit dans le jardin…* | AC-3 5.1, à 3,76 s | 118 trames devant | sans erreur | **0** (2,2 M) | zéros exacts | 0 | identiques |
| *L'Attaque des Titans* S01E25 | E-AC-3 2.0, finit 2 s avant | derrière | sans erreur | **0** (2,4 M) | zéros exacts³ | 0,57 | identiques |
| *Lockerbie* S01E05 | AC-3 5.1, finit 5,8 s avant | derrière | sans erreur | **0** (1,9 M) | zéros exacts³ | 0,97 | identiques |
| *Bandit* (film) | AC-3 5.1, finit 5 s avant | derrière | sans erreur | **0** (1,9 M) | zéros exacts³ | 0,73 | identiques |
| *Black Butler* S01E19 | AC-3 2.0 **32 kHz**, courte | derrière | sans erreur, 32 kHz | **0** (1,4 M) | zéros exacts³ | 0 | identiques |

¹ Les trames réelles de la fenêtre, écrites en flux élémentaire (AAC en ADTS **avec la configuration d'origine**),
décodées par le même ffmpeg depuis un décodeur neuf, contre le décodage des segments à partir de la première trame
réelle : écart maximal par échantillon. Le silence devant laisse le décodeur dans l'état d'un décodeur neuf, et la
configuration réécrite rend exactement ce que rendait la découverte du SBR. Les 10 794 trames HE-AAC des fenêtres
sont toutes parcourues jusqu'à leur dernier octet, toutes avec SBR. ² Énergie de la dérivée seconde sur ±2 ms à la
jointure, rapportée aux 100 ms de son voisines (sous 1,5 : pas de clic, la mesure de 5-conversion-son.md).
³ Après la première trame de silence, qui porte le recouvrement de la dernière trame réelle (sa décroissance
naturelle). Le son couvre l'image : il commence à 0 ou une trame avant, et finit au plus une trame après la dernière
image (fichiers de test et *Titans* : 23 ms, *Lockerbie* 0, *Bandit* 6 ms ; *The Circle* garde ses 6,4 s de VF au-delà
de l'image, comme toute piste plus longue que l'image — règle de §155, inchangée).

**Le recensement relancé** (les 300 fichiers de l'étape 3b, `cra`, `LUMEN_CENSUS_CUTS=cra`, 45 s en tout, index :
médiane 110 ms, p90 299 ms, max 743 ms avec les sondes de début et de fin) :

| | Avant | Après |
|---|---|---|
| **Piste par défaut servable** (extrapolé à 10 533 fichiers, IC 95 %) | 88,0 % ± 4,5 (259/300) | **96,2 % ± 2,4** (283/300) |
| `son-aac-sbr-implicite` | 6,3 % (17) | 0 |
| `son-plus-court` | 1,4 % (4) | 0 |
| `son-frequence` | 0,4 % (1) | 0 |
| `son-en-retard` | 0,1 % (2) | 0 |
| `son-codec` (DTS, TrueHD, Opus : phase 2) | 3,6 % (14) | 3,6 % (14) |
| `index-troue` (§158) | — | 0,2 % (3) |

24 fichiers gagnés, aucun perdu. Toutes pistes confondues : 34 pistes HE-AAC réécrites, 16 complétées de silence
(AC-3 11, E-AC-3 3, AAC 2) ; restent refusées deux pistes E-AC-3 Atmos courtes (*Monkey Man*, *Super Mario Bros.*,
pistes secondaires) et un AAC à PCE (*Rocketman*). Données : `xbench/lumen-serveur/sbr-silence/`.

**Sur un appareil** (la page `/lumen-test` dit « réparée : … » à côté de la piste) : un HE-AAC réécrit (*Glass*,
*The Pitt*) — le son, le changement de piste ; *The Circle* en VF depuis 0 (30 s muettes, puis le son à sa place,
sans clic) et un saut dans le silence puis au-delà de 30 s ; la fin de *Lockerbie* S01E05 ; *Black Butler* S01E19
(AC-3 32 kHz) ; sur iPhone, Mac, et une Apple TV quand l'étape AirPlay viendra.

## Étape 3e — la chronologie d'un démarrage et d'un saut, et les leviers de démarrage (17/11/2026, DECISIONS §160)

**La question.** Le comparatif rapide du 16/11 (iPhone, application installée) laisse Lumen serveur derrière le lecteur
actuel : première image 1,08 / 0,88 s (*À la Maison Blanche*), 1,26 / 0,29 s (*Ghosted*), 1,12 / 0,35 s (*Ted Lasso*) ;
reprise après un saut 1,19 / 1,02 s à 1,75 / 1,52 s, alors que l'image du saut (`seekedMs`) est presque aussi rapide.
Les segments de 2 s n'y changent rien (1,55 contre 1,51 s). Entre l'image et la reprise : Safari qui attend une
réserve, le réseau, ou le serveur ?

**Ce que les données existantes prouvent déjà** (lignes `lumen-test` du 16/11, 18:40Z et 20:30Z, trace serveur recollée
aux sauts de la page en prenant l'arrivée de la liste maître pour l'appui ; `analyse.mjs` hors dépôt) :
- **Le serveur n'est pas le goulot** : un segment se construit en 10 à 60 ms d'ordinaire, 257 ms au pire au banc 3b,
  763 ms une fois (*Black Monday*, disque froid) ; la file n'attend presque jamais (w0–w7).
- **« Remis » n'est pas « reçu »** : la trace donne des segments de 3 à 10 Mo remis au réseau en 1 à 60 ms
  (`e1`…`e60`), soit plusieurs Gb/s — impossible jusqu'à l'iPhone. Le relais inverse ne garde rien
  (`proxy_buffering off` sur cet hôte), mais les tampons des sockets du noyau, des deux côtés du relais, tiennent
  plusieurs Mo. Les quantités « remises avant la reprise » de l'étape 3c (5 segments, ~35 s, ~31 Mo) sont donc des
  **majorants** de ce que l'iPhone avait reçu : avec elles seules, on ne sépare pas le réseau de la réserve.
- **Ce que Safari demande** : 2 à 4 segments vidéo avant `seeked`, 5 à 9 avant la reprise (médianes par titre),
  toujours en rafale, un segment vidéo et un segment son à la fois. Ni un nombre fixe (*Black Monday* : 5 en cible
  4 s, 8 en cible 2 s), ni une durée fixe (16 s à 56 s de film), ni un poids fixe (21 à 35 Mo).
- **`playing` arrive avec `seeked`** (écart médian 0) : Safari se dit en lecture alors que l'horloge ne bouge pas.
- **Les listes partent en clair** : le relais retire `Accept-Encoding` de chaque requête vers l'application
  (`proxy_set_header Accept-Encoding ""`), donc `encodePlaylist` ne compresse jamais, et le relais ne compresse que
  `text/html`. La règle 10.1 d'Apple (« MUST deliver playlists using gzip ») n'est pas tenue. ~30 Ko pour une liste de
  deux heures : pas un levier de démarrage mesurable, noté pour le jour où le relais changera.

Ce qui reste **non prouvé** : que Safari exige une réserve (et combien), qu'elle dépende du débit ou de la définition.

**La chronologie** (`src/components/lumenTest/chronology.ts`, route `GET /api/lumen/{id}/chrono`, `ChronoEntry` dans
`playbackStats.ts`) :
- **Les horloges** : cinq échanges au début de chaque essai serveur ; le serveur rend l'arrivée et le départ de sa
  réponse sur `serverClockMs` (`performance.timeOrigin + performance.now()`), la page garde le décalage de l'échange au
  plus court aller-retour (NTP). Erreur bornée par la moitié de cet aller-retour, écrite dans la ligne (`clock.rttMs`).
- **Côté serveur**, chaque requête d'une lecture marquée par ces échanges : arrivée, prête (liste écrite, init lu,
  segment construit — file et disque compris), premier et dernier morceau de 256 Kio remis, poids, préparé ou partagé,
  coupé, statut. Une lecture qui ne l'a pas demandé n'en tient rien.
- **Côté page**, chaque évènement de `<video>` (`loadstart`, `loadedmetadata`, `loadeddata`, `canplay`,
  `canplaythrough`, `play`, `playing`, `pause`, `waiting`, `seeking`, `seeked`, `progress`, `stalled`, `suspend`,
  `emptied`, `error`, `ended`), les changements de `readyState` et l'avance de `buffered` échantillonnés toutes les
  100 ms (`rs`, `buf` — une seconde de plus au moins), la première image (`requestVideoFrameCallback`), la première
  image à la position de départ, la reprise : chacun avec `readyState`, position et **avance devant la position** —
  ce qu'AVFoundation a reçu et analysé, la seule mesure de ce que l'appareil a *reçu*.
- **Le débit réel** : 4 Mo aléatoires demandés à la route `chrono` avant chaque essai, mesurés par la page (Resource
  Timing, sinon la lecture du corps) — `link.mbps`. Le serveur ne le peut pas (ses envois s'arrêtent dans les tampons).
  Son propre débit de remise (`srvMbps`) est donné, et dit pour un majorant.
- **Une cascade par démarrage et par saut**, à l'écran (« Chronologie de la dernière lecture ») et dans la ligne
  (`runs[].chrono.cascades`) : `req` — `+105 v/12.m4s r23 f25 l140 k3200` (arrivée au serveur ramenée sur l'horloge de
  la page, prête, premier et dernier morceau remis, Ko) — et `ev` — `+612 seeked rs2 a3.2` ; puis les instants
  (`firstReqMs`, `firstVideoReadyMs`, `seekedMs`, `playingMs`, `advanceMs`…), l'avance à `seeked`, à `playing` et à la
  reprise, et ce qui avait été demandé et remis avant. Le lecteur actuel a les siennes depuis Resource Timing (ses
  plages d'octets, que la page tire elle-même).
- **Le résumé d'un essai** (`chrono.summary`, tableau « Chronologie » de fin de série) : médianes de la première
  requête, du premier segment vidéo prêt, de `seeked` → reprise, de l'avance à `seeked` et à la reprise, des segments
  vidéo demandés, et la plus longue préparation du serveur.
- **Ce qu'elle ne voit pas** : l'arrivée réelle de chaque segment sur l'iPhone (seulement l'avance que `buffered` en
  montre) ; les requêtes HLS de Safari côté page — `performance.getEntriesByType("resource")` est relevé pour le
  constater (`rtLumen` ; on s'attend à 0 sur iPhone, le chargeur d'AVFoundation n'étant pas celui de la page) ; le
  décodage. **La question se tranche ainsi** : une avance à la reprise à peu près constante en secondes d'un titre à
  l'autre, avec un lien bien plus rapide que le flux, c'est une réserve exigée par Safari (et sa valeur) ; une avance
  qui suit le débit ou la définition, une politique de débit ; un premier segment prêt tard, le serveur ; une avance
  qui monte au rythme du lien mesuré, le réseau.

**Les leviers de démarrage**, chacun un mode d'essai (`src/lib/lumenServer/trials.ts` ; rien ne change sans eux — ni
liste, ni segment, ni adresse ; les empreintes du lecteur non plus) :
- **(a) le son par défaut dans les segments vidéo** (`mux=1`) : la version de l'adresse porte `m1` après la découpe (`2m1-…`, `3m1-…` sous le format 3), la liste
  maître ôte l'URI de la piste par défaut et sa variante lit `vm{N}.m3u8` ; l'init a deux `trak` ; un segment
  `vm{N}/{k}.m4s` est fait des deux segments de la règle (construits et préparés comme eux), fragments entrelacés par
  instant de décodage et renumérotés. Une liste, un init et un segment de moins avant la première image. **Ce que
  disent les spécifications** : RFC 8216 §4.3.4.2.1, une piste AUDIO sans URI est dans les segments de la variante,
  les autres pistes du groupe gardent la leur — la forme exacte de l'essai ; §3.3, un init peut porter une `trak` par
  piste des fragments. Mais la spécification d'auteur d'Apple le déconseille : 9.5 « You SHOULD deliver video and
  audio as separate streams », 9.6 « If you have multichannel audio, you MUST use separate audio streams », 9.7 pour
  les autres langues (2.17, une seule piste son par segment, est tenue). Un essai contre une règle d'Apple, donc,
  pour chiffrer le prix des requêtes séparées. Vérifié : init + trois segments d'une fixture décodés par ffmpeg sans
  erreur (144 images, son entier).
- **(b) la préparation précoce** : `POST …/prepare` (index, segment de départ et son pendant audio gardés deux
  minutes), puis 5 s avant Lire (`EARLY_DELAY_MS`) — `prep` ; `fiche` : en plus, la source posée sur la vidéo avec
  `preload="auto"` pendant ces 5 s (Safari charge listes, init et premiers segments). Le temps de la première image
  part de l'appui sur Lire ; une image présentée avant ne compte pas.
- **(c) le départ à la bonne position**, pour une reprise : `saut` (la règle d'aujourd'hui : `currentTime` à
  `loadedmetadata`), `ext-x-start` (`?start=` sur la liste maître : `EXT-X-START:TIME-OFFSET=…,PRECISE=YES`, RFC 8216
  §4.3.5.2 — la spécification d'Apple n'en dit rien) et `fragment` (`#t=` sur l'adresse). Mesuré par la première
  image *à la position demandée* (`targetFrameMs`), à côté de la toute première image.
- **(d) le débit annoncé** (`?bw=moyen`) : BANDWIDTH à la moyenne plutôt qu'à la crête — un écart à RFC 8216
  §4.3.4.2, d'essai seulement : AVFoundation pèse peut-être le débit annoncé contre le débit mesuré avant de repartir.
  D'autres leviers viendront de la chronologie elle-même (taille du premier segment, nombre de requêtes avant
  l'image) ; les listes compressées n'en sont pas un ici (voir plus haut).

**L'équité du comparatif.** « Ordre des lecteurs » : *Lumen serveur d'abord* (l'ordre de l'étape 3c), ou *Lecteur
actuel d'abord* — tous ses essais, puis la page se recharge (WebKit refuse un HLS natif après une MediaSource), et
« Touchez pour continuer » rend à la vidéo le droit de jouer avec le son ; la série (rang, résultats, graine, lignes en
attente) passe le rechargement dans sessionStorage (`cine:lumen-test-serie`, une heure au plus). Les lignes portent
`auto.order`. Jouer les deux ordres sépare l'effet du cache disque plus chaud de celui du lecteur.

**Protocole, sur l'iPhone (application installée).**
- **« Comparatif rapide »** (~13 min estimées, 12 essais) : les quatre titres témoins en 10 sauts par chaque lecteur,
  plus le son multiplexé (5 sauts) et la préparation précoce (3 sauts) sur *Ghosted* et *Ted Lasso*, les deux titres
  à l'écart de première image le plus grand. La cible de 2 s de *Black Monday* en est sortie (elle a répondu). À
  jouer dans les deux ordres.
- **« Leviers de démarrage »** (~10 min estimées, 14 essais, Lumen serveur seul) : témoins *Black Monday*, *Ghosted*, *Ted
  Lasso* (5 sauts) ; le départ à 600 s par saut, `EXT-X-START` et `#t=` sur *Black Monday* et *Ghosted* ; la fiche
  ouverte 5 s avant sur *Ghosted* et *Ted Lasso* ; le débit annoncé moyen sur *Black Monday* et *Ghosted* ; le son
  multiplexé sur *À la Maison Blanche* (H.264, stéréo).
- **« Tout enchaîner »** inchangé (~28 min estimées), avec la chronologie.
- Lire les cascades : `jq 'select(.kind=="lumen-test" and .auto.serie=="…") | .runs[0].chrono'` sur `startup.log` ; le
  résumé de chaque essai est dans `.trials[].chrono` de la ligne récapitulative.

**Limites.** L'horloge vaut à la moitié de l'aller-retour près (quelques ms sur le Wi-Fi de la maison, ~30 ms en
roaming) ; `buffered` est échantillonné toutes les 100 ms et à chaque évènement ; la chronologie serveur garde 800
requêtes par lecture ; une cascade porte au plus 48 requêtes et 60 évènements.

## Étape 3f — le son multiplexé, une passe qui tranche

**La question.** Le levier a de l'étape 3e — le son par défaut dans les segments vidéo (`mux=1`, `trials.ts`) — fait-il
démarrer ou repartir Lumen serveur plus vite, et sans rien casser ? La passe « leviers » du 16/11 ne l'a essayé qu'une
fois (*À la Maison Blanche* : image 0,48 s, image au saut 0,60 s, reprise 1,25 s), sans témoin sur le même titre, et le
débit mesuré de l'iPhone y allait de 23 à 100 Mb/s d'un essai à l'autre : rien de concluant. Et la spécification d'auteur
d'Apple le déconseille (9.5 SHOULD des flux séparés ; 9.6 et 9.7 MUST pour le multicanal et les autres langues) : la passe
doit aussi montrer que rien ne se dégrade.

**Le plan** (`MUX_SERIES`, `src/components/lumenTest/autoSeries.ts` ; bouton « Son multiplexé », Lumen serveur seul,
24 essais, ~18 min estimées — la passe « leviers » a pris 4 % de moins que son estimation) :
- **quatre titres**, chacun à deux pistes de langues différentes : *À la Maison Blanche* S03E01 (H.264 1080p, AC-3 2.0),
  *Coup de foudre à Notting Hill* (HEVC 1080p à IDR seules, AC-3 5.1 — le multicanal multiplexé, ce que 9.6 interdit),
  *Ghosted* (4K Dolby Vision 8.1, E-AC-3 Atmos, ~53 Mb/s en moyenne), *Pearl Harbor* (HEVC 1080p à GOP ouvert, sans DV) ;
- **chaque titre six fois de suite** : la règle (A) et le multiplexé (B) trois fois chacun, en **A-B-B-A-A-B** (une dérive
  linéaire du réseau pèse autant sur les deux modes), **en miroir un titre sur deux** (B-A-A-B-B-A) : aucun segment n'est
  gardé par le serveur, seul le cache de pages les garde, donc le premier essai d'un titre est le seul à lire sur un
  disque froid — ce désavantage tombe ainsi deux fois sur chaque mode ;
- **les mêmes six sauts dans les six essais d'un titre** (`seekPositions(graine, titre, 0, …)`), ce qui permet la
  comparaison position par position ; 3 s de lecture avant le parcours, 3 s après chaque saut ;
- **le débit mesuré juste avant chaque essai** (l'échantillon de 4 Mo de l'étape 3e, après la lecture de la liste
  maître), dans le tableau de fin ; un essai sous **max(30 Mb/s, 1,5 × le débit moyen annoncé du titre)** est signalé ⚠ ;
- **par essai** : première image, `seekedMs` et `advanceMs` de chaque saut, la cascade de la chronologie, erreurs, gels,
  blocages, images perdues et corrompues.

**Les contrôles de non-régression.**
- **La piste entendue au départ** : la page lit la liste maître de l'essai (une fois par titre et par mode, sous un
  identifiant de lecture jetable, hors chronologie) et compare la piste allumée de `audioTracks` (langue et étiquette)
  au rendu DEFAULT du groupe de la variante en tête — en multiplexé, le rendu sans URI. La liste lue dit aussi si elle
  est bien multiplexée, et le débit annoncé (AVERAGE-BANDWIDTH).
- **Le changement de piste** : un par essai multiplexé, et un témoin (rendu à rendu) dans le premier essai de la règle
  de chaque titre, vers une piste d'une autre langue (`switchTarget` : un changement qui s'entend), observé 6 s —
  reprise, `waiting`, erreurs, gels, la piste allumée à la fin (`applied`), et **les segments de la nouvelle piste que
  la page a vus arriver** (`segs`) : la preuve que Safari a quitté le son des segments vidéo pour un rendu séparé.
- **Les pistes annoncées** identiques dans les six essais d'un titre.
- Ce que la page ne sait pas, deux questions de fin : « avez-vous entendu l'autre langue ? » (oui, parfois, non) et « la
  voix était-elle en phase avec les lèvres ? » (partout, décalée en multiplexé seulement, décalée partout).

**Le verdict** (`src/components/lumenTest/muxPass.ts`), par titre et par mesure — première image, image au saut, reprise
(par essai, la médiane de ses sauts) : les médianes des deux modes, l'écart, et **« multiplexé plus rapide (ou lent) de
X ms » seulement si les trois répétitions d'un mode sont toutes plus rapides que les trois de l'autre** (sous
l'hypothèse d'aucune différence, une fois sur dix) **et** l'écart d'au moins 50 ms ; sinon « pas de différence au-delà du
bruit », avec l'écart et la dispersion (la plus grande étendue des deux modes). Pour la reprise, en plus, le compte des
positions où le multiplexé est le plus rapide (médianes par position, six positions). En tête de l'écran de fin, la
synthèse sur les quatre titres ; sous chaque titre, chaque essai avec son débit, et les contrôles de chaque mode. La même
analyse part dans la ligne récapitulative (`.mux`), avec les deux réponses (`.answers.audioChanged`, `.answers.lipSync`).

**Ce que Safari montre à la page.** Les lignes du 16/11 comptent 82 à 153 entrées Resource Timing par essai pour les
adresses de Lumen serveur : Safari expose à la page les requêtes HLS d'AVFoundation, ce que l'étape 3e croyait
impossible. Chaque cascade d'un essai serveur (toutes passes) porte donc désormais l'**arrivée réelle de chaque segment
sur l'appareil** (`rx` : `+105 v/12.m4s l240 k3200` — début vu par la page, durée jusqu'au dernier octet, Ko), le premier
segment vidéo reçu en entier (`firstVideoRecvMs`, colonne « seg. reçu ») et les segments vidéo reçus avant `seeked` et
avant la reprise (`recvSeeked`, `recvAdvance`) ; chaque lecture, les segments reçus par rendu (`chrono.rtSegs` :
`{"vm2": 40, "a3": 4}`). Sans ces entrées (un autre moteur), rien ne change.

**Protocole, sur l'iPhone (application installée), puis le Mac si possible.** « Son multiplexé », le son audible ;
écouter le changement de langue des essais multiplexés et regarder les lèvres ; répondre aux deux questions, puis
« Envoyer le bilan ». Lire la passe :
`jq 'select(.kind=="lumen-test" and .auto.pass=="multiplexé" and .auto.summary) | .mux' startup.log` ; un essai :
`jq 'select(.auto.serie=="…" and .auto.trial=="ghosted-serveur-mux-r2") | .runs[0]'`.

**Ce qui tranchera** : multiplexé plus rapide de manière nette (répétitions séparées) sur la première image ou la reprise
d'au moins trois titres, sans régression ni réponse négative → l'essai mérite d'aller sur Mac et Apple TV avant d'être
discuté contre la règle d'Apple ; sinon le levier part avec `trials.ts`, et les groupes son séparés restent la règle.

## Phase 2 — conversion du son (17/11/2026, DECISIONS §161 à §163)

Les pistes que Lumen serveur ne copie pas — DTS, DTS-HD MA, TrueHD, Opus, MP2, MP3 — sont converties **en E-AC-3** au
serveur (640 kb/s 5.1, 256 kb/s 2.0), au fil de la lecture, par un ffmpeg minimal de l'image. La conception et ses
mesures sont dans [5-conversion-son.md](5-conversion-son.md) ; ce qui suit est ce qui a été construit et mesuré.
Code : `src/lib/lumenServer/audio/` ; outil : `tools/ffmpeg-lumen/`.

**L'option est coupée par défaut.** Configuration → Lecture → « Conversion du son (Lumen serveur) » (« Lab bêta ») :
à qui elle est ouverte (`LUMEN_AUDIO_CONVERT` : `off`, `admins`, `tous`), les processus simultanés, les lectures
admises, le cache en mémoire et sur le disque ; sous la carte, l'état de ffmpeg (« ffmpeg 7.1.5 détecté : E-AC-3, AC-3,
AAC, FLAC », ou pourquoi la conversion est indisponible), les lectures qui convertissent, l'occupation du cache, les
24 dernières heures. Sans l'option, ou sans ffmpeg, Lumen serveur répond comme avant (`son-codec`). Déploiement :
`LUMEN_FFMPEG_PATH` (vide = pas de conversion), `LUMEN_AUDIO_CACHE_DIR` (un autre volume que `data/`).

**Le chemin d'un segment converti** (`convert.ts`). Les trames cibles du segment (la trame k de 1 536 échantillons
porte l'instant k·N, et appartient au segment qui contient son instant), la fenêtre de l'encodeur (deux trames de
pré-roulement, son délai de 256, trois de queue) ; le fil de calcul lit les blocs de la piste (`audio-feed`, sur ses
deux fils à lui) et rend le flux élémentaire et la position exacte de son premier échantillon ; ffmpeg décode,
`atrim`/`adelay`/`apad` posent la fenêtre à l'échantillon (des zéros avant le premier son et après une piste courte),
`pan` replie (la règle de `fold`), l'encodeur E-AC-3 encode ; Node garde les trames du segment et les mux avec
`tfdt` = k × 32 000 µs + D. Une fenêtre entièrement dans le silence ne lit rien du fichier. **Le placement** se fait
par le nombre d'échantillons (DTS, MPEG, Opus : l'arrondi de l'instant du bloc sur la trame du codec ; TrueHD : le
compteur de chaque unité, arrondi aux synchronisations majeures — l'instant Matroska de *Braveheart* garde 55 ms
d'avance sur le compte) ; le pré-roulement du décodeur est de 0,25 s, **1 s pour l'Opus** ; le MP2 et le MP3 sont
décodés **en flottants** (les décodeurs en entiers de FFmpeg tramaient leur sortie selon la trame de départ).

**Le cache** : en mémoire (512 Mo) puis sur le disque (`DATA_DIR/lumen-audio`, 10 Go, LRU), clé : version de l'adresse,
piste, cible, identité de la conversion (`cid` : règles, version et empreinte de ffmpeg), segment ; enveloppe vérifiée
par SHA-256, écriture atomique. Louis voulait la RAM : le cache disque y est déjà, en pratique — **le cache de pages de
Linux** garde en mémoire ce qu'on vient d'écrire ou de lire (un segment relu au disque : 2 à 4 ms au banc), sans
compter dans la mémoire de l'application et rendu au système dès qu'il en a besoin.

**La file et l'avance** : 2 processus ffmpeg (`LUMEN_AUDIO_MAX_JOBS`) ; la demande d'un segment passe devant l'avance
et prend la place d'une avance en cours ; 120 s converties devant le dernier segment demandé, par tâches de 60 s
(`nice` 15), arrêtées deux minutes après la dernière requête ; la préparation (`prepare`) convertit le segment de
reprise en priorité de demande. **L'admission** : au-delà de 6 lectures qui convertissent (`LUMEN_AUDIO_MAX_SESSIONS`),
d'une attente des demandes de plus d'une seconde (p90 sur 60 s) ou d'une charge de plus de 3 par fil, l'éligibilité
répond `son-serveur-occupe` et le lecteur actuel prend le titre.

**Les listes** : une piste convertie entre dans le groupe `ec-3` avec la VF copiée, `CHANNELS` 6 ou 2, `LANGUAGE`,
`NAME` d'après ce qui est servi ; son nom porte l'identité de la conversion (`a3x1a2b3c4d.m3u8`) — un autre ffmpeg est
une autre adresse. `LUMEN_FORMAT_VERSION` passe à 4. Le relevé (`srv.*`) gagne `convSeg`, `convBuilt`, `convRam`,
`convDisk`, `convShared`, `convMs`, `convMaxMs`, `convWaitMaxMs`, `convBusy`.

### Le banc sur de vrais fichiers (`lumen-audio-bench.spec.ts`, 17/11/2026)

Le binaire de l'image (étape `ffmpeg-lumen`), X-Ray en pause, `--cpus 2`, médias en lecture seule. Par piste : 10
segments consécutifs construits chacun par son propre processus, contre la même plage en une seule tâche ; un segment
refait ; un segment loin dans le film à froid contre le même dans une tâche de trois (le saut) ; le décodage de la
concaténation (`crccheck+bitstream+explode`) contre la source décodée par ffmpeg depuis le début de la piste et
repliée par le même `pan` (intercorrélation, RMS par canal).

| Piste | Trames identiques (seuls / tâche) | Déterm. | Saut | Placement | RMS sortie − source | Segment seul (méd.) |
|---|---|---|---|---|---|---|
| *Braveheart*, TrueHD Atmos 7.1 → 5.1 | 2 123 / 2 123 | oui | identique | 0 éch. (1,000) | 0,00 dB (LFE −0,14¹) | 319 ms |
| *Le Prestige*, DTS-HD MA 5.1 | 2 222 / 2 222 | oui | identique | 0 (0,999) | ±0,01 dB | 212 ms |
| *Interstellar*, DTS-HD MA 5.1 | 2 174 / 2 174 | oui | identique | 0 (1,000) | ±0,01 dB² | 117 ms |
| *Lost in Translation*, DTS 5.1 | 2 633 / 2 633 | oui | identique | 0 (1,000) | ≤ 0,07 dB | 182 ms |
| *House* S01E08, Opus 5.1 | 1 789 / 1 789 | oui | identique | 0 (1,000) | ±0,01 dB | 86 ms |
| *JoJo* S01E01, Opus 2.0 → E-AC-3 2.0 | 2 725 / 2 725 | oui | identique | 0 (1,000) | ±0,01 dB | 104 ms |
| *Good People* S01E01, MP2 2.0 | 1 348 / 1 348 | oui | identique | 0 (1,000) | 0,00 dB | 45 ms |
| *The Leftovers* S01E01, MP3 2.0 | 1 922 / 1 922 | oui | identique | 0 (1,000) | 0,00 dB | 56 ms |

¹ Le filtre à 120 Hz du LFE de l'encodeur, sur un LFE presque muet. ² Les ambiances d'*Interstellar* à −88 dBFS
s'écartent de 1,4 à 2,5 dB : la quantification de l'encodeur à ce niveau. Le décodage de chaque concaténation est sans
erreur ; le « rapport de clic » aux jointures (dérivée seconde sur ±2 ms) est celui de la source aux mêmes échantillons
à 0,4 près au pire — les octets étant ceux d'un encodage continu, il n'y a pas de jointure. **L'ordre des canaux**
(tonalités marquées, sans fichier) : 7.1 → FL 300, FR 400, FC 500, LFE 60, SL 700+900, SR 800+1000 ; 5.1 et
5.1(side) tels quels, `acmod` 7 + LFE dans les deux cas (le piège du PCE ne touche pas l'E-AC-3) ; 3.0 → L R C, le reste
silencieux ; mono → les deux canaux. **La synchro image-son** : la VF E-AC-3 de *Braveheart* passée par la chaîne de
conversion contre sa copie de la phase 1, posées à leur `tfdt` : 0 échantillon d'écart. **Une piste en retard** (*The
Circle*, VF AC-3 à 30 s, passée par la chaîne) : le son à sa place (0 échantillon), avant lui ce que rend un décodeur
AC-3 sur des trames encodées depuis des zéros exacts (son tramage, sauf le LFE).

### La charge (17/11/2026, `--cpus 4 -m 3g`, X-Ray en pause)

N conversions en boucle (segments au hasard de *Braveheart* TrueHD, *Le Prestige*, *Lost in Translation*, *JoJo*)
pendant que le moteur sert les segments 4K de *Black Monday*, une requête à la fois :

| Processus | Segments convertis en 40 s | Segment (méd. / p95) | dont ffmpeg / lecture | Processeur du conteneur | Pic mémoire | Segment vidéo 4K (méd. / p95) |
|---:|---:|---|---|---:|---:|---|
| 0 | — | — | — | 1,0 cœur | 502 Mo | 49 / 75 ms |
| 1 | 88 | 401 / 1 063 ms | 140 / 203 ms | 2,0 | 560 Mo | 52 / 78 ms |
| 2 | 171 | 383 / 1 168 ms | 139 / 217 ms | 2,9 | 611 Mo | 50 / 77 ms |
| 4 | 239 | 556 / 1 576 ms | 160 / 360 ms | 3,2 | 639 Mo | 56 / 92 ms |
| 8 | 234 | 1 286 / 2 428 ms | 169 / 1 080 ms | 3,2 | 626 Mo | 53 / 92 ms |

- **Le premier essai** faisait lire les blocs du son sur les trois fils du remux et dans sa file : à quatre conversions,
  le segment vidéo passait de 65 à 2 156 ms (p95). Le son a maintenant ses deux fils à lui (`lumenFeedReader`) : le
  remux n'en sent plus rien. Et la lecture partait 2 s trop tôt : elle part maintenant de la coupe juste avant la
  fenêtre.
- **Ce qui coûte, c'est la lecture des blocs**, pas ffmpeg : une piste TrueHD range une unité de 40 échantillons par
  bloc (1 200 blocs par seconde).
- **Retenu : 2 processus** (`LUMEN_AUDIO_MAX_JOBS`) — un segment reste à ~0,4 s, quatre processus n'ajoutent que 40 %
  de débit pour 45 % de latence, huit rien ; **6 lectures** (`LUMEN_AUDIO_MAX_SESSIONS`) — en continu, une lecture
  demande un segment toutes les 4 à 6 s, six en prennent ~1,2 par seconde sur ~4,3 : le reste est la marge des sauts.
- **Avec X-Ray en marche** (une mesure, quatre processus, avant la séparation des fils) : ffmpeg passe de 70 à 120 ms
  en médiane (p95 575 ms) ; la file et l'admission (p90 de l'attente) le voient.
- **Mémoire** : le pic du processus de banc (moteur, fils, ffmpeg compris) reste sous 640 Mo ; un ffmpeg en prend 5 à
  13 Mo ; le cache en mémoire ajoute au plus son plafond (512 Mo). Dans les 3 Go du conteneur, avec le pic de 966 Mo du
  remux 4K mesuré à l'étape 3 : pas de réglage de déploiement à changer.

### Les leviers de lancement (la question de Louis, 17/11/2026)

**Le coût de lancement d'un ffmpeg** (le binaire statique de l'image, 20 répétitions) : `ffmpeg -version` seul, 2,6 ms
(p90 3,2) — la création du processus et le chargement du binaire. Pour une fenêtre d'une seule trame cible, le premier
octet rendu par un processus lancé à l'instant, contre le même lancé 300 ms plus tôt et qui attendait ses données :

| Entrée | Lancé à l'instant (méd. / p90) | Pré-lancé (méd. / p90) | `-probesize 32 -analyzeduration 0` |
|---|---|---|---|
| DTS-HD MA (*Le Prestige*) | 6 / 7 ms | 6 / 7 ms | 6 ms, mêmes octets |
| DTS (*Lost in Translation*) | 4 / 4 ms | 3 / 5 ms | 3 ms, mêmes octets |
| TrueHD 7.1 (*Braveheart*) | 9 / 23 ms | 8 / 10 ms | 8 ms, mêmes octets |
| Opus (*JoJo*) | 5 / 5 ms | 5 / 5 ms | 4 ms, mêmes octets |
| f32le (l'encodeur seul) | 2 / 2 ms | 1 / 2 ms | 2 ms, mêmes octets |

Rien n'est sondé inutilement (`-f` explicite ; réduire la sonde ne change ni le temps ni les octets) ni lu (aucun
fichier de configuration, environnement vide). Le lancement coûte **1 ms** ; le reste du premier octet est le décodage
du pré-roulement.

**Le pool de ffmpeg pré-lancés** (`ffmpegPool.ts`) a été écrit et mesuré quand même : un processus pré-lancé ne peut
porter que des arguments connus d'avance, donc la conversion passe par deux processus génériques (un décodeur par
format, un encodeur par cible) et Node pose la fenêtre entre les deux (`windowPcm`) — **mêmes octets** que la voie à un
processus (10 sur 10 par piste). Le premier segment converti disponible (`LumenAudio`, 10 positions tirées au hasard
par piste, des sauts imprévus) :

| Piste | (a) à froid, sans pool | (b) à froid, pool | (c) 300 ms après `prepare` | (d) mémoire / disque | saut pendant l'avance |
|---|---|---|---|---|---|
| *Le Prestige* (DTS-HD MA) | 215 / 278 ms | 180 / 254 ms | 0 / 0,1 ms | 0 / 2,5 ms | 507 / 855 ms |
| *Lost in Translation* (DTS) | 214 / 309 ms | 245 / 338 ms | 0 / 57 ms | 0 / 4,4 ms | 352 / 475 ms |
| *Braveheart* (TrueHD 7.1) | 569 / 848 ms | 652 / 1 388 ms | 390 / 770 ms | 0,1 / 3,8 ms | 699 / 961 ms |
| *JoJo* (Opus 2.0) | 83 / 200 ms | 98 / 179 ms | 0,1 / 0,1 ms | 0 / 1,5 ms | 119 / 228 ms |

(médiane / p90). **Le pool n'est pas adopté** (`POOL_DEFAULT = false`) : il gagne 35 ms sur une piste, en perd 15 à
80 sur les trois autres — le PCM qui traverse Node coûte autant que le lancement qu'il épargne. Il reste un mode
d'essai (`convPool=1`, la passe « Son converti » de `/lumen-test`). **La conversion n'est pas sur le chemin critique
quand la page prépare** : 300 ms après `prepare`, le segment de reprise est déjà là, sauf en TrueHD (390 ms restants
en médiane) ; ensuite l'avance de 120 s couvre la suite, et un segment relu sort de la mémoire en 0,1 ms ou du
disque en 2 à 4 ms. Reste sur le chemin critique **le saut imprévu** : 0,1 à 0,7 s selon le codec, pendant que l'avance
tourne (elle cède sa place). Sur l'iPhone, une reprise après un saut prend déjà 1,5 s (étape 3c) ; à mesurer sur
l'appareil (la passe « Son converti »).

### Le recensement (les 300 fichiers de l'étape 3b, `cra`, extrapolé aux 10 533 fichiers, IC 95 %)

| Piste par défaut servable | Conversion coupée | Conversion en service |
|---|---|---|
| Part de la bibliothèque | 96,2 % ± 2,4 (283/300) | **99,8 % ± 0,2** (297/300) |

14 fichiers gagnés (3,6 % ± 2,3 : la piste par défaut DTS, TrueHD ou Opus), 31 pistes converties en tout ; aucune piste
non convertible dans l'échantillon. Restent `index-troue` (3 fichiers).

### Sur un appareil

À écouter sur l'iPhone (puis le Mac relié à du 5.1), l'option ouverte aux administrateurs, page `/lumen-test`, passe
**« Son converti »** (~10 min) : *Le Prestige* et *Interstellar* (DTS-HD MA → 5.1), *Braveheart* VO (TrueHD Atmos 7.1
replié en 5.1), *JoJo* (Opus → 2.0), chacun sans puis avec le pool (ordre alterné), avec sauts ; le tour des pistes de
*Braveheart* entre la VF copiée et la VO convertie. Écouter : les voix au centre (l'ordre des canaux du décodeur d'Apple
sur ces trames n'a jamais été entendu), le son à sa place après chaque saut, aucun clic, le niveau en passant de la VF
(dialnorm de la piste) à la VO convertie (dialnorm −31).

### Pour la bascule en cours de lecture (étape 4, non faite)

L'éligibilité d'une lecture qui convertit rend `conversion: { state: "ok" | "tension", leadS }` — l'avance convertie
devant le dernier segment demandé, « tension » sous 30 s pendant que des demandes attendent ; un segment converti
« occupé » répond 503 `Retry-After: 1` avec `X-Lumen-Son: occupe`, compté au relevé (`srv.convBusy`). L'hôte client
devra : relire l'éligibilité sur un `waiting` de plus de 3 s (ou recevoir l'état dans la réponse du battement de
progression), préparer le lecteur actuel sur un second `<video>` à l'état « tension », et basculer HLS → MediaSource
(jamais l'inverse, WebKit le refuse) ; la ligne `fallback` portera `why: "son-serveur-occupe"`.

## Étape 4 — le vrai lecteur, derrière une option (17/11/2026, DECISIONS §180)

**Ce qui est en place.** Panneau Compte → groupe administrateur → « Lecteur expérimental : remux serveur » (par
appareil). Allumée sur un appareil WebKit (iPhone, iPad, Safari sur Mac), une lecture du cinéma passe par Lumen serveur
quand le serveur dit oui pour la piste que le lecteur actuel aurait ouverte ; sinon le lecteur actuel, sans un mot.
Coupée, rien ne change : les empreintes du lecteur sont identiques.

| Pièce | Fichier |
|---|---|
| L'option, la page sans MediaSource, les titres rendus | `src/lib/lumenServerChoice.ts` (`lumenWanted`) |
| La route `"lumen"` | `src/lib/playerRoute.ts`, `src/components/PlayerHost.tsx` |
| L'hôte | `src/components/player/lumen/LumenServerHost.tsx` |
| Ses décisions pures | `lumenOpening.ts` (piste d'ouverture, numéros Jellyfin ↔ Matroska, liste maître ↔ `audioTracks`), `lumenLog.ts` |
| Les sous-titres | `GET /api/lumen/{id}/pistes` → `subtitleTrackFacts` (la liste du lecteur serveur) |
| Le levier (1) | `src/lib/lumenSheetPrepare.ts`, appelé par `usePlaybackPrefetch` |
| Le relevé serveur dans player.log | `src/app/api/player/log/route.ts` (`srv.*`) |

**Ouverture.** Description, état du spectateur, verdict et sous-titres en parallèle ; la piste par la règle du lecteur
actuel (`preferredOpeningTrack`) sur les pistes servies — si la langue du compte n'existe qu'en DTS/TrueHD, le lecteur
actuel, qui les décode ; puis `<video src="master.m3u8?audio=N#t=<reprise>" preload="auto">`. La liste maître est
relue par la page en arrière-plan : c'est le seul lien sûr entre le menu et `video.audioTracks`.

**Redémarrage du serveur.** Un déploiement ne casse pas une lecture : après la première image, une erreur de l'élément
ou une horloge figée 35 s relisent le serveur toutes les 3 s pendant 90 s au plus ; tant qu'il ne répond pas, on attend
(et rien n'est touché si Safari repart seul) ; une autre version de la liste (segments en 410) est rouverte à la
position, ligne `rebuild` avec `fromVersion`/`toVersion`.

**Réglages serveur.** `LUMEN_MUX_AUDIO=1` (environnement du conteneur) : l'essai du son multiplexé dans les segments
vidéo (`m1`) pour les lectures de l'application. Coupé par défaut, non prouvé.

**Ce qui manque encore**, voulu ou à reprendre (AirPlay, « Générer des sous-titres », les bandes noires et le
changement de piste entre codecs sont faits à l'étape 4b ; « Améliorer les dialogues » rend la main au lecteur actuel) : le plafond HDR, la version
allégée sur connexion lente, le cache de reprise sur l'appareil, les pistes que le serveur ne sert pas (conversion du
son, étape 6 — elles passent au lecteur serveur).

**À éprouver sur l'iPhone** (application installée, puis Safari sur Mac) :
1. Compte → groupe administrateur → allumer « Lecteur expérimental : remux serveur ».
2. Ouvrir la fiche d'un titre en cours (*Black Monday* S02E10, *Ghosted*), attendre une seconde, Lire : l'image à la
   position de reprise ; Activité → la séance porte « Remux serveur », sa ligne `start` `resumeBy: fragment` et
   `prepared: ok`.
3. Sauts à la barre, ±10 s, pause et reprise ; le passage rejoué (−10 s) montre ses sous-titres.
4. Changer de piste son : entre deux pistes du même format (*Ted Lasso*, trois Atmos), sans rechargement ; vers un
   autre format (AC-3 ↔ AAC), la page se recharge et reprend sur la piste — ligne `audio` `via` à lire.
5. Sous-titres : un forcé, un complet, deux sous-titres ; « À l'écran », une question, « Jusqu'ici ».
6. Verrouiller l'écran une minute en pleine lecture : au retour, en pause 3 s avant.
7. Fin d'épisode : la carte de l'épisode suivant, qui s'ouvre aussi par Lumen serveur.
8. Pendant une lecture, un déploiement (ou `docker restart cine-app`) : la lecture attend puis reprend, ligne
   `rebuild` ; aucun `fallback`.
9. Un titre que le serveur ne sert pas (*Le Prestige*, DTS) : le lecteur actuel s'ouvre, ligne `fallback`
   `to: natif`, `planned: true`.

## Étape 4b — piste entre codecs, AirPlay, sous-titres générés, bandes noires, dialogues (17/11/2026, DECISIONS §185 à §189)

Sur le vrai lecteur (`LumenServerHost`), toujours derrière l'option d'appareil de l'administrateur. Le lecteur de
production ne change pas : empreintes identiques, rien pour les comptes sans l'option.

### 1. Le changement de piste entre codecs, sans rechargement (§185)

**Ce que dit Apple.** HLS Authoring Specification for Apple Devices, annexe « Audio rendition groups and variants » :
« Create one audio group for each pair of codec and channel count. **Each group needs to have every language in
it.** » ; « Generally speaking, **the player doesn't switch between audio codecs** » (sauf entre variantes AAC, entre
sans perte et AAC, et vers une sortie Spatial Audio) ; et la variante est répétée par groupe (« you want each codec to
be associated with every variant »). RFC 8216 §4.3.4.1.1 : des groupes du même type « MUST have the same set of
members ». rfc8216bis §4.4.6.2 : le `CODECS` d'une variante liste « every media format in any of the renditions » de
son groupe — un groupe peut donc mêler les codecs.

**Ce qu'on servait** (formats 1 à 4) : un groupe par codec et une variante par groupe — la forme d'Apple sans sa
condition, puisque nos langues n'existent chacune que dans un codec (VF AC-3, VO E-AC-3). Changer de langue, c'était
demander au lecteur de changer de variante pour une sélection de piste. Safari annonçait pourtant les pistes des deux
groupes dans `audioTracks` (*American Housewife*, AC-3 2.0 + E-AC-3 5.1, journal de `/lumen-test` du 16/11).

**Ce qu'on sert** (format 5) : **un seul groupe**, toutes les pistes, une seule variante dont le `CODECS` les liste
toutes. Un fichier à un seul codec garde sa liste à l'octet près. 15 % des fichiers ont des pistes de plusieurs codecs
(recensement : AC-3 + E-AC-3 702, AAC + AC-3 260, AC-3 + DTS 222, AAC + E-AC-3 119).

**Dans l'hôte** : `audioTracks[i].enabled` d'abord, la piste allumée relue 2 s après ; sinon **la liste rouverte dans
la page** : même élément, `?audio=N#t=<position>`, `prepare` lancé juste avant, l'image d'avant figée par-dessus jusqu'à
la nouvelle. Plus de rechargement de la page. Ligne `audio` : `via` (`audioTracks`, `réouverture`), `tookMs`,
`pictureMs`, `frozen`, `first`, `processing`.

**Pas de banc WebKit Linux** pour la réouverture : WebKitGTK lit le HLS par GStreamer, pas par AVFoundation.

### 2. AirPlay (§186)

L'élément porte l'adresse munie d'un laissez-passer dans le chemin (`…/{lecture}/tv.{jeton}/master.m3u8`), que le
bouton AirPlay tend au téléviseur ; les URI relatives des listes en héritent. Jeton à part de `castToken` : sa clé,
sa portée `lumen`, un administrateur, un titre, une lecture, la session vivante, six heures. Proxy et route posent la
même question (`lumenTvPassFor` / `verifyLumenTvPass`) ; une requête avec cookie passe en plus le contrôle ordinaire.
Chaque segment vidéo demandé sans cookie donne sa position au relais (`castProgress`). Avec un sous-titre affiché,
« Diffuser » passait au lecteur serveur ; depuis §191, un sous-titre de texte va au téléviseur dans le flux (section 8).

### 3. « Générer des sous-titres » (§187)

La génération du lecteur natif (`SubtitleGeneration`, §70), telle quelle : menu, demande avec la position, sondage,
messages d'état. Ses lignes passent par le calque de sous-titres de la page tant qu'il n'y a pas de fichier ; à la fin,
la liste des sous-titres est relue et la piste générée devient un `<track>`, choisie à sa place.

### 4. L'ajustement aux bandes noires (§188)

`useFrameFit` posé sur l'élément comme dans le lecteur natif (deux cadres, interrupteur dans les commandes s'il y a un
agrandissement à défaire, rien en mini-lecteur).

### 5. « Améliorer les dialogues » (§188) : aucune des deux voies maintenant

Web Audio sur l'élément HLS natif : WebKit n'y fait pas passer le son sur iPhone (sonde 8.39.0, §68), et un contexte Web
Audio est suspendu en arrière-plan — ce que ce chemin est venu régler. Une piste convertie côté serveur avec le
traitement : le traitement validé est en TypeScript, avec une mémoire de plusieurs secondes, alors qu'un segment doit
être une fonction du fichier — un pré-roulement et une preuve de jointure à faire, toutes les pistes copiées à convertir.
Fait à la place : le réglage choisi dans ce lecteur rend la lecture au lecteur actuel à la position, et `lumenWanted`
décline ce chemin tant que le réglage est allumé sur l'appareil.

### 6. Le panneau technique, le journal (§189)

Le panneau « Infos de lecture » de cet hôte (`describeLumenServerPlayback`, `src/lib/lumenPanel.ts`, quatre langues) :
« Remux serveur (HLS) », la version de format, la découpe, les segments et la cible, la piste et sa livraison (copiée,
réparée, convertie et vers quoi), les segments reçus par l'appareil et le débit de réception (Resource Timing), le
relevé du serveur pour la lecture (`/api/lumen/{id}/chrono?stats=1` : segments servis, volume, construction, file, son
converti), AirPlay, et les incidents de la séance (relances, réouvertures, changements de piste, AirPlay). Les panneaux
des autres lecteurs n'ont pas bougé (`playbackPanel.ts` intact). Au journal, chaque geste a sa ligne : `start`,
`opening`, `seek`, `audio` (`via`, `tookMs`, `pictureMs`), `cast` et `fallback` `cast: true` (AirPlay), `fallback`,
`rebuild`, `stall`, `error`, `stop` ; l'activité affiche la méthode d'un changement de piste à côté de son traitement.

### 7. Les sous-titres dessinés par la page (§190)

Jusqu'ici la piste choisie était un `<track>` en `showing` : Safari la dessinait lui-même, collée au bas de l'image,
dans son style, sous les commandes. Désormais les `<track>` ne servent plus qu'à charger les répliques — toujours posés
après la première image de l'élément (un `<track>` présent quand l'adresse HLS est posée fait refuser l'élément, code 4)
— et sont en `hidden` : le navigateur les charge sans rien dessiner. `useLumenSubtitleLines` lit la réplique à l'instant
de l'élément moins le décalage du menu (`cueLookupTime`, la règle du lecteur natif) et l'écrit dans `SubtitleLayer`,
avec le style des sous-titres et la rangée écartée des commandes affichées (`chromeEdges`) — comme le lecteur natif.
Un seul chemin pour un sous-titre, deux sous-titres et l'aide d'un passage rejoué (§150) ; une génération en cours garde
sa voie (§187). Les décalages (±0,5 s, principal et second) sont tenus par l'hôte et ne touchent plus aux répliques des
`<track>` ; la correction d'une piste recalée (§141) est déjà dans le WebVTT (`&sync=`). AirPlay inchangé : avec un
sous-titre choisi, « Diffuser » passe au lecteur serveur, qui le porte au téléviseur. **À regarder sur l'iPhone** : la
ligne au-dessus des commandes quand elles sont là, redescendue quand elles partent ; le style du réglage « Sous-titres » ;
une ligne qui suit bien la parole après ±0,5 s ; deux sous-titres ; un retour −10 s ; une piste son changée (réouverture).
Le PiP système ne montre pas les sous-titres de ce chemin (comme le lecteur natif : rien n'y est dessiné par Safari).

### 8. AirPlay avec sous-titres : un rendu WebVTT dans la liste maître (§191)

**Ce qui manquait.** L'Apple TV (comme un téléviseur AirPlay d'une autre marque) ne reçoit que l'adresse de la liste
maître et lit le flux elle-même : les sous-titres de ce chemin, dessinés par la page (section 7), n'y allaient pas, et
« Diffuser » avec un sous-titre affiché passait au lecteur serveur (un transcodage Jellyfin, sous-titre incrusté).

**Ce qu'on sert.** `master.m3u8?st=<index Jellyfin>` : la liste de la règle, plus **un** rendu
`TYPE=SUBTITLES,GROUP-ID="subs"` (DEFAULT=YES, AUTOSELECT=YES, FORCED=YES pour un forcé, NAME de `trackLabel.ts`, URI
relative — le jeton `tv.…` s'hérite) et `SUBTITLES="subs"` sur la variante. Sa liste `s{index}h{empreinte}.m3u8` a les
EXTINF de la vidéo ; chaque segment `s{index}h{empreinte}/{n}.vtt` porte
`X-TIMESTAMP-MAP=MPEGTS:round(D × 90 000),LOCAL:00:00:00.000` (les segments fMP4 présentent l'instant du fichier plus
D) et les répliques qui le recoupent, entières — une réplique à cheval est dans les deux segments. Le texte est le
WebVTT que Jellyfin tire de la piste, synchro §141 appliquée. Texte seulement ; sans `st`, la liste du format 5 à
l'octet près. Format **6**.

**Dans l'hôte.** « Diffuser » avec un sous-titre de texte reste sur Lumen serveur ; dès la route établie, la liste est
rouverte sur le même élément, à la position, avec `?st=` (les `<track>` retirés avant l'adresse, rendus à l'image) ;
changer de sous-titre pendant la diffusion rouvre avec le nouveau, le retirer rouvre sans. La piste du flux est mise
en `showing` pendant la diffusion (la sélection que WebKit passe au téléviseur), `disabled` partout ailleurs ; le calque
de la page se tait pendant que le téléviseur dessine. Ligne `cast` `reason: "sous-titres au téléviseur"`, `subtitles`,
`st`, `tookMs`, `pictureMs` ; panneau : « Sous-titres au téléviseur ».

**Pourquoi seulement pendant la diffusion.** Dans la page, rien n'a prouvé qu'un rendu de sous-titres ne fait pas
refuser l'élément (code 4, comme les `<track>` posés avec l'adresse) ni que Safari ne le dessine pas sous le calque.
Le banc le dit avant qu'on s'y fie : `/lumen-test` → levier « sous-titres dans la liste » (`?st=premier`, la première
piste de texte du titre).

**À éprouver, dans cet ordre** (option Lumen serveur allumée sur l'iPhone) :
1. **Le banc, sur l'iPhone, sans AirPlay.** `/lumen-test`, mode manuel, un titre avec des sous-titres de texte (*Ted
   Lasso* S01E08), levier « sous-titres dans la liste » allumé, Lire. Attendu : l'image comme sans le levier (pas de
   code 4), et au journal `textTracks` avec une piste `subtitles` du flux. « Envoyer les résultats », puis lire :
   `jq -c 'select(.kind=="lumen-test") | .runs[]? | select(.mode=="st") | {firstFrameMs, errors, textTracks}' startup.log`.
   Si la piste est `showing` et que Safari dessine des sous-titres sur l'image : noter, c'est sans conséquence pour
   l'application (elle ne pose `st` qu'en diffusion et éteint la piste), mais à dire.
2. **Apple TV, un sous-titre complet.** Lecture dans l'application, sous-titre français choisi, « Diffuser » → l'Apple
   TV. Attendu : la télévision joue à la position **avec** le sous-titre, calé sur la parole (une réplique ni en avance
   ni en retard — c'est `X-TIMESTAMP-MAP` qui est éprouvé) ; le téléphone reste sur Lumen serveur (aucune ligne
   `fallback`). Journal : `cast` « diffusion établie », puis `cast` « sous-titres au téléviseur » avec `subtitles` et
   `pictureMs`.
3. **Changer pendant la diffusion.** Depuis le téléphone : un autre sous-titre (anglais), puis aucun. Attendu : la
   télévision suit en quelques secondes, à la position, sans sortir d'AirPlay ; une ligne `cast` par changement. Si la
   route AirPlay tombe à la réouverture (`fallback` « fin de diffusion » juste après), le dire : c'est le risque
   principal de ce choix.
4. **Un forcé.** Un film en VO avec forcés français (le choix automatique les prend) : les forcés sur la télévision.
5. **Le centre de contrôle.** Route AirPlay prise depuis le centre de contrôle avec un sous-titre affiché : même
   résultat qu'au point 2.
6. **Un téléviseur AirPlay d'une autre marque**, s'il y en a un sous la main : le sous-titre s'affiche-t-il ? (Ces
   récepteurs n'ont souvent pas de menu de pistes ; DEFAULT=YES est leur seule indication.)
7. **Fin de diffusion.** Arrêter AirPlay : la lecture continue sur le téléphone, sous-titres par le calque de la page,
   rien dessiné par Safari en dessous.

### Un défaut vu en production le 16/11 au soir : *Mr. Robot* S01E03, « code 4 » avant l'image

Première lecture réelle sur l'iPhone de l'administrateur (10.46.0) : refus de l'élément 336 ms après l'adresse posée,
repli propre sur le lecteur actuel en 0,6 s. Le journal d'accès du relais montre que Safari a lu la liste maître, la
liste vidéo, puis la liste maître encore — **sans demander la liste son ni l'init** : le refus vient de ce que disent
les listes, pas des octets. Rejoué ici depuis le fichier (lecture seule) : rien d'anormal dans les listes (CODECS
`hvc1.2.4.H120.90,ec-3`, `TARGETDURATION` 14 pour un plus long segment de 14,18 s), sauf **`BANDWIDTH=33881422`**
(segment 159 : 22 Mo en 5,2 s) pour une moyenne de 2,5 Mb/s — le plus haut débit de crête de tous les titres déjà lus,
au-dessus du plafond du niveau HEVC annoncé (niveau 4, palier haut : 30 Mb/s). *Pearl Harbor*, même profil et même
niveau à 18 Mb/s de crête, joue. Hypothèse, non prouvée : AVFoundation écarte une variante dont le débit annoncé dépasse
ce que le niveau permet, et sans autre variante, refuse la source. **À trancher sur l'iPhone** : `/lumen-test`, mode
manuel, *Mr. Robot* S01E03 (`d9bff9f6b05cddb47542385563d2a732`), une fois tel quel, une fois avec « débit annoncé moyen »
(`?bw=moyen`). Si la seconde joue, la règle à écrire est de borner le `BANDWIDTH` annoncé au plafond du niveau (et la
version de format monte). Depuis 4b, la ligne `fallback` d'un refus d'avant l'image porte `seen` : ce que Safari a
demandé, dans l'ordre, avec la durée et la taille.

### Le refus code 4 dans l'app (17/11/2026)

**Ce qu'on sait.** Sur l'iPhone de l'administrateur (application installée, iOS 27.3, 10.47.0), **toutes** les lectures
réelles par Lumen serveur sont refusées par l'élément avant l'image : code 4, message vide, 0,2 à 0,5 s après l'adresse
posée — cinq titres sur cinq (*Mr. Robot* S01E03, *Ted Lasso* S01E08, *L'Odyssée*, *Bridget Jones*…), au début comme en
reprise, dans une page fraîchement ouverte où aucune MediaSource n'a servi. Le repli vers le lecteur actuel est propre.
Au même moment, `/lumen-test` sur le même iPhone lit les mêmes listes (format 5) sans faute, au début comme à 1 116 s,
avec deux changements de piste par `audioTracks`. Le relais inverse dit la différence : l'application fait lire
`master.m3u8` deux fois, puis `v.m3u8`, puis `master.m3u8` encore — **ni liste son, ni init, ni segment** ; le banc lit
`master.m3u8` une fois, puis `v.m3u8`, `a2.m3u8`, les init et les segments. Les listes elles-mêmes sont saines et de
même taille (691 octets pour les deux *Ted Lasso*), le `BANDWIDTH` n'y est pour rien, le laissez-passer `tv.{jeton}` non
plus (même schéma en 10.46.0, avant lui). Toutes les requêtes portent l'agent de Safari et l'origine de la page : le
chargeur d'AVFoundation passe par celui de WebKit (c'est pour cela que Resource Timing les voit), le relais ne sépare
donc pas la lecture de la page de celle de l'élément.

**Ce que l'hôte fait de plus que le banc**, relu dans le code : la page lit la liste maître elle-même (`fetch`, le lien
menu ↔ `audioTracks`) juste avant le rendu qui pose l'adresse ; `preload="auto"` ; `autoplay`, `x-webkit-airplay`,
`load()` après `src =` ; des `<track>` de sous-titres ; l'adresse munie du laissez-passer. L'effet qui pose l'adresse ne
rejoue pas sur le même élément (ses dépendances sont stables, la clé de l'élément ne change qu'à une relance, et un code 4
n'en déclenche pas) ; `PlayerHost` ne remonte pas l'hôte (une seule `eligibility` par lecture au relais). Le lecteur
serveur (`ActivePlayer`) a, lui, `autoplay`, `x-webkit-airplay`, `load()` et les `<track>` sur un HLS natif qui marche :
ce qui n'appartient qu'à l'hôte Lumen, c'est la lecture de la liste par la page et `preload="auto"` — les deux premiers
suspects, sans preuve. Aucune cause n'est assez sûre pour corriger à l'aveugle.

**La passe « Comme l'app »** (`/lumen-test`, `appLikePass.ts`) tranche sur l'appareil. Sur un titre (le champ du titre,
sinon *Ted Lasso* S01E08), au début, piste par défaut, un élément neuf par variante, 15 s au plus chacune (verdict : la
première image par `requestVideoFrameCallback` ou `loadeddata`, ou le code et le message de l'erreur, ou rien) :
le témoin (ce que fait le banc), chaque levier seul (`fetch`, `preload`, `attrs`, `tracks`, `tv`), tous ensemble (ce que
fait l'hôte), tous sauf un, puis le témoin de nouveau (s'il échoue alors, la page a changé en cours de passe). Le son
reste allumé ; si iOS refuse `play()` sans geste, l'élément passe muet (`play: "muet"`). Une ligne `kind: "lumen-test"`
par variante (`appLike` : variante, leviers, verdict, ms, code, message, et `seen` — ce que Safari a demandé), puis un
bilan (`appLike.summary`) dont `cause` nomme le levier fautif, la combinaison nécessaire, ou « tout passe » — alors ce
n'est aucun geste de l'hôte, mais le document du cinéma. Environ une minute.

**Le `seen` de la ligne `fallback`** était toujours vide dans l'application : le tampon Resource Timing de la page garde
250 entrées, et celui du cinéma est plein d'affiches bien avant le film. Depuis, l'hôte écoute dès son montage
(`watchLumenRequests`, un `PerformanceObserver` limité à `/api/lumen/`, et le tampon porté à 1 500) ; `MediaError.message`
part dans `mediaError` quand Safari en donne un (il était vide sur les cinq refus).

**Sur l'iPhone** : `/lumen-test` → « Comme l'app » → attendre la ligne en gras. Lire :
`jq -c 'select(.kind=="lumen-test" and .appLike) | .appLike | {variant, levers, outcome, ms, code, play, seen, cause}' startup.log`.
Puis une lecture réelle dans l'application : la ligne `fallback` porte désormais `seen`.

### Protocole, sur l'iPhone puis l'Apple TV (l'option allumée sur l'appareil)

1. **Changement de codec, sans rechargement.** `/lumen-test` → « Changement de codec » (~8 min, son audible) : quatre
   titres, chacun sous la règle et sous l'ancienne forme. Entendre chaque nouvelle piste. Lire la passe :
   `jq 'select(.kind=="lumen-test" and .auto.pass=="codecs") | .runs[0] | {trial: .trial, audioSwitches}' startup.log`.
   Ce qui tranche : la règle (un groupe) appliquée partout (`applied: true`), sans `reloaded`.
2. **Dans le vrai lecteur.** *The Mandalorian* S01E01 (VF AC-3, VO E-AC-3) : changer de piste en lecture, puis en
   pause. Attendu : la nouvelle langue en moins de 2 s, sans écran noir ni recharge ; ligne `audio` `via: "audioTracks"`
   (ou `réouverture` avec `pictureMs` et `first` — dire laquelle).
3. **AirPlay.** Pendant une lecture, « Diffuser » → choisir l'Apple TV. Attendu : la télévision joue à la position, le
   téléphone devient télécommande ; ligne `cast` « diffusion établie ». Verrouiller le téléphone 5 minutes : la
   télévision continue, et la position avance chez Jellyfin (ligne `cast` `serverRelay: true`). Arrêter depuis le centre
   de contrôle : ligne `fallback` « fin de diffusion ». Avec un sous-titre affiché : la section 8 (§191).
4. **Générer des sous-titres.** Un titre sans sous-titres anglais : menu sous-titres → « Générer » → anglais. Attendu :
   « Préparation des sous-titres… », puis les lignes ; à la fin, la piste « généré » choisie, sans coupure.
5. **Bandes noires.** Un film en 2.39 avec bandes incrustées : l'interrupteur dans les réglages, l'image agrandie.
6. **Dialogues.** Réglages → « Améliorer les dialogues » → Améliorer : la lecture repasse au lecteur actuel à la
   position (ligne `fallback` `planned: true`) ; tant que le réglage reste allumé, Lumen serveur ne s'ouvre plus.
7. **Panneau.** Infos de lecture : « Remux serveur (HLS) », format 5, `cra`, segments reçus qui montent, le relevé du
   serveur ; après un changement de piste par réouverture ou un AirPlay, la ligne d'incident.
8. ***Mr. Robot* S01E03** : le test du paragraphe précédent.

## Étape 4c — Chromecast (17/11/2026, DECISIONS §192)

**Ce qui change.** Avec l'option « Lecteur expérimental : remux serveur » allumée **sur l'appareil qui émet**, une
diffusion vers un Chromecast charge sur le récepteur l'adresse Lumen serveur du titre au lieu du flux de Jellyfin :
la vidéo remultiplexée telle quelle (mêmes init et segments que la page), le son en AAC. Sans l'option, rien ne change :
pas une requête de plus, le récepteur reçoit le flux de Jellyfin.

**Pourquoi l'émetteur décide seul.** Le Chromecast ne s'émet que de Chrome ou d'Edge (ordinateur, Android), où Lumen
serveur n'existe pas dans la page (HLS natif de WebKit, §180) : aucune lecture Lumen ne passe jamais la main à un
Chromecast. Le récepteur, lui, lit une adresse — le lecteur de la page n'y est pour rien. L'aiguillage est donc
`lumenCastWanted` (l'option, lue une fois par séance par `lumenChoiceFor` ; ni banc, ni extrait, ni hors ligne) puis le
verdict du serveur pour un récepteur (`eligibility?cast=1`). Le panneau Compte le dit sur Chrome (« Une diffusion vers
un Chromecast passe, elle, par le remux du serveur »).

**Ce qu'un récepteur lit** (documentation de Google, « Supported Media » et « Streaming protocols », lue le 17/11/2026) :

| Modèle | Vidéo | Son par Lumen serveur |
|---|---|---|
| Chromecast 1re et 2e gén. | H.264 High ≤ 4.1 (1080p30) | AAC |
| Chromecast 3e gén. | H.264 High ≤ 4.2 (1080p60) | AAC |
| Chromecast Ultra | H.264 ≤ 4.2, HEVC Main/Main10 ≤ 5.1 (4K60), HDR10, Dolby Vision | AAC |
| Chromecast avec Google TV | H.264 ≤ 5.1, HEVC Main/Main10 ≤ 5.1 (4K60), HDR10 | AAC |
| Google TV Streamer | H.264 ≤ 5.2, HEVC Main/Main10 ≤ 5.1, AV1 | AAC |

- **Le son, toujours en AAC.** Le récepteur lit le HLS par MediaSource ; Google ne cite l'AC-3/E-AC-3 qu'en
  « passthrough » vers un ampli, et le récepteur de Jellyfin n'annonce que `aac` pour du HLS fMP4 (« MSE rejects …
  AC-3/E-AC-3 there », `codecSupportHelper.ts`) — c'est aussi ce que §122 a vu (un E-AC-3 copié accepté sans jamais
  lire). Un AAC du fichier est **copié** (`a{N}`, mêmes octets que pour la page) ; tout le reste — DTS, TrueHD, Opus,
  MP2/MP3 **et** AC-3/E-AC-3 — est **converti en AAC-LC stéréo 192 kb/s** (`TARGET_CAST_AAC`), sous l'option de
  conversion existante (`LUMEN_AUDIO_CONVERT`, coupée par défaut). Coupée : seuls les titres dont la piste choisie est
  en AAC passent par Lumen serveur, les autres gardent le flux de Jellyfin (`son-codec`, « chromecast : … »). Le repli
  en stéréo suit la règle de `fold` (G = L + C·√½ + Ls·√½ (+ Lrs·½), le LFE laissé de côté), comme l'échelle de §122.
- **La vidéo, telle quelle.** H.264 Baseline/Main/High ; High 10, 4:2:2 et 4:4:4 refusés (`castVideoRefusal`). Le
  HEVC est tenté : un récepteur qui ne le lit pas (1re à 3e gén.) refuse le chargement ou reste sans image, l'émetteur
  repasse au flux de Jellyfin (H.264 transcodé) et retient ce récepteur pour la page (`hevc=0` aux titres suivants). Un
  Dolby Vision 8 garde son `dvvC` dans l'init : le récepteur lit la couche de base (HDR10 ou SDR) ; une entrée `dvh1`
  est refusée. Le kit de l'émetteur ne dit pas le modèle : c'est l'essai, une fois par récepteur et par page, qui le
  dit.

**L'adresse et le jeton.** `/api/lumen/{titre}/{version}/{lecture}/cc.{jeton}/master.m3u8?audio=N` — la forme du
`tv.{jeton}` d'AirPlay (§186), sous **sa propre portée** (`k: "lumen-cc"`, `signLumenCastPass`) : les bornes d'AirPlay
(un titre, une lecture, la session vivante, un administrateur, six heures, la clé `lumen-tv:`), et un jeton d'une
portée n'ouvre pas l'adresse de l'autre. Le proxy laisse passer le GET (`lumenCastPassFor`) et la question préalable
`OPTIONS` (`lumenCastPreflightFor`) ; la route revérifie avec les mêmes fonctions. Toute réponse à une requête sans
cookie munie de ce jeton porte le CORS de §64 (`*`, jamais d'identifiants), erreurs comprises ; l'`OPTIONS` répond 204
(`castPreflightResponse`), un jeton refusé 401 sans CORS. Les segments vidéo servis au récepteur nourrissent
`castProgress` (`player: "lumen-serveur"`), comme AirPlay.

**La liste maître du récepteur** (`castMasterPlaylist`, à part de `masterPlaylist`, dont les octets ne bougent pas) :
la vue `castView` (le son AAC), **une seule piste son** — celle demandée — et pas de `SUPPLEMENTAL-CODECS`. Le lecteur
de Google choisit son rendu par `DEFAULT` (« AUTOSELECT n'est pas utilisé ») ; une seule piste ne laisse aucun doute et
aucune autre conversion à payer. Un changement de piste est un nouveau chargement depuis la télécommande, comme avec
Jellyfin. Aucune adresse ni aucun octet de la page ne change : `LUMEN_FORMAT_VERSION` ne bouge pas (la vue se calcule à
la requête depuis l'index ; l'AAC a ses propres noms `a{N}x{cid}` et ses propres clés de cache).

**La grille de l'AAC** (encodeur natif de FFmpeg 7.1.5, mesuré le 17/11/2026 avec le binaire de l'image, signal
synthétique) : trame de 1 024, délai de 1 024 (la trame j sortie couvre l'instant (j − 1)·1 024, décodée à 1 024
échantillons près), une trame de plus en sortie qu'en entrée — la règle de §161 avec N = 1 024, d = 1 024. Mais
**l'encodeur a un état** (psychoacoustique, régulation du débit) : deux fenêtres qui se recouvrent ne donnent **aucune**
trame identique (0 sur 16), là où l'E-AC-3 les donnait toutes. D'où : **un segment AAC se convertit toujours seul**, sur
sa propre fenêtre (3 trames de pré-roulement, 3 de queue) — ses octets restent une fonction du fichier, qu'il vienne de
l'avance (une tâche par segment) ou d'une demande après un saut ; `convertRange` refuse une plage plus large. La
jointure entre deux segments faits séparément, décodée, s'écarte d'un encodage continu de −26 à −30 dB (−17 à −20 dB
avec deux trames de pré-roulement) — l'ordre de l'écart entre deux encodages du même son au milieu d'un segment (−25 à
−32 dB) : pas de clic mesurable. Échelle de temps 48 000 dans l'init et les segments (1 024 échantillons ne tombent pas
sur la µs) ; `tfdt` = k·1 024 + D arrondi à l'échantillon.

**L'émetteur** (`ChromecastPlayer`, `src/lib/chromecast/lumenCast.ts`). La négociation Jellyfin a toujours lieu (les
pistes, les sous-titres signés `castToken`, la séance où la reprise est rapportée, et l'adresse du repli). Puis, sous
l'option : `eligibility?cast=1` (l'index Jellyfin → numéro Matroska par le rang, `matroskaNumberOf`), et le récepteur
charge l'adresse `cc.` absolue (`application/x-mpegurl`, BUFFERED, `hlsSegmentFormat`/`hlsVideoSegmentFormat` FMP4, la
position, les sous-titres texte de Jellyfin en WebVTT à côté, comme avant). Un sous-titre en images garde le flux de
Jellyfin (il l'incruste). **Repli** : un chargement refusé, aucune image en 25 s, ou une erreur du récepteur →
ligne `fallback` (`target: "chromecast"`, `player: "lumen-serveur"`, `path: "remux-serveur"`, `to: "jellyfin"`, le
`code` Cast, `picture`), puis le flux de Jellyfin à la même position (`start` `why: "ladder"`), pour le reste du titre.
**Journal** : les lignes du Chromecast sur Lumen serveur portent `player: "lumen-serveur"`, `path: "remux-serveur"` et
`lumenSession` (la route du journal y joint le relevé `srv.*`) ; `start` dit `lumenAudio` (« copié », « aac converti ») et
`lumenVideo`, ou `lumenDeclined` (la raison du serveur) quand l'option est allumée et que le titre reste à Jellyfin.

**Les limites, dites.** Les sous-titres sont ceux de Jellyfin (WebVTT, à l'instant du fichier) : Lumen serveur décale
tout de D (§155, 3 images + le réordonnancement, ~0,1 à 0,2 s) ; si le lecteur de Google ne recale pas la ligne de temps
sur le premier segment, sous-titres et position sont décalés d'autant — à vérifier sur appareil. Pas d'AAC 5.1 (le
lecteur de Google préfère la stéréo). Pas de « Améliorer les dialogues » sur le récepteur (pas plus qu'avant).

### Protocole, sur un Chromecast (l'option allumée dans Chrome)

1. **Chrome sur ordinateur**, panneau Compte → groupe administrateur → « Lecteur expérimental : remux serveur » allumé
   (et, pour les titres sans AAC, Configuration → « Conversion du son » ouverte aux administrateurs).
2. **Un titre H.264 à piste AAC** (un épisode de série 1080p) : Lire, puis le bouton Chromecast → le récepteur. Attendu :
   l'image en quelques secondes, à la position ; `jq 'select(.target=="chromecast") | {kind, player, path, lumenAudio, lumenVideo, lumenDeclined}' player.log`
   dit `lumen-serveur` / `remux-serveur` / « copié ». Saut, pause, volume depuis la télécommande.
3. **Un titre E-AC-3 ou DTS** (conversion ouverte) : `lumenAudio: "aac converti"` ; le son juste, synchrone, sans clic
   toutes les quatre secondes (jointures).
4. **Un titre HEVC 4K** : sur un Chromecast avec Google TV, l'image ; sur un Chromecast 3e gén., une ligne `fallback`
   `to: "jellyfin"` puis le flux de Jellyfin — et le titre HEVC suivant ne tente plus Lumen (`lumenDeclined` « HEVC
   refusé par ce récepteur »).
5. **Un sous-titre texte** allumé depuis la télécommande : vérifier qu'il tombe juste (le décalage D).
6. **Changer de piste son** depuis la télécommande : un nouveau chargement, la nouvelle langue.
7. **Verrouiller / fermer l'onglet** 5 minutes : la télévision continue, la position avance chez Jellyfin (ligne `cast`
   `serverRelay: true`, `player: "lumen-serveur"`).
8. **Couper l'option** : la diffusion suivante reprend le flux de Jellyfin, sans requête à `/api/lumen`.

## Ordre de travail

1. **Preuve sur appareil** : une instance jetable sert la liste et les segments d'un fichier copiable ; on l'ouvre
   dans Safari sur iPhone et Mac. Mesures : lancement à froid et en reprise, sauts, écran verrouillé, image dans
   l'image dans un onglet, comparés à Lumen dans la page. On continue ou on s'arrête là.
2. **Socle** : fonction de segment partagée avec le lecteur navigateur (empreintes inchangées), lecteur d'index
   léger, cache d'index, correctif `dec3()`, signalisation Dolby Vision. **Fait** (§154, §155), sauf le partage
   de la fonction de segment avec le lecteur navigateur (voir « Étape 2 »).
3. **Routes et sécurité** : `/api/lumen/…`, `assertVisible`, workers. **Fait** (§156) ; le jeton à portée
   `lumen` attend l'étape AirPlay, `shareGate` n'a pas d'entrée (lien refusé), les noms restent `.m4s`.
4. **Client** : option du Compte, route `"lumen"`, `LumenServerHost`, repli, journal, page d'activité. **Fait** (§180),
   derrière l'option d'appareil de l'administrateur.
5. **AirPlay** : liste signée vers l'Apple TV, `castProgress` par segment. **Fait** (étape 4b, §186), à éprouver sur une Apple TV.
   **Chromecast** : la même adresse sous sa propre portée (`cc.{jeton}`), CORS, le son en AAC. **Fait** (étape 4c, §192),
   à éprouver sur un récepteur.
6. **Son converti** : ffmpeg minimal, grille de segments, cache disque. **Fait** (« Phase 2 », §161 à §163), sauf la
   bascule en cours de lecture (avec l'étape 4).
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
