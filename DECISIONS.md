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

**Règle.** Ordre des saisons puis des épisodes ; la fin d'une saison enchaîne sur la suivante ;
après le dernier, rien. Les spéciaux (saison 0) forment leur propre suite : un spécial enchaîne sur
le spécial suivant, et le final de la série n'enchaîne jamais sur un spécial (corrigé le 23/09 —
la route les rangeant en dernier, le premier spécial passait pour l'épisode suivant du final).

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
- Lecteur stable : Jellyfin choisit (l'index passé à `playback/start`).

**Tests.** `trackPreferences.test.ts`, `preferredAudio.test.ts`, `decisions-partagees.test.ts`
(« le chemin natif ouvre sur la piste que l'écran choisira »).

**Corrigé le 21/09.** Le lecteur canevas (retiré le 24/09/2026) ouvrait toujours sur la piste par
défaut et basculait ensuite — la bascule supprimée la veille pour le remux. Et sa conversion des
pistes oubliait les canaux : le départage « le plus riche » y était inerte.

**Voulu.**
- À l'ouverture du remux, on ne classe que les pistes **jouables** ; l'écran classe tout. Quand la
  langue demandée n'existe qu'en piste injouable, les deux diffèrent exprès : on ouvre sur ce qui
  joue, et choisir cette piste à l'écran passe la main au lecteur serveur (test dédié dans
  `preferredAudio.test.ts`). Le TrueHD était ce cas jusqu'au 21/09/2026 ; il est décodé ici depuis,
  et il n'en reste plus dans la bibliothèque — le test garde la règle avec du RealAudio.
- Sans préférence, `preferredAudio` prend la plus riche des pistes jouables, et l'écran ne touche
  à rien (`chooseAudioTrack` rend `null`) : pas de désaccord possible, donc pas de bascule.

## 4. Quand un fichier va au lecteur serveur

**Règle.** Tout fichier que le chemin natif ne porte pas passe au lecteur serveur, avec la raison
écrite au journal — une panne réseau exceptée, qui a son propre écran. Il n'y a plus d'autre
chemin local à essayer entre les deux depuis le retrait du lecteur canevas, le 24/09/2026
(`docs/lecteur-canvas.md`) : la distinction « refus du chemin » / « refus du lecteur » qu'imposait
ce second chemin a disparu avec lui. Voir `CLAUDE.md`.

**Porteur.** `choosePlaybackPath` (`pathSelector.ts`) à l'ouverture, qui lève l'erreur ;
`fallToStable` dans l'hôte, qui passe la main. Un changement de piste qui échoue ainsi revient à
la piste d'avant au lieu de céder le film (`revertFailedSwitch`).

**Voulu.** En plein film, choisir une piste que le remux ne porte pas (`canCarryAudio`, c'est-à-dire
`playableAudio`) passe la main au serveur. Reconstruire en cours de film sur un autre lecteur est
plus fragile que de confier le fichier à Jellyfin, qui le lit toujours.

**Tests.** `webcodecs-pathSelector.test.ts`, `ExperimentalPlayerHost.test.tsx` (« un fichier que
le chemin natif ne porte pas »).

## 5. Le nom d'une piste

**Porteur.** `labelAudioTracks` / `labelSubtitleTracks` — `src/lib/trackLabel.ts`, forme fixée dans
`CLAUDE.md`. Pour ce que le titre dit d'une piste : `titleSaysForced`,
`titleSaysHearingImpaired`, `isForcedTrack` — `src/lib/trackPreferences.ts`.

**Appelants.** Les deux lecteurs ; le `<track>` du lecteur stable ; la page de gestion Radarr via
`describeFileTracks` (`fileTracks.ts`).

**Une seule conversion des pistes du conteneur :** `fromMatroskaTrack`
(`src/lib/webcodecs/playerTrack.ts`) — qui servait aussi le canevas, retiré le 24/09/2026.

**Tests.** `trackLabel.test.ts`, `fileTracks.test.ts`, `webcodecs-playerTrack.test.ts`.

**La langue nommée est celle que le choix de piste retient** : `trackLanguage`, qui lit le titre
quand le code manque. L'étiquette ne lisait que le code, si bien qu'une piste « French » sans code
était ouverte comme la piste française du compte et affichée « Piste 2 » (corrigé le 23/09).

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

## 13. L'animation de la colonne d'une fiche du bureau

**Règle.** La colonne de contenu d'une fiche du bureau entre en montant à l'ouverture, ne bouge
pas quand la fiche se découvre par un retour arrière (`arrivedByBack`), et sort en descendant.

**Porteur.** `detailColumnMotion({ leaving, revealed })` (`src/lib/sheetMotion.ts`).

**Appelants.** `CinemaMovieDetail`, `CinemaSeriesDetail`, `PlayerDiscoverSheet` (bureau).

**Tests.** `sheetMotion-column.test.ts`, `decisions-partagees.test.ts`.

**Corrigé le 23/09.** La racine respectait le retour arrière, la colonne non : le texte remontait
de seize pixels sous une fiche qui, elle, restait immobile. La fiche TMDB n'avait pas de sortie.

**Voulu.** Les fiches du téléphone passent par `sheetMotionClass` : elles glissent en entier, sans
animation propre à leur colonne.

---

## 14. Ce que la bannière du bureau dit d'un titre

**Règle.** La bannière affiche le synopsis traduit et cinq noms de la distribution, venus de TMDB
seul par une requête légère, gardée une semaine par titre et par langue. Elle attend 200 ms avant
de demander (un défilement aux flèches ne lance pas une requête par carte), sauf si la réponse est
déjà en cache. Jamais la réponse du titre précédent. Sans identifiant TMDB : le synopsis du
catalogue. Le synopsis s'arrête sur la dernière phrase entière qui tient dans deux lignes, et
retombe sur un fondu vers la droite si ce qui tient est trop court.

**Porteurs.** `useHeroInfo` / `heroInfoKey` / `preloadHeroInfo` (`src/lib/useHeroInfo.ts`) côté
écran ; `heroInfo` (`src/lib/heroInfo.ts`) et `/api/cinema/hero/[type]/[tmdbId]` côté serveur ;
`sentencesThatFit` (`src/lib/heroSynopsis.ts`) pour la coupure.

**Appelants.** `CinemaHero`, `CinemaSeriesHero` ; le préchargement dans `CinemaClient` (mêmes titres
et même ordre que les images : la rotation, puis les premiers de chaque rangée).

**Tests.** `cinema-hero-route.test.ts`, `useHeroInfo.test.tsx`, `CinemaHero-previous-synopsis.test.tsx`,
`heroSynopsis.test.ts`, `HeroOverview-fit.test.tsx`, `CinemaHeroOverview.test.tsx`.

**Corrigé le 23/09.** Les deux bannières lisaient chacune la requête de la fiche complète (six
services, le plus lent dictait le délai) ; le synopsis arrivait une seconde après le logo, et
`keepPreviousData` faisait remonter celui du titre d'avant.

**Voulu.** Les fiches gardent leur propre requête et leur « Voir plus » ; le téléphone, son texte
entier.

---

## 15. Retirer un film de « Reprendre »

**Règle.** Un appui long (doigt), un clic droit ou la touche menu (bureau) sur un **film** de la
rangée « Reprendre » ouvre un menu avec « Retirer de Reprendre ». La carte part tout de suite ; la
position seule est oubliée dans Jellyfin — ni l'état « Vu » ni le nombre de visionnages, que
« marquer non vu » effacerait. Un échec se dit, et la carte revient.

**Porteurs.** `useLongPress` (`src/lib/useLongPress.ts`), `useRemoveFromResume`
(`src/lib/useRemoveFromResume.ts`), `DELETE /api/jellyfin/resume` et `jellyfin.resetPlaybackPosition`
(`POST /UserItems/{id}/UserData`, Jellyfin 10.9+).

**Appelants.** `CinemaClient` (`ContinueCard`, `onMenu`), `CinemaMobileClient` (`LongPressButton`).

**Tests.** `useLongPress.test.tsx`, `useRemoveFromResume.test.tsx`, `resume-route.test.ts`,
`proxy-guest-mutations.test.ts` (la route est ouverte aux comptes ordinaires), `decisions-partagees.test.ts`.

**Voulu.** Pas de menu sur un épisode : « À suivre » est l'épisode suivant non vu, que Jellyfin ne
permet pas de masquer sans marquer la série vue. Une liste masquée locale serait une seconde source
de vérité.

---

## 16. Au nom de qui cine-app parle à Jellyseerr

**Règle.** Une action faite pour quelqu'un — demander, lister ses demandes, en annuler une — part :
avec le cookie Jellyseerr de sa session, s'il est encore accepté ; sinon avec la clé d'API **en
nommant son compte** (`userId`), retrouvé par son identifiant Jellyfin ; sinon après avoir importé
ce compte depuis Jellyfin ; sinon au nom du propriétaire de la clé. Ce dernier recours est voulu :
l'attribution sert au suivi, et une demande mal signée vaut mieux qu'une demande refusée. À la
connexion, un compte que Jellyseerr ne connaît pas est importé et la connexion réessayée une fois.

Le cookie ne s'obtient qu'à la connexion, et la session le garde des semaines : un compte connecté
avant d'exister dans Jellyseerr restait sans cookie, et ses demandes partaient au nom du
propriétaire de la clé — même une fois le compte importé. Quatre endroits résolvaient « mon
compte Jellyseerr », de trois façons, dont une qui ne savait lire que le cookie.

**Porteur.** `resolveJellyseerrIdentity`, `ensureJellyseerrUserId` et `loginToJellyseerr`
(`src/lib/jellyseerrIdentity.ts`).

**Appelants.** `/api/player/requests` (demander), `/api/player/requests/[id]` (annuler),
`getPlayerRequests`, `jellyseerr-scope.ts`, `/api/jellyseerr/requests`, `/api/jellyseerr/my-requests`,
`/api/auth/jellyfin` (connexion).

**Tests.** `jellyseerr-identity.test.ts`, `player-routes.test.ts`, `jellyseerr-routes.test.ts`,
`decisions-partagees.test.ts`.

**Voulu.** Sans cookie, l'annulation part avec la clé, qui peut tout supprimer : la demande est
relue d'abord, et refusée si elle n'est pas à la personne (l'administrateur excepté). Une demande
faite à la clé au nom de quelqu'un est approuvée comme le propriétaire de la clé l'approuverait ;
les droits de demander, eux, restent ceux de la personne.

---

## 17. Où se règlent les notifications

**Règle.** Les notifications se règlent à un seul endroit : le panneau Compte du cinéma. Chacun y
choisit ses trois annonces de spectateur ; l'administrateur y voit en plus les annonces de
téléchargement ; tout le monde peut s'y envoyer un essai. La gestion ne garde qu'un renvoi vers
ce panneau.

Deux écrans réglaient les mêmes choix, rangés au même endroit, sous des libellés différents — et
l'un décrivait encore une règle qui n'était plus la bonne (« série suivie » pour « série
commencée »).

**Porteurs.** `NotificationChoices` et `NotificationTest` (`src/components/player/accountControls.tsx`),
`VIEWER_NOTIFICATION_CATEGORIES` / `ADMIN_NOTIFICATION_CATEGORIES` (`src/lib/notifications.ts`).

**Appelants.** `PlayerAccountPanel` (tout), `PlayerOnboarding` (les choix de spectateur seulement).

**Tests.** `player-notification-choices.test.tsx`, `proxy-guest-mutations.test.ts`,
`decisions-partagees.test.ts`.

**Voulu.** Les annonces de téléchargement arrivent groupées (`torrentWatch.ts` : un lot après deux
minutes de calme, au plus dix minutes) ; les nouveaux épisodes, une fois par série et par passage.

---

## 18. Le titre d'un film ou d'une série

**Règle.** Un titre s'affiche dans la langue de qui regarde, pris dans les traductions de TMDB ;
à défaut, celui de Radarr ou de Sonarr. Le titre remplacé reste cherchable (`aka`). La traduction
n'est jamais attendue : un titre inconnu part sous son ancien nom, et sa traduction est cherchée en
arrière-plan (et au démarrage du serveur, pour toute la bibliothèque).

Radarr et Sonarr ne connaissent que l'anglais : un film français s'affichait sous son titre
anglais, juste sous une affiche qui portait le titre français.

**Porteur.** `getTitleNames` et `localizedTitle` (`src/lib/titleNames.ts`).

**Appelants.** `/api/cinema/movies`, `/api/cinema/series`, `/api/player/lists`, `instrumentation.ts`
(préchauffage).

**Tests.** `titleNames.test.ts`, `cinema-movies-route.test.ts`, `cinema-search.test.ts`.

**Voulu.** Les titres venus de Jellyfin (Reprendre, À suivre, le lecteur) restent ceux de Jellyfin,
dans la langue de ses métadonnées. Les notifications gardent le titre de Radarr : elles sont
écrites par le serveur, pour tout le monde à la fois.

## 19. Des sous-titres qui se chevauchent

**Règle.** Quand plusieurs répliques couvrent le même instant — deux personnes qui parlent en même
temps, un panneau traduit pendant un dialogue —, elles s'affichent ensemble, dans l'ordre où elles
sont apparues, deux au plus. En haut seulement si toutes le demandent (`{\an8}`).

Chaque lecteur n'en montrait qu'une, et pas la même : la première trouvée pour les pistes du
fichier (remultiplexage, et le canevas d'alors), la dernière commencée pour un fichier à côté — qui ne
regardait en outre que huit répliques en arrière et perdait un panneau long.

**Porteur.** `simultaneousText` (`src/lib/webcodecs/subtitleMarkup.ts`).

**Appelants.** `RemuxPlayback.subtitleAt`, `ExternalSubtitleTrack.textAt`. (`selectCue`, dans
le moteur canevas, en était un troisième jusqu'au 24/09/2026.)

**Tests.** `subtitleMarkup.test.ts`, `webcodecs-externalSubtitles.test.ts`.

**Voulu.** Le lecteur serveur n'est pas concerné : ses pistes passent par des `<track>` que le
navigateur dessine lui-même, chevauchements compris.

## 20. Quelle fiche ouvre un résultat de recherche

**Règle.** Un titre de la bibliothèque *regardable* — un film avec son fichier, une série avec au
moins un épisode — ouvre sa fiche de bibliothèque ; tout le reste, y compris un titre que Radarr ou
Sonarr suit sans l'avoir encore, ouvre sa fiche TMDB, qui dit où en est la demande.

Un film en salle suivi par Radarr (*L'Odyssée*) ouvrait sa fiche de bibliothèque, qui ne le
trouvait pas dans le catalogue et se refermait aussitôt : l'adresse passait à `#film=631` et
revenait, sans un mot.

**Porteur.** `available` dans `/api/search` (même règle que `playableLibrary`), lu par
`libraryTargetOf` (`src/lib/searchResultTarget.ts`).

**Appelants.** `PlayerSearchPanel`, `PlayerListAdd`.

**Tests.** `search-route.test.ts`, `player-search-panel.test.tsx`.

**Voulu.** La recherche de la gestion ignore ce champ : un titre suivi y reste un titre suivi.

---

## Ce qui n'est pas une dette

Deux interfaces — bureau et mobile — ne sont pas une décision dupliquée : ce sont deux produits
(voir `CLAUDE.md`). La dette, c'est une *règle* écrite deux fois. Le bon axe n'est pas la taille
d'écran : un correctif de reprise a manqué la fiche série alors qu'il avait touché le film et sa
jumelle mobile. On compte les endroits qui décident, pas les mises en page.

---

## 21. Un jeton Jellyfin que Jellyfin ne reconnaît plus

**Règle.** Changer ou réinitialiser un mot de passe révoque, côté Jellyfin, tous les jetons du
compte, alors que la session de l'application continue de se prolonger. Un refus du jeton (401)
n'est donc jamais silencieux : pendant un film, la position est écrite avec la clé
d'administration (mêmes seuils que Jellyfin : sous 5 %, rien ; au-delà de 90 %, vu) et le film
continue ; au chargement suivant d'une page, la session est fermée et la connexion redemandée
(`/login?reason=jellyfin`). Seul un 401 conclut : un Jellyfin absent ou lent ne dit rien du jeton.

**Porteur.** `src/lib/jellyfinToken.ts` (`jellyfinTokenAlive`, `markJellyfinTokenDead` — au plus
une question par heure et par session, un refus écrit une fois dans `server.log`, scope
`jellyfin-token`) ; `src/lib/playbackReport.ts` (`reportPlayback`, le filet des rapports).

**Appelants.** `src/proxy.ts`, sur les pages seulement ; les routes `playback/playing`,
`playback/progress`, `playback/stop`.

**Différent exprès.** Le proxy ne vérifie **jamais** sur une route d'API : fermer la session là
couperait aussi le flux d'un film en cours. `playback/start` (lecteur serveur) garde sa propre
réponse, `jellyfin_reauth_required`, parce qu'il ne peut rien lancer sans le jeton — la
négociation se fait avec lui.

**Tests.** `jellyfin-token.test.ts`.

**Trouvé le 24/09/2026** dans le journal du lecteur : deux films regardés en entier par un compte,
aucune seconde gardée, « Invalid token » toutes les 10 s dans le journal de Jellyfin, et la reprise
du lendemain repartie de zéro.

---

## 22. Ce que révoque une déconnexion

**Règle.** Chaque connexion à l'application obtient de Jellyfin un jeton, sous un appareil à elle
(`cine-app-<aléatoire>`), gardé avec la session (`sessions.jf_device`, pas un secret).
« Se déconnecter » ferme la session **et** supprime cet appareil chez Jellyfin, ce qui révoque son
jeton. « Déconnecter tous les autres » ne ferme **que** les sessions de l'application — choix de
l'administrateur. Une session fermée par l'administrateur, effacée parce qu'expirée, ou fermée
parce que son jeton était déjà refusé, révoque le sien. Seul l'appareil de la connexion tombe :
télévision, Jellyfin web et applications mobiles gardent leurs jetons. Toujours au mieux — un
Jellyfin absent n'empêche jamais de se déconnecter.

**Porteur.** `src/lib/jellyfinRevoke.ts` (`revokeJellyfinDevices`, qui refuse tout identifiant
qui ne commence pas par `cine-app-` ; `revokeJellyfinToken`, pour une session ouverte avant qu'on
garde son appareil — le jeton est dans son cookie).

**Appelants.** `/api/auth/logout`, `/api/auth/jellyfin` et `/api/auth/login` (ménage des
expirées), `/api/admin/activity/accounts/[id]` (fermeture par l'administrateur), `src/proxy.ts`
(jeton refusé).

**Différent exprès.** `/api/auth/sessions` (« tous les autres ») ne révoque rien chez Jellyfin.

**Tests.** `auth-routes.test.ts`, `jellyfin-revoke.test.ts`, `auth-jellyfin-route.test.ts`.

**Décidé le 24/09/2026**, en revenant sur le choix du 06/09 (rien ne se révoquait) : vingt-quatre
appareils « CineApp » s'étaient accumulés pour un seul compte, autant de jetons valides pour
toujours.

---

## 23. Qui lit le flux HLS du lecteur serveur

**Règle.** Le flux HLS va au pipeline du navigateur (`video.src`) sur WebKit seulement ; partout
ailleurs, à hls.js — même quand le navigateur répond oui à
`canPlayType("application/vnd.apple.mpegurl")`. La sonde des codecs pose la même question pour
choisir ce qu'elle interroge (`canPlayType` sur WebKit, MediaSource ailleurs), de sorte que le
profil négocié avec Jellyfin décrit le pipeline qui lira réellement le flux.

**Porteur.** `playsHlsNatively` (`src/lib/webkitEngine.ts`).

**Appelants.** `src/lib/codecSupport.ts` (`isNativeHlsBrowser`) ; `src/components/PlayerHost.tsx`
(le choix hls.js / natif, le remontage de l'élément, le rechargement au changement de piste et
en fin d'échelle).

**Tests.** `webkitEngine.test.ts`, `decisions-partagees.test.ts`.

**Trouvé le 25/09/2026** : Opera 135 (Chromium 151) sous Windows répond désormais oui au HLS.
L'hôte, qui ne demandait que `canPlayType`, lui a donné la playlist directement ; le HLS intégré de
Chromium l'a refusée quatre fois sans demander une variante, pendant que la sonde avait décrit
MediaSource. Le film ne démarrait pas du tout.

---

## 24. La lecture au retour d'arrière-plan

**Règle.** Une vidéo qui jouait quand l'application est passée en arrière-plan (écran verrouillé,
autre application) attend en pause au retour, 3 s avant l'endroit quitté, si l'absence a duré plus
de 5 s. Plus court, elle reprend comme avant. Une vidéo qui a continué pendant l'absence (image dans
l'image, lecture en arrière-plan) n'est pas touchée. La relance que WebKit fait de lui-même au
déverrouillage est refusée tant qu'aucun geste du spectateur ne l'a demandée ; une reconstruction au
retour (source fermée par iOS) repart elle aussi en pause, au même endroit.

**Porteur.** `holdPausedOnReturn`, `rewoundPosition` (`src/lib/backgroundReturn.ts`).

**Appelants.** `ExperimentalPlayerHost.tsx` : le relevé au départ, la décision au retour, le refus de
la relance, la reconstruction d'arrière-plan.

**Différent exprès.** Le lecteur serveur (`PlayerHost.tsx`) n'applique pas la règle : sur iPhone, il
sert surtout à diffuser vers un téléviseur, où la lecture continue par définition.

**Tests.** `backgroundReturn.test.ts`, `ExperimentalPlayerHost.test.tsx` (« la lecture au retour
d'une veille »).

**Décidé le 25/09/2026** : un film verrouillé une minute sur un iPhone repartait tout seul au
déverrouillage — c'est WebKit qui le relançait, notre lecteur n'y était pour rien. Netflix, YouTube et
l'app TV d'Apple laissent la lecture en pause.

---

## 25. La bannière quand ses données changent sous elle

**Règle.** Le catalogue s'affiche d'abord depuis le cache de l'appareil, puis les données fraîches
arrivent. La bannière suit **le titre qu'elle montre**, pas sa place dans la rotation : le titre à
l'écran y reste, et une nouveauté (un titre absent de l'ordre d'avant) vient juste après lui — elle
arrive au passage suivant, huit secondes au plus. Sans nouveauté, rien ne bouge. Dès que la bannière
quitte l'écran — l'autre onglet, un panneau du rail (Ma liste, Compte, recherche, grille complète,
activité), le lecteur en plein écran —, elle reprend l'ordre officiel depuis le début : la nouveauté
en premier. Pas une fiche (c'est une interaction : on revient au titre d'où l'on vient), pas le retour
d'arrière-plan (la bannière est alors à l'écran). Aucune mention « nouveau ». Les images du titre
suivant sont décodées d'avance. Les rangées d'affiches se réorganisent en glissant (`CATALOGUE_FLIP` :
jusqu'à huit cartes, un peu décalées, un fondu au-delà, le simple changement d'ordre compté), après la
bannière si elle change au même moment.

**Porteur.** `reconcileHeroOrder` et `heroOffscreen` (`src/lib/heroCarousel.ts`), portés par le hook
`useHeroOrder` ; `resolveHeroCarousel` rend les titres d'un ordre de clés. `CATALOGUE_FLIP`
(`src/lib/useFlipGrid.ts`) pour les rangées.

**Appelants.** `CinemaClient.tsx` (les deux bannières du bureau, films et séries) ;
`mobile/CinemaMobileHero.tsx`, avec `offscreen` posé par `CinemaMobileClient.tsx`. Rangées :
`CinemaRow`, `CinemaSeriesRow`, `CinemaTop10Row`, `CinemaDiscoveryRow`, `CinemaSpotlight`, « Reprendre »
des deux côtés, et `PosterRow`, `DiscoveryRow`, le classement du téléphone.

**Différent exprès.** Le titre à l'écran sorti de la liste officielle est retrouvé dans le catalogue
entier sur le bureau, dans les titres déjà montrés sur le téléphone — qui n'a pas le catalogue sous la
main. Les deux bannières ne partent pas de la même liste (le bureau : le « spotlight », le téléphone :
les ajouts récents) : c'était déjà le cas, ce chantier n'y touche pas. « Ma liste » et les demandes
gardent `useFlipGrid` sans options (trois changements, pas de fondu).

**Tests.** `heroCarousel.test.ts`, `useHeroOrder.test.tsx`, `CinemaMobileHero-fresh.test.tsx`,
`useFlipGrid.test.tsx` (« options du catalogue »), `decisions-partagees.test.ts`.

**Décidé le 25/09/2026**, avec le catalogue instantané : la bannière est la vitrine de la rapidité
d'ajout, et changer le film sous les yeux une demi-seconde après l'ouverture ressemble à un bug.
L'ancienne rotation retenait un index : une nouveauté insérée en tête lui faisait désigner un autre
film, sans rien qui l'explique.

---

## 26. Films ↔ Séries, et les affiches des rangées

**Règle.** Un onglet visité reste monté ; celui qu'on ne regarde pas est caché (`hidden`), inerte
(`inert`) et marqué `data-tab-hidden`, que la navigation au clavier et aux gestes ignore. Les
affiches des rangées de l'accueil sont décodées d'avance : les rangées jusqu'à deux écrans et demi
sous le bord, les douze premières cartes de chacune, dans la variante que l'affiche chargera
(`srcset` et `sizes` recopiés). Une affiche prête en moins de 100 ms (cache, chauffée d'avance)
s'affiche sans fondu ; une vraie arrivée réseau garde le sien.

**Porteurs.** `useKeptTabs`, `tabPaneProps`, `inHiddenTab` (`src/lib/keptTabs.ts`) ;
`useDecodeRowsAhead` (`src/lib/useDecodeAhead.ts`) ; `revealLoaded` (`src/lib/imageReveal.ts`).

**Appelants.** `CinemaClient.tsx` (un volet par onglet, « Reprendre » seulement dans le volet
affiché) et `CinemaMobileClient.tsx` (`MobileTabRows`, un par onglet) ; `useTvGridNav`,
`useCentredCard`, `PlayerRail` pour `inHiddenTab` ; `PosterImage`, `FadeInImg` pour `revealLoaded`.

**Différent exprès.** La bannière n'est pas dans ces volets : elle a sa propre règle (§25) et sa
remise à plat hors de l'écran ne dépend que de l'onglet courant. « Reprendre » n'existe qu'une fois,
dans le volet affiché : c'est la même rangée des deux côtés.

**Tests.** `keptTabs.test.tsx`, `useDecodeRowsAhead.test.tsx`, `imageReveal.test.tsx`,
`CinemaClient-grid-top.test.tsx` (« Films ↔ Séries sans reconstruction »), `decisions-partagees.test.ts`.

**Décidé le 25/09/2026** : en descendant l'accueil, les affiches « se génèrent au fur et à mesure »,
et revenir à Films « régénère les affiches », quand « Tous les films » paraissait tout rendre d'un
coup — lui seul décodait d'avance.

---

## 27. Les listes de la personne, redemandées

**Règle.** Ma liste (`TO_WATCH_KEY`, `/api/player/lists`), la reprise et « À suivre » sont
redemandées au retour de l'application au premier plan et à chaque changement d'onglet Films/Séries
— pas le catalogue, toujours figé pendant une séance. Rien pendant un film en plein écran (SWR y est
en pause). Deux demandes rapprochées de moins de 5 s n'en font qu'une.

**Porteur.** `useFreshPersonalLists` (`src/lib/freshLists.ts`).

**Appelants.** `CinemaClient.tsx`, `CinemaMobileClient.tsx`. Le panneau Ma liste se redemande de
lui-même à son ouverture (SWR, donnée de plus de 10 s).

**Tests.** `keptTabs.test.tsx` (« les listes personnelles redemandées »), `decisions-partagees.test.ts`.

**Décidé le 25/09/2026** : un titre ajouté à Ma liste depuis l'ordinateur, l'application ouverte sur
l'iPhone, n'y apparaissait ni en changeant d'onglet ni en ouvrant une fiche — seulement au
redémarrage.
