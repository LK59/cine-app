# Les décisions prises à plusieurs endroits

`CLAUDE.md` nomme la dette de ce dépôt : *la même décision est prise à plusieurs endroits, et elles
dérivent*. Ce fichier est leur registre, et le seul. Pour chacune : la règle, **la fonction qui la
porte**, ceux qui l'appellent, les tests qui la tiennent — et ce qui diffère **exprès** d'un
endroit à l'autre, pour que personne ne « corrige » une différence voulue.

La règle de fond : **une décision a une fonction, et les écrans l'appellent**. Deux copies d'une
même règle ne restent identiques que jusqu'au jour où l'une apprend quelque chose. Quand on touche
à l'une de ces décisions, on la cherche ici d'abord ; quand on en trouve une nouvelle, on l'ajoute.

`src/__tests__/decisions-partagees.test.ts` lit la source et échoue si une copie réapparaît : il ne
vérifie pas que la règle est juste — ses tests à elle le font — mais qu'il n'y en a qu'une.

Inventaire du 21/09/2026. Les numéros de ligne changent : on cite les fonctions.

---

## 1. D'où part une lecture

**Règle.** Un nombre — zéro compris — est une affirmation ; un champ `resumeAt` absent veut dire
« je ne sais pas, demande au serveur ». « Recommencer » dit toujours zéro. Un appelant n'affirme
une position que si **Jellyfin a répondu** — pas seulement si la requête est revenue.

**Porteur.** `src/lib/resumePosition.ts`
- `resumeAtFor({ fromStart, known, resumeTicks })` — ce qu'un appelant peut affirmer ;
- `resolveResumeAt(itemId, resumeAt)` — ce qu'un lecteur fait d'une absence : il lit
  `playback-state` (8 s de garde, puis le début).

**Appelants.** `PlayButton` (fiche film bureau, fiche série bureau), `CinemaMobileDetail.play`.
Lecteur stable : `PlayerHost` passe par `resolveResumeAt` avant d'ouvrir. Lecteur natif : sa
propre lecture de `playback-state` (qui rapporte aussi les préférences de pistes) puis
`session.resumeAt ?? playbackState.resumeSeconds`.

**Tests.** `resumePosition.test.ts`, `PlayButton.test.tsx`, `resumeContract.test.ts` (chaque
`.play({` du dépôt porte un `resumeAt` explicite ou le dit), `decisions-partagees.test.ts`.

**Corrigé le 21/09.**
- Les fiches film (bureau et mobile) lisaient `progress !== undefined`. La route revient
  `{ known: false, resumeTicks: null }` quand Jellyfin ne répond pas : le film partait à zéro, et
  les rapports de progression effaçaient chez Jellyfin la position qu'on voulait reprendre.
  Elles lisent maintenant `progress?.known === true`.
- Le lecteur stable lisait une absence comme zéro (`if (resumeAt) …`) : un compte réglé sur le
  lecteur stable repartait du début.

**Voulu.** Les boutons d'épisode passent `episode.resumeTicks … : 0` sans `known` : la liste
d'épisodes n'existe que si la route a répondu, et elle porte la position de chaque épisode.

**Reste connu.** `playback-state` répond `resumeSeconds: 0` quand Jellyfin échoue, au lieu de le
dire. Un lecteur ouvert pendant une panne de Jellyfin part donc du début — mieux que de ne pas
s'ouvrir, et rare.

## 2. L'épisode suivant

**Règle.** Ordre des saisons puis des épisodes, spéciaux (saison 0) en dernier ; la fin d'une saison
enchaîne sur la suivante ; après le dernier, rien.

**Porteur.** `nextEpisodeIn(seasons)` — `src/lib/nextEpisode.ts`. L'ordre des saisons est celui de
la route `cinema/series/[id]/episodes`, qui le fixe.

**Appelants.** `CinemaSeriesDetail`, `CinemaMobileDetail`, `playSeriesNextEpisode` (« lire la
suite » depuis une rangée). Les deux lecteurs ne font que l'appeler (`session.getNextEpisode`).

