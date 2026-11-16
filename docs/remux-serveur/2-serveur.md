# 2. Lumen serveur — le côté serveur hors remuxeur

Recherche faite le 16/11/2026 sur `main` (bea33981, prod 10.44.7), en lecture seule. Mesures prises dans le
conteneur `cine-app` pendant qu'X-Ray analysait la bibliothèque (~3 cœurs, disque occupé) : ce sont donc des
chiffres « sous charge », pas des chiffres de banc.

---

## 2.1 L'accès aux octets

### Ce que le conteneur voit

- `docker-compose.yml` monte `/mnt/media/video:/mnt/media/video:ro` (docker-compose.yml:22-23), sous
  `user: "1001:1000"` : le GID primaire 1000, parce que mergerfs ignore les groupes secondaires et que beaucoup de
  dossiers de séries sont en 770 (docker-compose.yml:30-34).
- Vérifié par `docker inspect` : le montage est `RW=false`. `docker exec cine-app ls /mnt/media/video` liste
  `books books-packs downloads movies other tv`. Le processus tourne en `uid=1001(cineapp) gid=1000(node)`.
- Sur l'hôte, `/mnt/media/video` est un **mergerfs de trois branches** (`16to/video_data:8to_a:8to_b`, trois disques
  physiques). Le conteneur ne peut ni lire `user.mergerfs.basepath` ni voir les branches (src/lib/repliques/disks.ts:20-23) :
  impossible de savoir sur quel disque est un fichier, donc impossible de répartir les lectures par disque.
- **Jellyfin voit le même dossier sous un autre nom** : `/mnt/media/video -> /media` (docker inspect jellyfin). Ses
  `MediaSource.Path` sont donc `/media/movies/…`, `/media/tv/…`, et `laterna-xray` monte aussi `/mnt/media/video -> /media`.
  Le chemin local s'obtient en remplaçant le préfixe `/media/` par `MEDIA_ROOT` (`/mnt/media/video`,
  src/lib/media-paths.ts:6).
- Aucune fonction du dépôt ne fait aujourd'hui cette traduction Jellyfin → conteneur. Ce qui existe :
  - X-Ray prend `MediaSources[0].Path` et l'`ETag` de Jellyfin (src/lib/xray/cast.ts:82-95), vérifie
    `isLibraryPath` sur ce chemin **côté Jellyfin** (src/lib/xray/orders.ts:126 ; racines `/media/movies`, `/media/tv`,
    src/lib/xray/scanPlan.ts:288-304) et l'envoie au service, qui monte le même chemin. Laterna ne lit jamais le fichier.
  - L'indexation des répliques reconstruit le chemin depuis **Radarr** : dossier + `relativePath` sous `MOVIES_PATH`
    (`containerPathOf`, src/lib/repliques/library.ts:28-35). Films seulement.
  - Les installations neuves ne montent pas forcément les médias : le compose minimal le présente comme optionnel
    (« for Management → Statistics and the storage card only », docker-compose.example.yml:39-40).

### Mesures (dans le conteneur, Node 26, `fetch` vers `JELLYFIN_URL` sur le réseau Docker)

Plages de 4 Mio à des positions éloignées (fichiers mkv de 2, 3,3 et 21,5 Go) ; l'essai Jellyfin lit 64 Mio plus
loin pour ne pas profiter du cache de pages laissé par la lecture directe :

| | 1er octet | 4 Mio | débit |
|---|---|---|---|
| Lecture directe (`fs.readSync`) | 19–186 ms | 38–237 ms | 141–890 Mb/s |
| Jellyfin `static=true` + `Range` | 15–102 ms | 54–263 ms | 128–620 Mb/s |

