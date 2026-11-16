# 3. Le côté client de « Lumen serveur »

Relevé sur `main` à `bea33981` (10.44.7), le 16/11/2026. Les numéros de ligne vieillissent ; les noms de
fonctions beaucoup moins. Aucune modification du dépôt n'a été faite pour cette section.

Vocabulaire : **Lumen** = le lecteur natif actuel (remultiplexage dans le navigateur → MediaSource) ;
**lecteur serveur** = `ActivePlayer` (négociation Jellyfin, HLS Jellyfin) ; **Lumen serveur** = le
nouveau chemin (remultiplexeur côté serveur, HLS fMP4 sans état, `<video src="….m3u8">` sur WebKit).

---

## 0. Ce qui conditionne tout le reste

Quatre faits, relevés dans le code ou dans `player.log`, décident de la plupart des choix ci-dessous.

1. **L'aiguillage vit déjà en un seul endroit, pur et testé** : `choosePlayer`
   (`src/lib/playerRoute.ts:18-54`), appelé une fois par `PlayerHost` (`src/components/PlayerHost.tsx:287`)
   après les deux cas tranchés avant lui (téléchargement hors ligne `:256-258`, configuration publique
   inconnue `:271`). Il rend `"native" | "chromecast" | "server"`.
2. **La page ne voit rien des requêtes du HLS natif de Safari.** Le chargeur média de WebKit fait ses
   requêtes lui-même : ni statut HTTP, ni en-tête, seulement un `MediaError` (code 2/3/4 et un
   message) et, « au mieux », `performance.getEntriesByType("resource")` (commentaire de tête de
   `src/lib/serverStartup.ts:1-12`, d'où `startup.firstSegment`). Toute mesure fine et toute cause
   d'échec côté flux doivent donc venir **du serveur**.
3. **WebKit et les séances HLS d'une même page.**
   - HLS natif **après** un lecteur MediaSource dans la même page : refusé (code 4, aucun segment
     demandé) — c'est pourquoi le relais natif → serveur recharge la page (`shouldReloadDirect`,
     `src/lib/serverReload.ts:1-18` et `:106`, appelé dans `PlayerHost.tsx:221-235`).
   - Changement de piste du lecteur serveur par une nouvelle négociation : refusé
     (`SRC_NOT_SUPPORTED`), d'où le rechargement protégé de `changeAudio` (`PlayerHost.tsx:1715-1769`,
     « Do not change » dans CLAUDE.md).
   - En revanche, **HLS natif après HLS natif, élément remonté** (épisode suivant du lecteur serveur)
     marche : un iPhone iOS 18.4, MacGyver S01E04 → S01E05 le 08/11/2026 — `stop why:"next"`
     14:11:04.9, `fallback` du natif (AV1 refusé avant toute MediaSource), `start player:"serveur"
     why:"handover" hls:"natif"` 14:11:05.8, séance poursuivie jusqu'au `stop why:"lost"` 17:17.
     Même séquence les 05/11 et 06/11. Et MediaSource **après** HLS natif marche aussi : c'est le
     retour de diffusion AirPlay (`stepBack`, `src/lib/useStableFallback.ts:266`), validé.
4. **Les empreintes enregistrent des sorties, pas l'ordre des hooks** (`src/__tests__/empreinte/README.md`) :
   chaque ligne du journal, chaque `fetch` (sauf SWR, simulé : `empreinte-serveur.test.tsx:67-77` rend
   `undefined` sans requête pour toute clé inconnue), chaque écriture `storage set|remove` d'une clé
   `cine*` (`recorder.ts:168-178` ; **les lectures ne sont pas enregistrées**), chaque ordre donné à
   l'élément, et le résumé ARIA des commandes. Conséquence : un nouveau composant jamais monté ne
   change rien ; un champ ajouté à une fonction partagée doit être **absent** (pas `undefined` écrit à
   une autre place, pas un ordre de champs changé) tant que l'option est coupée.

---

## 1. Où brancher le choix

### 1.1 Recommandation : une quatrième route de `choosePlayer`, un hôte à part

**Pas avant `PlayerHost`.** `PlaybackProvider` ne connaît ni les relais (`handedOver`, `takeover`), ni
la configuration du serveur ; c'est `PlayerHost` qui les possède (`docs/cycle-de-vie-lecteur.md`,
« Les trois couches »). Choisir plus tôt obligerait à dupliquer les règles « un relais ou une
diffusion passe avant » — exactement la dette que DECISIONS §115 a fermée.

**Une route `"lumen"` dans `choosePlayer`**, prise seulement là où la route serait aujourd'hui
`"native"` :

```
offline → OfflinePlayerHost              (inchangé, PlayerHost.tsx:256)
serverFallback === undefined → rien      (inchangé, :271)
choosePlayer :
  useNative faux (handedOver, cast, lighter, reloadedOnServer) → chromecast | server   (inchangé)
  useNative vrai :
    ctx.lumen === true  → "lumen"        (nouveau ; ctx.lumen absent → "native", comme avant)
    sinon              → "native"
```

`ctx.lumen` est calculé par `PlayerHost`, jamais par `choosePlayer` (qui reste pur) :

- l'option de l'appareil est allumée (voir 1.3) ;
- `playsHlsNatively()` (`src/lib/webkitEngine.ts:44`, DECISIONS §23 : « WebKit », pas « sait lire du
  HLS ») — phase 1 sans hls.js ; Chrome/Firefox d'un administrateur restent sur Lumen ;