**Tests.** `nextEpisode.test.ts`, `decisions-partagees.test.ts`.

**Corrigé le 21/09.** Les trois copies du cinéma, identiques mais sans test, sont devenues une.
La page de gestion Sonarr cherchait « même saison, numéro + 1 » : elle s'arrêtait à chaque fin
de saison et au premier trou de numérotation. Elle suit maintenant le même ordre, sur les objets
Jellyfin qu'elle a sous la main (elle n'a pas la charge du cinéma).

**Reste connu.** Aucun des deux lecteurs ne relit les vues après un enchaînement (`advance`) ;
elles le sont à la fermeture (`refreshAfterPlayback`), qui couvre toute la séance.

## 3. Quelle piste audio ouvre

**Règle** (voir `CLAUDE.md`) : la langue demandée, puis ce que le chemin porte, puis le plus de
canaux, puis le drapeau du fichier, puis l'ordre du fichier. **Choisie avant de construire le
pipeline**, et par la même fonction que l'écran, sinon la bascule revient.

**Porteur.** `chooseAudioTrack` / `rank` — `src/lib/trackPreferences.ts`.

**Appelants.**
- Remux : `preferredAudio` (`remuxPlayback.ts`) à l'ouverture ; `applyPreferences` à l'écran.
  Un pipeline **reconstruit** ouvre sur la piste choisie par le spectateur quand elle joue ici
  (`openingAudio`, depuis le 22/09/2026) : tout changement de piste passe par cette
  reconstruction (`requestAudioTrack`), et ouvrir ailleurs puis y basculer en redemanderait une
  seconde.
- Canevas : l'option `chooseAudioTrack` de `PlaybackEngine.load`, que l'hôte remplit avec la même
  fonction ; `applyPreferences` à l'écran.
- Lecteur stable : Jellyfin choisit (l'index passé à `playback/start`).

**Tests.** `trackPreferences.test.ts`, `preferredAudio.test.ts`, `ExperimentalPlayerHost.test.tsx`
(« le canevas ouvre sur la bonne piste »), `decisions-partagees.test.ts`.

**Corrigé le 21/09.** Le canevas ouvrait toujours sur la piste par défaut et basculait ensuite —
la bascule supprimée la veille pour le remux. Et sa conversion des pistes oubliait les canaux :
le départage « le plus riche » y était inerte.

**Voulu.**
- À l'ouverture du remux, on ne classe que les pistes **jouables** ; l'écran classe tout. Quand la
  langue demandée n'existe qu'en piste injouable, les deux diffèrent exprès : on ouvre sur ce qui
  joue, et choisir cette piste à l'écran passe la main au lecteur serveur (test dédié dans
  `preferredAudio.test.ts`). Le TrueHD était ce cas jusqu'au 21/09/2026 ; il est décodé ici depuis,
  et il n'en reste plus dans la bibliothèque — le test garde la règle avec du RealAudio.
- Sans préférence, `preferredAudio` prend la plus riche des pistes jouables, et l'écran ne touche
  à rien (`chooseAudioTrack` rend `null`) : pas de désaccord possible, donc pas de bascule.

## 4. Quand un fichier va au lecteur serveur

**Règle.** Un refus qui vise le *lecteur* (aucun chemin local ne portera ce fichier) arrête la
chaîne et passe au serveur ; un refus qui vise le *chemin* essaie le suivant. Voir `CLAUDE.md`.

**Porteur.** `choosePlaybackPath` (`pathSelector.ts`) à l'ouverture : Dolby Vision sans couche
HDR10. (Le TrueHD/MLP partout, `SANS_DECODEUR`, était le second cas jusqu'au 21/09/2026 : son
décodeur existe maintenant ici — `truehd/`, FFmpeg compilé en WebAssembly.)

**Voulu.** En plein film, choisir une piste que le remux ne porte pas (`canCarryAudio`, c'est-à-dire
`playableAudio`) passe la main au serveur **plutôt qu'au canevas**, même si le canevas saurait la
décoder. Reconstruire en cours de film sur un autre chemin est plus fragile que de confier le
fichier à Jellyfin, qui le lit toujours. C'est un choix de robustesse, pas l'oubli du prédicat.