Petites lectures aléatoires de 64 Kio (ce que coûte la lecture d'un index) : 20 essais sur un épisode de 1,3 Go.

| | disque (p50 / p90) | cache de pages (p50) |
|---|---|---|
| Directe | 11,7 / 18,1 ms | **0,2 ms** |
| Jellyfin | 11,4 / 15,9 ms | **5,6 ms** |

Lecture : le disque domine quand il travaille ; sur un fichier déjà en cache (le cas d'un index relu, d'un segment
redemandé, d'un fichier qu'on regarde), Jellyfin ajoute ~5 ms de requête HTTP par lecture et plafonne son débit
à ~50–70 % de la lecture directe. Pour un segment qui demande 3 à 10 lectures (index, blocs, son), l'écart est de
15 à 50 ms par segment, et du double sur le débit des gros segments 4K.

### Les deux options

**A. Lire le fichier directement** (`fs.promises.open` + `read` en lecture seule).

- Latence/débit : les meilleurs mesurés ci-dessus ; aucune requête de plus chez Jellyfin.
- Chemin : demandé à Jellyfin (`/Users/{jfId}/Items/{id}` ou l'appel d'X-Ray), traduit `/media/` → `MEDIA_ROOT`
  par **une** fonction nouvelle et réglable (Jellyfin peut monter ailleurs sur une autre installation — un réglage
  « racine Jellyfin = racine conteneur », comme `XRAY_LIBRARY_ROOTS` est réglable). Garde-fous à poser dans cette
  fonction : `isLibraryPath` sur le chemin Jellyfin (refuse `downloads/`, seeds, livres), puis `fs.realpath` et
  vérification que le résultat reste sous `MEDIA_ROOT` (un lien symbolique ne doit pas sortir), refus de `..`/`\0`.
- Droits : la lecture directe ne demande rien à Jellyfin. Le droit du compte reste donc à vérifier **avant**, par
  `assertVisible` (src/lib/itemVisibility.ts:106-138 : `/Users/{jfId}/Items/{itemId}`, verdict gardé 6 h par
  `(jti, itemId)`, refus en 404, Jellyfin injoignable = 503 sauf verdict déjà connu). C'est exactement ce que fait
  la route de flux actuelle (src/app/api/jellyfin/stream/[itemId]/[...path]/route.ts:123-143). Les tags bloqués
  sont appliqués par Jellyfin dans cet appel, rien n'est à réécrire.
- Identité : `stat()` donne taille, `mtime`, `ino` en quelques microsecondes. Vérifié sur un épisode : le
  `Last-Modified` que Jellyfin envoie est **exactement** le `mtime` du fichier, et la taille de la `MediaSource`
  est celle de `stat`. L'`ETag` de la `MediaSource` (qui marque les sous-titres recalés, X-Ray, le `fileVersion` de
  `direct/[itemId]`, route.ts:354) vient de Jellyfin et doit donc être lu chez lui, une fois à l'ouverture.
- Repli obligatoire : sans montage (installation sans médias, chemin introuvable, `EACCES`), basculer sur B.
- Coût caché : les pages lues sont comptées dans le cgroup de `cine-app` (`mem_limit: 2g` ; mesuré
  `file 67 Mo / anon 253 Mo` dans `memory.stat`). Le cache de pages se reprend avant tout OOM, mais un conteneur
  à 2 Go qui lit plusieurs 4K verra son cache tourner vite ; c'est sans danger, à surveiller.

**B. Passer par le relais Jellyfin** (`/Videos/{id}/stream?static=true&mediaSourceId=…` + `Range`, comme
`serveStream` le fait, route.ts:151-215 et 303-338).

- Latence : +5 ms par lecture à chaud, débit 50–70 % ; `fetchWithRetry` et le délai d'en-têtes de 30 s existent déjà
  (route.ts:36-54, 197-218), et passent par le disjoncteur Jellyfin (`passJellyfinFetch`).
- Droits : identiques (`assertVisible` en amont ; la clé d'administration signe l'appel et voit tout).
- Identité : `Last-Modified` présent, **pas d'en-tête `ETag`** sur la réponse de flux (mesuré : `etagHdr=non` sur
  les 9 plages) ; taille par `Content-Range`. L'`ETag` de la `MediaSource` doit donc venir, ici aussi, de l'appel
  d'ouverture.
- Avantage : marche sur toute installation, médias montés ou non. Jellyfin n'y gagne pas de séance visible :
  `static=true` sans `PlaySessionId` n'en ouvre pas ; les rapports `playing/progress/stop` restent ceux de la page,
  comme aujourd'hui.

**Recommandation** : A par défaut, B en repli automatique, derrière une seule interface `ByteSource`
(src/lib/webcodecs/byteSource.ts:18-67 : `size`, `read(offset, length)`, `close` suffisent ; tous les autres membres
sont optionnels) — `FileByteSource` (A) et `JellyfinRangeSource` (B). Le remuxeur ne voit pas la différence. Dans
les deux cas, appeler `noteMediaRead()` (src/lib/repliques/playbackActivity.ts:51) à chaque segment, comme le relais
le fait (route.ts:146), sinon l'indexation des répliques ne se tait plus pendant une séance Lumen serveur.

### Identité du fichier et cache de reprise

- Le cache de reprise (`src/lib/resumeCache/`) est celui du lecteur natif MSE : il garde des morceaux de 1 Mio en
  OPFS et les valide par `ETag` MediaSource + taille + `Last-Modified` du flux (byteSource.ts:499-532). **Lumen serveur
  n'en profite pas** : Safari lit le HLS par AVFoundation, aucun octet ne passe par `HttpByteSource`. Rien à
  brancher, mais rien à casser : les adresses de la route de flux et leur `Last-Modified` restent telles quelles.
