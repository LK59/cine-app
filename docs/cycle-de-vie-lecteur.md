# Le cycle de vie du lecteur

Ce document est la carte du lecteur **dans le temps** : dans quel état il peut être, ce qui le
fait passer d'un état à l'autre, et qui l'emporte quand deux événements se croisent. `DOC-TECH.md`
décrit la chaîne des octets jusqu'à l'image — remultiplexage, fragments, tampons, pistes. Ici, on
décrit qui décide, quand.

Aucun de ces états n'est écrit quelque part dans le code : chacun se déduit d'une combinaison de
drapeaux, d'états React et de références. C'est pour cette raison que ce document existe — et que
la plupart des régressions du lecteur sont nées là, d'une correction qui modifiait un de ces
drapeaux sans voir les autres chemins qui le lisent.

Relevé sur le code du 27/09/2026 (commit `67eed86`). **Les numéros de ligne vieillissent** ; les
noms de fonctions et de champs, beaucoup moins. En cas de doute, chercher le nom.

## Sommaire

1. [Les trois couches](#les-trois-couches)
2. [La séance — PlaybackProvider et PlayerHost](#la-séance--playbackprovider-et-playerhost)
3. [L'hôte natif — ExperimentalPlayerHost](#lhôte-natif--experimentalplayerhost)
4. [Le moteur — RemuxPlayback et MseSource](#le-moteur--remuxplayback-et-msesource)
5. [Les contrats entre couches](#les-contrats-entre-couches)
6. [Quand deux événements se croisent](#quand-deux-événements-se-croisent)
7. [Les points fragiles](#les-points-fragiles)
8. [Ce que chaque couche écrit au journal](#ce-que-chaque-couche-écrit-au-journal)
9. [Vers une machine à états explicite](#vers-une-machine-à-états-explicite)

---

## Les trois couches

```
 PlaybackProvider  ── la séance : ouverte ? plein écran ou réduite ? quel numéro d'ouverture ?
        │
    PlayerHost     ── le choix du lecteur, les passages de relais, la diffusion (AirPlay)
      ├── ExperimentalPlayerHost   (lecteur natif : remultiplexage → MediaSource → <video>)
      │       │
      │   RemuxPlayback ── MseSource ── PlaybackGuard / SeekLifecycle / BufferQueue
      │                        │
      │                     Remuxer ── HttpByteSource
      │
      └── ActivePlayer             (lecteur serveur : négociation Jellyfin, HLS ou lecture directe)
```

| Couche | Fichiers | Ce qu'elle possède |
|---|---|---|
| Séance | `PlaybackProvider.tsx`, `useStableFallback.ts`, `usePlaybackSession.ts`, `swr.ts` (`refreshAfterPlayback`) | l'objet `session` (son **identité** veut dire « cette lecture-là »), `mode` (`closed`/`full`/`mini`), `openId`, les relais (`handedOver`, `takeover`, `returning`), les rapports à Jellyfin |
| Hôte natif | `ExperimentalPlayerHost.tsx` | l'ouverture, la reconstruction (`restart`), le retour d'arrière-plan, le changement de piste, la bascule vers le serveur (`fallToStable`), la fin de film, le journal de séance |
| Moteur | `webcodecs/remuxPlayback.ts`, `mseSource.ts`, `playbackGuard.ts`, `seekLifecycle.ts`, `bufferQueue.ts`, `bufferBudget.ts`, `byteSource.ts`, `remuxer.ts` | le remplissage, les sauts, l'échelle de rattrapage, la réserve réseau, l'éviction, la détection d'une source perdue — **jamais** la reconstruction, qui appartient à l'hôte |

Deux règles de montage, qui définissent ce qu'est « la même lecture » :

- L'hôte natif est clé sur `${itemId}:${openId}` (`PlayerHost.tsx`, rendu de
  `ExperimentalPlayerHost`). Un autre épisode, ou une nouvelle ouverture du même film, est donc un
  **nouveau composant** : aucune transition en place, tout l'état repart de zéro.
- Le lecteur serveur est clé sur `openId` seul : il **passe à l'épisode suivant sans être
  démonté** (sa négociation dépend de `itemId`). Clé par épisode, il rapportait l'arrêt deux fois.

---

## La séance — PlaybackProvider et PlayerHost

### Les phases

| Phase | Comment le code le sait |
|---|---|
| Fermée | `session === null`, `mode === "closed"` |
| Demandée | `session` posée, `mode === "full"` ; tant que la préférence `legacy` ou le réglage `serverFallback` ne sont pas connus, `PlayerHost` ne rend rien |
| Lecteur natif | `useNative` vrai : `!serverFallback \|\| (!legacy && !handedOver.includes(itemId) && !carried && !castingNow(...))` |
| Lecteur serveur : négociation | `ActivePlayer` monté, `loading && !playSession` pendant `POST /api/jellyfin/playback/start` |
| Lecteur serveur : chargement | `playSession` posé, `loading` jusqu'à `loadeddata` ; chien de garde de 20 s |
| Lecteur serveur : lecture | `!loading && !error` |
| Relais natif → serveur (échec) | l'élément est dans `handedOver` ; `takeover.cast` absent |
| Relais natif → serveur (diffusion) | `castingNow(takeover, session)`, ou `carried` après un épisode suivant |
| Diffusion active | `castActive` / `castActiveRef`, posés par l'écoute de la route AirPlay — possible dans n'importe quelle séance serveur, pas seulement une diffusion demandée depuis le lecteur natif |
| Retour de diffusion | `returning` posé, `takeover` nul : le lecteur natif remonte à la position rendue, en pause si la TV s'est arrêtée d'elle-même |
| Réduite ↔ plein écran | `mode` ; le même élément vidéo est gardé, seul son conteneur change |
| Fermeture | `closing` (fondu de 200 ms), puis `playback.close(openId)` |

Note : l'état « négociation » affiché pendant un relais (`negotiating`, `useStableFallback.ts`) est
un **minuteur d'affichage de 4 s**, pas une phase réelle. Rien d'observable ne marque « relais
terminé », sinon `loading` qui retombe dans `ActivePlayer`.

### Les transitions

| Déclencheur | Effet | Où |
|---|---|---|
| `playback.play(s)` (bouton Lecture, fiches, épisode suivant, banc, rechargement WebKit) | `openId++`, `mode = full`, SWR mis en pause (`setWatchingFullScreen`) | `PlaybackProvider` `play` |
| L'hôte natif abandonne (`fallToStable`) | `stepAside` : l'élément rejoint `handedOver` (sauf diffusion), `takeover` posé, `continued` relie les deux séances du journal | `PlayerHost` `handOver`, `useStableFallback` |
| Diffusion demandée depuis le menu natif | `fallToStable("diffusion demandée", {...takeoverNow(), cast: true})` ; le sélecteur s'ouvre à `loadedmetadata` côté serveur | `ExperimentalPlayerHost`, `PlayerHost` |
| Route AirPlay établie / perdue | ligne `cast` / ligne `fallback` (`cast: true`) ; si la diffusion venait du natif, `onCastEnded(position, paused = true)` | `PlayerHost` écoute de la route |
| Bouton « revenir sur le téléphone » | `onCastEnded(position)` → `stepBack` → le natif remonte | `PlayerHost` `handleCastReturn` |
| Réduire / agrandir | `mode = mini` lève la pause de SWR et redemande les clés sans données ; `mode = full` la remet | `PlaybackProvider` |
| Épisode suivant | l'arrêt est rapporté (sans l'attendre), `playback.advance` remplace l'objet `session` (`resumeAt: 0`) | les deux hôtes, `handleAdvance` |
| Fin de fichier (serveur) | réduite ou sans épisode suivant → fermeture ; sinon `stop` Jellyfin seul, `resume()` si on relance | `ActivePlayer` écouteur `ended` |
| Fermer | ligne `stop`, arrêt Jellyfin, fondu, `close(openId)` après 200 ms, `refreshAfterPlayback` | les deux hôtes, `handleClose` |
| La séance passe à `null` | `RESUME_KEY` et `NEXT_UP_KEY` redemandés | `PlaybackProvider` effet `wasPlaying` |
| `refreshAfterPlayback` | attend le rapport d'arrêt **puis** l'écran libre (au plus 3 s), puis revalide Reprendre, À suivre, la progression du titre et toutes les listes d'épisodes | `swr.ts` |
| Changement de piste sur le lecteur serveur | WebKit : intention dans `sessionStorage` puis `location.reload()` ; ailleurs : nouvelle négociation, nouveau `playSessionId` | `PlayerHost` `changeAudio` (protégé, voir `CLAUDE.md`) |

Ce qui est perdu au rechargement WebKit : `getNextEpisode`, la route AirPlay, `handedOver` et
`takeover`, l'identifiant de séance du journal, `openId`. C'est accepté et documenté dans le code.

---

## L'hôte natif — ExperimentalPlayerHost

2 625 lignes, 76 `useState`/`useRef`. Les phases ci-dessous sont **déduites** ; aucune n'est
stockée.

### Les phases

| Phase | Combinaison qui la définit |
|---|---|
| En attente des entrées | `!info` ou `playbackState === undefined` ; `path === null` |
| Refusé avant ouverture | `info.refusedReason` → `fallToStable` ; description introuvable (hors service injoignable) → `fallToStable` ; service injoignable → écran d'erreur, pas de bascule |
| Sondage | `probePlaybackPath` en cours ; `path === null`, `ready === false` |
| Attache | `probe.start(element)` attendu dans `startRemux` |
| Prêt, pas encore parti | `ready` vrai (`declareReady`) ; `startingAt` posé (roue de reprise) ou `lifecycle.keepPaused` consommé (reste en pause) |
| Lecture | `playing` vrai, `ended` faux |
| Pause du spectateur | `playing` faux, `viewerPausedAtRef` posé |
| Attente en pleine lecture | aucun état React : `tally.waitingSince`, et `onStall` du moteur à 5 s |
| Saut | `requestedSeekRef` et/ou `seekTimingRef` posés, et/ou `element.seeking` |
| Reconstruction | `ready` faux et `lifecycle.rebuildAt` posé ; `rebuildCount` vient d'augmenter ; image figée possible (`frozen`) |
| Changement de piste | reconstruction **et** `pendingSwitchRef` posé |
| Reconstruction plafond HDR | reconstruction sans `pendingSwitchRef` |
| Réseau perdu | `networkLost` posé ; nouvel essai programmé si `online`. `ready` peut rester vrai si la coupure a eu lieu en plein film |
| Arrière-plan | `visibilityState === "hidden"`, `hiddenAtRef`. Au retour : `holdOnReturnRef` (2,5 s) puis la vérification de source perdue |
| Bloqué | ouverture depuis plus de 20 s → message « toujours en train de chercher » |
| Abandon | ouverture depuis plus de 35 s → `fallToStable("aucune image après 35 s")` |
| Fin | `ended` vrai, `lifecycle.isEnded()` vrai (arrêt Jellyfin déjà envoyé) |
| Passé la main | `steppedAside` vrai ; avec lecteur serveur, l'hôte est démonté ; sans lui, `runtimeError` posé et écran d'erreur |
| Fermeture | `closing` vrai, `stopReportedRef` vrai ; `close(openId)` 200 ms plus tard |

### Les briques qui portent les transitions

- **`restart(at, why)`** — la seule façon de reconstruire. Elle pose `lifecycle.rebuildAt = at`, remet
  `openedAt`, efface `networkLost`, `ready`, `playing`, `runtimeError`, et augmente
  `rebuildCount`, ce qui démonte l'ancien pipeline (nettoyage de l'effet) et en monte un neuf. Elle
  décide aussi de rester en pause si le spectateur avait mis en pause *avant* un passage en
  arrière-plan (une pause d'iOS lui-même ne compte pas).
- **`declareReady()`** — le seul endroit où une reconstruction est considérée finie :
  `lifecycle.rebuildAt = null`, saut demandé entre-temps honoré, `ready`, `announced`, `everReadyRef`,
  compteur réseau remis à zéro.
- **`fallToStable(reason, takeover?)`** — une seule fois (`steppedAside`). Avec lecteur serveur :
  ligne `fallback`, relais avec la position courante si le film a déjà montré une image. Sans lui
  (`PLAYER_SERVER_FALLBACK=false`) : ligne `error` et écran d'erreur.
- **`lifecycle.spendRebuild`** — budget de 3 reconstructions par fenêtre de 180 s.
- **L'effet du pipeline** (le grand `useEffect` qui sonde, attache et branche les écouteurs) —
  relancé par `rebuildCount`, et par tout changement d'identité de ses 17 dépendances. Toutes sont
  **censées rester stables** après leur première valeur ; le code le dit dans un commentaire, rien
  ne le vérifie.

### Les transitions principales

| Déclencheur | Condition | Effet | Résultat |
|---|---|---|---|
| Description + état de reprise arrivés | pas de refus | position de départ : `lifecycle.rebuildAt` → position connue → `session.resumeAt` → reprise serveur → 0 ; recul d'ouverture appliqué une seule fois (`openingPosition`) ; `probePlaybackPath` | Sondage |
| Pipeline prêt (`begin` résolu) | effet non annulé | ligne `start`, pistes, préférences du compte, `declareReady` | Prêt |
| Après prêt : la piste voulue n'est pas celle ouverte | `requestAudioTrack` → `"rebuild"` | `pendingSwitchRef`, `restart` | Reconstruction |
| Après prêt : la piste voulue n'est pas transportable | `!canCarryAudio` | `fallToStable` avec la piste demandée | Passé la main |
| `onError(msg, "network")` du moteur | — | ligne `network`, `networkLost` | Réseau perdu |
| `onError(msg)` avec `lost` | `lifecycle.spendRebuild` | ligne `rebuild` ; même endroit deux fois (< 3 s) → reprise 12 s plus loin | Reconstruction |
| `onError(msg)` sinon | — | `fallToStable` | Passé la main |
| Retour au premier plan | `path === "remux"`, `lost`, `lifecycle.rebuildAt === null`, `lifecycle.spendRebuild` | ligne `rebuild` (`hiddenMs`), `restart`, en pause si retenu ou si le film était fini ; revérifié 400 ms plus tard | Reconstruction |
| `networkLost` et en ligne | recul 0,8 s × 2ⁿ, plafond 30 s | `restart(networkLost.at)` | Reconstruction |
| Minuteur d'abandon | pas prêt, pas d'erreur, pas de réseau perdu | après 35 s : `fallToStable` | Passé la main |
| Changement de piste (menu) | `"rebuild"` | image figée, `lifecycle.keepPaused = paused`, `restart(intendedPosition())` | Changement de piste |
| Saut (commandes) | — | `noteSeekRequest` : cible notée, réécrit `lifecycle.rebuildAt` si une reconstruction attend ; le déplacement lui-même est écrit sur l'élément par `PlayerControls` | Saut |
| `ended` | — | arrêt Jellyfin, `lifecycle.isEnded()`, cache de reprise oublié | Fin |
| Fermer | — | ligne `stop`, arrêt Jellyfin, fondu, `close(openId)` | Fermeture |

---

## Le moteur — RemuxPlayback et MseSource

`MseSource` (2 181 lignes) est la vraie machine à états du moteur. Sa pièce centrale est
**`generation`** : une époque augmentée par chaque saut réellement servi et par `destroy`. Toute
opération asynchrone (remplissage, envoi, minuteur réseau) la compare avant d'agir, et s'efface
si elle a changé.

### Les phases

| Phase | Où | Résumé |
|---|---|---|
| Sondage | `probePlaybackPath`, `pathSelector.ts` | source d'octets, en-tête, choix de la piste audio, `tryRemux` : soit un `PathProbe`, soit un refus nommé |
| Attache | `RemuxPlayback.start`, `MseSource.attach` | `sourceopen` (15 s max), deux `SourceBuffer`, segments d'initialisation ; **`attach` se résout avant le moindre segment média** |
| Ouverture différée | `pendingStart` | le lecteur de fichier est déjà à la position de reprise, la tête attend que le média arrive ; pendant cette phase, chien de garde et détecteurs se taisent |
| Remplissage | `runFill` | boucle tant que l'avance est sous la cible (budget en octets, `bufferBudget.ts`) ; s'arrête dès qu'un saut est demandé |
| Lecture stable | — | pas de remplissage en cours ; relancé par `timeupdate`, `waiting`, `playing`, `startstreaming`, `play` ; chien de garde toutes les 250 ms |
| Saut | `performSeek` | voir ci-dessous |
| Taille derrière la tête | `trimBehind`, `evict` | après chaque envoi quand un budget existe ; sur `QuotaExceededError` |
| Éviction par le navigateur | `refillEvicted` | ManagedMediaSource seulement : une plage retirée devant la tête est relue (3 fois par minute au plus) |
| Rattrapage | chien de garde, horloge figée, tête partie, échelle | voir ci-dessous |
| Réserve réseau | `keepThroughNetworkFailure` | avance ≥ 5 s : on garde les tampons et on réessaie (1, 2, 4, 8 s) |
| Perte | `lost` | `sourceclose` ou `error` de l'élément ne font qu'**une photo** (`lossSnapshot`) ; `lost` = source fermée ou échelle épuisée. **Le moteur ne se reconstruit jamais lui-même** |
| Fin de flux | `ended` | `nextSegment()` nul → `endOfStream` |
| Destruction | `destroy` | voir ci-dessous |

### Un saut, étape par étape

Un saut n'est jamais appelé par l'hôte : il arrive par l'événement `seeking` de l'élément, que
`PlayerControls` déclenche en écrivant `currentTime`.

1. `seeking` → `seekState.started(cible)`. Si c'est notre propre déplacement (jeton à usage unique,
   2 s) : simple remplissage. Si la cible est déjà dans le tampon et qu'aucun saut n'attend :
   simple remplissage, sans nouvelle époque.
2. Sinon `seek(cible)` : `seekState.request` (le dernier d'une rafale gagne),
   `remuxer.prepareSeek` (abandonne les lectures réseau ailleurs), puis `performSeek` enchaîné
   derrière le précédent (`pending`).
3. `performSeek` : annule l'ouverture différée, borne la cible, refuse un saut sans index,
   **augmente `generation`**, attend la fin du remplissage en cours, **revérifie** `destroyed` et
   l'arrivée d'une cible plus récente, vide les deux tampons, revérifie encore, accorde la licence
   d'atterrissage (`guard.seekServed`), repositionne le lecteur de fichier, écrit `currentTime`
   (avec le jeton « c'est nous »), relance le remplissage.
4. `seeked` → `seekState.arrive` ; l'intention reste ouverte si la tête est à plus de 1,5 s de la
   cible.
5. Le choix de l'image clé, des CRA et des RASL n'est pas ici : il est dans le remultiplexeur
   (`seekTo`, `isRaslPicture`). Le moteur tolère seulement leurs conséquences (pré-roulage de 40 s,
   atterrissage jusqu'à 15 s après la cible).

### L'échelle de rattrapage

- **Chien de garde (250 ms)** : si rien ne joue alors que la lecture est demandée, que rien n'est
  en cours de remplissage et que le dernier envoi date de plus de 700 ms → `recover`.
- **Horloge figée** : trois petits pas de 0,08 s, puis `recover`.
- **Tête partie** : la tête est loin de la cible d'un saut, ou l'horloge court sans rien dessous
  → ligne `stall` (`runaway`), puis `recover`.
- **`recover(cible)`** : un saut vers la cible. Trois tentatives au même endroit en 5 s, ou huit
  sans lecture → `escalate` : saut à l'image clé suivante. Si cela échoue aussi → **`handOver`** :
  `stuck = true`, `onError("lecture bloquée…", "playback")`, `lost` devient vrai, et c'est l'hôte
  qui reconstruit.
- Trois secondes de vraie lecture remettent l'échelle à zéro.

### La destruction

`RemuxPlayback.destroy` retire ses écouteurs, détruit `MseSource`, ferme le remultiplexeur, puis
la source d'octets. `MseSource.destroy` : `destroyed`, `guard.destroy()` (qui appelle
`onStarting(null)` pour éteindre la roue), **nouvelle époque**, écouteurs et minuteurs retirés,
files des tampons fermées (ce qui y attend se résout sans s'exécuter), fin de flux, puis
`removeAttribute("src")` **avant** `revokeObjectURL`.

---

## Les contrats entre couches

### PlayerHost → hôte natif

- **Entrées** : `key = itemId:openId`, `session` (avec la position de retour de diffusion et
  `startPaused` le cas échéant), `mode`, `onFallback(reason, takeover?, sessionId?)`.
- **Sortie** : `onFallback` au plus une fois par montage, et seulement si un lecteur serveur
  existe ; ensuite l'hôte natif est démonté. `takeover.resumeAt` est toujours un nombre ;
  `takeover.cast` veut dire « un choix, pas un échec » (l'élément n'entre pas dans `handedOver`).
- L'hôte natif parle **directement** à `PlaybackProvider` pour `close`, `advance`, `minimize`,
  `expand`, et gère lui-même son rapport à Jellyfin, son `refreshAfterPlayback` et ses arrêts
  non envoyés.

### PlayerHost → lecteur serveur

`key = openId`, `session` brute (comparée par identité), `mode`, `fallbackReason`,
`takeover = carried ?? takeover`, `continuesSession` (si `continued.owner === session`),
`onCastEnded(resumeAt, paused?)` (sans effet hors d'une diffusion venue du natif).

### Hôte natif → moteur

| Appel | Quand | Note |
|---|---|---|
| `probePlaybackPath(options)` | avant tout | rejette avec un refus nommé, une erreur réseau, `ReadAbandoned` ou une erreur d'en-tête |
| `probe.start(video)` / `probe.discard()` | une fois, après le sondage | `start` se résout avant tout média ; rejette après avoir tout nettoyé |
| `playback.destroy()` | n'importe quand, idempotent | |
| `requestAudioTrack(n)` | n'importe quand | `"rebuild"`, `"refused"` ou `null` (détruit) — l'hôte reconstruit |
| `canCarryAudio(n)`, `selectSubtitleTrack`, `subtitleAt` | n'importe quand | |
| Accesseurs `lost`, `position`, `seekPending`, `lossReport()`… | n'importe quand, sûrs même sans `MseSource` | `lost` et `position` pilotent la reconstruction |

L'hôte écrit aussi l'élément directement (`currentTime`, `play()`, `pause()`) ; le moteur
l'observe par ses événements.

### Moteur → hôte natif

| Rappel | Émis par | Lu par l'hôte comme |
|---|---|---|
| `onError(msg, "network")` | remplissage (réseau non gardé), chaîne des sauts | écran « connexion perdue » |
| `onError(msg, "playback")` | remplissage après 3 échecs ou échelle épuisée, `handOver` | avec `lost` : reconstruction ; sinon bascule |
| `onWarning` | saut ou piste sans index | message passager |
| `onStarting(t \| null)` | le garde (lecture demandée, première image, pause, destruction) | roue de reprise |
| `onStall(faits)` | blocage de 5 s, tête partie ; 60 s entre deux | ligne `stall` |

---

## Quand deux événements se croisent

| Croisement | Arbitrage | État |
|---|---|---|
| Ancien pipeline contre reconstruction | drapeau `cancelled` de l'effet après chaque `await` ; `destroy` du moteur | solide pour les promesses — **mais les rappels du moteur ne regardent pas `cancelled`** (point fragile n° 3) |
| Saut pendant un remplissage | `requested` arrête la boucle, `prepareSeek` abandonne les lectures, `generation` rend les envois périmés inoffensifs | solide ; un saut attend une lecture gardée jusqu'au bout (60 s hors ligne au pire) |
| Rafale de sauts | coalescence dans `seekState.requested`, `performSeek` sérialisé et revérifié après chaque attente | solide, éprouvé par le fuzz |
| Saut pendant une reconstruction | `noteSeekRequest` réécrit `lifecycle.rebuildAt`, `declareReady` honore la cible | complet (les commandes sont inertes pendant la reconstruction ; seuls le banc et les touches média y arrivent) |
| Changement de piste pendant un saut | `restart(intendedPosition())` lit la cible demandée, puis `element.seeking` | corrigé le 22/09 |
| Changement de piste pendant une reconstruction | le choix est gardé dans `wantedAudioRef` | correct ; aucune ligne `audio` écrite pour ce changement-là |
| Reconstruction pendant une reconstruction | la seconde augmente `rebuildCount`, l'effet annule la première | acceptable ; `pendingSwitchRef` survit jusqu'au pipeline qui aboutit |
| Retour d'arrière-plan + retenue + source perdue | la retenue est lue par la vérification → reste en pause | cohérent |
| Arrière-plan pendant l'ouverture | la vérification de source perdue n'est active qu'une fois `path === "remux"` | une source fermée par iOS avant l'attache n'est vue que si l'attache échoue |
| Fin de film + reconstruction | seul le chemin « retour d'arrière-plan » regarde `lifecycle.isEnded()` | **fragile** (point n° 2) |
| Bascule pendant la fermeture | `fallToStable` ne regarde que `steppedAside` | **fragile** (point n° 5) |
| Fermer pendant la négociation serveur | la génération n'est pas revérifiée après la lecture du corps de la réponse | **fragile** (point n° 6) |
| Deux fermetures du lecteur serveur | rien ne garde la ligne `stop` | **fragile** (point n° 7) |
| Envoi pendant qu'un tampon travaille | tout passe par `BufferQueue` | solide, sauf la fin de flux (point n° 8) |
| Quota dépassé | éviction, puis `recover` : un saut complet qui **vide les deux tampons** | lourd mais voulu (« relit depuis la tête ») ; compte dans l'échelle |
| Préférence `legacy` ou réglage serveur qui change en plein film | les deux lecteurs s'échangent sans relais de position | **fragile**, rare (point n° 9) |
| SWR en pause pendant le plein écran | les requêtes vitales portent `playerBootstrapOptions` ; au retour, `PlaybackProvider` redemande ce qui n'a rien reçu | solide (dépend de l'ordre des effets dans `PlaybackProvider`) |

---

## Les points fragiles

Relevés à la lecture, puis vérifiés dans le code pour les marqués **vérifié**. Aucun n'a de trace
connue dans le journal à ce jour : ce sont des chemins possibles, pas des bugs observés. Chacun est
un candidat naturel pour un test, avant ou pendant un découpage.

**État au 27/09/2026** : tous traités. 6, 7, 8, 10 et 12 corrigés à l'étape 0, chacun avec un
test qui échoue sans sa correction (`player-host-server.test.tsx`, le premier harnais du lecteur
serveur ; `webcodecs-mseSource.test.ts`). 2, 4, 5 et 14 corrigés à l'étape 2, dans
`PlayerLifecycle` (voir plus bas), en inversant leur test « comportement actuel ». 14 n'était
pas un défaut (voir le point). 1 s'est révélé bénin, 11 est laissé tel quel, 13 est couvert par un
test, 3 et 9 restent notés.

1. **Bénin, testé.** **`lifecycle.rebuildAt` n'est remis à zéro qu'en cas de succès** (vérifié). Seul `declareReady` l'efface.
   Une reconstruction qui finit en `networkLost` ou en abandon le laisse posé : la vérification de
   source perdue au retour d'arrière-plan est alors **désactivée** (`lifecycle.rebuildAt !== null`), et
   chaque saut suivant écrit dans ce champ au lieu de rien. Un nouvel essai réseau réussi le remet
   en ordre. *Relu en écrivant les tests :* tant qu'une reconstruction n'a pas abouti, il n'y a pas
   de pipeline à surveiller (`remuxRef` est vide), donc la vérification désactivée ne rate rien ;
   et le nouvel essai rouvre bien à la position de la reconstruction (« une reconstruction ratée
   faute de réseau rouvre… »). Pas de correction nécessaire.
2. **Corrigé** (`restart` garde en pause toute reconstruction d'un film fini). **Les reconstructions après perte et après coupure réseau ignorent la fin du film** (vérifié).
   Le chemin « source perdue » (`onError` + `lost`) et le nouvel essai réseau ne regardent pas
   `lifecycle.isEnded()`. Comme `onPause` n'enregistre pas de pause du spectateur quand l'élément est à
   sa fin, `restart` ne garde pas non plus la pause : une source perdue sur l'écran de fin est
   reconstruite **en lecture**. C'est le symptôme que le code a déjà corrigé le 24/09 pour le seul
   retour d'arrière-plan. De même, `restart` ne remet pas `ended` à faux.
3. **Les rappels du moteur ne regardent pas `cancelled`, et lisent `remuxRef` global.** `onError`,
   `onStall` et `onStarting` sont fermés sur l'effet d'un pipeline, mais le test « la source est
   perdue » lit `remuxRef.current`, c'est-à-dire le pipeline *courant*. La sûreté repose entièrement
   sur `MseSource`, qui se tait après `destroy` (elle le fait presque partout).
4. **Corrigé** (`isOver`). **Après une bascule sans lecteur serveur, l'hôte peut se relancer.** La reconstruction après
   perte, la vérification d'arrière-plan et le nouvel essai réseau ne regardent pas
   `steppedAside`. `restart` efface `runtimeError` : l'écran d'erreur peut disparaître et le
   pipeline repartir après un abandon. Ne concerne que `PLAYER_SERVER_FALLBACK=false`.
5. **Corrigé** (`noteClosing` : plus de bascule, de reconstruction ni de nouvel essai pendant le fondu ; un `play()` d'un sondage qui aboutit reste possible). **Fermer n'arrête ni le pipeline ni ses minuteurs pendant le fondu de 200 ms.** Un sondage qui
   aboutit à ce moment appelle `play()` (le son peut démarrer pendant la sortie), le nouvel essai
   réseau peut appeler `restart`, et un `fallToStable` (le minuteur d'abandon, par exemple) peut
   écrire une ligne `fallback` **après** la ligne `stop` — et ajouter le film à `handedOver`, ce
   qui l'envoie au lecteur serveur pour tout le reste de la vie de l'application.
6. **Corrigé.** **Lecteur serveur : fermer pendant la négociation peut laisser un transcodage ouvert.** La
   génération est vérifiée avant la lecture du corps de la réponse de `/playback/start`, pas après.
   Une réponse lue après le démontage peut encore écrire la ligne `start`, poser `playSession` et
   lancer la lecture sur un élément détaché ; une réponse arrivée après le démontage ouvre un
   transcodage Jellyfin qu'aucun `stop` ne ferme.
7. **Corrigé** (`closedRef`). **Lecteur serveur : deux appuis sur Fermer écrivent deux lignes `stop`** (vérifié), la seconde
   avec `watched: 0`, et lancent deux `refreshAfterPlayback`. L'hôte natif, lui, a
   `stopReportedRef`.
8. **Corrigé** (la fin attend aussi la file du son). **La fin de flux ne passe que par la file vidéo** (vérifié). Une suppression non attendue sur la
   file audio (`trimBehind`, `evict`) peut encore travailler : `endOfStream` lève, l'erreur est
   avalée, et `ended` est déjà vrai — le flux peut ne jamais être déclaré fini. Possible, jamais
   observé.
9. **Un changement de préférence en plein film change de lecteur sans relais.** `legacy` et
   `serverFallback` sont des clés SWR non suspendues ; si l'une bascule (reconnexion), le lecteur
   est remplacé et repart de `session.resumeAt`, pas de la position courante.
10. **Corrigé** (la route est arrêtée comme par la croix, et la fin de diffusion écrite). **Le bouton « revenir sur le téléphone » n'arrête pas la TV et n'écrit rien** (vérifié).
    Contrairement à `handleClose`, `handleCastReturn` ne met pas l'élément en pause et ne le vide
    pas ; or le code a constaté le 26/09 que démonter l'élément n'arrête pas AirPlay. Aucune ligne
    `fallback`/fin de diffusion n'est écrite, donc le temps regardé sur la TV est perdu pour le
    journal.
11. **Évalué, laissé tel quel.** **Remplacer un film par un autre depuis le mini-lecteur** ne
    rafraîchit pas les vues du premier (pas de `refreshAfterPlayback`, et la séance ne passe jamais
    par `null`), et le lecteur serveur n'écrit pas de `stop` pour lui. En pratique, la fermeture du
    second film relit toutes les progressions montées, les listes d'épisodes, Reprendre et À
    suivre (`revalidateWatchState`) : le premier est rattrapé à ce moment-là. Il ne reste qu'un
    décalage visible si le second joue réduit, et une ligne absente du journal — dont l'ajout
    toucherait au regroupement des séances de la page d'activité, pour peu.
12. **Corrigé** (DECISIONS §28 ; `bench` transmis à la route, qui n'annonce rien). **Le lecteur serveur n'applique pas le recul d'ouverture** (`openingPosition`, DECISIONS §28)
    et **rapporte à Jellyfin pendant un banc** (son `usePlaybackSession` n'a pas la condition
    `bench` du natif). Deux décisions qui devraient être partagées et ne le sont pas.
13. **Couvert par un test** (« se redessiner avec la même séance ne reconstruit rien »). **L'effet du pipeline dépend de 17 identités censées rester stables.** Une seule qui change
    reconstruit tout le lecteur **sans** passer par `restart` (donc sans position de
    reconstruction, sans ligne au journal). Même dépendance cachée pour l'arrêt rapporté au
    démontage : une dépendance ajoutée à `reportStop` écrirait `stop "unmount"` en pleine séance.

14. **Pas un défaut — correction défaite.** **Une coupure signalée pendant l'attache laisse l'écran de coupure sur un lecteur prêt.**
    Si le moteur signale une erreur réseau pendant `probe.start`, puis que l'attache aboutit
    quand même, `declareReady` pose `ready` sans effacer `networkLost` : l'écran « connexion
    perdue » reste affiché par-dessus un lecteur prêt, jusqu'au nouvel essai. C'est juste : le
    moteur ne signale une coupure qu'une fois sa boucle de lecture arrêtée ; le lecteur « prêt » ne
    lira plus rien, et c'est cet écran qui programme le nouvel essai. L'effacer (essayé, puis défait
    le 27/09/2026) figeait le film au bout de son tampon, sans écran ni relance. Le test décrit
    désormais ce comportement comme voulu.

### Ce que les tests figent

`ExperimentalPlayerHost.test.tsx`, section « cycle de vie — comportement figé », décrit
l'hôte tel qu'il est aux croisements de cette carte — défauts compris : les tests des points 2, 4,
5 et 14 s'intitulent « comportement actuel, point n » et seront inversés, exprès, dans le commit
qui corrige chacun. Chaque ligne du tableau des transitions de l'hôte natif a au moins un test,
dans cette section ou dans les 95 qui la précèdent.

Un croisement de la carte n'est pas atteignable depuis l'écran : le changement de piste pendant
une reconstruction. Le menu des pistes disparaît tant que le lecteur se reconstruit ; seuls le
banc ou une touche média y arriveraient, et le code le traite (`wantedAudioRef`).

---

## Ce que chaque couche écrit au journal

| Ligne | Hôte natif | Lecteur serveur |
|---|---|---|
| `start` | une par pipeline (chaque reconstruction en écrit une, avec `rebuild`) | une par négociation |
| `stop` | fermeture, épisode suivant, `pagehide`, démontage ; jamais après une bascule ; `why: "lost"` renvoyé au lancement suivant si iOS a tué la page | fermeture, épisode suivant — pas au démontage, pas d'arrêt perdu récupéré |
| `fallback` | bascule vers le serveur (`takeover`, `cast`, `watched`) | fin de diffusion (`cast: true`) |
| `error` | bascule impossible (pas de lecteur serveur) | refus de négociation, reconnexion Jellyfin, pas d'image en 20 s, erreur pendant une diffusion |
| `rebuild` | source perdue, retour d'arrière-plan (`hiddenMs`) — **pas** pour un changement de piste, le plafond HDR ni un nouvel essai réseau | — |
| `network` | coupure en pleine lecture — **pas** pendant le sondage ou l'attache | — |
| `seek`, `stall`, `audio` | oui | — |
| `cast` | — | route AirPlay établie |

Trous connus côté serveur : aucune ligne quand les nouveaux essais hls.js ou l'échelle audio sont
épuisés, ni pour l'escalade par rechargement WebKit, le bouton Réessayer ou le retour de
diffusion.

---

## Vers une machine à états explicite

Ce document est aussi la carte d'un découpage possible : sortir les **décisions** de l'hôte natif
dans un module pur, testable sans navigateur, sans toucher à la mécanique (moteur, tampons,
pistes). L'hôte garderait ses effets, et demanderait au module ce qui est permis au lieu de le
recalculer avec ses drapeaux.

Les coutures existent déjà :

- **Le moteur est déjà une machine à états** raisonnablement fermée (`generation`,
  `SeekLifecycle`, `PlaybackGuard`, `BufferQueue`). Il n'y a pas à le redécouper.
- **Le contrat moteur → hôte est petit** : cinq rappels, une poignée d'accesseurs. C'est la
  frontière naturelle.
- **Les transitions de l'hôte passent déjà par trois fonctions** — `restart`, `declareReady`,
  `fallToStable`. Ce sont les points où un module d'état s'insérerait.

Un ordre de découpage, du moins au plus risqué, chaque étape sans changement de comportement :

**Où on en est (27/09/2026).** Étape 1 faite : le modèle d'ouverture et de reconstruction vit dans
`src/lib/playerLifecycle.ts` (`PlayerLifecycle`) — budget, position de reconstruction, « même
endroit », règle de pause, position d'ouverture, retour d'arrière-plan, nouveaux essais réseau,
passage de main, fin de film et fermeture. Déplacé à l'identique d'abord (commit à part, les 105
tests de l'hôte inchangés), puis les points 2, 4 et 5 corrigés dedans. L'hôte l'appelle ; il n'y
écrit plus de drapeau lui-même. `restart` y est **le seul point de contrôle** des reconstructions
automatiques : refusées une fois la main passée ou pendant la fermeture, au moment où elles
partiraient — un contrôle posé seulement là où elles se programmaient laissait passer un minuteur
déjà armé. Une reconstruction demandée par le spectateur (réessayer, une piste, le plafond HDR)
passe toujours et redonne la main au lecteur.

1. **Les états de reconstruction** (`lifecycle.rebuildAt`, `rebuildCount`, `lifecycle.spendRebuild`,
   `networkLost`, `lifecycle.keepPaused`) : un réducteur pur « ouvrir / prêt / perdu / réseau perdu /
   abandon », avec ses tests. Règle naturellement les points 1, 2 et 4 — **mais en les corrigeant,
   pas en les déplaçant** : à faire en deux temps, d'abord à l'identique, puis la correction avec
   son test.
2. **Les sauts côté hôte** (`requestedSeekRef`, `seekTimingRef`, `noteSeekRequest`) — déjà
   clarifiés le 22/09.
3. **La fin de film et la fermeture** (`ended`, `lifecycle.isEnded()`, `closing`, `stopReportedRef`,
   `steppedAside`) : un seul endroit qui dit « cette séance est finie » — points 5 et 7.
4. **Le retour d'arrière-plan** (`hiddenAtRef`, `hiddenPlaybackRef`, `holdOnReturnRef`) — en
   dernier : c'est là que vivent les défauts propres à iOS, et le seul juge est un appareil.

Avant chaque étape : figer le comportement actuel par des tests, défauts compris ; puis déplacer ;
les tests doivent rester verts. Après chaque étape : comparer au journal, par `build`, les
bascules, erreurs, blocages et reconstructions avec la version d'avant.
