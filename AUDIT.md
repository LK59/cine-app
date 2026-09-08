# Audit — cine-app

> Rapport d'audit. Aucun fichier de code n'a été modifié : ce document est le seul livrable.
>
> Méthode : reconnaissance → audit module par module (écrit au fil de l'eau) → synthèse.
> Base auditée : branche `main`, commit `4c54497`, 607 fichiers TS/TSX, ~84 000 lignes.
> Vérifications dynamiques faites en lecture seule contre le conteneur `cine-app` en cours
> d'exécution (`docker exec`, `curl`) — signalées explicitement à chaque fois qu'elles servent
> de preuve.

---

## 1. Inventaire des modules

### 1.1 Négociation de lecture (serveur)

| Fichier | Rôle |
|---|---|
| `src/app/api/jellyfin/playback/start/route.ts` (267 l.) | La négociation `PlaybackInfo` : construit le DeviceProfile, l'envoie à Jellyfin, dérive le `PlayMethod`, ré-enracine l'URL de flux sous le proxy maison, pré-chauffe le manifeste, rapporte le démarrage. |
| `src/lib/deviceProfile.ts` (128 l.) | Fabrique le `DeviceProfile` à partir des capacités détectées : `DirectPlayProfiles`, `TranscodingProfiles` (HLS/fMP4), `CodecProfiles` (`VideoRangeType`, profondeur de bits), `SubtitleProfiles`. |
| `src/lib/clients/jellyfin.ts` (477 l.) | `getPlaybackInfo` + tous les rapports `/Sessions/Playing*`, et l'ensemble des lectures catalogue. |
| `src/app/api/jellyfin/direct/[itemId]/route.ts` (203 l.) | **La seconde négociation** : décrit le fichier pour le lecteur natif *sans* appeler `PlaybackInfo` (donc sans session de transcodage). Décide `refusedReason` / `canvasHdrRefusal` côté serveur. |
| `src/app/api/jellyfin/playback-state/[itemId]/route.ts` | Position de reprise + préférences de pistes, séparées de la description du fichier. |

### 1.2 Détection de capacités (client)

| Fichier | Rôle |
|---|---|
| `src/lib/codecSupport.ts` (194 l.) | Sonde réelle du navigateur : `MediaSource.isTypeSupported` + instanciation d'un vrai `SourceBuffer` (Chrome/Firefox), `canPlayType` (WebKit natif HLS). Cache localStorage `cine:codec-support:v4` clé sur le user-agent. |
| `src/lib/webkitEngine.ts` (29 l.) | Distingue « moteur WebKit » de « sait lire du HLS » — la confusion des deux avait faussé le profil sur Chrome Android. |
| `src/lib/webcodecs/capabilities.ts` (105 l.) | Sondes du panneau technique : `AudioEncoder.isConfigSupported`, `MediaSource.isTypeSupported` pour HEVC 8/10 bits, AV1, DTS, AAC, Opus. |
| `src/lib/webcodecs/mseSupport.ts` (115 l.) | Support MSE / `ManagedMediaSource`. |

### 1.3 Lecteur natif (remultiplexage / WebCodecs) — `src/lib/webcodecs/` (9 521 l.)

Trois chemins, choisis par fichier : remux → `<video>` natif, WebCodecs → canvas, lecture directe.

| Fichier | Rôle |
|---|---|
| `pathSelector.ts` (186 l.) | Choix du chemin, et la raison de chaque refus. Porte `TRUST_BUFFER_REBUILD = false`. |
| `remuxer.ts` (1 093 l.) | Matroska → fMP4 fragmenté ; unification codec/canaux audio par fichier. |
| `mseSource.ts` (1 237 l.) | Alimentation du `MediaSource`, sondes de jouabilité, reconstruction de tampon. |
| `engine.ts` (1 056 l.) | Moteur du chemin canvas : horloge, décodage, ordonnancement. |
| `playbackGuard.ts` (697 l.) | Surveillance de la lecture, replis. |
| `audioTranscode.ts` (677 l.) | Décodage DTS/AC-3 → ré-encodage AAC/Opus. |
| `renderer.ts` (550 l.), `matroska.ts` (531 l.), `mp4SampleEntries.ts` (483 l.), `remuxPlayback.ts` (381 l.), `byteSource.ts` (369 l.), `audioOutput.ts` (342 l.), `codecConfig.ts` (284 l.), `mp4Muxer.ts` (215 l.), `mediaFacade.ts` (145 l.), + 12 modules plus petits | Rendu, démultiplexage, boîtes MP4, lecture par plages, sortie audio, façade `<video>`. |

### 1.4 Lecteur (hôtes React)

| Fichier | Rôle |
|---|---|
| `src/components/PlayerHost.tsx` (1 158 l.) | Lecteur stable : hls.js + `<video>`, échelle de repli des codecs audio, `changeAudio`, panneau d'info. |
| `src/components/ExperimentalPlayerHost.tsx` (1 503 l.) | Lecteur natif : monte le moteur `webcodecs`, `fallToStable`. |
| `src/components/PlayerControls.tsx` (1 759 l.) | Contrôles partagés par les deux, typés contre `HTMLVideoElement`. |
| `src/components/PlaybackProvider.tsx` (234 l.) | Session de lecture globale (mini-lecteur, PiP), pré-chauffage `detectCodecSupport`. |
| `src/components/MiniPlayer.tsx`, `PlaybackInfoPanel.tsx`, `CapabilityStatus.tsx`, `ExperimentalPlayerReport.tsx` | Périphérie du lecteur. |
| `src/lib/usePlaybackSession.ts`, `playbackPanel.ts`, `trackPreferences.ts`, `autoAdvance.ts`, `reportPlayback.ts` | État et rapport de session. |

### 1.5 Couche API amont — `src/lib/clients/` (1 648 l.)

`jellyfin.ts`, `tmdb.ts`, `jellyseerr.ts`, `qbittorrent.ts`, `sonarr.ts`, `radarr.ts`, `bazarr.ts`, `jackett.ts`, `omdb.ts`.
Transport commun : `src/lib/http.ts` (`fetchJson`, `HttpError`, `UpstreamUnreachableError`, réessai 429).
Authentification Jellyfin centralisée : `src/lib/jellyfinAuth.ts`.

### 1.6 Authentification, sessions, autorisation

| Fichier | Rôle |
|---|---|
| `src/proxy.ts` (222 l.) | **La grille unique** : chemins publics, liste blanche des écritures `user`, redirections 308, prolongation de session, en-tête `x-session-expired`. |
| `src/lib/auth.ts` (243 l.) | Jeton signé HMAC-SHA256, champs `jfToken`/`jsCookie` chiffrés AES-GCM, `shouldRefresh`. |
| `src/lib/session.ts` (27 l.) | `verifySessionFull` = signature + expiration + révocation SQLite. |
| `src/lib/publicPaths.ts` (27 l.) | Liste des chemins publics, partagée client/serveur. |
| `src/instrumentation.ts` | Refus de démarrer sur `SESSION_SECRET` par défaut ; crons notifications / état / sauvegarde. |
| `src/app/api/auth/*` | `login` (admin local), `jellyfin` (SSO), `logout`, `me`, `sessions`. |

### 1.7 Routes API (103 routes) et proxys de flux

- `src/app/api/jellyfin/stream/[itemId]/[...path]/route.ts` — proxy HLS/fichier statique, réécriture des manifestes, réessais 5xx.
- `src/app/api/jellyfin/stream/subtitle/[itemId]/route.ts` — sous-titres WebVTT.
- `src/app/api/jellyfin/image/route.ts`, `trickplay/*`, `chapters` — vignettes et images.
- Familles `radarr/`, `sonarr/`, `bazarr/`, `jackett/`, `qbittorrent/`, `jellyseerr/`, `tmdb/`, `discover/`, `player/`, `cinema/`, `stats/`, `watchlist/`, `push/`, `sse/`.

### 1.8 Persistance et cache

`src/lib/db.ts` (729 l., better-sqlite3, `migrate()` idempotent, toutes requêtes synchrones),
`src/lib/server-cache.ts` (345 l., cache TTL devant les clients), `src/lib/cachedJson.ts`,
`src/lib/dbBackup.ts`, `src/lib/logFile.ts` (journaux JSONL rotatifs).

### 1.9 Interface

- Cinéma : `src/components/cinema/` (6 768 l.), dont le doublon assumé desktop/mobile.
- Gestion : `src/app/(dashboard)/` (~10 000 l.).
- Lecteur end-user : `src/components/player/` (3 402 l.).
- Transverse : `src/components/` (10 729 l.), `src/lib/cinemaRoute.ts` (navigation dans le hash).
- i18n : `src/locales/` (fr, en, es, de).

### 1.10 Build, configuration, déploiement

`next.config.js` (en-têtes de sécurité, optimiseur d'images, `output: standalone`),
`Dockerfile`, `docker-compose.yml` / `.dev.yml`, `public/sw.js` (PWA),
`src/lib/config.ts` (variables d'environnement), `.github/workflows`.

### 1.11 Découpages assumés

`src/lib/webcodecs/` (9 500 l.) et `src/components/` (10 700 l.) dépassent ce qui s'analyse
sérieusement d'un bloc. Ils sont traités par sous-ensembles : sélection de chemin + cycle de vie
des ressources média d'abord (c'est là que se trouvent les fuites et les incohérences de verdict),
puis les hôtes React. Le détail bit-à-bit des boîtes MP4 (`mp4SampleEntries.ts`,
`mp4Muxer.ts`, `matroska.ts`) n'est pas re-vérifié ligne à ligne contre les spécifications :
`DOC-TECH.md` et le banc `bench.spec.ts` le couvrent, et un audit qui prétendrait le refaire
en survol produirait du bruit plutôt que des findings.

---

## 2. Findings par module

### 2.1 Négociation de lecture

---

#### F-001 — Le verdict `PlayMethod` annonce « DirectStream » sur un vrai transcodage

- **Localisation** : `src/app/api/jellyfin/playback/start/route.ts:50-52`, `:141`, `:176-177`
- **Catégorie** : correctness
- **Sévérité** : important

**Constat.** `derivePlayMethod` décide qu'une vidéo est copiée (`DirectStream`) plutôt que
ré-encodée (`Transcode`) en comparant le codec de la source à la liste `VideoCodec` extraite de
la query string de `TranscodingUrl` :

```ts
// :141
({ videoCodecs, reasons: transcodeReasons } = parseTranscodingUrlInfo(source.TranscodingUrl));
// :176-177
const isVideoCopied = isDirectPlay || (!!videoStream?.Codec && videoCodecs.includes(videoStream.Codec));
const playMethod = derivePlayMethod(isDirectPlay, isVideoCopied);
```

Or `VideoCodec` dans cette URL est la liste des codecs que le client **accepte**, pas celui que
ffmpeg va **produire**. Les deux se confondent tant qu'aucune `CodecProfile` ne rejette le flux —
et divergent exactement dans le cas que `deviceProfile.ts:114-116` a été écrit pour couvrir.

**Preuve.** Négociation réelle contre le serveur Jellyfin de cette installation, sur
`(500) jours ensemble` (HEVC, `BitDepth: 10`, `HDR10`), avec les deux profils que
`buildDeviceProfile` produit selon `support.video["mp4/hevc10"]` :

```
profil hevc10=true : DirectPlay=false DirectStream=false
   TranscodingUrl VideoCodec=[h264,hevc]  TranscodeReasons=[ContainerNotSupported]
   -> derivePlayMethod dit : DirectStream        (correct)

profil hevc10=false : DirectPlay=false DirectStream=false
   TranscodingUrl VideoCodec=[h264,hevc]  TranscodeReasons=[ContainerNotSupported,
                                                            VideoBitDepthNotSupported]
   -> derivePlayMethod dit : DirectStream        (FAUX — Jellyfin va ré-encoder la vidéo)
```

`VideoBitDepthNotSupported` est la réponse du serveur : le flux 10 bits sera converti. `hevc`
figure pourtant toujours dans `VideoCodec`, donc `isVideoCopied` vaut `true`.

Le commentaire des lignes 41-48 affirme que cette dérivation « ne peut pas contredire la réalité
comme le faisait l'heuristique par motifs ». Ici c'est l'inverse qui se produit : `TranscodeReasons`
porte bien le motif vidéo, et c'est la comparaison de codecs qui se trompe.

**Conséquence.** Sur un appareil dont la sonde `mp4/hevc10` répond non — un HEVC 8 bits
seulement, ce que `codecSupport.ts:45-50` décrit comme un cas réel et coûteux — chaque lecture
d'un fichier 10 bits déclenche un ré-encodage GPU complet et est rapportée comme une simple
copie. Trois effets :

1. `reportPlaybackStart` (`:212`) écrit ce `playMethod` dans l'historique de Jellyfin, et le
   tableau de bord `/api/jellyfin/sessions` de cette app le relit.
2. Le panneau « Playback Info » (`:236`) — dont la raison d'être est de répondre « est-ce que ça
   transcode ? » sur un serveur sans GPU — affiche « DirectStream » précisément dans le cas
   qu'il devait attraper.
3. La bibliothèque compte 396 films HEVC sur 499 et 183 HDR : ce n'est pas un cas de bord.

**Correction proposée.** Croiser les deux signaux au lieu d'en remplacer un par l'autre — la
comparaison de codecs reste nécessaire (elle attrape le cas que les motifs ratent, documenté
lignes 41-48), mais un motif vidéo explicite doit primer :

```ts
const VIDEO_TRANSCODE_REASONS = new Set([
  "VideoCodecNotSupported", "VideoBitDepthNotSupported", "VideoProfileNotSupported",
  "VideoLevelNotSupported", "VideoResolutionNotSupported", "VideoBitrateNotSupported",
  "VideoRangeTypeNotSupported", "VideoFramerateNotSupported", "AnamorphicVideoNotSupported",
  "InterlacedVideoNotSupported",
]);
const forcedByReason = transcodeReasons.some((r) => VIDEO_TRANSCODE_REASONS.has(r));
const isVideoCopied =
  isDirectPlay || (!forcedByReason && !!videoStream?.Codec && videoCodecs.includes(videoStream.Codec));
```

La liste est fermée et nommée : `ContainerNotSupported` et les motifs `Audio*` n'y sont pas, et
c'est ce qui préserve le vrai DirectStream (remux de conteneur, vidéo copiée) que le commentaire
existant protège.

**Risque de la correction.** Si Jellyfin devait un jour émettre un de ces motifs sans ré-encoder,
une vraie copie serait rapportée « Transcode ». Le coût est un libellé pessimiste dans un panneau
de diagnostic et une ligne d'historique — sans effet sur la lecture elle-même, contrairement au
défaut actuel qui masque une charge GPU réelle. À vérifier au cas par cas si un motif est ajouté
à la liste.

---

#### F-002 — Le palier de débit mobile force un transcodage sur 8 % de la bibliothèque

- **Localisation** : `src/components/PlayerHost.tsx:108-113`
- **Catégorie** : performance
- **Sévérité** : important

**Constat.**

```ts
function pickMaxBitrate(): number {
  const w = window.innerWidth * (window.devicePixelRatio || 1);
  if (w <= 1280) return 20_000_000;
  if (w <= 1920) return 40_000_000;
  return 100_000_000;
}
```

Cette valeur part en `MaxStreamingBitrate`, qui — comme le dit le commentaire des lignes 55-66 —
décide **aussi** si la source est éligible au DirectPlay/DirectStream, pas seulement la cible d'un
transcodage. Le même commentaire explique que les anciens paliers (4/8/15 Mbps) ont été relevés
« bien au-dessus de tout débit réaliste » parce qu'un remux Blu-ray FHD HEVC « tourne couramment
à 15-25+ Mbps ». Le palier ≤ 1280 est resté à 20 Mbps, c'est-à-dire **à l'intérieur** de
l'intervalle que ce commentaire désigne comme le problème.

Le seuil se calcule en pixels physiques : un iPhone 15 Pro (393 pt × 3) donne 1179, un Pixel 8
(412 × 2,625) donne 1081. Tous les téléphones de la cible tombent dans le palier 20 Mbps.

**Preuve.** Relevé sur la bibliothèque réelle (499 films interrogés via `/Items?Fields=MediaSources`) :

```
médiane 6,4 Mbps · p90 17,6 Mbps · max 38,4 Mbps
films au-dessus de 20 Mbps : 38    (7,6 %)
films au-dessus de 40 Mbps : 0
```

**Conséquence.** 38 films sur 499 sont refusés au DirectPlay/DirectStream **uniquement sur le
débit** dès qu'on les ouvre depuis un téléphone, et partent en ré-encodage HEVC borné — sur un
serveur sans GPU, la charge exacte que ce projet existe pour éviter. Aucun de ces fichiers ne
dépasse 40 Mbps : le palier supérieur, lui, ne refuse rien.

**Correction proposée.** Aligner le palier mobile sur les deux autres, c'est-à-dire au-dessus de
tout débit réel de la bibliothèque :

```ts
-  if (w <= 1280) return 20_000_000;
-  if (w <= 1920) return 40_000_000;
+  if (w <= 1920) return 60_000_000;
   return 100_000_000;
```

Et déplacer le commentaire des lignes 55-66, aujourd'hui accroché à `MAX_NETWORK_RETRIES`, sur la
fonction qu'il décrit.

**Risque de la correction.** Un téléphone en 4G se verra proposer le fichier d'origine plutôt
qu'un flux contraint : sur les 38 fichiers concernés, jusqu'à 38 Mbps. Sur un réseau lent, cela
déplace le problème du serveur vers le tampon du client — un remplissage plus lent, pas un échec
(le lecteur a déjà son échelle de repli réseau, `MAX_NETWORK_RETRIES`). Si ce compromis n'est pas
voulu, l'alternative est de garder un palier bas mais de ne l'appliquer qu'à la cible de
transcodage, ce que l'API Jellyfin ne permet pas avec un seul `MaxStreamingBitrate` — il faudrait
alors le porter dans le `TranscodingProfile` et laisser les `DirectPlayProfiles` sans plafond.

---

#### F-003 — Les deux négociations ne partagent aucun verdict, par construction

- **Localisation** : `src/app/api/jellyfin/direct/[itemId]/route.ts:114-137` vs
  `src/app/api/jellyfin/playback/start/route.ts:99-113`
- **Catégorie** : dette
- **Sévérité** : mineur

**Constat.** Deux routes décident « ce fichier est-il lisible et comment » et n'ont aucun code
commun. `playback/start` construit un `DeviceProfile` et laisse le `StreamBuilder` de Jellyfin
trancher. `direct/[itemId]` n'appelle jamais `PlaybackInfo` (`getItemMediaSources`, `:115`) et
tranche sur deux ensembles littéraux : `SUPPORTED_CONTAINERS` (`:18`) et `TONE_MAPPABLE_RANGES`
(`:23`). Le vrai verdict du chemin natif est ensuite rendu côté client par
`pathSelector.ts:157-178`, à partir de sondes navigateur.

C'est un choix défendable et documenté (`:452-454` : pas d'appel `PlaybackInfo`, donc pas de
session de transcodage créée pour un fichier qu'on va lire tel quel). Il n'y a pas de verdict
contradictoire à signaler : le chemin natif ne demande jamais rien au `StreamBuilder`, donc les
deux ne peuvent pas se contredire — ils ne répondent pas à la même question.

Le vestige, en revanche, est réel. `direct/[itemId]:126-129` porte une logique défensive contre un
`Container` multi-noms (`"mov,mp4,m4a,3gp,3g2,mj2"`) que `playback/start:123` n'a pas
(`.split(",")[0]`). Vérifié en direct contre le serveur : sur ce Jellyfin, les trois points
d'entrée (`/Items?Fields=MediaSources`, `/Users/{id}/Items/{id}?Fields=MediaSources`,
`PlaybackInfo`) répondent tous `"mkv"` ou `"mp4"`, jamais la forme multi-noms.

**Conséquence.** Aucune aujourd'hui. La divergence redeviendrait observable si un serveur
Jellyfin d'une autre version reprenait la forme multi-noms : `playback/start` construirait alors
`stream.mov?static=true` là où `direct` construit `stream.mp4`. C'est signalé pour ce que
`CLAUDE.md` appelle « la même décision prise à plusieurs endroits », pas comme un défaut actif.

**Preuve.** `direct/[itemId]/route.ts:126-129` et `playback/start/route.ts:123` ; relevé direct :
`getItemMediaSources` → `"mp4"` pour *Aftersun*, `"mkv"` pour *(500) jours ensemble* ;
`PlaybackInfo` → `"mp4"` pour le même *Aftersun*.

**Correction proposée.** Une fonction partagée `primaryContainer(source.Container)` portant la
logique de `direct/:126-129`, appelée par les deux routes. Pas de changement de comportement sur
ce serveur.

**Risque de la correction.** Nul en pratique ; c'est du code que rien n'exerce ici.

### 2.2 Proxys de flux et validation des entrées

---

#### F-004 — Traversée de chemin dans le proxy de flux : n'importe quel spectateur obtient un GET arbitraire sur Jellyfin, avec la clé d'administration

- **Localisation** : `src/app/api/jellyfin/stream/[itemId]/[...path]/route.ts:50-51`
- **Catégorie** : sécurité
- **Sévérité** : **critique**

**Constat.** Le segment attrape-tout est concaténé tel quel dans l'URL amont, et la requête part
avec `config.jellyfin.apiKey` — la clé d'administration, pas le jeton du spectateur :

```ts
// :44   seul itemId est validé
if (!JELLYFIN_ID_RE.test(itemId)) return new NextResponse(null, { status: 400 });
// :48   toute session porteuse d'une identité Jellyfin passe — aucun contrôle de rôle
if (!session?.jfId) return new NextResponse(null, { status: 403 });
// :50-51
const restPath = path.join("/");
const target = `${config.jellyfin.url}/videos/${itemId}/${restPath}${req.nextUrl.search}`;
// :73
{ ...jellyfinAuthHeaders(config.jellyfin.apiKey), ... }
```

`restPath` n'est ni validé ni normalisé, et `req.nextUrl.search` est recopié intégralement.

**Preuve.** La chaîne complète a été vérifiée en direct, en trois maillons :

1. **Next.js décode les paramètres de route.** Sonde sur la route publique
   `/api/gallery/clara/[filename]`, dont la garde `path.basename(p) !== p` (`:35-38`) distingue
   les deux cas :
   ```
   GET /api/gallery/clara/..%2Fetc%2Fpasswd   -> 403   (param décodé en "../etc/passwd")
   GET /api/gallery/clara/nope.jpg            -> 404   (témoin)
   ```
   Un `%2F` dans un segment devient donc un `/` dans la valeur du paramètre. (Les `%2e%2e`
   *non* encodés, eux, sont normalisés par Next avant routage — vérifié séparément : une requête
   sur `/zzz/%2e%2e/%2e%2e/bar` arrive au proxy comme `/bar`. C'est `%2F` qui passe.)

2. **`fetch` normalise les segments `..`.** Dans le conteneur :
   ```
   new URL("http://jellyfin:8096/videos/aaaa…aaaa/../../Users").href
     === "http://jellyfin:8096/Users"
   ```

3. **Jellyfin répond aux points d'administration avec cette clé.** Dans le conteneur, avec la
   clé de son propre environnement :
   ```
   GET http://jellyfin:8096/videos/aaaa…aaaa/../../Users   ->  200, 45 348 octets
   21 comptes, champs Name, ServerId, Id, HasPassword, HasConfiguredPassword,
   HasConfiguredEasyPassword, EnableAutoLogin, LastLoginDate…
   ```

Le seul maillon non exercé de bout en bout est la garde de la route (`:48`), qui se lit
directement : elle exige une identité Jellyfin, pas le rôle `admin`. `PLAYER_ENABLED=true` est
confirmé dans l'environnement du conteneur, donc le `404` de la ligne 41 ne s'applique pas.

**Conséquence.** Chacun des ~19 comptes du foyer — rôle `user`, aucun privilège de gestion —
peut transformer cette route en proxy GET authentifié en administrateur sur toute l'API Jellyfin :
énumération des comptes (`/Users`), configuration du serveur, bibliothèques et éléments d'autrui,
et le flux de n'importe quel fichier média du serveur, y compris ce que la politique de leur
propre compte leur interdit. Le proxy de session (`src/proxy.ts:182-189`) ne filtre que les
méthodes non-GET : il ne voit rien passer.

**Correction proposée.** Valider chaque segment plutôt qu'assainir la chaîne — une liste
d'autorisation étroite, puisque les seules formes légitimes sont connues (`master.m3u8`,
`main.m3u8`, `hls1/main/N.mp4`, `stream.{container}`) :

```ts
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
if (path.length > 4 || !path.every((s) => SEGMENT_RE.test(s) && s !== "." && s !== "..")) {
  return new NextResponse(null, { status: 400 });
}
```

Le point est autorisé (les noms portent une extension) mais un segment réduit à `.`/`..` est
refusé, et `/` ne peut plus apparaître puisqu'il n'est pas dans la classe. À faire **avant** toute
concaténation, et sans se reposer sur une normalisation de `fetch` qui va dans le mauvais sens.

Deux durcissements à faire dans le même passage, chacun réduisant l'impact si la garde tombe :
- Poser le jeton du spectateur (`session.jfToken`) plutôt que `config.jellyfin.apiKey`. C'est déjà
  l'argument retenu pour `getPlaybackInfo` (`clients/jellyfin.ts:141-145`) : « garder cette
  exposition inévitable à faible enjeu ». Le même raisonnement s'applique ici avec plus de force.
- Vérifier que le préfixe construit est bien celui attendu :
  `if (!target.startsWith(`${config.jellyfin.url}/videos/${itemId}/`)) return 400;`

**Risque de la correction.** Un nom de segment inattendu produit par une future version de
Jellyfin serait refusé en 400 au lieu d'être relayé — visible immédiatement (la lecture s'arrête),
pas silencieux. Le passage au jeton du spectateur est le changement le plus risqué des trois :
Jellyfin applique alors la politique du compte au flux, ce qui est l'intention, mais un compte à
la politique restrictive pourrait perdre l'accès à un fichier qu'il obtenait jusqu'ici par la
clé d'administration. À tester compte par compte, ou à faire dans un second temps — le contrôle
du chemin, lui, ferme la faille à lui seul.