- Côté serveur, l'identité sert à trois choses :
  1. **La clé du cache d'index** : `chemin local + taille + mtimeMs + ino` (lu par `stat` à chaque segment, quasi
     gratuit). Un fichier remplacé par Radarr/Sonarr/FileFlows change au moins de `mtime` ; l'index est alors
     reconstruit.
  2. **La version dans l'adresse** : les listes et segments portent un court condensé de l'`ETag` Jellyfin (ou, en A,
     de `taille+mtime`). Un segment demandé pour une version qui n'est plus celle du disque répond une erreur nette
     plutôt que des octets d'un autre fichier recollés sur l'ancien init segment.
  3. **La version du format** : voir risques (2.5) — un déploiement change le code entre deux segments d'une même
     séance.

---

## 2.2 Les routes à créer

### Forme des adresses : jeton dans l'adresse, cookie accepté en plus

- Une Apple TV en AirPlay n'a pas de cookie (castToken.ts:8-10) ; et **toute** lecture serveur reçoit déjà
  aujourd'hui une adresse signée, parce que le bouton AirPlay de la vidéo envoie la `src` courante au téléviseur sans
  passer par « Diffuser » (`castUrl`, PlayerHost.tsx:1563-1573 ; signé pour toute lecture,
  src/app/api/jellyfin/playback/start/route.ts:366-373 et 483-487). Lumen serveur doit faire pareil : **jeton dans
  l'adresse, toujours**, le cookie de Safari n'étant qu'un plus (qui déclenche, lui, `assertVisible` et le compte
  des liens de partage).
- Reprendre le laissez-passer existant (`signCastToken`, castToken.ts:87-91) : un titre, 6 h (castToken.ts:31),
  lié au `jti` de la session (meurt avec elle), et porte le `jfId` pour `castProgress`. Pour la phase admin, ajouter
  une revendication de portée (`p: "lumen"`) vérifiée par la route : voir le proxy ci-dessous.
- **Où mettre le jeton** : deux formes possibles.
  - En paramètre `castToken=` comme aujourd'hui : il faut l'écrire dans chaque ligne de chaque liste. Mesuré par
    `playlistEncoding.ts:7-14` sur les listes Jellyfin : ~1,1 Ko par segment, 5,6 Mo pour *Kill Bill* — d'où la
    compression brotli. Nos listes seraient plus courtes (pas de requête Jellyfin recopiée), mais ~250 octets de jeton
    × 1 800 segments ≈ 450 Ko en clair pour 2 h de film.
  - **Dans le chemin**, recommandé : `/api/lumen/{itemId}/{jeton}/{version}/master.m3u8`, et des URI **relatives**
    dans les listes (`video.m3u8`, `init-v.mp4`, `v/123.mp4`). Le téléviseur résout chaque URI sous le même
    préfixe : aucune réécriture (`withCastPass`, castToken.ts:236, devient inutile pour ce chemin), listes minimales.
    Il faut alors étendre `castItemOf` / `castPassDetailsFor` (castToken.ts:166-174, 217-224) pour lire le jeton à cet
    endroit — une seule fonction, partagée par le proxy et la route, comme aujourd'hui.
  - Dans les deux cas le jeton finit dans les journaux d'accès du relais inverse, comme aujourd'hui (c'est la raison
    du lien au `jti`, castToken.ts:66-72).
- `EXT-X-DEFINE:QUERYPARAM` (HLS v11, pour hériter du paramètre de la liste maître) serait une troisième voie ;
  son support par tvOS/AirPlay n'est pas vérifié ici — le chemin relatif n'a pas cette inconnue.

### Le proxy (`src/proxy.ts`)

- Ordre actuel : chemins publics → redirections → **`castPassFor` laisse passer sans session** (proxy.ts:509) et
  `castPreflightFor` (proxy.ts:512) → session → porte `share` (proxy.ts:544-558) → refus des écritures `user`
  (proxy.ts:560-567) → `ADMIN_ONLY_READS` (proxy.ts:568-570, liste proxy.ts:219-302).
- Conséquence importante : **un laissez-passer passe avant la vérification de rôle**. Ajouter
  `/^\/api\/lumen(\/|$)/` à `ADMIN_ONLY_READS` ne ferme la route qu'aux requêtes avec cookie ; une Apple TV munie
  d'un laissez-passer la franchirait quel que soit le rôle de qui l'a demandé. Pour une phase admin seulement, il faut
  donc **deux** verrous :
  1. `ADMIN_ONLY_READS` pour les requêtes avec session ;
  2. un laissez-passer Lumen **émis seulement pour une session admin** (portée `p: "lumen"` signée), refusé par la
     route s'il manque la portée. Plus simple encore : que `castItemOf` ne reconnaisse le préfixe `/api/lumen/` que
     pour un jeton portant cette portée.
  La route revérifie elle-même (règle du dépôt : le proxy et la route posent la même question, castToken.ts:150-156).