- ni `session.bench` (le banc mesure Lumen), ni `session.labSample` ;
- le titre n'est pas dans `lumenDeclined` (liste de la page, voir §3) ;
- **la page n'a pas encore servi de MediaSource** (fait 3 : un HLS natif après Lumen dans la même page
  est le refus code 4 connu). Un drapeau de module posé par `ExperimentalPlayerHost` au premier
  `probe.start` suffit ; phase 1 : on retombe sur Lumen sans rien dire (plutôt qu'un rechargement).

Une scène ouverte depuis une réplique (§91) peut passer par Lumen serveur : `useSceneMode` est
indépendant de l'hôte.

**Un hôte à part, `LumenServerHost`**, et non un mode d'`ActivePlayer` :

| | Mode d'`ActivePlayer` | Hôte à part (recommandé) |
|---|---|---|
| Empreintes `serveur` | `ActivePlayer` est monté réellement par `empreinte-serveur.test.tsx` : chaque branche ajoutée est un risque d'écart (un effet de plus, un `setState` de plus, une ligne déplacée) | aucune : jamais monté par les empreintes existantes |
| Ce qui s'applique | ~60 % d'`ActivePlayer` ne concerne pas Lumen serveur : négociation Jellyfin, échelle audio (`audioLadder.ts`, `useElementErrorLadder`), version allégée et préchauffage (§78), hls.js et ses relances (`wireServerHls`, `hlsRecovery`), `warmSegmentAt`, marche H.264 | seulement ce qui sert |
| Clé de montage | `openId` (enchaîne les épisodes sans démonter) | `${itemId}:${openId}`, comme le natif : un épisode = un nouvel élément = une nouvelle séance HLS, ce que le fait 3 montre sûr |
| §24 (retour d'arrière-plan) | « Différent exprès » : le lecteur serveur ne l'applique pas | doit l'appliquer : c'est une lecture, pas une diffusion |
| Dérive des décisions | aucune | réelle — à fermer par des fonctions partagées (§6, DECISIONS) |

L'hôte s'assemble avec les pièces **déjà sorties** pour être partagées :
`src/components/player/server/` (`useServerSessionRecord`, `useServerStopOnLeave`, `useServerTimeline`,
`useServerSessionWaits`, `useServerPositionWatch`, `serverTracks`, `ServerPlayerIntro`,
`ServerPlayerScreens`, `serverElement.withStartFragment` / `releaseHlsElement`), `src/components/player/session/`
(`useWatchedClockRun`, `intendedPosition`, `habitWatch.recordsResume`, `dualSubtitleRules`,
`stallSignals`), `src/components/player/playerClose.ts` (`closePlayerSession`, `advanceTo`, `claimOnce`),
`src/lib/backgroundReturn.ts` (`BackgroundWatch`), `src/lib/hostSeek.ts`, `PlayerControls` tel quel.

### 1.2 Ce qu'on réutilise du lecteur serveur, point par point

| Besoin | Pièce existante | Réutilisable ? |
|---|---|---|
| Commandes, barre, menus, raccourcis, Media Session, PiP, « À l'écran », question, « Jusqu'ici », minuterie | `PlayerControls` (`PlayerHost.tsx:2622-2659` pour l'appel serveur ; `useSystemPip` `PlayerControls.tsx:656`, `useMediaSession` `:1013`, X-Ray `:708-709`) | **oui, tel quel** — tout y est déjà commun aux trois lecteurs |
| Ouverture animée | `ServerPlayerIntro` (`PlayerHost.tsx:2585-2617`) | oui |
| Reprise | `resolveResumeAt` + `openingPosition` (`PlayerHost.tsx:1956-2000`, `src/lib/resumePosition.ts`) | oui, même règle `resumeAt: 0` / absent |
| Rapport à Jellyfin | `usePlaybackSession` (`src/lib/usePlaybackSession.ts:129`) | oui, mais **comme le natif** (`announce: true`, `ExperimentalPlayerHost.tsx:1541-1561`) : aucune négociation Jellyfin n'annonce la séance |
| Bilan `stop`, arrêt gardé pour iOS | `useServerSessionRecord` / `useServerStopOnLeave` (`player/server/useServerSessionRecord.ts:25`, `:162`) | oui, avec un contexte `player: "lumen-serveur"` (voir §4) |
| Sous-titres `<track>` + synchro §141 | `serverSubtitleTracks` (`player/server/serverTracks.ts`) ; URL `/api/jellyfin/stream/subtitle/…&sync=` construite par la route (`start/route.ts:393-414`) | oui : la négociation Lumen serveur rend `subtitleTracks` **sous la même forme** |
| Deux sous-titres §87 | `useServerDualSubtitles`, `SubtitleLayer` (`PlayerHost.tsx:2499-2507`) | oui |
| Passage rejoué §150 | `replayTrack`/`showReplay` (`PlayerHost.tsx:1879-1907`), `pickReplaySubtitle` | oui (modes des `<track>`) |
| Libellés de pistes | `serverAudioTracks` / `trackLabel.ts` | oui |
| Route AirPlay, diffusion | `useCastRoute`, `castUrl` signé | **non en phase 1** (voir 2.11) |
| Échelle audio, version allégée, hls.js, préchauffage, rechargements Jellyfin | `audioLadder`, `lighterPrewarm`, `wireServerHls`, `serverReload` | non |
| Rechargement WebKit pour une seconde séance HLS | `reloadServerPage` / `audioReloadIntent` (`serverElement.ts:62`, `:111`), relu par `PlaybackProvider` | **le mécanisme oui** (intention en `sessionStorage`), avec un drapeau `lumen: true` dans l'intention et une route qui le relit — seulement en dernier recours (2.3) |

### 1.3 L'option, par appareil, sans toucher aux empreintes

**Stockage** : `localStorage["cine:lumen-serveur"] = "1"`, sur le modèle exact du simulateur d'iPad
(`src/lib/ipadSimulator.ts:15-45` : clé `cine:`, lecture sous `try/catch`, absence = coupé). Rangée par
appareil, jamais par compte, comme le choix d'interface (`useIsMobile.ts:73-91`, DECISIONS §106).
Un module `src/lib/lumenServer.ts` : `lumenServerOn()`, `setLumenServer(on)`.

**Panneau Compte** : une ligne dans le groupe administrateur (`PlayerAccountPanel.tsx:225-282`), avec
`Toggle` comme `DisplayRows` (`:370-388`), titre « Remuxage serveur », aide « Sur cet appareil :
Safari lit le film remultiplexé par le serveur, quand le fichier s'y prête. » Lue avec
`useSyncExternalStore(noSubscribe, lumenServerOn, () => false)` comme `InterfaceRow` (`:401-403`). Pas de
rechargement nécessaire : l'option vaut **à la prochaine ouverture**. Hors WebKit, la ligne reste
visible mais dit « Safari seulement » (sinon un administrateur sur Chrome croirait tester). Clés dans
les quatre langues (`player.account.lumenServer`, `…Hint`, `…SafariOnly`) ; aucun mot interdit
(« dashboard », « stack »).

**Lecture dans `PlayerHost`, figée par séance** : `const lumenWanted = lumenChoiceFor(session)` — une
`WeakMap<PlaybackSession, boolean>` qui lit `localStorage` à la première demande pour cet objet
`session` et ne la relit plus. Raisons : (a) le point fragile n° 9 du cycle de vie (« un changement
de préférence en plein film change de lecteur sans relais ») — basculer l'option pendant un film ne
doit rien faire ; (b) l'épisode suivant (`advance` remplace l'objet) relit, ce qui est voulu.

**Pourquoi les empreintes ne bougent pas** :
- pas de `useSWR` nouveau ni de `fetch` dans `PlayerHost` pour savoir si le compte est
  administrateur — l'interface ne protège rien ; c'est la route Lumen serveur qui refuse un compte
  non administrateur (le refus devient un déclin silencieux, §3) ;
- une lecture de `localStorage` n'est pas enregistrée, et la clé est absente dans les scénarios ;
- `choosePlayer` ne lit `ctx.lumen` que s'il est vrai ;
- rien n'écrit `cine:lumen-serveur` hors du panneau.

Un appareil partagé où un administrateur a allumé l'option puis où un autre compte se connecte : la
route répond 403 → déclin → Lumen, un aller-retour perdu. Acceptable en phase 1 ; on peut aussi
effacer la clé à la déconnexion (`useSignOut`).

---

## 2. Le comportement attendu

### 2.1 Ouverture et reprise
- **Position** : même règle que les deux hôtes. `session.resumeAt` est une affirmation (zéro compris) ;
  absent → `resolveResumeAt(itemId)` ; recul d'ouverture `openingPosition` une seule fois
  (DECISIONS §28) ; pas de recul pour un relais ni une scène (`recordsResume`). Écrit une fois,
  appelé par les deux.
- **Négociation** : `POST /api/player/lumen/start` (nom à fixer avec la partie serveur) avec
  `{ itemId, resumeAt, audioStreamIndex?, subtitleStreamIndex?, codecSupport, displayHdr, scene?, sessionId }`.
  `codecSupport` = `detectCodecSupport()` (`src/lib/codecSupport.ts`), qui pose déjà les questions
  `canPlayType` sur WebKit (§23) ; `displayHdr` = `matchMedia("(dynamic-range: high)")`. La réponse a
  **la forme de celle du lecteur serveur** (`start/route.ts:495-560`) : `manifestUrl`, `subtitleTracks`,
  `audioTracks` (avec `delivered`/`copied` en plus), `introSkip`/`recapSkip`/`creditsStart`, `title`,
  `originalLanguage`, et un `playbackInfo` pour le panneau — plus `lumenSession` (identifiant qui
  porte les mesures serveur, §4). Un refus : `409 { lumen: false, reason }` → déclin (§3).
- **Élément** : `video.src = withStartFragment(manifestUrl, resumeAt)` (`serverElement.ts:31`) — `#t=` a
  prouvé avec Jellyfin que Safari demande le segment de la reprise d'abord (`diag.resumeFragment`,
  `startup.firstSegment`) ; puis `load()` et `play()` avec la gestion `NotAllowedError`
  (`PlayerHost.tsx:1552-1561`). Attributs : `playsInline`, `autoPlay`, et en phase 1
  `x-webkit-airplay="deny"` + `disableRemotePlayback` (2.11).
- **Démarrage depuis le début** : la retenue d'ouverture (`openingHold`, 57 départs figés sur 377) est
  propre à MediaSource ; ici, `ServerPlayerIntro` couvre jusqu'à `loadeddata`.
- **Chien de garde** : 20 s sans image → déclin vers Lumen (§3) ; le message « toujours en cours » à
  `loadingLong` comme le lecteur serveur.

### 2.2 Sauts
Écrits sur l'élément par `PlayerControls` (`currentTime`), servis par Safari, qui demande le segment
qui contient la cible. Rien à piloter. L'hôte mesure chaque saut avec `HostSeek`
(`src/lib/hostSeek.ts`) : `seeking` → cible notée ; `seeked`/`playing` → `tookMs`. **Une ligne `seek`
par saut comme Lumen** (`from`, `to`, `buffered`, `ranges` = `element.buffered`, `tookMs`) — c'est la
mesure qui compare les chemins (`docs/bench-comparatif.md` : 0,34 s médiane natif). `intendedPosition`
pour le bilan et le rapport pendant un saut qui charge (§115).

### 2.3 Changement de piste audio
**Toutes les pistes livrables sont déclarées dans la liste maître** (`EXT-X-MEDIA:TYPE=AUDIO`), la
piste d'ouverture marquée `DEFAULT=YES`. Le menu change de piste par
`video.audioTracks[i].enabled = true` : **aucune nouvelle séance HLS**, donc ni renégociation ni
rechargement WebKit — c'est le gain principal sur le lecteur serveur (~9,5 s d'écran noir mesurés
chez Jellyfin iOS, `bench-comparatif.md`).