---

#### F-005 — Même faille dans la route de sous-titres, sans même la validation d'`itemId`

- **Localisation** : `src/app/api/jellyfin/stream/subtitle/[itemId]/route.ts:22-31`
- **Catégorie** : sécurité
- **Sévérité** : important

**Constat.** `itemId` est validé (`:16`), mais les deux autres composants du chemin ne le sont
pas du tout :

```ts
const mediaSourceId = req.nextUrl.searchParams.get("mediaSourceId");
const index = req.nextUrl.searchParams.get("index");
if (!mediaSourceId || !index) return new NextResponse(null, { status: 400 });

const target = `${config.jellyfin.url}/Videos/${itemId}/${mediaSourceId}/Subtitles/${index}/Stream.vtt`;
// :31  clé d'administration
headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
```

Le seul test est « non vide ». Un `mediaSourceId` valant `../../../Users` ou un `index` valant
`0/../../../../System/Configuration` produit, après normalisation par `fetch`, une requête
arbitraire — sans même avoir besoin d'un `%2F`, puisque ce sont des paramètres de requête et non
des segments de route : la valeur arrive telle quelle.

**Preuve.** Lignes 22-26 : aucune expression régulière, aucun `encodeURIComponent`, aucune
comparaison au `source.Id` réellement renvoyé par Jellyfin. À comparer à la ligne 16, qui valide
`itemId` dans le même fichier, et à `direct/[itemId]/route.ts:162` qui, lui, passe bien par
`encodeURIComponent` en construisant cette même URL — la validation manque du côté qui la reçoit.
La normalisation `..` par `fetch` est celle mesurée en F-004.