- Le matcher (proxy.ts:722-724) couvre déjà tout `/api/…` : rien à y changer. Ne **pas** mettre ces routes dans
  `HORS_PROXY` ni dans `ACTIFS_PUBLICS`.
- Rôle `share` : `shareGate` est une liste fermée ; la route n'existe pas pour un lien tant qu'on n'ajoute pas une
  entrée du type de celle du flux (src/lib/share/gate.ts:72-73, `scope: PATH` — l'élément de l'adresse est comparé au
  titre partagé). La limite de trois lectures simultanées (`shareStreamRefusal`, src/lib/share/guard.ts:30) n'est
  comptée aujourd'hui que sur le fichier `static` (route.ts:138-141) : pour Lumen, la compter à l'ouverture de la liste
  maître. Pour la phase admin : ne pas l'ajouter, un lien n'y a pas accès.
- `crossSiteWrite` ne concerne que les écritures : tout est GET ici.

### Le service worker

- `public/sw.js:217-230` : seuls les GET sont regardés ; sur WebKit, les images et trois routes JSON
  (`RELAYED_API`, sw.js:188) sont relayées ; **tout autre `/api/` sort par `return` sans `respondWith`**
  (sw.js:230). Une route `/api/lumen/…` n'est donc ni mise en cache ni relayée. Ne pas l'ajouter à `RELAYED_API`.
- De plus, les requêtes de média d'AVFoundation (HLS natif) et celles d'une Apple TV ne passent pas par le worker de
  la page. Rien à changer, rien à bumper (`CACHE_NAME` intact).
- CSP : `media-src 'self' blob:` (next.config.js:28, 161) — une adresse de même origine passe.

### Le cadrage des réponses (DECISIONS §131)

- Une route n'écrit jamais `Content-Length`/`Content-Encoding` ; elle pose `x-cine-length` / `x-cine-encoding` via
  `src/lib/responseFraming.ts` (`lengthHeader` :32, `encodedBodyHeaders` :24), traduits par
  `server-boot/responseFraming.mjs` au `setHeader`, avec compte des octets envoyés (connexion coupée si le corps ne
  tient pas sa longueur).
- **Next 16.4.6 compresse désormais les réponses de route** — mais seulement les types que son module `compression`
  juge compressibles (mime-db). Vérifié dans `node_modules/next/dist/compiled/compression/index.js` :
  - `application/vnd.apple.mpegurl` : **pas de drapeau `compressible`** → `compressible()` retombe sur son motif
    (`text/*`, `+json|+text|+xml`) → **non compressé par Next**.
  - `video/mp4` : `compressible: false` → jamais compressé ; `video/iso.segment` (`.m4s`) : sans drapeau → non plus.
- Donc :
  - **Liste `.m3u8`** : la compresser nous-mêmes avec `encodePlaylist` (src/lib/playlistEncoding.ts:72 ; brotli 4,
    puis gzip, au-dessus de 1 Ko, `Vary: Accept-Encoding`, longueur du corps compressé déclarée). C'est exactement ce
    que fait la route actuelle (route.ts:288-291). Une liste maître (< 1 Ko) part en clair avec `lengthHeader`. Ne
    jamais la servir en `text/plain` : ce type, lui, serait recompressé par Next et perdrait sa longueur
    (responseFraming.mjs, en-tête : « recompressée par lui : il retire `Content-Length` »). Toujours servie entière
    (200, pas d'`Accept-Ranges` — la leçon de route.ts:271-283 sur Safari et les listes tronquées).
  - **Init segment et segments** (`video/mp4`) : construits en mémoire, donc **longueur tenue** → `lengthHeader(n)`
    et `Content-Type: video/mp4`. Next ne les touche pas. AVFoundation peut envoyer un `Range` sur un segment :
    répondre 200 entier est valide (même raisonnement que route.ts:184-194), ou honorer la plage en 206 sur le tampon
    tenu, avec `x-cine-length` de la tranche. Sans `boot.mjs` (`next dev`, tests), `framingAvailable()` est faux :
    pas de longueur, ce qui reste correct.
  - `Cache-Control` : `private, no-store` pour les listes ; `private, max-age=21600, immutable` pour les segments
    **seulement si** l'adresse porte la version du fichier et du format (sinon un segment gardé survivrait à un
    remplacement de fichier). `private` toujours (relais inverse partagé, route.ts:307-309).
  - `Server-Timing: app;dur=…` comme le relais (route.ts:336-337), et idéalement `read;dur` / `mux;dur` : c'est ce
    qui dira, en production, si un segment lent était le disque ou le remuxeur.