## 5. Le nom d'une piste

**Porteur.** `labelAudioTracks` / `labelSubtitleTracks` — `src/lib/trackLabel.ts`, forme fixée dans
`CLAUDE.md`. Pour ce que le titre dit d'une piste : `titleSaysForced`,
`titleSaysHearingImpaired`, `isForcedTrack` — `src/lib/trackPreferences.ts`.

**Appelants.** Les deux lecteurs ; le `<track>` du lecteur stable ; la page de gestion Radarr via
`describeFileTracks` (`fileTracks.ts`).

**Une seule conversion des pistes du conteneur :** `fromMatroskaTrack`
(`src/lib/webcodecs/engineTrack.ts`), pour le remux et le canevas.

**Tests.** `trackLabel.test.ts`, `fileTracks.test.ts`, `webcodecs-engineTrack.test.ts`.

**Corrigé le 21/09.**
- Le lecteur natif perdait le drapeau « malentendants » du conteneur : il n'étiquetait SDH que les
  pistes dont le titre le disait (85 ici) quand le lecteur stable en reconnaissait 112.
- `fileTracks.ts` avait ses propres motifs : « Forces spéciales » y était forcé, « Forcé » ne
  l'était pas.

**Reste connu.** `FileTrackChips` (page de gestion Radarr) garde sa propre mise en forme — nom de
langue, `6 ch` pour les dispositions rares, mots français en dur. C'est un écran d'administration
qui montre le fichier tel qu'il est, pas un choix de lecture ; à aligner le jour où on y touche.

## 6. « Vu » et « Favori »

**Règle.** Ils appartiennent à Jellyfin. On n'écrit que si on a pu lire (`known`) : une lecture
ratée ne doit pas devenir une écriture.

**Porteur.** `useJellyfinItemState` — les trois fiches du cinéma.

**Tests.** `useJellyfinItemState.test.tsx`.

**Reste connu.** Les pages de gestion Radarr/Sonarr basculent directement depuis
`UserData.Played`, sans la garde `known`. Réservées à l'administrateur.

## 6 bis. « Ma liste »

**Règle.** Une seule liste locale, « À voir » (`to_watch`). « Vu » et « Favori » sont à Jellyfin,
les demandes à Jellyseerr : les garder aussi ici, c'était deux vérités.

**Porteurs.** `watchlistDb` (`db.ts`) ; `migrate()` ramène à chaque démarrage tout ancien statut à
« À voir » (à demander, favori) ou le retire (vu, abandonné). `POST /api/watchlist` n'écoute plus
ni statut ni note.

**Tests.** `watchlist-single-list.test.ts` (la migration, sur une vraie base), `watchlist-route.test.ts`,
`PosterCard.test.tsx`, `gestion-coherence.test.ts`.

**Corrigé le 21/09.** Onze titres « à demander » apparaissaient dans le panneau du lecteur et pas
dans la rangée « Ma liste » du cinéma, qui ne lisait que `to_watch`. La page de gestion qui
maintenait cinq statuts et des notes (0 note sur 47 titres) est supprimée.

**Qui peut y entrer.** Un titre qui a un identifiant TMDB — la liste est indexée dessus :
`canJoinWatchlist` (`useAddToWatchlist.ts`). Sans lui, le bouton n'est pas rendu. Appelants : la
fiche série du bureau, la fiche du téléphone (la fiche film du bureau a toujours un identifiant
Radarr → TMDB). Corrigé le 21/09 : les deux envoyaient `tmdbId ?? 0`, la route répondait 400 et la
fiche en affichait l'erreur brute, en français. Tests : `decisions-partagees.test.ts`.

## 7. Refermer une fiche, et ce qu'on relit après une lecture

**Porteurs.** `cinemaClose` (seule sortie), `useDelayedClose` / `useExitDelay` (l'un ou l'autre,
jamais les deux pour une même décision), `refreshAfterPlayback` (les quatre vues relues à la
fermeture du lecteur, par les deux lecteurs). Contrat complet dans `CLAUDE.md`, « The sheet
lifecycle ».