**Conséquence.** Identique à F-004 en nature (GET arbitraire avec la clé d'administration),
plus étroite en portée : la réponse n'est relayée que si elle est `ok`, et sous
`Content-Type: text/vtt`. Cela suffit à exfiltrer tout corps JSON que Jellyfin sert en GET.

**Correction proposée.**

```ts
if (!/^[0-9a-f]{32}$/i.test(mediaSourceId) || !/^\d{1,4}$/.test(index)) {
  return new NextResponse(null, { status: 400 });
}
```

Ces deux formes sont exactement ce que produisent les seuls appelants
(`playback/start/route.ts:195` et `direct/[itemId]/route.ts:162` : `source.Id` et `s.Index`).

**Risque de la correction.** Un `MediaSourceId` non hexadécimal — ce que Jellyfin produit pour
une source de type LiveTV ou un chemin externe — serait refusé. Cette app ne négocie que des
fichiers (`AutoOpenLiveStream: false`, `clients/jellyfin.ts:153`), donc le cas n'existe pas ici ;
il existerait sur une installation avec de la TV en direct.

---

#### F-006 — Trois routes de lecture interpolent un identifiant non validé dans une URL Jellyfin

- **Localisation** : `src/app/api/jellyfin/streams/[itemId]/route.ts:20,28` ;
  `src/app/api/cinema/series/[jellyfinId]/episodes/route.ts:60,66-67` ;
  `src/app/api/cinema/progress/[itemId]/route.ts:36,43`
- **Catégorie** : sécurité
- **Sévérité** : important

**Constat.** Ces trois routes sont ouvertes à tout compte authentifié (GET, donc invisibles pour
la garde de rôle du proxy) et passent leur paramètre de route directement aux clients Jellyfin,
qui l'interpolent dans l'URL et signent avec la clé d'administration :

```ts
// streams/[itemId]:20,28 — aucune validation entre les deux
const { itemId } = await ctx.params;
const item = await jellyfin.getItemMediaSources(session.jfId, itemId);
// -> clients/jellyfin.ts:461 : `${url}/Users/${userId}/Items/${itemId}?Fields=…`, headers = apiKey

// cinema/series/[jellyfinId]/episodes:60,66-67
const { jellyfinId } = await props.params;
jellyfin.getSeriesEpisodes(session.jfId, jellyfinId)   // `${url}/Shows/${seriesId}/Episodes?userId=…`
jellyfin.getNextUp(session.jfId, jellyfinId)           // `${url}/Shows/NextUp?SeriesId=…`

// cinema/progress/[itemId]:36,43
const { itemId } = await props.params;
jellyfin.getItemUserData(session.jfId, itemId)         // `${url}/Users/${userId}/Items/${itemId}?…`
```

Le paramètre peut porter des `..` (via `%2F`, cf. F-004) **et** un `?`, qui tronque le chemin et
laisse réécrire la query string : `/Shows/{X}/Episodes?userId=…` devient
`/Users/{autre}/Items?Recursive=true&…` avec `/Episodes` relégué dans la requête.

**Preuve.** Les six lignes citées : dans les trois fichiers, il n'existe aucune expression
régulière, aucun `Number()`, aucun `encodeURIComponent` entre le `await params` et l'appel client.
C'est le seul groupe de routes dynamiques du dépôt dans ce cas — les autres valident
(`JELLYFIN_ID_RE` pour les identifiants Jellyfin, `Number()` pour les identifiants Radarr/Sonarr).
Le mécanisme de traversée est celui mesuré en F-004.

**Conséquence.** Moindre que F-004 parce que la réponse est remise en forme et non relayée telle
quelle, mais réelle : `getSeriesEpisodes` renvoie `res.Items` et la route mappe chaque élément
(`toCinemaEpisode`, `:38-51`), donc toute réponse Jellyfin de forme `{Items:[…]}` traverse — de
quoi énumérer la bibliothèque et l'état de visionnage d'un autre compte.

**Correction proposée.** Le même garde-fou que partout ailleurs dans le dépôt, en tête des trois
routes :

```ts
if (!/^[0-9a-f]{32}$/i.test(itemId)) return NextResponse.json({ error: "id invalide" }, { status: 400 });
```

Mieux : le poser une fois dans les fonctions du client (`clients/jellyfin.ts`) plutôt qu'à chaque
appelant, puisque c'est là qu'est faite l'interpolation et que c'est là que la garantie manque.
`CLAUDE.md` le dit sur un autre sujet : « donnez-leur une fonction partagée pour qu'elles ne
puissent plus diverger ».

**Risque de la correction.** Aucun sur ces trois routes : tous les appelants côté client passent
des identifiants Jellyfin, qui sont hexadécimaux sur 32 caractères par construction. Un garde-fou
posé dans le client toucherait en revanche toutes les fonctions du fichier — à faire fonction par
fonction, en vérifiant que `getEpisodeTimestamps` (plugin Intro Skipper) et les identifiants de
série reçoivent bien la même forme.

---

#### F-007 — `Cache-Control: public` sur des flux authentifiés

- **Localisation** : `src/app/api/jellyfin/stream/[itemId]/[...path]/route.ts:119`, `:134` ;
  `src/app/api/jellyfin/stream/subtitle/[itemId]/route.ts:39`
- **Catégorie** : sécurité
- **Sévérité** : mineur

**Constat.** Le fichier média entier (`isStatic`), chaque segment HLS et chaque piste de
sous-titres sont renvoyés avec `Cache-Control: public, max-age=21600` (ou `3600`). Ces réponses
ne sont servies qu'après `verifySessionFull` (`:47-48`), donc leur contenu est privé ; `public`
autorise explicitement un cache **partagé** à les conserver et à les resservir sans la requête
d'origine.

**Preuve.** Lignes 119 et 134 du proxy de flux, ligne 39 de la route de sous-titres. `README.md`
et `CLAUDE.md` décrivent un reverse proxy en frontal qui sert une vingtaine d'autres sites sur la
même machine.

**Conséquence.** Le proxy actuel ne met probablement rien en cache par défaut — mais la directive
dit à *tout* intermédiaire, présent ou futur, qu'il a le droit. Une configuration de cache ajoutée
en amont un jour (pour accélérer les images, par exemple) prendrait ces réponses avec, et servirait
un segment de film à quelqu'un sans session.

**Correction proposée.** `private` au lieu de `public` sur les trois lignes. L'intention réelle —
laisser le **navigateur** rejouer un segment déjà téléchargé, expliquée aux lignes 129-132 — est
entièrement préservée par `private`, qui n'exclut que les caches partagés.

**Risque de la correction.** Nul pour la lecture. Si un cache amont avait été délibérément mis en
place devant ces réponses, il cesserait de servir — mais rien dans le dépôt ne le suggère.

### 2.3 Authentification, exposition publique, en-têtes

---

#### F-008 — `/api/status/public` : 330 ms de SQLite bloquant par requête, sans session ni limite

- **Localisation** : `src/app/api/status/public/route.ts:16-33` ;
  `src/lib/db.ts:592-596` ; `src/components/CapabilityStatus.tsx:187-191`
- **Catégorie** : performance / robustesse
- **Sévérité** : important

**Constat.** La route est publique (`publicPaths.ts:19`), marquée `dynamic = "force-dynamic"`
(donc jamais mise en cache), et recalcule tout à chaque appel :

```ts
const services = await runAllServiceChecks();          // :17  — 12 requêtes amont en parallèle
const capabilities = computeCapabilities(services);
const since = Date.now() - SEVEN_DAYS_MS;
const payload = capabilities.map((cap) => {
  const history = statusHistoryDb.getCapabilityHistory(cap.id, since);   // :22 — une requête SQL par capacité
  …
});
```

`getCapabilityHistory` est un `SELECT … ORDER BY checked_at ASC` sur `capability_checks`, et
better-sqlite3 est **synchrone** : il tient la boucle d'événements pendant toute la lecture.
`CLAUDE.md` le pose comme invariant du dépôt (« chaque requête est synchrone et tient la boucle
d'événements »).

**Preuve.** Mesures sur la base de production, en lecture seule :

```
capability_checks : 529 883 lignes, 31 capacités distinctes, 10,1 jours d'historique
fenêtre de 7 jours : 393 204 lignes rendues sur les 31 requêtes
temps SQL synchrone cumulé, par requête HTTP : 330 ms
```

et sur le point d'entrée lui-même, **sans cookie** :

```
GET /api/status/public  ->  200 en 0,599 s  puis  200 en 0,480 s
```

Côté client, `CapabilityStatus.tsx:187-191` interroge cette route avec
`{ refreshInterval: INTERVALS.FAST }`, soit **toutes les 15 secondes**
(`refresh-intervals.ts:5`).

**Conséquence.** Deux, de natures différentes.

*Coût permanent.* Un seul onglet laissé ouvert sur `/status` bloque la boucle d'événements 330 ms
toutes les 15 s — 2,2 % du temps CPU du processus, et surtout 330 ms pendant lesquelles **rien**
n'est servi : ni une page, ni un segment HLS de quelqu'un qui regarde un film. Il déclenche aussi
12 requêtes vers Radarr/Sonarr/Jellyfin/qBittorrent/Bazarr/Jackett/Jellyseerr/TMDB quatre fois par
minute. C'est précisément la page qu'on ouvre quand l'application est déjà lente — et l'ouvrir
l'aggrave.

*Vecteur de déni de service.* La route est publique par conception (`publicPaths.ts:9-12` : elle
doit répondre « le jour où plus rien ne répond ») et n'a aucun limiteur de débit, contrairement à
`/api/mdblist/[imdbId]` (`createRateLimiter(60, 60_000)`, `:8`) ou à la connexion. Trois requêtes
par seconde depuis l'extérieur saturent la boucle d'événements : plus aucune lecture ne passe,
pour personne.

**Correction proposée.** Trois changements indépendants, du moins risqué au plus :

1. **Servir le résultat déjà calculé par le cron.** `statusCron.ts` interroge déjà les services
   périodiquement et écrit `capability_checks`. La route peut lire le dernier état enregistré au
   lieu de relancer `runAllServiceChecks()` à chaque appel — c'est ce que la table existe pour
   porter.
2. **Agréger côté SQL** au lieu de rapatrier 393 204 lignes en JavaScript. `analyzeHistory` a
   besoin du taux de disponibilité et des incidents ; le premier est un `GROUP BY`, le second se
   calcule sur les seules lignes où le statut change :
   ```sql
   SELECT capability, status, MIN(checked_at) AS from_at, MAX(checked_at) AS to_at, COUNT(*) AS n
     FROM (SELECT capability, status, checked_at,
                  ROW_NUMBER() OVER (PARTITION BY capability ORDER BY checked_at)
                    - ROW_NUMBER() OVER (PARTITION BY capability, status ORDER BY checked_at) AS grp
             FROM capability_checks WHERE checked_at >= ?)
    GROUP BY capability, status, grp ORDER BY from_at;
   ```
   Une requête au lieu de 31, et quelques centaines de lignes au lieu de 393 000.
3. **Un limiteur sur la route publique**, sur le modèle de `mdblist` :
   `createRateLimiter(20, 60_000)` par IP, avec `getClientIp`.

Enfin, `INTERVALS.FAST` (15 s) est un rythme de file d'attente Jellyseerr, pas d'une page d'état
qui dépend d'un cron : `INTERVALS.SLOW` (120 s) suffit et divise la charge par huit.

**Risque de la correction.** (1) change la sémantique : la page dirait l'état du dernier passage
du cron, pas de l'instant — jusqu'à `POLL_INTERVAL_MS` de retard. C'est un vrai changement pour
une page de diagnostic, à arbitrer ; un bouton « rafraîchir maintenant » qui, lui, force le
recalcul, rend les deux compatibles. (2) est un remplacement de requête à vérifier contre
`analyzeHistory` par un test sur des données réelles — la logique d'incident est subtile
(interruptions déduites de `POLL_INTERVAL_MS`). (3) est sans risque, sinon qu'un limiteur trop
serré ferait clignoter la page pour quelqu'un qui la garde ouverte : la valeur doit tenir compte
de `refreshInterval`.

---

#### F-009 — `/_next/image` est un proxy d'images ouvert, sans session

- **Localisation** : `next.config.js:13-17` ; `src/proxy.ts:146`, `:218-221`
- **Catégorie** : sécurité
- **Sévérité** : important

**Constat.**

```js
// next.config.js:14
images: { remotePatterns: [{ hostname: "**" }], … }
```

`**` autorise l'optimiseur d'images de Next à aller chercher **n'importe quel hôte**. Et le point
d'entrée n'est protégé par rien : `src/proxy.ts:146` laisse passer tout ce qui commence par
`/_next`, et le `matcher` (`:218-221`) exclut de toute façon explicitement `_next/image`.

**Preuve.** Requête sans cookie contre le conteneur en production :

```
GET /_next/image?url=https%3A%2F%2Fupload.wikimedia.org%2F…%2F120px-Commons-logo.svg.png&w=640&q=75
  ->  200  image/png  1 988 octets
```

Un hôte interne en `http://` est en revanche refusé (`"url" parameter is not allowed`) : sans
`protocol` explicite, Next restreint `remotePatterns` au HTTPS. La SSRF vers le réseau interne
n'est donc **pas** ouverte — c'est le relais vers l'Internet public qui l'est.

**Conséquence.** Toute personne capable d'atteindre le site peut lui faire télécharger, ré-encoder
(`sharp`, coûteux en CPU) et resservir n'importe quelle image du web, sous le nom de domaine du
foyer, avec `minimumCacheTTL: 31536000` — soit un an de conservation sur `./data`, le seul volume
inscriptible. Trois coûts : bande passante et CPU offerts, remplissage du disque, et du contenu
arbitraire servi depuis ce domaine. À rapprocher de F-011 : l'avis GHSA-q8wf-6r8g-63ch (déni de
service de l'optimiseur d'images via des SVG) vise exactement ce point d'entrée, ici accessible
sans authentification.

**Correction proposée.** Restreindre aux hôtes réellement utilisés. Un relevé rapide des sources
d'images distantes du dépôt donne `image.tmdb.org` et l'hôte des affiches Jellyseerr ; tout le
reste passe par `/api/jellyfin/image` (local, et déjà couvert par `localPatterns`) :

```js
remotePatterns: [
  { protocol: "https", hostname: "image.tmdb.org" },
  // … un objet par hôte réellement servi ; à établir en relevant les `src` distants
],
```

**Risque de la correction.** Une source d'image oubliée cesse de s'afficher — visible tout de
suite, sans effet sur la lecture. La liste doit être établie en relevant les hôtes effectivement
utilisés (TMDB, Jellyseerr, et toute vignette d'indexeur) plutôt que devinée, faute de quoi une
grille se vide en production.

---

#### F-010 — Aucune politique de sécurité du contenu (CSP)

- **Localisation** : `next.config.js:37-51`
- **Catégorie** : sécurité
- **Sévérité** : important

**Constat.** Six en-têtes de sécurité sont posés (`X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`, `X-DNS-Prefetch-Control`, `Strict-Transport-Security`) ;
`Content-Security-Policy` n'y est pas.

**Preuve.** `next.config.js:41-48` (la liste complète), et vérification sur la réponse réelle :

```
GET /login  ->  200,  aucun en-tête content-security-policy
```

**Conséquence.** Il n'y a **pas** de faille XSS connue à l'appui : les métadonnées Jellyfin (titres,
synopsis, noms de fichiers) sont rendues par React, qui échappe, et le balayage du dépôt ne trouve
qu'un seul `dangerouslySetInnerHTML` (`src/app/layout.tsx:84`), dont le contenu est une chaîne
littérale sans interpolation ; aucune affectation à `.innerHTML`, aucun `eval`, aucun `srcdoc`. Les
sous-titres sont dépouillés de tout balisage avant affichage
(`webcodecs/subtitleMarkup.ts:24-26`) et rendus comme texte.

La CSP n'est donc pas ici un correctif mais un filet : c'est ce qui limite les dégâts d'une
injection future, d'une dépendance compromise, ou d'une image servie par le relais ouvert de F-009.
Sur une application qui porte le jeton Jellyfin de dix-neuf personnes dans un cookie, l'absence de
filet est une décision à prendre sciemment, et rien dans le dépôt ne dit qu'elle l'a été.

**Correction proposée.** Un en-tête de plus dans le même bloc. Next 16 avec le compilateur React
injecte des styles en ligne, d'où `'unsafe-inline'` sur `style-src` ; le script en ligne de
`layout.tsx:84` demande soit un nonce, soit son hash :

```js
{
  key: "Content-Security-Policy",
  value: [
    "default-src 'self'",
    "script-src 'self' 'sha256-<hash du script de layout.tsx>'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://image.tmdb.org",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "frame-src https://www.youtube-nocookie.com",   // TrailerModal / loadYoutubeIframeApi
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
}
```

**Risque de la correction.** Réel, et c'est pourquoi la valeur ci-dessus est un point de départ et
non un correctif prêt à poser. Une directive trop serrée casse silencieusement une fonctionnalité :
`media-src blob:` est indispensable au lecteur natif (`URL.createObjectURL` sur le `MediaSource`,
`mseSource.ts:240`), `frame-src` à la bande-annonce YouTube, `img-src` aux affiches. À déployer
d'abord en `Content-Security-Policy-Report-Only` pendant quelques jours, en relevant les violations,
avant de basculer — sans quoi le premier symptôme sera un film qui ne démarre plus.

---

#### F-011 — Neuf avis de sécurité sur Next.js 16.2.10, dont un contournement du proxy

- **Localisation** : `package.json:21`
- **Catégorie** : sécurité
- **Sévérité** : important

**Constat.** `npm audit --omit=dev` sur l'arbre du dépôt (Node 24, conteneur jetable) signale
quatre vulnérabilités de sévérité haute, dont neuf avis portant sur `next` :

```
next  >=16.0.0 <16.2.11   (installé : 16.2.10, confirmé aussi dans le conteneur en production)
  GHSA-6gpp-xcg3-4w24  Middleware / Proxy bypass in App Router applications
  GHSA-q8wf-6r8g-63ch  Denial of Service in the Image Optimization API using SVGs
  GHSA-955p-x3mx-jcvp  Unauthenticated disclosure of internal Server Function endpoints
  GHSA-89xv-2m56-2m9x  SSRF in Server Actions on custom servers
  GHSA-p9j2-gv94-2wf4  SSRF in rewrites via attacker-controlled destination hostname
  GHSA-68g3-v927-f742 / GHSA-4633-3j49-mh5q  Cache confusion of response bodies
  GHSA-m99w-x7hq-7vfj  DoS in App Router using Server Actions
  GHSA-4c39-4ccg-62r3  Unbounded Server Action payload in Edge runtime
sharp  <0.35.0  (installé : 0.34.5, confirmé dans le conteneur)
  GHSA-f88m-g3jw-g9cj  CVE-2026-33327/33328/35590/35591 (libvips)
postcss  <=8.5.22  — build uniquement
```

**Conséquence.** Le premier est celui qui compte ici. `CLAUDE.md` pose `src/proxy.ts` comme
« la grille unique » : c'est lui, et lui seul, qui décide qu'une adresse exige une session et
qu'une écriture exige le rôle `admin`. Un contournement du proxy ne dégrade pas ce modèle, il le
supprime. L'avis mentionne Turbopack et une locale unique ; je n'ai pas pu établir si cette
installation remplit les conditions — Next 16 compile avec Turbopack par défaut, mais aucune
configuration `i18n` n'est déclarée (`next.config.js`), et l'avis ne détaille pas assez pour
trancher depuis le dépôt. **[HYPOTHÈSE]** sur l'applicabilité ; le reste (version installée,
existence de l'avis, plage affectée) est vérifié.

Le second (déni de service de l'optimiseur d'images par SVG) est adressable sans authentification
via F-009. Il est atténué par défaut : Next refuse d'optimiser du SVG sans
`dangerouslyAllowSVG`, qui n'est pas activé ici.

`sharp` 0.34.5 sert l'optimiseur d'images et la vignette de galerie
(`api/gallery/clara/[filename]/route.ts:18-24`), route **publique**. L'attaquant ne contrôle
cependant pas les octets de l'image : le nom de fichier est réduit par `path.basename` et doit
exister dans `/app/gallery/clara` (répertoire vide sur cette machine). Le risque pratique est donc
faible ici, réel sur une installation où la galerie est peuplée.

**Correction proposée.** `next` : `16.2.11`. C'est un correctif de version corrective, dans la
plage déclarée (`"next": "16.2.10"` est épinglé ; il faut donc l'écrire), qui ferme les neuf avis
d'un coup. `eslint-config-next` suit dans la même version. `sharp` : voir F-012, sa version n'est
aujourd'hui pas maîtrisée.

**Risque de la correction.** Faible mais non nul : une version corrective de Next reste une
version de Next, et ce dépôt a un lecteur qui dépend finement du comportement des routes, du
proxy et de l'optimiseur d'images. Le passage doit se faire par la porte habituelle
(`typecheck` + `lint --max-warnings=0` + `test`, puis lecture d'un fichier réel — `CLAUDE.md`
recommande `The Exorcist (1973)`), pas en confiance.

---

#### F-012 — L'image de production installe `sharp` sans version ni verrou

- **Localisation** : `Dockerfile:8`, `:45`
- **Catégorie** : robustesse / sécurité
- **Sévérité** : mineur

**Constat.**

```dockerfile
# :8   étape deps
RUN --mount=type=cache,target=/root/.npm npm install
# :45  étape runner
RUN --mount=type=cache,target=/root/.npm apk add --no-cache libstdc++ tzdata && npm install --no-save sharp
```

`npm install` (et non `npm ci`) autorise la résolution à s'écarter de `package-lock.json`.
`npm install --no-save sharp` est pire : aucune contrainte de version, aucune entrée de verrou,
et `--no-save` garantit qu'aucune trace n'en subsiste. La version de `sharp` qui tourne en
production est celle que le registre servait le jour du build.

**Preuve.** Les deux lignes ci-dessus. `sharp` n'apparaît ni dans les `dependencies` ni dans les
`devDependencies` de `package.json`, et le conteneur en production porte `0.34.5` — une version
que rien dans le dépôt ne demande et que rien n'y enregistre.

**Conséquence.** Deux builds du même commit peuvent produire deux images différentes : un audit
de dépendances fait sur le dépôt (F-011) ne décrit pas ce qui tourne réellement, et une régression
ou une compromission en amont entre dans l'image sans qu'aucun fichier versionné ne change. C'est
aussi ce qui explique que `sharp` reste en 0.34.5 alors que l'avis demande ≥ 0.35.0 : personne
n'a de ligne à modifier pour le faire monter.

**Correction proposée.** Déclarer `sharp` comme une dépendance ordinaire, épinglée, et installer
depuis le verrou :

```dockerfile
-RUN --mount=type=cache,target=/root/.npm npm install
+RUN --mount=type=cache,target=/root/.npm npm ci
…
-RUN … apk add --no-cache libstdc++ tzdata && npm install --no-save sharp
+RUN … apk add --no-cache libstdc++ tzdata && npm ci --omit=dev --ignore-scripts=false
```

avec `"sharp": "0.35.x"` ajouté aux `dependencies` et `serverExternalPackages` inchangé.

**Risque de la correction.** `npm ci` échoue si `package-lock.json` n'est pas exactement en phase
avec `package.json` — ce qui est le comportement voulu, mais transforme un build qui passait en
build qui casse tant que le verrou n'est pas régénéré. `sharp` porte des binaires natifs par
plateforme : le passage à 0.35 doit être vérifié sur `node:24-alpine` (musl), pas seulement en
local. À faire dans son propre commit, séparé du reste.

### 2.4 Lecteurs

---

#### F-013 — `startPlayback` n'a aucune garde de ré-entrance : la seconde négociation abandonne un `Hls` vivant

- **Localisation** : `src/components/PlayerHost.tsx:346-641`
- **Catégorie** : correctness / performance
- **Sévérité** : important

**Constat.** `startPlayback` traverse deux `await` — `detectCodecSupport()` (`:394`) et le POST
sur `/api/jellyfin/playback/start` (`:411`) — et ne vérifie à aucun moment, après eux, qu'un appel
plus récent ne l'a pas remplacée. La destruction de l'instance précédente a lieu **en tête**
(`:371-372`), l'affectation de la nouvelle **en queue** (`:579`) :

```ts
:371  hlsRef.current?.destroy();
:372  hlsRef.current = null;
      …
:394  const codecSupport = await detectCodecSupport();
:411  const res = await fetch("/api/jellyfin/playback/start", { … });
      …
:450  setPlaySession({ itemId, playSessionId: data.playSessionId, mediaSourceId: data.mediaSourceId });
      …
:579  hlsRef.current = hls;
:640  hls.attachMedia(video);
```

Deux appels A puis B se déroulent donc ainsi : A vide `hlsRef` et attend ; B vide `hlsRef` (déjà
nul) et attend ; A revient, crée `hls_A`, l'écrit dans `hlsRef` et l'attache ; B revient, crée
`hls_B`, **écrase** `hlsRef` et l'attache. `hls_A` n'est plus référencé par personne et n'a jamais
reçu `destroy()`.

**Preuve.** Quatre appelants peuvent se chevaucher, tous asynchrones et non sérialisés :

```
:693  changeAudio       -> startPlayback({ audioStreamIndex, resumeAt })     (hors WebKit)
:702  handleRetry       -> startPlayback({ resumeAt })                        (bouton « Réessayer »)
:745  effet de montage  -> startPlayback({ resumeAt, audioStreamIndex })
:883  échelle de repli  -> startPlaybackRef.current({ …, disableAudioCodecs }) via setTimeout
```

Aucun n'attend la promesse du précédent, aucun ne teste un drapeau. Le corps de la fonction
(`:346-641`) ne contient ni compteur de génération, ni `AbortController`, ni `if (cancelled)` —
là où la même équipe en a bien posé un dans le lecteur natif
(`ExperimentalPlayerHost.tsx:752` : `if (cancelled) return playback.destroy();`).

Le symptôme est d'ailleurs déjà nommé dans le fichier, ligne 893 : « les tentatives zombies que
chaque essai raté ci-dessus vient de créer ». La seule échappatoire écrite est un rechargement
complet de la page, et elle est conditionnée à `isWebKit()` (`:897`) : sur Chrome et Firefox,
c'est-à-dire sur le chemin hls.js, il n'y en a aucune.

**Conséquence.** L'instance orpheline conserve son `MediaSource`, ses tampons et ses chargeurs de
fragments, et **continue de télécharger** : deux flux HLS en parallèle pour un seul film, sur un
appareil qui vient déjà d'échouer une fois. Sur mobile, c'est le double de données et de mémoire
dans la fenêtre la moins favorable. L'échelle de repli audio (`:82-86`) fait jusqu'à trois
tentatives : jusqu'à trois `Hls` abandonnés pour une seule ouverture de film.

Le `playSessionId` retenu (`:450`) est de même décidé par l'ordre d'**arrivée** des réponses et
non par l'ordre des appels. La séance Jellyfin superflue, elle, est bien arrêtée : le nettoyage
d'effet de `usePlaybackSession` (`usePlaybackSession.ts:133-140`) émet un `stop` sur l'ancienne
séance dès que `playSessionId` change. Ce n'est donc pas le transcodage qui fuit ici — c'est le
client.

**Correction proposée.** Un compteur de génération, sur le modèle du `cancelled` du lecteur natif :

```ts
const playbackGeneration = useRef(0);
// …au tout début de startPlayback :
const generation = ++playbackGeneration.current;
// …après chaque await :
if (generation !== playbackGeneration.current) return;
// …et avant d'affecter hlsRef, en dernier recours :
if (generation !== playbackGeneration.current) { hls.destroy(); return; }
hlsRef.current = hls;
```

Trois lignes ajoutées après `:394`, après `:411`, et autour de `:579`.

**Risque de la correction.** Une négociation abandonnée en cours de route ne posera plus ni
`setPlaySession` ni les listes de pistes : si un appelant comptait sur ces effets de bord d'un
appel qu'il a lui-même remplacé, il ne les verra plus. C'est le comportement voulu, mais il faut
vérifier le cas du repli audio, qui rejoue volontairement la même requête (échelon 0) — le
compteur doit s'incrémenter à chaque appel, y compris à celui-là, sans quoi l'échelon se
neutraliserait lui-même.

---

#### F-014 — Un attachement `MediaSource` en échec abandonne le décodeur, l'encodeur, la connexion et l'URL d'objet

- **Localisation** : `src/lib/webcodecs/remuxPlayback.ts:185-215` ;
  `src/components/ExperimentalPlayerHost.tsx:1030-1065` ; `src/lib/webcodecs/mseSource.ts:236-252`
- **Catégorie** : performance / robustesse
- **Sévérité** : important

**Constat.** `RemuxPlayback.start` construit l'objet puis attache, et ne rend l'objet qu'après :

```ts
// remuxPlayback.ts:193-197
const playback = new RemuxPlayback(video, source, file, videoTrack, audioTrack, chosen.remuxer!, chosen, options);
await playback.attach(chosen.plan!, options.startSeconds);
return playback;
```

Si `attach` rejette, l'instance n'est jamais rendue — donc son `destroy()` (`:372-380`), qui est
le seul endroit appelant `remuxer.close()` et `source.close()`, ne peut plus être appelé par
personne. Et l'appelant ne rattrape rien non plus :

```ts
// ExperimentalPlayerHost.tsx:1030-1065
.then((probe) => {
  if (cancelled) { probe.discard(); return; }          // :1034 — seul chemin qui libère
  if (probe.path === "remux") { …; return startRemux(element, probe.start); }   // :1047
  …
})
.catch((cause: unknown) => {                            // :1055
  …
  fallToStable(message);                                // :1065 — on bascule, on ne libère rien
});
```

`probe.discard()` n'est appelé que dans la branche « annulé ». Le rejet de `startRemux` tombe dans
le `.catch`, qui bascule vers le lecteur stable sans jamais toucher `discard()`.

Côté `MseSource`, l'URL d'objet est créée **avant** l'opération qui peut lever :

```ts
// mseSource.ts:240-246
this.objectUrl = URL.createObjectURL(this.source as MediaSource);
this.video.src = this.objectUrl;
…
// :252  — lève NotSupportedError si le navigateur refuse le type MIME
this.videoBuffer = this.source.addSourceBuffer(this.plan.videoMimeType);
```

`URL.revokeObjectURL` ne vit que dans `destroy()` (`:1227-1230`), inatteignable dans ce cas.

**Preuve.** Les trois blocs ci-dessus. Le chemin d'échec n'est pas théorique : `pathSelector.ts`
ne valide le type MIME qu'avec `playabilityOf` (`:138-146`), qui repose sur
`MediaSource.isTypeSupported` — et `codecSupport.ts:7-12` documente précisément que cette API a
des faux positifs sur certaines versions de Firefox/Windows, « qui peut affirmer prendre en charge
un codec qu'il refuse ensuite d'attacher comme SourceBuffer ». C'est exactement le cas où
`addSourceBuffer` lève, ligne 252. Les appends d'initialisation (`:262-267`) peuvent également
rejeter.

**Conséquence.** À chaque échec d'ouverture par le chemin natif — sur Firefox/Windows, une des
cibles déclarées — l'onglet retient définitivement : un `Remuxer`, qui détient un `AudioDecoder` et
un `AudioEncoder` (ressources matérielles, dont le nombre simultané est plafonné par le
navigateur) ; un `HttpByteSource`, sa connexion et son index en mémoire ; un `MediaSource` que son
`blob:` maintient vivant, avec `video.src` pointant encore dessus. Une PWA qu'on ne recharge
jamais accumule cela film après film, et l'épuisement des encodeurs audio se manifestera plus tard
comme une panne du chemin natif sans rapport apparent avec sa cause.

**Correction proposée.** Deux verrous, chacun suffisant, tous deux souhaitables.

Dans `remuxPlayback.ts`, ne pas laisser un objet à moitié construit sans propriétaire :

```ts
   const playback = new RemuxPlayback(…);
-  await playback.attach(chosen.plan!, options.startSeconds);
+  try {
+    await playback.attach(chosen.plan!, options.startSeconds);
+  } catch (error) {
+    playback.destroy();
+    throw error;
+  }
   return playback;
```

Dans `mseSource.ts`, envelopper la suite de `open()` après la création de l'URL, pour que l'objet
ne survive pas à son propre échec d'ouverture :

```ts
   await opened;
   if (this.destroyed) return;
-  this.videoBuffer = this.source.addSourceBuffer(this.plan.videoMimeType);
-  …
+  try {
+    this.videoBuffer = this.source.addSourceBuffer(this.plan.videoMimeType);
+    …
+  } catch (error) {
+    this.destroy();
+    throw error;
+  }
```

**Risque de la correction.** `RemuxPlayback.destroy()` appelle `remuxer.close()` et
`source.close()` : si l'un lève sur un objet partiellement initialisé, l'erreur d'origine — celle
qui nomme le vrai motif à l'écran et dans le rapport technique — serait masquée. Le `throw error`
doit donc suivre un `destroy()` lui-même protégé, ou `destroy()` être rendu tolérant à un état
partiel (il l'est déjà pour `MseSource`, dont chaque étape est en `try`/`catch` ou en appel
optionnel — à vérifier pour `Remuxer.close()`).

### 2.5 Cache serveur et cycle de vie PWA

---

#### F-015 — `staleStore` n'est jamais purgé : une entrée par titre consulté, à vie

- **Localisation** : `src/lib/server-cache.ts:32`, `:71`, `:142`, `:153-170`
- **Catégorie** : performance
- **Sévérité** : mineur

**Constat.** Le cache tient deux tables. `store` porte les entrées vivantes ; `staleStore` porte
le dernier bon résultat, servi quand l'amont tombe. Toutes les fonctions d'invalidation ne
touchent que la première :

```ts
:31  const store      = new Map<string, Entry<unknown>>();
:32  const staleStore = new Map<string, StaleEntry<unknown>>();
…
:70    store.set(key, { v, exp: Date.now() + ttlMs });
:71    staleStore.set(key, { v, fetchedAt: Date.now() });
…
:153 export function invalidateKey(key: string)      { store.delete(key); }
:157 export function invalidateByPrefix(prefix)      { for (…) store.delete(key); }
:163 export function invalidateLibrary()             { store.delete(…); store.delete(…); }
```

Il n'existe aucun `staleStore.delete`, aucune expiration, aucune borne de taille — le seul
`.delete` du fichier porte sur `store`. `store` lui-même n'est purgé que par invalidation
explicite : une entrée expirée reste en mémoire jusqu'à ce que la même clé soit réécrite.

**Preuve.** Les lignes ci-dessus, plus le relevé des clés effectivement utilisées, dont la
cardinalité n'est pas bornée par le nombre de comptes mais par le nombre de titres :

```
mdblist:${imdbId}        js:movie:${tmdbId}       js:tv:${tmdbId}
jf:providers:${itemId}   sonarr:episodes:${seriesId}
```

**Conséquence.** Chaque film, série ou fiche jamais ouverte par l'un des dix-neuf comptes laisse
une charge utile complète en mémoire pour la durée de vie du processus. La bibliothèque compte
déjà 499 films et autant de séries à parcourir, et les fiches TMDB de découverte ne sont pas
limitées à ce qui est en bibliothèque : la cardinalité réelle est celle du catalogue TMDB
parcouru, pas celle de la médiathèque.

À relativiser honnêtement : `CLAUDE.md` décrit un conteneur recréé « plusieurs fois par jour »,
ce qui remet le compteur à zéro et empêche la fuite de devenir visible. C'est ce qui la classe
mineure — et aussi ce qui fait qu'elle ne se manifestera que le jour où l'on cessera de déployer
aussi souvent.

**Correction proposée.** Une borne, pas une expiration — la valeur d'une entrée stale est
justement d'être vieille :

```ts
const STALE_MAX_ENTRIES = 500;
function rememberStale(key: string, v: unknown) {
  // Map conserve l'ordre d'insertion : réinsérer remet l'entrée en fin, la plus ancienne sort.
  staleStore.delete(key);
  staleStore.set(key, { v, fetchedAt: Date.now() });
  if (staleStore.size > STALE_MAX_ENTRIES) {
    staleStore.delete(staleStore.keys().next().value as string);
  }
}
```

appelée aux lignes 71 et 142, et un `staleStore.delete(key)` ajouté dans `invalidateKey`.

**Risque de la correction.** Sous forte pression, une entrée stale peut être évincée avant qu'un
amont ne tombe : le repli « servir la dernière valeur connue » ne joue alors plus pour ce titre, et
l'appelant reçoit l'erreur au lieu d'une donnée périmée. C'est exactement le comportement d'avant
la première mise en cache, et `withCacheSafe` sait déjà le rendre (`:110`). La borne doit rester
généreuse pour que les clés fréquentes (`jf:movies:${userId}`, une par compte) ne soient jamais les
victimes — 500 laisse largement la place aux dix-neuf comptes plus le catalogue courant.

---

#### F-016 — Le cache du service worker grossit sans borne et n'est vidé que par un changement de version

- **Localisation** : `public/sw.js:86-100`, `:20-27`, `:11`
- **Catégorie** : performance
- **Sévérité** : mineur

**Constat.** Toute réponse GET qui n'est ni une API, ni une charge RSC, ni un document de
navigation est écrite dans le cache, sans condition de taille ni de nombre :

```js
:86   event.respondWith(
:87     fetch(event.request)
:88       .then((response) => {
:91         if (isDocument || !response.ok) return response;
:92         const copy = response.clone();
:95         caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
```

La seule suppression du fichier est dans `activate` (`:20-27`), et elle ne supprime que les caches
dont le **nom** diffère de `CACHE_NAME` — c'est-à-dire rien, tant que la constante ligne 11 ne
bouge pas. Il n'existe donc aucun chemin d'éviction en régime normal.

**Preuve.** Les deux blocs ci-dessus ; le fichier ne contient aucun `cache.delete`, aucun
`cache.keys()` autre que celui de `activate`.

**Conséquence.** Les affiches optimisées (`/_next/image?…`) tombent dans cette branche, et une
grille façon Netflix en produit des centaines par session de navigation. Le cache d'origine grossit
donc à mesure qu'on parcourt le catalogue, sans plafond côté application. Le navigateur finit par
appliquer son propre quota — et sur iOS, où le quota est étroit, l'éviction peut emporter tout le
stockage de l'origine, `PRECACHE` compris : la page hors ligne (`/offline.html`) disparaît
précisément dans la situation qui la rend utile.

`CLAUDE.md` interdit à raison de faire tourner `CACHE_NAME` sans motif ; ce n'est pas une éviction,
c'est une remise à zéro. Le correctif ne doit donc pas passer par là.

**Correction proposée.** Un second cache, borné, pour ce qui est volumineux et remplaçable, en
laissant `CACHE_NAME` aux ressources précachées et aux fragments `_next/static` (déjà immuables et
peu nombreux) :

```js
const RUNTIME_CACHE = "cine-app-runtime-v1";
const RUNTIME_MAX_ENTRIES = 300;

async function putBounded(request, response) {
  const cache = await caches.open(RUNTIME_CACHE);
  await cache.put(request, response);
  const keys = await cache.keys();          // ordre d'insertion
  for (const k of keys.slice(0, keys.length - RUNTIME_MAX_ENTRIES)) await cache.delete(k);
}
```

et faire écrire la branche `:95` dans `RUNTIME_CACHE` via `putBounded`. `activate` supprime déjà
tout cache au nom inconnu : il faut donc l'amender pour épargner celui-ci, sans quoi il se vide à
chaque activation.

**Risque de la correction.** L'amendement d'`activate` est le point délicat : mal fait, il
transforme un bump de `CACHE_NAME` en purge partielle et laisse survivre un cache d'une version
précédente — exactement ce que l'historique du fichier (`:1-10`) raconte avoir voulu éviter. La
liste des caches épargnés doit être explicite et versionnée elle aussi.

### 2.6 Vérifié et jugé sain

Consigné pour délimiter la couverture — ce sont des points que le cahier des charges demandait
d'examiner et sur lesquels il n'y a pas de finding à remonter.

- **XSS par les métadonnées Jellyfin.** Balayage complet : un seul `dangerouslySetInnerHTML`
  (`src/app/layout.tsx:84`), contenu littéral sans interpolation ; aucune affectation à
  `.innerHTML`/`.outerHTML` ; aucun `eval`, `new Function` ou `srcdoc`. Titres, synopsis et noms de
  fichiers passent par React. Les sous-titres — le seul texte qui arrive en balisage — sont
  dépouillés avant affichage (`webcodecs/subtitleMarkup.ts:24-26`) et rendus comme texte.
- **Injection SQL.** Toutes les requêtes de `src/lib/db.ts` sont paramétrées. Les deux seules
  interpolations (`:646`) portent sur un nom de table issu d'un littéral `as const` et sur une
  constante numérique.
- **Signature et chiffrement de session.** HMAC-SHA256 via `crypto.subtle.verify` (comparaison en
  temps constant), `jfToken`/`jsCookie` chiffrés en AES-GCM avec clé dérivée
  (`auth.ts:68-116`), `jti` de 128 bits aléatoires, révocation vérifiée en base à chaque requête
  (`session.ts:19`). Le secret par défaut fait échouer le démarrage (`instrumentation.ts:14-18`) —
  le `console.error` de `auth.ts:48-50` n'est qu'un doublon inoffensif, l'invariant annoncé par
  `CLAUDE.md` est bien tenu.
- **Usurpation d'IP sur les limiteurs.** `getClientIp` (`api-helpers.ts:12-17`) lit la **dernière**
  entrée de `X-Forwarded-For`, celle posée par le proxy, et non la première.
- **CORS.** Aucun en-tête `Access-Control-*` n'est émis nulle part : la politique d'origine unique
  du navigateur s'applique pleinement. C'est le bon défaut ici.
- **Redirection ouverte.** `/api/jellyfin/redirect` (`:10-15`) construit sa cible sur une base
  issue de la configuration ; le paramètre contrôlé par l'appelant n'atterrit qu'après le `#`, et
  ne peut donc pas changer d'hôte.
- **Chargement des affiches.** Le compromis `next/image` / `<img>` de `PosterImage.tsx` est
  délibéré et documenté (`:88`) : les vignettes déjà dimensionnées côté CDN évitent l'optimiseur,
  ce qui est le bon sens inverse de l'attente habituelle. Les grilles à forte densité portent
  `loading="lazy"`, les héros `priority`.
- **Rapport de position de lecture.** `usePlaybackSession` couvre `pagehide`, `beforeunload`,
  `visibilitychange` et le retour de cache-arrière (`pageshow` + `persisted`), avec `keepalive`.
  Le nettoyage d'effet émet bien un `stop` sur la séance remplacée (`:133-140`), ce qui exclut
  l'orphelin de transcodage côté serveur — voir F-013.
- **Branches spécifiques à un navigateur.** `isWebKitEngine` vs `canPlayType`, l'échelle de repli
  audio, le rechargement WebKit de `changeAudio`, `TRUST_BUFFER_REBUILD = false` : lues, comprises,
  et laissées telles quelles. Elles encodent des mesures que le code ne peut pas redémontrer, et
  aucune n'est apparue incorrecte à l'examen.

---

## 3. Synthèse

### 3.1 Findings par sévérité décroissante

| ID | Sévérité | Catégorie | Titre | Localisation |
|---|---|---|---|---|
| **F-004** | **critique** | sécurité | Traversée de chemin dans le proxy de flux → GET arbitraire sur Jellyfin avec la clé d'administration | `api/jellyfin/stream/[itemId]/[...path]/route.ts:50-51` |
| F-005 | important | sécurité | `mediaSourceId`/`index` non validés dans la route de sous-titres | `api/jellyfin/stream/subtitle/[itemId]/route.ts:22-31` |
| F-006 | important | sécurité | Trois routes de lecture interpolent un identifiant non validé | `streams/[itemId]:20`, `cinema/series/[jellyfinId]/episodes:60`, `cinema/progress/[itemId]:36` |
| F-008 | important | performance | `/api/status/public` : 330 ms de SQLite bloquant, sans session ni limite, sondé toutes les 15 s | `api/status/public/route.ts:16-33`, `db.ts:592-596` |
| F-009 | important | sécurité | `/_next/image` est un proxy d'images ouvert et non authentifié | `next.config.js:14`, `proxy.ts:146` |
| F-010 | important | sécurité | Aucune politique de sécurité du contenu | `next.config.js:37-51` |
| F-011 | important | sécurité | Neuf avis sur Next 16.2.10, dont un contournement du proxy | `package.json:21` |
| F-001 | important | correctness | `PlayMethod` annonce « DirectStream » sur un vrai transcodage 10 bits | `api/jellyfin/playback/start/route.ts:50-52,176-177` |
| F-002 | important | performance | Le palier mobile à 20 Mbps force un transcodage sur 38 des 499 films | `PlayerHost.tsx:108-113` |
| F-013 | important | correctness | `startPlayback` sans garde de ré-entrance : `Hls` orphelin jamais détruit | `PlayerHost.tsx:346-641` |
| F-014 | important | performance | Attachement `MediaSource` en échec : décodeur, encodeur, connexion et `blob:` abandonnés | `remuxPlayback.ts:185-215`, `ExperimentalPlayerHost.tsx:1030-1065` |
| F-007 | mineur | sécurité | `Cache-Control: public` sur des flux authentifiés | `stream/[itemId]/[...path]/route.ts:119,134` |
| F-012 | mineur | robustesse | L'image de production installe `sharp` sans version ni verrou | `Dockerfile:8,45` |
| F-015 | mineur | performance | `staleStore` n'est jamais purgé | `server-cache.ts:32,153-170` |
| F-016 | mineur | performance | Cache du service worker sans borne ni éviction | `public/sw.js:86-100` |
| F-003 | mineur | dette | Les deux négociations ne partagent aucun code ; vestige `Container` multi-noms | `direct/[itemId]:126-129` vs `playback/start:123` |

### 3.2 Les cinq chantiers prioritaires

**1. Fermer la traversée de chemin — F-004, F-005, F-006.**
Un seul défaut, trois expressions. N'importe lequel des dix-neuf comptes du foyer peut aujourd'hui
émettre un GET arbitraire contre Jellyfin authentifié par la clé d'administration ; la chaîne est
vérifiée maillon par maillon en F-004. C'est le seul finding critique et le seul qui n'a pas de
circonstance atténuante. Le correctif est une validation par segment posée avant toute
concaténation, plus le remplacement de la clé d'administration par le jeton du spectateur là où
c'est possible. Une seule fonction partagée, appelée par les cinq routes concernées, plutôt que
cinq expressions régulières recopiées — c'est exactement le motif que `CLAUDE.md` décrit comme
« la même décision prise à plusieurs endroits, et elles divergent ».

**2. Rendre au projet son objectif affiché — F-001, F-002.**
Cette application existe pour maximiser le DirectPlay sur un serveur sans GPU, et les deux findings
attaquent cet objectif par les deux bouts. F-002 fait partir en ré-encodage 38 films sur 499 dès
qu'on les ouvre depuis un téléphone, sur un seuil de débit que le commentaire du fichier désigne
lui-même comme trop bas. F-001 fait que ce ré-encodage — et tous les autres provoqués par une
condition de profondeur de bits — est rapporté comme une copie : le panneau construit pour
surveiller le transcodage est aveugle au cas qu'il devait attraper, et l'historique de Jellyfin
ment. Les deux corrections tiennent en quelques lignes ; c'est le rapport bénéfice/risque le plus
favorable de tout ce rapport.

**3. Réduire la surface non authentifiée — F-008, F-009, F-010.**
Trois portes ouvertes sur le même segment : une page d'état publique qui bloque la boucle
d'événements 330 ms par requête sans aucun limiteur, un optimiseur d'images qui relaie n'importe
quel hôte HTTPS sans session, et aucun filet CSP derrière les deux. Prises ensemble, elles font
qu'un tiers peut consommer le CPU, la bande passante et le disque du serveur — et arrêter la
lecture de tout le monde — sans jamais s'authentifier. Le limiteur de débit et la restriction de
`remotePatterns` sont sans risque et immédiats ; la CSP demande un passage en
`Report-Only` avant bascule, et l'agrégation SQL de F-008 demande un test contre `analyzeHistory`.

**4. Reprendre la chaîne de dépendances — F-011, F-012.**
Neuf avis ouverts sur Next, dont un contournement du proxy — c'est-à-dire du seul composant qui
tient tout le modèle d'autorisation. Le correctif est une version corrective (`16.2.11`). Dans le
même mouvement, faire de `sharp` une dépendance déclarée et épinglée et passer à `npm ci` : tant
que l'image de production installe une version non verrouillée au moment du build, tout audit de
dépendances décrit un arbre qui n'est pas celui qui tourne.

**5. Poser les gardes de cycle de vie dans les deux lecteurs — F-013, F-014.**
Les deux lecteurs abandonnent des ressources sur leur chemin d'échec : un `Hls` qui continue de
télécharger côté stable, un décodeur/encodeur/connexion/`blob:` côté natif. Ni l'un ni l'autre ne
casse une lecture qui marche — ce qui est précisément pourquoi ils sont restés invisibles — mais
tous deux s'accumulent dans une PWA qu'on ne recharge jamais, et le second épuise une ressource
plafonnée par le navigateur, dont la panne se manifestera loin de sa cause. Le lecteur natif a
déjà le motif à recopier (`if (cancelled) return playback.destroy()`), il ne l'applique pas au
chemin de rejet ; le lecteur stable n'a pas de compteur de génération du tout.

---

## 4. Portée et limites de cet audit

- **Vérifié dynamiquement, en lecture seule**, contre le conteneur et le serveur Jellyfin en
  production : le décodage des paramètres de route par Next, la normalisation des segments `..`
  par `fetch`, la réponse de Jellyfin aux points d'administration, les verdicts `PlaybackInfo`
  pour les deux profils de `buildDeviceProfile`, les débits et conteneurs réels de la
  bibliothèque, le coût SQL de `/api/status/public`, l'ouverture de `/_next/image`, l'absence de
  CSP, les versions installées de `next` et `sharp`, l'inventaire `npm audit`.
- **Vérifié par lecture seule** : proxy, authentification, sessions, clients amont, les deux
  lecteurs et leur cycle de vie, cache serveur, service worker, routes API.
- **Non couvert** : le détail bit-à-bit des boîtes MP4 et du démultiplexage Matroska
  (`mp4SampleEntries.ts`, `mp4Muxer.ts`, `matroska.ts`, `remuxer.ts`) — `DOC-TECH.md` et
  `bench.spec.ts` le documentent et l'exercent, et un survol y aurait produit du bruit plutôt que
  des findings ; le comportement réel sur appareil (aucun navigateur n'a été piloté) ; les 103
  routes API ont été balayées par classes de défauts (validation des paramètres, garde de session,
  interpolation vers l'amont) et non lues intégralement une à une.
- **Aucun fichier de code n'a été modifié.** Les correctifs proposés sont des diffs à appliquer,
  pas des diffs appliqués.