### CrowdSec : 404 et rafales

Lu dans le conteneur `crowdsec-agent` (lecture seule) :

- `crowdsecurity/http-crawl-non_statics` : seau de **40**, fuite **0,5 s** (2 noms/s), `distinct:
  evt.Parsed.file_name`, filtré sur `static_ressource == 'false'` et GET/HEAD, groupé par IP + nom d'hôte.
- `file_name` est le **dernier segment du chemin, sans la requête** (parser `crowdsecurity/http-logs` : la requête
  est coupée au `?`, puis `DIR` / `FILE` / `EXT`).
- `static_ressource` vaut `true` pour ces extensions seulement : `.JPG .CSS .JS .JPEG .PNG .SVG .MAP .ICO .OTF .GIF
  .MP3 .MP4 .WOFF .WOFF2 .TTF .EOT .WEBP .WAV .GZ .BROTLI .BVR .TS .BMP .AVIF .MJS .TGZ`.
  **`.mp4` et `.ts` y sont ; `.m4s` et `.m3u8` n'y sont pas.**
- `crowdsecurity/http-probing` : plus de **10** chemins distincts en 404/403/400, non statiques, fuite 10 s.
- Liste blanche locale : l'IP fixe de la maison de l'administrateur, son /24 local et le /12 Docker
  (`my-whitelist.yaml`) — les autres foyers, un iPhone en itinérance, une Apple TV chez un ami ne sont pas couverts.

Donc, pour une Apple TV qui charge des segments numérotés :

- **Nommés `123.mp4`, ils ne comptent pas** (statiques), ni pour le crawl ni pour le probing, quel que soit leur
  nombre ou leur statut. C'est déjà le cas des segments Jellyfin relayés aujourd'hui (`hls1/main/12.mp4`).
- **Nommés `123.m4s`, chacun serait un nom distinct** : une Apple TV qui remplit son tampon (plusieurs segments par
  seconde au démarrage, deux pistes en parallèle, et un saut qui en redemande une série) dépasse 40 en quelques
  secondes et fait bannir l'adresse du foyer pour des heures. **Règle : extension `.mp4` pour l'init et chaque
  segment, vidéo comme audio.**
- Les listes `.m3u8` comptent : en garder un petit nombre de **noms** distincts (`master.m3u8`, `video.m3u8`,
  `audio-2.m3u8`, `subs-3.m3u8`…), la variation passant par le chemin (le répertoire ne compte pas, seul le nom de
  fichier) ou la requête. Pour un fichier à six pistes audio et vingt sous-titres, rester sous ~30 noms au total, ou
  regrouper les sous-titres.
- Absences attendues : ne jamais répondre 404/403/400 sur une `.m3u8` ou une route non statique pour un cas normal
  (piste absente, élément pas encore prêt, jeton expiré) — 204/200 vide ou 410/401/503. Le proxy répond déjà 401 sans
  session (proxy.ts:521-528), qui ne compte pas. Un segment `.mp4` hors fin de fichier peut répondre 404 sans risque
  CrowdSec, mais 416 est plus juste.

### Le cache serveur de l'index par fichier