**Tests.** `decisions-partagees.test.ts`, `useDelayedClose.test.tsx`, `useExitDelay.test.tsx`,
`sheet-stack-under-discover.test.ts`, `cinemaRoute.test.tsx`, `refreshAfterPlayback.test.ts`.

**Voulu.** Le mobile n'a pas de champ `episodes` dans l'adresse : ses épisodes vivent dans la
fiche, pas dans un panneau.

### 7.1 Une fiche qui s'en va n'a plus d'avis

**Règle.** Pendant sa sortie, une fiche n'écoute plus Échap, ne reçoit plus le doigt, et sa
fermeture ne fait plus rien (règle 2 de « The sheet lifecycle »).

**Porteurs.** `useSheetExit(close, { leaving, listening })` (`src/lib/useSheetExit.ts`) pour les
fiches dont la coquille tient la sortie : `PlayerPersonSheet`, `PlayerDiscoverSheet`.
`PlayerPanelFrame` tient la même règle pour les panneaux. Les fiches de bibliothèque passent par
`useDelayedClose`, qui absorbe déjà une seconde demande.

**Corrigé le 21/09.** Aucune des deux fiches ne regardait `leaving` : la garde de `cinemaClose` ne
tient que jusqu'au `popstate`, donc un second Échap ou un second appui sur le voile ou la croix
pendant les 280 ms de sortie reculait d'un cran de plus et refermait l'écran du dessous.

**Tests.** `sheet-exit.test.tsx`, `decisions-partagees.test.ts`.

### 7.2 L'animation d'une fiche qu'on tire

**Règle.** L'entrée s'éteint pour de bon au premier contact avec la poignée (elle anime la même
transformation que le doigt) ; la sortie ne se tait **que** si c'est le geste qui a refermé la
fiche. Une croix posée dans la poignée n'en fait pas partie.

**Porteurs.** `sheetMotionClass` (`src/lib/sheetMotion.ts`), `dismissed` et `NOT_THE_HANDLE`
(`src/lib/useSwipeToDismiss.ts`). Appelants : `CinemaMobileDetail`, `PlayerDiscoverSheet`,
`PlayerPersonSheet`.

**Corrigé le 21/09.** Les trois écrivaient `swipe.touched ? "" : closing ? "sheet-out" : …` :
après un simple appui sur la bannière, toutes les fermetures suivantes disparaissaient d'un coup.
Et la croix de la fiche découverte, sans `NOT_THE_HANDLE`, démarrait le geste — la poignée prenait
la capture, ce qui sur Chrome pour Android renvoie le clic ailleurs que sur la croix.

**Voulu.** `out` et `into` changent d'une fiche à l'autre : la fiche personne se pose au centre sur
grand écran (`md:animate-fade-*`), la fiche de bibliothèque sort sans animation quand rien n'est
dessiné derrière elle (`swapsInPlace`).

**Tests.** `useSwipeToDismiss.test.tsx`, `sheet-exit.test.tsx`, `cinema-mobile-detail-keys.test.tsx`,
`decisions-partagees.test.ts`.

### 7.3 Le lecteur tient le clavier

**Règle.** Une fiche restée montée sous le lecteur n'écoute aucune touche tant que le film est en
plein écran.

**Porteur.** `playerHoldsKeyboard(playback)` (`src/lib/playerKeyboard.ts`). Appelants :
`CinemaMobileDetail`, `CinemaMovieDetail`, `CinemaSeriesDetail`, `CinemaEpisodeBrowser`, et
`gridIsTop` (`src/lib/cinemaGridTop.ts`) pour la grille du bureau — flèches, « / », carte centrée.

**Corrigé le 21/09.** Les fiches du bureau le savaient, chacune avec son `playback.mode === "full"` ;
la fiche du téléphone non — Échap sur une tablette à clavier refermait le lecteur *et* la fiche.

Le raccourci « / » de `CinemaClient`, dernier à lire `mode === "full"` en direct, passe depuis le
21/09 au soir par `gridIsTop`, qui passe par elle.