Points à fixer avec la partie serveur et à **mesurer sur iPhone** avant d'y croire :
- **Correspondance menu ↔ `AudioTrackList`** : par `label` (le `NAME` porte un jeton stable, par
  exemple l'index Jellyfin) plutôt que par l'ordre, que rien ne garantit.
- **Codecs différents** (AC-3 copiée, AAC ré-encodée, E-AC-3) : la spécification HLS veut un groupe
  par codec et des variantes par groupe ; Safari n'expose dans `audioTracks` que le groupe de la
  variante courante. Si deux pistes ne sont pas dans le même groupe, le changement **n'est pas** un
  simple `enabled`. Option sûre pour la phase 1 : un seul groupe, de codecs que Safari accepte
  ensemble ; une piste hors groupe passe par le repli ci-dessous.
- **`applied`** : une piste que le navigateur refuse laisse jouer l'autre (CLAUDE.md, ligne `audio`).
  Vérifier `audioTracks[i].enabled` et la progression de l'horloge 2 s après.

Repli, dans l'ordre : (1) piste dans la liste → `enabled` ; (2) sinon, nouvelle négociation avec
`audioStreamIndex` dans un **élément remonté** (le fait 3 dit qu'une seconde séance HLS en page marche
après remontage pour un épisode ; le commentaire de `changeAudio` dit le contraire pour un changement
de piste Jellyfin — à trancher au banc) ; (3) sinon, rechargement avec intention
(`lumen: true`, position, piste, sous-titre), relu par `PlaybackProvider` et `choosePlayer`
(`reloadedOnLumen` à côté de `reloadedOnServer`). Ligne `audio` à chaque fois, `via`
`"rendition" | "renégociation" | "rechargement"`.

**La piste d'ouverture** (§3) : la langue demandée, ce que le chemin porte, les canaux **livrés**, la
copie, le drapeau, l'ordre. Le serveur la choisit avec `chooseAudioTrack`/`rank`
(`src/lib/trackPreferences.ts`) sur ce que Safari porte (le `codecSupport` envoyé) ; le menu doit la
retrouver par la même fonction et les mêmes faits (`delivered` dans `audioTracks`), sinon la bascule
d'ouverture revient. La langue retenue par série (§110, `noteSeriesLanguage`) se note au changement,
comme `changeAudio` (`PlayerHost.tsx:1719`).

### 2.4 Sous-titres
**Phase 1 : `<track>` par la route existante**, exactement comme le lecteur serveur
(`PlayerHost.tsx:1502-1545` et `:2496-2498`) :
- la synchro §141 vient gratuitement (`&sync=` posé par la route de négociation, `start/route.ts:390-414`) ;
- deux sous-titres (§87) et le passage rejoué (§150) jouent sur les modes des `<track>` — déjà écrit ;
- le style du compte (`subtitleStyleStore`) et la hauteur au-dessus des commandes (§72) restent ceux
  du lecteur serveur.

Pas de WebVTT dans la liste maître en phase 1 : Safari l'exposerait comme une seconde série de
`textTracks`, mêlée aux `<track>`, et le menu, §150 et §87 se tromperaient de piste. Il ne devient
utile que pour AirPlay (le téléviseur ne voit pas les `<track>`) — phase 2, avec la diffusion.

Sous-titres en images (PGS, VobSub) : Lumen serveur ne les incruste pas. Choisis au menu → relais au
lecteur serveur avec le sous-titre (`handOver`, comme une piste que Lumen ne porte pas). Les sous-titres
forcés : la même règle (drapeau ou titre seul, CLAUDE.md) que le serveur applique à `isForced`.

« Générer des sous-titres » (§69-70) : le lecteur serveur en a déjà l'entrée ; à reprendre telle quelle.

### 2.5 « À l'écran » / X-Ray, question, « Jusqu'ici »
Rien à faire dans l'hôte : `PlayerControls` lit les scènes (`useXrayScenes(itemId)`) et la position
de l'élément. La commande d'analyse part de la ligne `start` (`src/app/api/player/log/route.ts:65`) :
elle doit porter `itemId` et `at`, et `player` ≠ `"hors-ligne"` — c'est le cas. Le bilan `stop` porte
`xray` et `sceneRestart` par `useServerSessionRecord` (`:112-113`). `replaySubs` (§150) : le même
relevé que le lecteur serveur.

### 2.6 Épisode suivant
`session.getNextEpisode` → `PlayerControls` (carte du générique, bouton, menu Épisodes) →
`advanceTo` (`playerClose.ts`, §114). Clé `${itemId}:${openId}` : nouvel hôte, nouvel élément, nouvelle
négociation. **Préparation** (remplace les 16 Mio gardés en OPFS une minute avant la fin) : une
minute avant la fin, `POST /api/player/lumen/prepare { itemId: suivant }` — le serveur lit en-tête et
index et prépare le premier segment ; rien ne part du navigateur.

### 2.7 Fin du film
`ended` → arrêt Jellyfin (une fois, `claimOnce`), écran de fin et saga (§44) par `PlayerControls`,
fermeture sans épisode suivant. `releaseHlsElement` (`serverElement.ts:13`) à la fermeture quand
l'élément n'a pas d'image — sinon iOS continue de demander des segments ~30 s (26/10/2026), ce qui
coûterait ici du remultiplexage serveur pour rien.

### 2.8 Progression vers Jellyfin
`usePlaybackSession` avec `announce: true` (Jellyfin ne sait rien de cette lecture), `client:
PLAYBACK_CLIENTS.engine` (« Lumen by Laterna »), `playMethod: "DirectStream"` (le fichier est
remultiplexé, ni transcodé ni lu tel quel), `playSessionId` distinct de celui du natif
(`lumen-serveur-${itemId}`) pour que les statistiques séparent les chemins. Rien pour un banc ni une
scène (§91). Battement 30 s, comme les autres (§84). Avant un relais vers le lecteur serveur, l'arrêt
de cette séance-là part (le lecteur serveur annonce la sienne en négociant).

### 2.9 Image dans l'image
`useSystemPip` (`PlayerControls.tsx:656`, §123) : rien à faire. Avec un `src` HLS natif, Safari
(onglet) accepte la PiP ; l'app installée reste soumise au défaut d'Apple (WebKit 303885, 280627) —
la question préfixée y répondra faux comme aujourd'hui.

### 2.10 Arrière-plan, écran verrouillé
- iOS met en pause toute vidéo cachée dans l'app installée (§123) ; rien ne change.
- **Pas de source perdue** : il n'y a plus de `ManagedMediaSource` qu'iOS ferme ; au retour, Safari
  redemande ses segments. `backgroundRebuilds` disparaît de fait.
- **§24 s'applique** (Lumen serveur est une lecture) : `BackgroundWatch` — au-delà de 5 s d'absence,
  attendre en pause 3 s avant ; refuser la relance spontanée de WebKit au déverrouillage. C'est
  l'écart voulu avec `ActivePlayer`, à écrire dans DECISIONS §24.
- Le bilan gardé sur l'appareil pour une page tuée (`unsentStop`, `why:"lost"`) vient avec
  `useServerStopOnLeave`.

### 2.11 AirPlay et diffusion
Le gain potentiel est réel — un `src` HLS est exactement ce qu'AirPlay tend au téléviseur — mais il
demande ce que la diffusion du lecteur serveur a mis des semaines à obtenir : adresse **absolue et
signée** (laissez-passer de `castToken.ts`), segments réécrits avec le jeton, route ouverte aux
requêtes sans cookie (`castPassFor`), codecs que l'Apple TV accepte. Sans cela, le bouton AirPlay du
système tendrait l'adresse relative à cookie : 401 au téléviseur, le scénario des 624 refus du
24/09/2026 (`start/route.ts:463-482`).

**Phase 1** : `x-webkit-airplay="deny"` et `disableRemotePlayback` sur l'élément ; le bouton
« Diffuser » de `PlayerControls` (`onCastRequest`) fait comme le natif
(`ExperimentalPlayerHost.tsx:3071-3097`) : `handOver("diffusion demandée", { …position, cast: true,
castSubtitle })` → lecteur serveur, retour par `stepBack` → la route se recalcule (Lumen serveur si
toujours éligible). Chromecast : idem. **Phase 2** : `castUrl` signé pour Lumen serveur, lignes `cast`.

### 2.12 Media Session
`useMediaSession` est dans `PlayerControls` (`:1013`) : titre, illustration, lecture/pause, ±10 s,
position. Avec le HLS natif, l'écran verrouillé d'iOS reçoit ces actions comme pour le lecteur serveur.

### 2.13 Hors ligne
Non concerné : `session.offline` part vers `OfflinePlayerHost` avant tout aiguillage
(`PlayerHost.tsx:256-258`). (Un jour, le remultiplexeur serveur pourrait préparer les téléchargements
à la place de Jellyfin — hors sujet.)

---

## 3. Le repli

Le principe : **avant la première image, le chemin d'aujourd'hui (Lumen) ; après, le lecteur serveur
Jellyfin** — parce qu'un échec après l'image vient presque toujours des octets que le même
remultiplexeur produirait aussi dans le navigateur, alors qu'un échec avant l'image est le plus
souvent un refus ou une panne du chemin neuf.

| Situation | Signal côté page | Décision | Ligne |
|---|---|---|---|
| Option allumée, fichier non éligible (codec, conteneur, compte non admin, service coupé) | `409 { lumen:false, reason }` / 403 / 404 | **déclin** : titre ajouté à `lumenDeclined`, la route redevient `"native"` (`ExperimentalPlayerHost` se monte sur le même `openId`) ; aucun `src` n'a été posé, donc aucune séance HLS ouverte | `fallback`, `player:"lumen-serveur"`, `to:"natif"`, `planned:true`, `reason:"remux serveur refusé : …"` |
| Négociation en panne (5xx, réseau) | `fetch` rejeté / 5xx | déclin, même chose | `fallback` `planned:false` |
| Liste ou premier segment refusés, code 4, ou pas d'image en 20 s | `error` de l'élément (`MEDIA_ERR_SRC_NOT_SUPPORTED`) / chien de garde | `releaseHlsElement`, puis déclin vers Lumen **dans la page** (MediaSource après HLS : marche, fait 3) ; Lumen garde ensuite toutes ses règles (connexion lente §78, bascule serveur) | `fallback` `to:"natif"`, `startup.stage` |
| Après l'image : erreur de décodage (code 3) ou code 4 | `error` de l'élément | interroger le serveur (ci-dessous), puis `handOver(raison, { resumeAt, audioStreamIndex, subtitle })` → lecteur serveur Jellyfin, par le chemin éprouvé (`shouldReloadDirect` → rechargement direct sur WebKit, `server: true`, la page rouverte ne revient jamais à Lumen serveur puisque `reloadedOnServer` passe avant) | `fallback` `to:"serveur"`, `takeover`, `watched` |
| Après l'image : réseau (code 2, ou attente sans fin) | `waiting` qui dure, `error` code 2 | Safari réessaie seul ; notre borne `NETWORK_OUTAGE_GIVE_UP_MS` (48 s, `src/lib/networkOutage.ts`) → écran « La lecture a été interrompue », « Réessayer » = nouveau `src` au `lastKnownTime` dans un élément remonté (`start why:"retry"`). Un second échec → lecteur serveur | `error` puis `start` |
| Blocage (horloge figée en lecture, avance vide) | `waiting` sans `playing`, `buffered` | 5 s : ligne `stall` ; 35 s sans reprise alors que le réseau répond → relais au lecteur serveur | `stall`, puis `fallback` |
| Zone illisible du fichier (§93) | rien côté page (le segment échoue) | le serveur la connaît (il remultiplexe) : son état le dit, relais au lecteur serveur à la position de reprise après la zone, comme §93 | `fallback` avec `zoneSeconds`, `reason` §93 (`isUnreadableZoneReason` la reconnaît, et le diagnostic dit « fichier ») |

**Le canal d'état du serveur.** Le fait 2 interdit de lire la cause dans la réponse du segment. Sur
toute erreur ou tout blocage, l'hôte demande `GET /api/player/lumen/session/<lumenSession>` (une
requête, bornée à 2 s, dans sa propre garde : « une vérification sur le chemin d'erreur ne devient
jamais l'erreur », CLAUDE.md) : dernière erreur de remultiplexage, zone illisible et sa fin, Jellyfin
injoignable, dernier segment servi et quand. La décision de la table s'appuie dessus ; sans réponse,
la table seule.

**Pas de boucle** : `lumenDeclined` (page entière, par titre) est posé à tout repli ; un titre passé
au lecteur serveur est dans `handedOver`, qui passe avant de toute façon. Une seule relance en place
(« Réessayer »), jamais d'échelle. `PLAYER_SERVER_FALLBACK=false` : les cas « vers le serveur »
deviennent un écran d'erreur (ligne `error`), comme `fallToStable` sans lecteur serveur ; le déclin
vers Lumen reste possible.

**Le point de contrôle.** Comme `restart` pour le natif, un seul `fallTo(target, reason, takeover?)`
dans l'hôte, une seule fois (`claimOnce`), refusé pendant la fermeture (point fragile n° 5 du cycle de
vie) ; `PlayerHost` lui passe `onDecline(reason, sessionId)` (natif) et `onFallback` = `handOver`
existant (serveur).

