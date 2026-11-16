# Lumen serveur — le remux côté serveur, servi en HLS

Conception du 16/11/2026. Rien n'est construit. Les quatre sections jointes détaillent chaque partie, avec
références `chemin:ligne` et mesures ; ce document en tire les décisions, l'architecture et l'ordre de travail.

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

## Ordre de travail

1. **Preuve sur appareil** : une instance jetable sert la liste et les segments d'un fichier copiable ; on l'ouvre
   dans Safari sur iPhone et Mac. Mesures : lancement à froid et en reprise, sauts, écran verrouillé, image dans
   l'image dans un onglet, comparés à Lumen dans la page. On continue ou on s'arrête là.
2. **Socle** : fonction de segment partagée avec le lecteur navigateur (empreintes inchangées), lecteur d'index
   léger, cache d'index, correctif `dec3()`, signalisation Dolby Vision.
3. **Routes et sécurité** : `/api/lumen/…`, jeton à portée `lumen`, `assertVisible`, `shareGate`, noms `.mp4`,
   workers.
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