**Tests.** `cinema-mobile-detail-keys.test.tsx`, `decisions-partagees.test.ts`.

### 7.4 Une prise de pointeur

**Règle.** Toute capture de pointeur passe par `usePointerCapture` (rendue au démontage, jamais
levée sur un pointeur déjà parti). Appelants : `useSwipeToDismiss`, `useCarouselDrag`, la feuille
d'action et le mini-lecteur.

**Corrigé le 21/09.** Le carrousel de la bannière capturait à la main, sans rien rendre si la
bannière se démontait en plein glissement.

**Tests.** `usePointerCapture.test.tsx`, `useCarouselDrag.test.tsx`, `decisions-partagees.test.ts`
(aucun autre fichier n'appelle `setPointerCapture`).

## 7 cinquies. Une recherche qui échoue

**Règle.** Une recherche qui échoue efface les résultats d'une frappe précédente et dit qu'elle a
échoué — jamais « rien trouvé », qui affirme ce qu'on ne sait pas.

**Porteur.** `useSearchResults(url)` (`src/lib/useSearchResults.ts`). Appelants :
`PlayerSearchPanel`, `PlayerListAdd`.

**Corrigé le 21/09.** Les deux posaient leur propre `useSWR` avec `keepPreviousData` : hors ligne,
on lisait sous « dune » les résultats de « matrix ».

**Voulu.** Les résultats de la bibliothèque, cherchés sur place, restent affichés dans la recherche
générale : ils ne dépendent pas du réseau. La ligne d'échec s'affiche à côté d'eux.

**Tests.** `player-search-panel.test.tsx`, `player-list-add.test.tsx`, `decisions-partagees.test.ts`.

## 7 sexies. Se déconnecter

**Porteur.** `signOut(go)` (`src/lib/signOut.ts`) : prévient le serveur, puis va à `/login` quoi
qu'il arrive. Appelants : `PlayerAccountPanel`, `Sidebar`, `MobileNav`. Les trois attendaient
`fetch` sans garde : hors ligne, rien ne se passait. Tests : `signOut.test.ts`.

## 7 bis. La distribution et la fiche personne

**Règle.** Un titre montre sa distribution en visages ; chaque visage ouvre la fiche de la personne,
posée **par-dessus** le titre (carte au centre sur grand écran, panneau qui monte du bas sur
téléphone), qu'on referme d'un geste vers le bas ou en touchant le voile.

**Porteurs.** `CinemaCastRow` pour les trois fiches ; `PlayerPersonSheet` pour la personne — la
forme de la fiche acteur de la gestion (`ActorModal`), sur la mécanique du cinéma (adresse, pile,
`underneath`, sortie tenue par la coquille).

**Tests.** `CinemaCastRow.test.tsx`, `player-person-sheet.test.tsx`, `decisions-partagees.test.ts`.

**Voulu.** La gestion garde `ActorModal` : elle y ajoute un titre à Radarr, ce que le cinéma fait
autrement (la fiche découverte, puis « Demander »).

## 7 ter. Accroche, durée, arrivée

**Règle.** Des détails légers et discrets : l'accroche en italique sous les métadonnées ; la durée
d'un film, ou d'un épisode pour une série (« 45min/ép. ») ; « Arrive · 63 % » là où un spectateur
attend quelque chose — un titre demandé (fiche découverte) ou un épisode manquant. Jamais sur un
film de la bibliothèque : il a déjà un fichier, un téléchargement n'y serait qu'un remplacement.

**Porteurs.** `CinemaTagline`, `useRuntimeLabel`, `CinemaDownloading` (`CinemaDetailExtras.tsx`) ;
`queueProgress` / `titleDownloadProgress` (`src/lib/downloadProgress.ts`) côté serveur. Les fiches
se relisent toutes seules toutes les 15 s tant que quelque chose arrive, jamais sinon.

La durée d'un épisode vient de `tvEpisodeRuntime` (`src/lib/tvRuntime.ts`) : TMDB a abandonné
`episode_run_time`, vide pour les séries récentes — on passe par Sonarr puis par le dernier épisode.

Les notes critiques (`CinemaRatingsLine`) : une ligne de texte dans la fenêtre « Voir plus » des
fiches du bureau, **jamais sur téléphone**, par choix. La fenêtre reste ouvrable quand il y
a des notes, même si le synopsis tient en entier (`alwaysOpenable`).

**Tests.** `CinemaDetailExtras.test.tsx`, `tvRuntime.test.ts`, `player-routes.test.ts`,
`decisions-partagees.test.ts`.

## 7 quater. Les réglages d'un compte, et l'écran d'accueil

**Règle.** Les réglages d'un compte (langues audio et sous-titres, mode des sous-titres, choix des
notifications) se choisissent avec les mêmes contrôles partout : panneau Compte et écran d'accueil.