- Modèle : état sur `globalThis` sous `Symbol.for("cine-app.lumenIndex")`, comme `server-cache.ts:53` ou
  `transcodeBudget.ts:40` — les routes et `instrumentation.ts` sont des points d'entrée séparés et chaque route a sa
  copie du module (CLAUDE.md, « The cache's state lives on globalThis »). Chaque route Lumen (liste, init, segment)
  doit lire la même instance.
- Contenu : description du fichier (`mediaFile.ts`), index des images clés (Cues Matroska ou `stss`/`stco` MP4),
  table des segments (frontières de groupes d'images en temps et en octets), init segments déjà construits par piste.
- Borne : en **octets estimés**, pas en entrées (un index 4K de 3 h est cent fois un épisode) — par exemple 128 Mo au
  total, LRU, oubli après 2 h sans requête ; `inflight` partagé pour que la rafale de démarrage (liste + init + trois
  segments) ne lise l'index qu'une fois (même motif que `assertVisible`, itemVisibility.ts:124-130).
- Clé : chemin local + taille + `mtimeMs` + `ino` (voir 2.1). Validation à chaque requête par un `stat` — un fichier
  remplacé invalide l'entrée sans attendre son expiration.
- **Sans état** veut dire : n'importe quel segment se reconstruit depuis le fichier seul. Le cache n'est qu'une
  accélération : après un déploiement (plusieurs par jour, conteneur recréé), la première requête d'une Apple TV en
  pleine lecture relit l'en-tête et l'index (1 à 3 Mo, ~50–200 ms mesurés à froid) et repart. Un cache disque de
  l'index (dans `DATA_DIR`, comme `book-index.json`) éviterait même cela ; facultatif.

---

## 2.3 AirPlay et téléviseurs

### Aujourd'hui

1. `playback/start` négocie chez Jellyfin et signe un laissez-passer pour **toute** lecture serveur
   (start/route.ts:366-373) ; `castUrl` = origine publique + manifeste + `castToken` (start/route.ts:483-487).
2. Le lecteur serveur met `castUrl` dans `video.src` (PlayerHost.tsx:1573) : le bouton AirPlay de l'élément
   (`x-webkit-airplay="allow"`, PlayerHost.tsx:2494) tend cette adresse au téléviseur. `useCastRoute` écoute la
   bascule dans toutes les séances (useCastRoute.ts:71-77).
3. Le lecteur natif (MSE) ne peut pas diffuser : il **cède au lecteur serveur** (`fallToStable("diffusion
   demandée", { cast: true })`, ExperimentalPlayerHost.tsx:3071-3085 et 1261 pour Chromecast).
4. Le proxy laisse passer sans cookie un GET dont le jeton nomme le titre de l'adresse (proxy.ts:509 ;
   `castPassFor`, castToken.ts:156-174 ; `castItemOf` reconnaît `/api/jellyfin/stream/{id}/…` et les sous-titres,
   castToken.ts:217-224). La route revérifie (route.ts:77-83).
5. La route réécrit le manifeste (adresses Jellyfin → relais, `withCastPass` dans chaque ligne, variantes SDR de
   secours retirées par `castMasterPlaylist`, route.ts:240-269).
6. `castProgress` : pour chaque segment demandé **avec** laissez-passer et **sans** cookie (route.ts:353), la
   position est lue dans le `runtimeTicks` de l'adresse (`segmentStartSeconds`, castProgress.ts:69, motif
   `\d+\.(mp4|m4s|ts)$`), moins 30 s de marge, rapportée à Jellyfin toutes les 30 s si la page s'est tue depuis
   150 s, arrêt après 90 s de silence (castProgress.ts:40-60).
7. CORS `*` sans identifiants pour un laissez-passer sans cookie (Chromecast seulement ; AirPlay n'en a pas besoin,
   castCors.ts:4-8).

### Comment Lumen serveur s'y branche

- **La même liste pour la page et pour la télé.** Safari reçoit dans `video.src` l'adresse absolue signée de la
  liste maître Lumen ; AirPlay la tend telle quelle à l'Apple TV. Aucune négociation Jellyfin, aucun `PlaySessionId`,
  pas de transcodage : `admitTranscode` (transcodeBudget.ts:56) ne s'applique pas, mais il faut un budget équivalent
  pour nos propres constructions de segments (2.4).
- **Le passage natif → Lumen pour diffuser** : aujourd'hui « diffuser » = négocier un transcodage Jellyfin. Avec
  Lumen, la page peut basculer sur Lumen serveur (même `fallToStable` avec `cast: true`, cible nouvelle) sans rien
  demander à Jellyfin — c'est le principal gain : Ted Lasso 4K DV (castMaster.ts:4-10) ne relancerait plus ffmpeg à
  chaque saut, un segment Lumen étant indépendant.
- **`castItemOf`** doit reconnaître `/api/lumen/{id}/…` (avec la portée Lumen pour la phase admin), sinon chaque
  requête de l'Apple TV repart en 401 — la panne du 19/09 et du 22/09 décrite dans castToken.ts:203-215 et 231-235.
- **`castProgress`** : appeler `noteCastSegment` depuis la route de segment, dans la **même condition** (laissez-passer
  et pas de cookie — sinon chaque lecture Safari en pause est « relayée », chasse du 11/10). Comme nos segments n'ont
  pas de `runtimeTicks`, soit on écrit `?t=<début en secondes>` dans l'URI de chaque segment (lu sans l'index), soit
  `noteCastSegment` reçoit la position calculée par la route. La seconde voie est plus propre ; la première permet de
  garder `segmentStartSeconds` comme seule lecture. Ne compter que les segments **vidéo** (deux listes en parallèle
  doubleraient les notes).
- **Sous-titres** : texte en WebVTT segmenté (une liste par piste) ou une seule liste d'un segment couvrant le film ;
  les URI relatives héritent du jeton. Les sous-titres images (PGS) restent hors périmètre, comme dans le lecteur
  natif.