---

## 4. Le journal

### 4.1 Les lignes de la page

Toutes avec `player: "lumen-serveur"`, `path: "remux-serveur"`, `session`, `agent`, `build` — via
`ServerPlayerContext` (`serverPlayerLog.ts:96-127`) étendu d'un champ optionnel `player` ;
**`base()` (`:275-284`) écrit `"serveur"` à la même place quand il est absent**, donc les lignes du
lecteur serveur et ses empreintes restent identiques. Valeur distincte, et non `player:"serveur"`
avec un autre `path` : la page d'activité compte `serveur` comme « Jellyfin transcode ou
remultiplexe », et le diagnostic fichier-ou-appareil doit pouvoir traiter Lumen serveur comme ce
qu'il est — une lecture du **fichier** par **notre** remultiplexeur.

| Ligne | Quand | Champs |
|---|---|---|
| `start` | chaque `src` posé | `why` (`open`, `retry`, `audio`, `audio-reload`, `reload` ; vocabulaire de `ServerStartWhy`, sous-ensemble), `at`, `audioStreamIndex`, `hls:"natif"`, les faits du fichier comme le natif (`container`, `video`, `range`, `audio` livré, `copied`), `displayHdr`, `startup.*` (`ServerStartup` : `negotiateMs`, `masterMs`, `variantMs`, `firstSegment`, `pictureMs` — `resourceEntries()` sur WebKit, « au mieux »), `openedFrom:"serveur"` (le cache du serveur) |
| `seek` | chaque saut abouti | comme Lumen : `from`, `to`, `buffered`, `ranges`, `tookMs` |
| `audio` | chaque changement | `from`, `to`, `via`, `fromTrack`, `toTrack`, `processing` (copié / ré-encodé, de la liste), `applied`, `tookMs`, `at` |
| `stall` | horloge figée 5 s en lecture (60 s entre deux, comme Lumen) | `position`, `stalledMs`, `readyState`, `networkState`, `seeking`, `videoBuffered` (élément), `lead`, `onLine`, `timeline` (`useServerTimeline`), `shownAgoMs`/`lastHiddenMs` |
| `error` | erreur affichée, négociation refusée hors déclin, borne de coupure | `reason`, `mediaError` (code + message), `startup.stage` |
| `fallback` | déclin vers Lumen, relais vers le serveur, diffusion | `to` (`"natif"` / `"serveur"`), `planned`, `cast`, `takeover`, `watched`, `reason` |
| `stop` | fermeture, suivant, `pagehide`, démontage, `lost` | le bilan du lecteur serveur (`serverStopFields` : `why`, `at`, `watched`, `duration`, `ended`, `waits`/`waitedMs`/`longestWaitMs`, `seeks`/`seekWaitMs`, `audioSwitches`, `subtitleSwitches`, `backgrounds`/`backgroundMs`, `restarts`) + `frames.total`/`frames.dropped` (`getVideoPlaybackQuality` répond en HLS natif) + `timeline` + `xray`, `sceneRestart`, `replaySubs` + les `diag.*` du serveur (4.2) |
| `pause` | minuterie de veille | comme les autres |