**Porteurs.** `src/components/player/accountControls.tsx` (`LanguageSelect`, `SubtitleModeSelect`,
`NotificationChoices`). L'accueil : `PlayerOnboarding` / `PlayerOnboardingGate`, marqueur
`onboardingDb` — seul le bouton de fin l'éteint ; « Passer » ne le cache que jusqu'au prochain
lancement ; l'administrateur le rallume depuis Paramètres.

**Voulu.** Le préremplissage garde ce qui est réglé chez Jellyfin et ne met le français que là où
il n'y a rien ; « quand l'audio n'est pas dans ma langue » seulement pour un compte qui n'avait
réglé aucune langue.

**Tests.** `PlayerOnboarding.test.tsx`, `onboarding-db-routes.test.ts`,
`player-notification-choices.test.tsx`.

## 8. Pastilles de qualité

**Porteur.** `qualityBadges` (`videoQuality.ts`) et `QualityBadges.tsx`, pour les deux bannières et
les deux fiches. Tests : `videoQuality.test.ts`. Les tranches de qualité de la page Radarr sont un
filtre d'administration, pas une pastille.

## 9. La langue de l'interface

**Porteur.** `getLocaleFromCookie` / `localeOf` (`i18n.ts`).

**Reste connu.** `app/layout.tsx` et `api/search/route.ts` relisent le cookie à la main, sans le
`decodeURIComponent` de `localeOf`. Sans effet aujourd'hui : les quatre valeurs possibles n'ont
rien à décoder.

## 10. La grille du bureau est-elle l'écran du dessus ?

**Règle.** Rien ne la recouvre dans l'adresse — ni fiche (`film`, `serie`), ni fiche TMDB ou
personne, ni la grille complète (`browse`), ni un panneau du rail (recherche, Ma liste, compte) —
et le lecteur n'est pas en plein écran. Refermer une fiche ne rend le focus à la grille que si
c'est elle qu'on découvre, et une fois qu'elle l'est redevenue (l'adresse change un tour plus
tard).

**Porteur.** `src/lib/cinemaGridTop.ts` — `coversGrid(route)`, `gridIsTop(route, playerMode)`,
`closeUncoversGrid(route, sheetBehind)`, `gridCardInFocus(pane)` (seule une carte de la grille
est retenue comme point de retour, jamais un bouton de fiche).

**Appelants.** `CinemaClient`, six fois : `useTvGridNav`, `useCentredCard`, le raccourci « / »,
`inert` sur la grille, la pause des deux rotations de bannière, le focus rendu par
`closeDetail` / `closeSeriesDetail`.