- **Chromecast** : le récepteur Google lit le même HLS fMP4 par `fetch` depuis son domaine. Il faut alors
  `withCastCors` et une réponse `OPTIONS` (`castPreflightResponse`, castCors.ts:39-48) sur les routes Lumen. Hors
  phase 1 si l'on veut, mais l'architecture le permet sans rien d'autre.
- **Rapports à Jellyfin** : la page continue d'envoyer `playing/progress/stop` (sans `PlaySessionId` de transcodage :
  à vérifier que Jellyfin accepte un rapport « DirectStream » pour un fichier qu'il ne sert pas — c'est ce que fait déjà
  le lecteur natif).

---

## 2.4 La charge serveur

### Ce que la machine montre (16/11/2026, ~13 h)

- `nproc` = **12** ; `free` : 62 Gio, 23 Gio utilisés, 41 Gio de cache, **15 Gio de swap occupés** sur 31.
- `docker stats` : `laterna-xray` **306 % CPU**, 6,4 Gio / 8 (analyse en cours) ; `jellyfin` 102 % ; `qbittorrent`
  11 % ; `cine-app` 16 %, **319 Mio / 2 Gio**.
- Parts CPU : `laterna-xray` `cpu_shares=256`, `NanoCpus` 12 ; `jellyfin` et `cine-app` aux 1024 par défaut — sous
  contention, `cine-app` passe avant X-Ray, à égalité avec Jellyfin. `cine-app` : `cpu.max = max` (pas de plafond).
- Node : `UV_THREADPOOL_SIZE` non réglé → **4 fils libuv**, partagés entre `fs.read`, zlib (brotli des listes et du
  catalogue), `crypto` et DNS.
- Fréquentation (`player.log` et ses archives, 23/09 → 16/11, bancs exclus) : 2 212 séances ; **pic de 15 séances
  ouvertes en même temps** (04/11, 21 h 22) — borne haute, des séances sans `stop` s'allongent. Hypothèse de
  dimensionnement réaliste : **3 à 6 lectures Lumen simultanées**, 10 au pire.

### Coût par lecture