Plafond de 400 lignes de détail par heure (`playerLogAllowed`) : `seek` et `audio` y entrent, comme
pour Lumen ; `start`/`stop`/`error`/`fallback` passent toujours.

Les lignes d'un banc vont à `bench-player.log` et celles de `next dev` à `dev-player.log` sans rien
faire : la route le décide (CLAUDE.md).

### 4.2 Les mesures fines deviennent serveur

Ce que Lumen mesure dans le navigateur (`playbackDiagnosis.ts`) et que la page ne voit plus :
octets reçus, attente des octets (`readWaitS`), construction des segments (`buildS`), ré-encodage
(`audioS`), envoi (`appendS`), premier octet. Le serveur, lui, voit tout cela pour chaque segment.

**Proposition : la route du journal enrichit les lignes `stop`, `stall`, `error` et `fallback` de
Lumen serveur avec le relevé du serveur**, au moment où elle les reçoit (`log/route.ts`, juste avant
`logPlaybackEvent`, `:58`) : la séance Lumen est retrouvée par `lumenSession` (posé sur chaque ligne,
lié au compte de la session — un compte ne lit jamais le relevé d'un autre). Une seule ligne par
événement, comme aujourd'hui ; pas de ligne de plus ; pas d'attente (relevé en mémoire, sur
`globalThis` comme `castProgress.ts`, parce que les routes et `instrumentation.ts` sont des copies
distinctes du module).

**Mêmes noms que Lumen là où le sens est le même**, pour que la page d'activité et les comparaisons
lisent une seule colonne :

| Champ | Lumen (navigateur) | Lumen serveur (serveur) |
|---|---|---|
| `diag.netMB` | octets reçus | octets envoyés à cet appareil |
| `diag.readWaitS` | attente des octets du fichier | attente des octets venus de Jellyfin / du disque |
| `diag.buildS` | construction des segments | idem, côté serveur |
| `diag.audioS` | ré-encodage du son | idem (s'il y en a) |
| `diag.req` | requêtes de plages | segments servis |
| `diag.fbMedMs` / `diag.slowestMs` | premier octet / requête la plus lente | requête du segment → premier octet envoyé ; segment le plus lent à produire |
| `diag.recvMbps` | débit reçu | débit d'envoi d'un segment, du premier octet au dernier (borne basse du lien de l'appareil) |
| `diag.needMbps` | débit du flux | idem |
| `diag.linkVerdict` | `suffisante` / `trop lente` | même règle (§77), sur `recvMbps` serveur — `seances.ts:333` la lit déjà pour classer un `stall` en « réseau » |

Nouveaux, préfixés pour ne rien confondre : `srv.segments`, `srv.cacheHits` (segments servis d'un
cache serveur), `srv.restarts` (requêtes non contiguës = sauts vus du serveur), `srv.lastSegAgoMs` (sur
`stall` : depuis quand le serveur n'a plus rien servi — distingue « Safari n'a rien demandé »,
`décodeur`, de « le serveur a tardé », `calcul`, et « l'envoi a traîné », `réseau`). La classification
des attentes (`diag.verdict` réseau / calcul / décodeur) se fait donc au serveur, avec la même règle.

Absences assumées : une ligne `why:"lost"` renvoyée des heures plus tard, après un déploiement, n'a
plus de relevé en mémoire ; elle part sans `diag.*` (le relevé pourrait aussi être gardé une heure
dans `kv_cache` — à décider avec la partie serveur). `diag.reserve*`, `evictions`, `openedFrom`
appareil, `deviceBytes`, `diag.longTask*` n'ont pas d'équivalent.

### 4.3 La page d'activité

| Fichier | Changement |
|---|---|
| `src/lib/activity/seances.ts:45` (`Seance.player`), `:204-206` (`playerOf`), `:283` (`absorb`) | ajouter `"lumen-serveur"` ; une séance relayée ensuite au lecteur serveur reste « serveur » (`absorb`), comme un relais du natif |
| `seances.ts:303` (relances `why`) | lire `why` pour `lumen-serveur` aussi (`retry`, `audio-reload` = relances) |
| `seances.ts:396` (`serverCounts`) | **ne pas** y mettre Lumen serveur : il écrit des lignes `seek` et `audio`, que `absorb` compte déjà (double compte sinon) |
| `seances.ts:177` (`isPlannedHandoff`) | un déclin `planned:true` est prévu, pas un échec (champ lu en plus du préfixe « Aucun chemin… ») |
| `src/lib/activity/diagnosis.ts:112` | **garder** Lumen serveur dans les témoins : c'est le fichier de la bibliothèque, par le même remultiplexeur — un échec y accuse le fichier ou le remultiplexeur, pas l'appareil. Un déclin `planned` n'est pas un échec (`failuresOf`, `:15-21`) |
| `src/lib/activity/dashboard.ts:42`, `:182`, `:210-211`, `:388` ; `accounts.ts:80`, `:284` | un chemin `lumen` dans `paths` (sinon `playerOf` le range dans « natif » — inexact mais sans danger tant que seul l'administrateur l'utilise) |
| `src/components/activity/DashboardParts.tsx:18` (`PATH_COLORS`), `views/ActivityOverview.tsx:418` | une couleur et un libellé `activity.dash.path.lumen` (4 langues) |
| `src/components/activity/parts.tsx:268` (étiquettes), `:668` (libellé du `why` de `start`) | étiquette « Remux serveur », libellés de `why` |
| `src/components/activity/views/ActivitySeance.tsx` | la frise et le détail affichent `srv.*` et `startup.*` |

Phase 1 (un seul administrateur) : seules `seances.ts` (player, `serverCounts`, `planned`) et
`parts.tsx` (étiquette) sont nécessaires pour que rien ne soit faux ; le reste peut suivre.

---

## 5. Ce qu'on perd côté client, et ce qui se compense

| Perdu | Ce qu'il apportait (mesuré) | Compensation |
|---|---|---|
| Cache de reprise OPFS (`src/lib/resumeCache/`, §28) | ouverture médiane 1,5 s depuis l'appareil contre 2,0 s depuis le réseau (`bench-comparatif.md`) | **côté serveur, pour tous les appareils** : en-tête, index et segment de la position gardés par fichier (ETag) ; « Reprendre » et « À suivre » préparés au serveur (la partie serveur). Précharger depuis la page ne sert à rien : le chargeur média de Safari ne partage pas le cache HTTP de la page de façon fiable |
| `MemoryReserve` (avance en RAM par rafales, 5 min, 150 Mo iPhone) | radio endormie entre deux remplissages ; avance contre les creux du lien | aucune côté page : Safari décide de son avance (AVFoundation). À mesurer au serveur (`srv.*`, intervalle entre requêtes) avant de juger |
| `earlyFetch` (catalogue, Reprendre, À suivre avec le HTML) | — | **rien de perdu** : il ne touche pas la lecture |
| « mémoire » (réouverture servie par la source précédente) | réouverture quasi instantanée d'un titre fermé à l'instant | cache serveur |
| Mesures fines navigateur (`diag.*`) | diagnostic réseau / calcul / décodeur | serveur (§4.2) |
| Connexion lente §77-79 (`SlowLinkRunner`, préchauffage, bascule allégée) | — | phase 1 : pas d'image en 20 s → déclin vers Lumen, qui a toute la mécanique ; plus tard, le verdict serveur de `recvMbps` |
| Plafond de luminosité HDR (`hdrLightCap`), choix HDR | — | aucun : Safari gère seul le HDR d'un HLS |
| Retenue d'ouverture (`openingHold`), échelle de rattrapage, éviction, budget des tampons | — | sans objet (pas de MediaSource) |

**Compensation par anticipation, recommandée** : à l'appui sur Lire (ou dès l'ouverture d'une fiche
pour l'administrateur dont l'option est allumée — phase 1 seulement, coût nul pour les autres), un
`POST /api/player/lumen/prepare { itemId, at }` sans attendre : le serveur lit en-tête et index et
construit le segment de la reprise pendant l'animation d'ouverture (~1,1 s, §60). Puis la
négociation, et `#t=` pour que Safari demande ce segment-là en premier.

---

## 6. Risques

1. **WebKit et les séances HLS** (fait 3). Lumen serveur après Lumen dans la même page : exclu par la
   route. Seconde séance HLS en page (épisode suivant, renégociation d'une piste) : prouvée pour le
   premier cas, contredite pour le second par le commentaire de `changeAudio` — au banc avant tout
   (iPhone, iPad, Mac), le rechargement avec intention restant le filet.
2. **La page est aveugle sur le flux** (fait 2) : sans le canal d'état serveur, un échec de segment se
   lirait « code 4 » et rien d'autre ; tout repli mal ciblé partirait de là.
3. **`audioTracks` sur des groupes de codecs différents** : comportement de Safari non mesuré ici ; un
   menu qui croit avoir changé de langue alors que le son est resté (`applied:false`).
4. **Empreintes** : seules les fonctions partagées touchées peuvent les faire bouger —
   `serverPlayerLog.base()`, `useServerSessionRecord`, `choosePlayer`, `PlayerControls` (si une prop
   s'ajoute), `PlaybackProvider` (intention `lumen`). Règle : champ ou branche **absents** quand
   l'option est coupée ; passer `npx vitest run src/__tests__/empreinte/` avant chaque commit, et
   ajouter une famille `empreinte-lumen.test.tsx` pour le nouvel hôte (nouveaux fichiers, enregistrés
   avec `EMPREINTE_UPDATE=1`).
5. **Dérive des décisions** (CLAUDE.md « the same decision is made in several places ») : reprise,
   piste d'ouverture, sous-titres forcés, §24, fermeture, épisode suivant — chacune doit être appelée,
   pas recopiée. Une entrée DECISIONS (« Lumen serveur ») : la route, l'hôte, ce qui diffère exprès
   (§24 appliqué, AirPlay refusé en phase 1, pas d'échelle, pas de version allégée).
6. **AirPlay du système** : sans `x-webkit-airplay="deny"`, le bouton du centre de contrôle tend une
   adresse à cookie — refus au téléviseur.
7. **Coût serveur** : chaque spectateur remultiplexe sur le serveur ; un saut lointain = un segment
   reconstruit ; un son ré-encodé (TrueHD, DTS) coûte du processeur à chaque lecture. Phase 1, un
   appareil : négligeable ; à mesurer avant d'ouvrir.
8. **Jellyfin** : deux séances annoncées au moment d'un relais (Lumen serveur puis lecteur serveur) si
   l'arrêt de la première ne part pas avant ; le natif a la même règle, à reprendre.
9. **Appareil partagé** : option allumée par l'administrateur, compte ordinaire connecté → 403 → déclin.
   Pas une faille (le serveur refuse), un aller-retour.
10. **Données du journal** : `lumen-serveur` inconnu des lecteurs d'activité d'avant le changement →
    rangé « natif » par `playerOf`. Sans danger, mais à corriger avant d'ouvrir l'option à d'autres.
11. **Énergie** : la stratégie d'avance de Safari (requêtes régulières plutôt que rafales) peut garder
    la radio éveillée ; le relevé serveur des intervalles entre segments le dira.

---

## 7. Fichiers à toucher (côté client)

**Nouveaux**
- `src/lib/lumenServer.ts` — option de l'appareil (`lumenServerOn`, `setLumenServer`, `lumenChoiceFor`),
  drapeau « la page a servi MediaSource », `lumenDeclined`.
- `src/components/player/lumen/LumenServerHost.tsx` — l'hôte (négociation, élément, `fallTo`, §24).
- `src/components/player/lumen/lumenLog.ts` — champs `start`/`seek`/`audio`/`stall` (fonctions pures, testées).
- `src/components/player/lumen/useLumenAudioTracks.ts` — menu ↔ `video.audioTracks`, `applied`.
- `src/components/player/lumen/lumenStatus.ts` — le canal d'état serveur (borné, gardé).
- Tests : `lumenServer.test.ts`, `playerRoute.test.ts` (cas `lumen`), `LumenServerHost.test.tsx`,
  `src/__tests__/empreinte/empreinte-lumen.test.tsx` + `__empreintes__/lumen/`.

**Modifiés (additif, absent quand coupé)**
- `src/lib/playerRoute.ts` — route `"lumen"`, `ctx.lumen` optionnel.
- `src/components/PlayerHost.tsx` — `lumenWanted`, `lumenDeclined`, montage de `LumenServerHost`
  (clé `${itemId}:${openId}`), `onDecline` ; `handOver` réutilisé tel quel.
- `src/components/ExperimentalPlayerHost.tsx` — une ligne : noter « la page a servi MediaSource » au
  premier `probe.start` (une écriture de module, pas de stockage : invisible des empreintes).
- `src/lib/serverPlayerLog.ts` — `ServerPlayerContext.player?` (défaut `"serveur"`, même position).
- `src/components/player/server/useServerSessionRecord.ts` — accepter ce contexte (et `frames.*` si absent aujourd'hui).
- `src/components/PlaybackProvider.tsx` / `src/lib/serverReload.ts` — intention `lumen: true` (filet du
  changement de piste) et `reloadedOnLumen`.
- `src/components/player/PlayerAccountPanel.tsx` — la ligne « Remuxage serveur » du groupe administrateur.
- `src/i18n/*` (fr, en, es, de) — `player.account.lumenServer*`, `activity.dash.path.lumen`, `activity.flags.lumen`.
- `src/app/api/player/log/route.ts` — enrichissement `diag.*`/`srv.*` des lignes Lumen serveur (avec la partie serveur).
- Activité : `src/lib/activity/seances.ts`, `diagnosis.ts`, `dashboard.ts`, `accounts.ts`,
  `src/components/activity/parts.tsx`, `DashboardParts.tsx`, `views/ActivityOverview.tsx`, `views/ActivitySeance.tsx`.
- `DECISIONS.md` — nouvelle entrée ; §24 (« différent exprès » : Lumen serveur l'applique) ; §23 (troisième lecteur du HLS natif).
- `docs/cycle-de-vie-lecteur.md` — la quatrième branche, ses phases et ses lignes.
- `tools/regress-lecteur/` — scénarios Lumen serveur (WebKit et iPhone émulé seulement), plus tard.

**Non touchés, exprès** : `ActivePlayer` (le lecteur serveur), `mseSource.ts` et le moteur,
`PlayerControls` (sauf prop optionnelle si `audioTracks` l'exige), `public/sw.js` (les routes Lumen
sous `/api/` ne sont pas interceptées, `sw.js:230`).