**Tests.** `CinemaClient-grid-top.test.tsx` (l'écran entier monté, fiches en doublures).

**Corrigé le 21/09.** Six conditions recopiées, aucune identique : les flèches et « / » ignoraient
la grille complète ou les fiches TMDB (une flèche envoyait le focus sur une affiche cachée,
Entrée ouvrait un film invisible) ; le focus rendu ignorait les panneaux ; la bannière tournait
sous les fiches et redessinait tout l'écran toutes les 8 s.

**Voulu.**
- `inert` suit `coversGrid` et non `gridIsTop` : sous le lecteur plein écran, la carte qui l'a
  lancé doit garder le focus pour le retour.
- Les titres similaires et les sagas passent par `openSimilarTitle` (`cinemaOpen.ts`), qui ne
  touche pas à l'onglet — comme `openResumeTarget`. Le bureau seulement : la pile du téléphone
  lit l'onglet autrement et garde `openLibraryTitle`.
- Le téléphone n'a ni flèches ni bannière tournante sous ses fiches : pas d'appelant là-bas.

---

## 11. Un logo qui ne vient pas

**Règle.** Un logo refusé ne laisse jamais d'image cassée : il cède la place au titre écrit.

**Fonction.** `CinemaLogo` (`src/components/cinema/CinemaLogo.tsx`) : il retient l'adresse
refusée et rend son `fallback`, puis prévient l'appelant par `onError`.

**Appelants.** Les deux bannières du bureau, les deux fiches du bureau, la fiche du téléphone
(elles gèrent encore leur titre elles-mêmes par `onError`), et la bannière du téléphone, par
`fallback`.

**Tests.** `CinemaLogo.test.tsx`.

**Corrigé le 21/09.** Cinq endroits le faisaient chacun à sa façon ; la bannière du téléphone,
sixième, l'avait oublié : *Dallas Buyers Club* y montrait l'icône d'image cassée de Safari au
milieu de l'affiche, et plus aucun nom.

## 12. Ce que Lire trouve déjà prêt

**Règle.** Une fiche ouverte demande d'avance les deux réponses sans lesquelles le lecteur natif
ne peut pas ouvrir son titre : la description du fichier (`/api/jellyfin/direct/…`) et l'état du
spectateur (`/api/jellyfin/playback-state/…`). Seulement pour le titre du bouton principal — le
film, ou l'épisode à reprendre —, **jamais** depuis une carte ni une ligne d'épisode. Seulement
quand c'est le lecteur natif qui ouvrira (même règle que `PlayerHost`). L'état du spectateur n'est
repris que s'il a moins de trente secondes, une seule fois, et il est oublié à chaque fermeture de
lecteur et à chaque « vu » coché à la main : une position gardée à travers une lecture ferait
reprendre le film là où il en était avant.

**Porteurs.** `usePlaybackPrefetch(itemId)` (`src/lib/usePlaybackPrefetch.ts`) côté fiche ;
`src/lib/playbackPrefetch.ts` pour le reste — `directInfoKey`, `fetchPlaybackState`,
`prefetchPlaybackState`, `takePrefetchedPlaybackState`, `forgetPrefetchedPlaybackState`.

**Appelants.** `CinemaMovieDetail`, `CinemaSeriesDetail`, `CinemaMobileDetail`. Lecteur natif :
`ExperimentalPlayerHost` lit la description sous `directInfoKey` (SWR reprend la demande en vol)
et prend l'état préparé, sinon le demande. L'oubli : `refreshAfterPlayback` (avant et après le
rapport d'arrêt) et `revalidateWatchState`.

**Tests.** `playbackPrefetch.test.tsx`, `ExperimentalPlayerHost.test.tsx` (« ce que la fiche a
préparé avant Lire »), `decisions-partagees.test.ts`.

**Voulu.** Le lecteur serveur ne consomme rien de ce qui est préparé : il ne lit pas la
description, et `resolveResumeAt` ne sert qu'aux appelants qui ne connaissent pas la position.
La description, elle, reste en cache toute la session — c'était déjà le cas dans l'hôte, et le
fichier ne change pas sous un film ; une taille périmée est corrigée par le flux lui-même (voir
DOC-TECH, « `byteSource` — HTTP range reads »).

---

## Ce qui n'est pas une dette

Deux interfaces — bureau et mobile — ne sont pas une décision dupliquée : ce sont deux produits
(voir `CLAUDE.md`). La dette, c'est une *règle* écrite deux fois. Le bon axe n'est pas la taille
d'écran : un correctif de reprise a manqué la fiche série alors qu'il avait touché le film et sa
jumelle mobile. On compte les endroits qui décident, pas les mises en page.