- **Octets** : une lecture Lumen sert ce que le relais sert déjà au lecteur natif (le natif tire les plages par
  `cine-app` aujourd'hui) : la sortie réseau ne change pas. En option A, Jellyfin sort du chemin des octets — moins de
  CPU et de connexions chez lui.
- **Mémoire par requête de segment** : le segment est tenu en mémoire (pour déclarer sa longueur et pour la
  construction) : lecture du groupe d'images + fragment produit ≈ **2 × taille du segment**. Ordres de grandeur :
  1080p HEVC 5–10 Mb/s × 4 s ≈ 2,5–5 Mo ; 4K 40–60 Mb/s × 4–6 s ≈ 20–45 Mo ; un GOP long (≥ 10 s) en 4K dépasse
  70 Mo. Les `Buffer` vivent hors du tas V8 mais **dans le cgroup** de 2 Gio. Avec 4 constructions simultanées au
  pire en 4K : ~350 Mo. Il faut une **file bornée** (par exemple 3–4 constructions à la fois, au plus 2 par lecture)
  et un plafond de taille de segment (couper un GOP trop long aux images clés n'est pas possible : un segment = au
  moins un GOP ; c'est le cas pathologique à mesurer).
- **CPU** : le remux de la vidéo copiée est léger (CLAUDE.md : « launching is bound by bytes, not by CPU »,
  `cout.spec.ts`). Mais tout tourne sur **la boucle d'événements de `cine-app`**, la même qui sert le catalogue, le
  proxy et les autres spectateurs : un segment de 40 Mo assemblé en JavaScript peut tenir la boucle des dizaines de
  millisecondes. À construire dans des `worker_threads` (pool de 2–3), ou à mesurer d'abord avec `cout.spec.ts` sur
  *The Exorcist* et un 4K DV. Le son ré-encodé (TrueHD/DTS/FLAC → AAC) est le vrai coût CPU — et il dépend de ce
  que le remuxeur peut faire en Node (pas de WebCodecs côté serveur) : hors de cette section, mais c'est lui qui
  décidera de la charge.
- **Disque** : mergerfs sur trois disques à plateaux, sans moyen de savoir lequel (disks.ts:20-23). X-Ray lit les
  mêmes fichiers (`/media` en lecture seule) en continu, et cède déjà l'iGPU à Jellyfin pendant une lecture
  (`scanWaitsForPlayback`) mais **pas le disque**. Mesuré sous son analyse : premier octet jusqu'à 186 ms, débit
  descendu à 141 Mb/s sur un gros fichier — suffisant pour un 4K à 60 Mb/s, avec peu de marge pour deux. Un `stall`
  de lecture Lumen pendant une analyse X-Ray serait le premier suspect ; prévoir la mesure (`read;dur` dans
  `Server-Timing`) dès le départ.
- **Libuv** : 4 fils pour les lectures de fichier de plusieurs spectateurs + la compression brotli des listes ;
  passer à 8 (`UV_THREADPOOL_SIZE` à poser avant le démarrage de Node, dans le `Dockerfile` ou `boot.mjs`) si l'on
  choisit l'option A.
- **Jellyfin** : en option A, il ne reçoit plus que l'appel d'ouverture (droits + `MediaSource`) et les rapports de
  position. En option B, une requête HTTP par lecture de plage.

---

## 2.5 Risques et inconnues

1. **Le laissez-passer passe avant le rôle** (proxy.ts:509 avant 568). Une phase « admin seulement » qui ne ferme
   que `ADMIN_ONLY_READS` serait ouverte à tout compte muni d'une adresse signée. Portée signée dans le jeton et
   vérifiée par la route : obligatoire.
2. **Déploiements en pleine séance.** Le conteneur est recréé plusieurs fois par jour ; une Apple TV qui joue garde
   l'init segment de l'ancien code et demande les segments suivants au nouveau. Si le format produit change (ID de
   piste, timescale, ordre des boîtes, découpe des segments), les segments ne se recollent plus. Mettre une **version
   du format** dans le chemin et la garder stable ; quand elle change, l'ancienne version doit être encore servie ou
   l'erreur doit être nette. Et pendant les secondes où le conteneur redémarre, l'Apple TV reçoit des 502 : tolérance
   d'AVPlayer aux segments en échec **inconnue** (la route actuelle documente une Safari intolérante à un 500 sur
   l'init, route.ts:24-35).
3. **Découpe des segments stable entre deux processus** : « sans état » exige que la table des segments (frontières,
   numéros, durées annoncées dans la liste) soit une fonction pure du fichier. Une liste servie avant un déploiement
   et un segment construit après doivent tomber sur les mêmes frontières.
4. **Cookie et HLS natif dans Safari** : envoyé ou non par AVFoundation selon la plateforme — inconnu ici, sans
   importance si le jeton est toujours dans l'adresse.
5. **CrowdSec** : une seule faute d'extension (`.m4s`) bannit un foyer ; un test du dépôt devrait l'interdire, comme
   `pare-feu-rafales.test.ts` le fait pour `prefetch`. Le scénario `nginx-req-limit-exceeded` est aussi chargé : la
   limite de requêtes du relais inverse n'a pas été lue ici (on n'y touche pas).
6. **Traduction des chemins** : codée en dur (`/media` → `/mnt/media/video`) elle marche ici et nulle part ailleurs.
   Réglage explicite + repli Jellyfin (option B) quand le fichier n'est pas lisible.
7. **`ETag` Jellyfin** : sa formule n'a pas été vérifiée (date de modification ? chemin ?). Un fichier réécrit sur
   place à la même seconde et à la même taille garderait la même clé `taille+mtime` — improbable avec
   Radarr/FileFlows, qui remplacent le fichier (nouvel `ino`).
8. **Mémoire du conteneur** : 2 Gio, tas Node ~1,1 Gio ; segments 4K en mémoire + cache d'index + cache de pages.
   La file bornée est indispensable ; relever `mem_limit` serait une décision à part (le commentaire de
   docker-compose.yml:37-45 l'a fixé quand « rien de lourd ne tourne ici » — Lumen serveur change cette prémisse).
9. **Le swap de l'hôte** (15 Gio occupés) : une page de `cine-app` passée en swap rendrait un segment lent sans
   raison visible. À surveiller avec `Server-Timing`.
10. **Compte des liens de partage** : aujourd'hui compté sur le fichier `static` (route.ts:138-141) ; Lumen n'a pas de
    fichier `static`, il faudra le compter ailleurs, sinon un lien échappe à sa limite de trois.
11. **`assertVisible` ne s'applique pas à un laissez-passer** (itemVisibility.ts:101-104) : il est vérifié à
    l'émission seulement. Six heures de validité après un blocage de tag : accepté aujourd'hui pour le flux, à accepter
    en connaissance de cause pour Lumen.

### Ce qu'il faudrait mesurer avant de construire

- Le coût d'un segment en Node (lecture + remux) sur *The Exorcist* et un 4K DV, avec et sans X-Ray en marche :
  `cout.spec.ts` donne déjà la méthode.
- Le comportement d'une Apple TV face à : une liste VOD de 1 800 segments, un segment en 502 pendant un
  redéploiement, un saut (combien de segments distincts en rafale).
- La taille d'un index en mémoire pour les plus gros fichiers de la bibliothèque (Cues de 3 h en 4K).
