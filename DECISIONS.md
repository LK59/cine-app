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

**Appelants.** `PlayButton` (fiche film bureau, fiche série bureau — Lire et « Recommencer »,
variante `row`, `restart`), `CinemaMobileDetail.play`.
Lecteur stable : `PlayerHost` passe par `resolveResumeAt` avant d'ouvrir. Lecteur natif : sa
propre lecture de `playback-state` (qui rapporte aussi les préférences de pistes) puis
`session.resumeAt ?? playbackState.resumeSeconds`.

**Tests.** `resumePosition.test.ts`, `PlayButton.test.tsx`, `resumeContract.test.ts` (chaque
`.play({` du dépôt porte un `resumeAt` explicite ou le dit), `decisions-partagees.test.ts`,
`cinema-player-disabled.test.tsx`.

**Corrigé le 21/09.**
- Les fiches film (bureau et mobile) lisaient `progress !== undefined`. La route revient
  `{ known: false, resumeTicks: null }` quand Jellyfin ne répond pas : le film partait à zéro, et
  les rapports de progression effaçaient chez Jellyfin la position qu'on voulait reprendre.
  Elles lisent maintenant `progress?.known === true`.
- Le lecteur stable lisait une absence comme zéro (`if (resumeAt) …`) : un compte réglé sur le
  lecteur stable repartait du début.

**Corrigé le 29/09.** Les deux fiches du bureau réécrivaient leur ligne « Recommencer » au lieu
de passer par `PlayButton`, et en avaient perdu la garde de lecture intégrée : avec
`PLAYER_ENABLED=false`, la ligne s'affichait et menait à « Lecteur intégré désactivé ». Elles
rendent maintenant `<PlayButton restart variant="row">`. Les lignes d'épisode (navigateur du
bureau, liste du téléphone), qui ne passent pas par `PlayButton`, lisent la même réponse
(`usePlayerEnabled` / `usePlayerEnabledState`) : sans lecture intégrée, elles restent lisibles,
sans pastille de lecture, et ne lancent rien.

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
canaux **livrés**, puis la piste copiée plutôt que ré-encodée, puis le drapeau du fichier, puis
l'ordre du fichier. **Choisie avant de construire le pipeline**, et par la même fonction que
l'écran, sinon la bascule revient.

Les canaux livrés sont le moindre de la source et de ce que l'encodeur du navigateur sait
produire — depuis le 29/09/2026. Compter ceux de la source faisait passer, sur un système Apple,
une TrueHD 7.1 devant une AC-3 5.1 de la même langue : décodée en WebAssembly, ré-encodée par
l'AAC d'Apple plafonné à six canaux, elle sortait en 5.1 comme l'AC-3, qui aurait été copiée.
Là où la 7.1 sort réellement en 7.1 (l'Opus huit canaux de Firefox), elle gagne toujours.

**Porteur.** `chooseAudioTrack` / `rank` — `src/lib/trackPreferences.ts`. Les canaux livrés et
la copie viennent de `deliveredAudio` (`remuxer.ts`) : la copie de `audioDelivery`, le prédicat de
`playableAudio` ; les canaux ré-encodés du plan que `chooseTranscodePlan` a obtenu du navigateur
(`knownTranscodePlan`), demandé pour chaque piste à ré-encoder par `primeAudioDelivery` juste
avant le choix (`probeOpened`). Aucune liste de plafonds n'est écrite à part.

**Appelants.**
- Remux : `preferredAudio` (`remuxPlayback.ts`) à l'ouverture ; `applyPreferences` à l'écran,
  qui lit les mêmes réponses sur `PlayerTrack.delivered` (posé par `RemuxPlayback.audioTracks`).
  Un pipeline **reconstruit** ouvre sur la piste choisie par le spectateur quand elle joue ici
  (`openingAudio`, depuis le 22/09/2026) : tout changement de piste passe par cette
  reconstruction (`requestAudioTrack`), et ouvrir ailleurs puis y basculer en redemanderait une
  seconde.
- Lecteur stable : Jellyfin choisit (l'index passé à `playback/start`).

**Tests.** `trackPreferences.test.ts`, `preferredAudio.test.ts`, `decisions-partagees.test.ts`
(« le chemin natif ouvre sur la piste que l'écran choisira »), `audio-canaux-livres.test.ts`
(iPhone et Firefox simulés : ouverture et écran d'accord sur l'AC-3 copiée, puis sur la 7.1).

**Corrigé le 21/09.** Le lecteur canevas (retiré le 24/09/2026) ouvrait toujours sur la piste par
défaut et basculait ensuite — la bascule supprimée la veille pour le remux. Et sa conversion des
pistes oubliait les canaux : le départage « le plus riche » y était inerte.

**Voulu.**
- À l'ouverture du remux, on ne classe que les pistes **jouables** ; l'écran classe tout. Quand la
  langue demandée n'existe qu'en piste injouable, les deux diffèrent exprès : on ouvre sur ce qui
  joue, et choisir cette piste à l'écran passe la main au lecteur serveur (test dédié dans
  `preferredAudio.test.ts`). Le TrueHD était ce cas jusqu'au 21/09/2026 ; il est décodé ici depuis,
  et il n'en reste plus dans la bibliothèque — le test garde la règle avec du RealAudio.
- Sans préférence, `preferredAudio` prend la plus riche des pistes jouables — au même sens :
  canaux livrés, puis copie —, et l'écran ne touche à rien (`chooseAudioTrack` rend `null`) : pas
  de désaccord possible, donc pas de bascule.
- Un plan jamais demandé (hors `probeOpened`, dans les tests sans navigateur) laisse compter les
  canaux de la source : c'est le classement d'avant, pas une supposition sur l'encodeur.

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
`PlayerSearchPanel`, `PlayerListAdd`, `GlobalSearch` (la recherche de la gestion). Sans clé (champ
vidé), le crochet ne rend rien : `keepPreviousData` y rendait encore la dernière réponse.

**Corrigé le 21/09.** Les deux posaient leur propre `useSWR` avec `keepPreviousData` : hors ligne,
on lisait sous « dune » les résultats de « matrix ». Le 29/09, `GlobalSearch` : un `useSWR` sans
option, mais sous le `keepPreviousData` global de `SWRProvider` — même défaut, et l'erreur n'était
jamais lue.

**Voulu.** Les résultats de la bibliothèque, cherchés sur place, restent affichés dans la recherche
générale : ils ne dépendent pas du réseau. La ligne d'échec s'affiche à côté d'eux.

**Tests.** `player-search-panel.test.tsx`, `player-list-add.test.tsx`, `global-search-previous.test.tsx`,
`decisions-partagees.test.ts`.

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
reprendre le film là où il en était avant. La description n'est reprise que si elle a moins de
cinq minutes : elle porte la taille et l'ETag qui décident si les octets gardés sur l'appareil sont
ceux du fichier.

**Porteurs.** `usePlaybackPrefetch(itemId)` (`src/lib/usePlaybackPrefetch.ts`) côté fiche ;
`src/lib/playbackPrefetch.ts` pour l'état du spectateur — `directInfoKey`, `fetchPlaybackState`,
`prefetchPlaybackState`, `takePrefetchedPlaybackState`, `forgetPrefetchedPlaybackState` ;
`src/lib/directInfo.ts` pour la description — `fetchDirectInfo`, `directInfoForOpening`,
`forgetDirectInfo`. Jamais `preload` de SWR pour la description : il garde une réponse jusqu'à ce
qu'un hook la prenne, des heures s'il le faut.

**Appelants.** `CinemaMovieDetail`, `CinemaSeriesDetail`, `CinemaMobileDetail`. Lecteur natif :
`ExperimentalPlayerHost` lit la description par `directInfoForOpening`, sous une clé SWR propre à
chaque ouverture, et prend l'état préparé, sinon le demande. Le cache de reprise (`recordTitle`) et
l'épisode suivant (`warmNextEpisode`) passent par `fetchDirectInfo`. L'oubli : `refreshAfterPlayback` (avant et après le
rapport d'arrêt) et `revalidateWatchState`.

**Tests.** `playbackPrefetch.test.tsx`, `directInfo.test.ts`, `ExperimentalPlayerHost.test.tsx`
(« ce que la fiche a préparé avant Lire »), `decisions-partagees.test.ts`.

**Voulu.** Le lecteur serveur ne consomme rien de ce qui est préparé : il ne lit pas la
description, et `resolveResumeAt` ne sert qu'aux appelants qui ne connaissent pas la position.
La description restait en cache toute la session, sur l'idée qu'une taille périmée serait corrigée
par le flux lui-même. C'était vrai tant que tout venait du réseau ; avec la reprise depuis
l'appareil, une description périmée *et* des octets gardés du même fichier s'accordent, et le
contrôle les sert : *Ted Lasso* S04E09 ouvert en 1080p chez Lucas après son remplacement par une 4K
(30/09/2026). Une fois ouverte, la description ne bouge plus pendant le film — le fichier ne change
pas sous lui, et la revalider reconstruisait le lecteur.

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

**Porteur.** `holdPausedOnReturn`, `rewoundPosition`, et depuis le 27/09/2026 `BackgroundWatch`
(`src/lib/backgroundReturn.ts`) — le relevé au départ, la retenue au retour, le refus de la relance,
les pauses du spectateur. « Cette pause est-elle celle d'iOS ? » a une seule définition,
`pausedByViewer` (fenêtre `IOS_PAUSE_WINDOW_MS`), pour les deux décisions qui en dépendent :
l'état noté au départ et la reconstruction qui garde la pause (`PlayerLifecycle.restart`). Les
pauses que le lecteur fait lui-même pendant une retenue ne comptent pas comme celles du spectateur.

**Appelants.** `ExperimentalPlayerHost.tsx` : les écouteurs (`visibilitychange`, `play` en capture,
gestes, `play`/`pause` de l'élément), et la reconstruction d'arrière-plan (`currentHold`).

**Différent exprès.** Le lecteur serveur (`PlayerHost.tsx`) n'applique pas la règle : sur iPhone, il
sert surtout à diffuser vers un téléviseur, où la lecture continue par définition.

**Tests.** `backgroundReturn.test.ts` (dont `BackgroundWatch`, `pausedByViewer`),
`ExperimentalPlayerHost.test.tsx` (« la lecture au retour d'une veille »), `playerLifecycle.test.ts`.

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

**Le catalogue, lui, n'est relu en séance que dans un cas** : l'adresse nomme un titre (`film=`,
`serie=`) qu'il ne contient pas. Le filet `useRepairUnresolvedSheet` fait alors un `mutate` de ce
catalogue — un seul par titre demandé, une fois l'écran rendu par le film (SWR y est en pause et
jetterait la relecture) — et n'efface l'adresse qu'après sa réponse, si le titre manque toujours.
Tout autre lecteur du catalogue le lit dans le cache sans jamais le demander : `cacheOnlyOptions`
(`src/lib/swr.ts`), avec le vrai récupérateur, puisque `mutate` relit par le premier crochet
inscrit sur la clé.

- **Porteurs.** `useRepairUnresolvedSheet` et `unresolvedSheetRequest`
  (`src/lib/useRepairUnresolvedSheet.ts`) ; `cacheOnlyOptions` (`src/lib/swr.ts`).
- **Appelants.** Le filet : `CinemaClient.tsx`, `CinemaMobileClient.tsx`. Les options :
  `PlayerSearchPanel`, `ReportWizard`, `PlayerEndScreen`, `PlayerOnboarding`, `CinemaSimilarRow`,
  `CinemaCollectionRow`.
- **Tests.** `repair-unresolved-refresh.test.tsx`, `useRepairUnresolvedSheet.test.tsx`,
  `catalogue-lu-dans-le-cache.test.tsx` (qui refuse aussi un lecteur sans ces options, ou une copie
  en ligne).
- **Voulu.** Les deux clients demandent le catalogue au montage : ce sont eux qui le tiennent.

**Décidé le 29/09/2026** : un titre importé pendant la séance ne s'ouvrait pas depuis la
notification « Disponible », Ma liste ou une filmographie — le filet effaçait l'adresse au bout de
2 s. Et ouvrir la recherche ou l'assistant de signalement redemandait les deux catalogues, alors
que leur commentaire promettait « zéro réseau » : c'était la seule relecture en séance, par
accident.

---

## 28. Où s'ouvre une reprise, et ce qu'on garde sur l'appareil pour elle

**Règle.** À la première ouverture d'un titre (pas une reconstruction, pas le banc), le lecteur
recule de 5 s si l'on a quitté le titre depuis plus de dix minutes, sauf près des deux bords. La
reprise instantanée garde, en arrière-plan, les octets de **toutes** les ouvertures possibles :
l'en-tête, l'index et les blocs depuis l'image clé qui précède la position reculée jusqu'à un groupe
après la position exacte (`openingSpan`). Elle ne sait pas quand on ouvrira : calculée par
`openingPosition` quand la liste arrive, elle gardait la position exacte d'un titre qu'on venait de
quitter, et le lecteur ouvert une heure plus tard reculait vers une image clé absente — ouverture
« mixte », relevée au journal le 28/09/2026.

**Porteur.** `openingPosition(itemId, position, durée)` (`src/lib/resumeRewind.ts`), sur `awayFrom`
et `rewound` ; `openingSpan(position, durée)` pour ce qu'on garde d'avance, sur `rewound`.

**Appelants.** `ExperimentalPlayerHost` (la position d'ouverture), le lecteur serveur
(`ActivePlayer` dans `PlayerHost.tsx`, depuis le 27/09/2026 : il ouvrait pile à la position, et
ne retenait pas quand un titre venait d'être joué — il note désormais `noteWatching` comme le
natif) et `targetsFrom` (`src/lib/resumeCache/useResumeCache.ts`, ce qu'on garde). Deux calculs viseraient deux positions :
les octets gardés ne seraient plus ceux que le lecteur lit, et l'ouverture redeviendrait « mixte »
sans que rien ne casse — seul le journal (`openedFrom`) le dirait.

**Tests.** `resumeRewind.test.ts`, `resumeCache-core.test.ts`, `resumeCache-run.test.ts`,
`decisions-partagees.test.ts` (ni l'hôte ni la reprise instantanée n'appellent `awayFrom` eux-mêmes ;
l'hôte passe par `openingPosition`, la reprise instantanée par `openingSpan`).

**Voulu.** Le lecteur serveur ne recule pas un relais (la position exacte où le natif s'est
arrêté, ou le retour d'une télé), ni un rechargement pour changer de piste ; et, faute de durée
connue avant la négociation, il ne connaît pas l'exception de fin de film. Le retour d'une pause de
plus de dix minutes pendant la lecture recule aussi, par
`rewound` directement : c'est un autre moment (l'élément joue déjà), et rien n'y est gardé d'avance.

**Décidé le 25/09/2026**, avec la reprise instantanée.

---

## 29. Ce qu'une fiche montre avant que le réseau ait répondu

**Règle.** Une fiche d'un titre de la bibliothèque s'ouvre complète avec ce que l'appareil sait
déjà. La durée, l'année, les genres et le synopsis viennent du catalogue (gardé sur l'appareil) ;
TMDB ne donne la durée ou le synopsis que quand le catalogue n'en a pas — le synopsis ne change
jamais de texte sous les yeux. Le bouton Lire est là d'emblée : « Reprendre · durée restante » si le
titre est dans « Reprendre » (une série : son épisode dans « À suivre », sinon dans « Reprendre »),
« Lire » sinon — mais tant que Jellyfin n'a pas répondu, `resumeKnown` reste faux et `resumeAt`
absent : le libellé vient de l'appareil, la position du serveur. La réponse de Jellyfin l'emporte
dès qu'elle arrive. La configuration qui décide s'il y a un bouton Lire (`/api/config/public`) est
gardée sur l'appareil ; tant qu'elle manque, le bouton garde sa place, invisible (`reserve`).

Le bouton ne se grise (« Fichier introuvable ») **que** si la route `direct` a répondu
`file_missing` — Jellyfin a dit que le fichier n'existe pas. Une coupure, un Jellyfin injoignable,
un jeton refusé ou un retard ne grisent jamais un titre lisible.

Ce qui n'arrive que par le réseau — accroche, distribution, bande-annonce, durée d'une série — a sa
place tenue dès l'ouverture et s'y pose en fondu de 150 ms, seulement si la réponse est arrivée
après l'ouverture. Et l'appui sur une affiche demande déjà la description du titre, une fois par
demi-minute — et elle seulement : l'état Jellyfin et la liste d'épisodes, préchargés sans être lus,
étaient servis périmés quelques minutes plus tard (25/09/2026).

**Porteurs.** `src/lib/sheetFacts.ts` — `useSheetPlayFacts` (sur `localPlayTarget` et
`sheetPlayFacts`), `sheetRuntimeMinutes`, `sheetOverview` ; `useFileMissing`
(`src/lib/missingFiles.ts`, alimenté par `usePlaybackPrefetch`) ; `useLateArrival` et
`ReservedLine` (`CinemaDetailExtras.tsx`) ; `prefetchTitleSheet` / `prefetchLibraryItem`
(`src/lib/prefetch.ts`).

**Appelants.** `CinemaMovieDetail`, `CinemaSeriesDetail`, `CinemaMobileDetail` ; l'appui :
`CinemaCard`, `CinemaSeriesCard`, les rangées d'affiches du téléphone (`PosterRow`).

**Tests.** `sheetFacts.test.ts`, `PlayButton.test.tsx` (place gardée, bouton grisé),
`playbackPrefetch.test.tsx` (grisé seulement sur `file_missing`), `jellyfin-direct-route.test.ts`
(le code, seulement quand Jellyfin a répondu), `persistentCache.test.ts`,
`decisions-partagees.test.ts`.

**Voulu.** Les fiches TMDB (découverte, personnes) et les films demandés mais pas encore là ne
passent pas ici : ils gardent Demander / Demandé. La fiche téléphone garde son propre gros bouton
blanc, mais il lit les mêmes faits. La série n'a pas de durée au catalogue : la sienne reste celle
de TMDB, en fondu. Une place tenue que la réponse n'occupe pas (un film sans accroche) se referme :
c'est le seul mouvement qui reste, et le plus rare.

**Décidé le 25/09/2026.**

## 30. Ce qu'une connexion accepte avant de travailler

**Règle.** Un identifiant et un mot de passe sont des chaînes, bornés (256 et 1 024 caractères),
vérifiés avant toute comparaison, tout appel à Jellyfin et toute écriture dans `auth.log`. Le mot
de passe est essayé tel quel, puis sans ses blancs de fin (`trimEnd`) seulement s'il en a.

**Pourquoi.** Les deux routes de connexion sont publiques. Le rognage par `replace(/\s+$/, "")`
était quadratique : un mot de passe fait d'espaces suivies d'un caractère figeait tout le serveur,
quinze minutes pour un mégaoctet, avant même la limite d'essais. Et un mot de passe qui n'était pas
une chaîne répondait 500 (audit du 26/09/2026).

**Porteurs.** `readCredentials` et `passwordAttempts` (`src/lib/passwordAttempts.ts`).

**Appelants.** `src/app/api/auth/jellyfin/route.ts`, `src/app/api/auth/login/route.ts`.

**Tests.** `passwordAttempts.test.ts`, les tests des deux routes.

**Voulu.** 400 et « Identifiants requis » pour ce qui est refusé ici, comme un champ vide : rien
de plus précis à dire à qui envoie cela.

**Décidé le 26/09/2026.**

## 31. La forme d'une fiche de titre sur téléphone

**Règle.** Une fiche de titre commence sous la barre d'état, un demi-rem plus bas, avec des coins
de 16 px au repos, qui grandissent jusqu'à 28 px quand on la tire vers le bas.

**Pourquoi.** Elle était collée en haut de l'écran et carrée, alors que la fiche personne se posait
déjà en carte arrondie. Et la moitié des titres d'une rangée de saga ouvre la fiche de
bibliothèque, l'autre moitié la fiche TMDB, sans que rien dans le geste dise laquelle : les deux
doivent avoir la même forme.

**Porteurs.** `.phone-sheet-frame` (`globals.css` : position et hauteur, dans les unités
d'`app-viewport`) et `phoneSheetCorner` (`src/lib/sheetMotion.ts`).

**Appelants.** `CinemaMobileDetail`, `PlayerDiscoverSheet` (sa version téléphone).

**Tests.** `sheet-exit.test.tsx` et `cinema-mobile-detail-keys.test.tsx` retrouvent les deux fiches
par `.phone-sheet-frame`.

**Voulu.** La fiche personne garde sa propre forme : elle se pose en bas, à 92 % de la hauteur.

**Décidé le 26/09/2026.**

## 32. Fermer une fenêtre du cinéma ramène à l'accueil

**Règle.** La croix, Échap et un clic à côté de la fenêtre (grand écran) ramènent à l'accueil,
comme « Accueil » dans le rail. Sur un écran poussé (Parcourir, l'activité, les signalements), la
flèche et Échap reviennent d'un cran ; le clic à côté ramène à l'accueil là aussi.

**Pourquoi.** Tout passait par `cinemaClose`, un retour dans l'historique : Accueil → Ma liste →
Compte, puis fermer, rouvrait Ma liste — un « fermer » qui ouvre une autre fenêtre.

**Porteurs.** `closeWindow` dans `PlayerPanelFrame`, qui s'appuie sur `openPanel("home")`
(`playerNav.ts`).

**Appelants.** Tous les panneaux montés dans `PlayerPanelFrame` : Recherche, Ma liste, Compte,
Parcourir, Activité, Signalements.

**Tests.** `player-panel-frame.test.tsx` (« Échap », « clic à côté de la fenêtre »).

**Voulu.** Les fiches (film, série, personne, découverte) gardent `cinemaClose` : elles s'empilent
les unes sur les autres, et en sortir revient bien à celle d'en dessous. Aller à l'accueil ajoute une
entrée d'historique, comme le rail : le retour du navigateur rouvre la fenêtre fermée.

**Décidé le 26/09/2026.**

## 33. L'ordre de la rangée « Reprendre »

**Règle.** Le dernier lu d'abord, films et épisodes mêlés. Un épisode jamais ouvert (le suivant d'une
série) prend la date du dernier épisode lu de sa série. Sans date, une carte garde sa place relative,
après les datées. Un titre qui remonte glisse à sa place.

**Pourquoi.** La rangée mettait bout à bout les films du flux « Reprendre », puis les épisodes
d'« À suivre » dans l'ordre de Jellyfin : un film laissé l'avant-veille restait devant l'épisode lancé
cinq minutes plus tôt, et l'ordre d'« À suivre » selon Jellyfin n'est pas celui de la dernière lecture
(Ted Lasso devant Mr. Robot, lu une minute après — 28/09/2026). Aucun rafraîchissement n'y changeait rien.

**Porteurs.** `continueOrder` (`src/lib/continueOrder.ts`) ; `lastPlayedAt` posé par
`/api/jellyfin/resume` et `/api/cinema/next-up` (`jellyfin.getSeriesLastPlayed` pour un épisode sans date).

**Appelants.** `CinemaClient.tsx` et `mobile/CinemaMobileClient.tsx` — la rangée et son animation
(`useFlipGrid`, sur l'ordre rendu).

**Tests.** `continueOrder.test.ts`, `cinema-next-up-route.test.ts` (« date chaque épisode… »).

**Voulu.** Les cartes gardent leurs gestes propres (un film ouvre sa fiche Radarr et son menu « Retirer
de Reprendre », un épisode la fiche de sa série) : seul l'ordre est commun. `PERSISTED_CACHE_SCHEMA` est
passé à 3 avec ce champ.

**Décidé le 28/09/2026.**


---

## 34. Qui peut voir un élément servi avec la clé d'administration

**Règle.** La visibilité d'un élément pour un compte se décide chez Jellyfin, jamais ici : tout octet
de Jellyfin servi avec la clé d'administration (flux, sous-titres, images, vignettes de la barre)
n'est servi qu'après `/Users/{jfId}/Items/{itemId}` répondu favorablement pour ce compte. Le verdict
est gardé par séance et par titre (six heures s'il est favorable, cinq minutes s'il ne l'est pas,
5 000 entrées au plus). Refus : 404, sans détail. Jellyfin injoignable : un verdict favorable déjà
obtenu vaut encore, même périmé (un film en cours ne s'arrête pas) ; sans verdict, 503 — une panne
n'ouvre jamais l'accès.

**Porteur.** `assertVisible` (`src/lib/itemVisibility.ts`).

**Appelants.** `/api/jellyfin/stream/[itemId]/[...path]`, `/api/jellyfin/stream/subtitle/[itemId]`,
`/api/jellyfin/image`, `/api/jellyfin/trickplay/tile`.

**Différent exprès.** Un administrateur passe sans question (il tient la clé ; le compte
administrateur local n'a pas d'identité Jellyfin). Le laissez-passer de diffusion d'un téléviseur
n'y passe pas : il ne porte que le compte de l'application, pas son `jfId`, et il n'est émis que par
`playback/start`, qui négocie avec Jellyfin sous l'identité du compte. `direct/[itemId]` n'appelle
pas `assertVisible` : il lit déjà l'élément par `/Users/{jfId}/Items`, ce qui revient au même refus.
Le catalogue reste commun à tous (voir `cinema/movies`).

**Tests.** `item-visibility.test.ts`.

**Trouvé le 29/09/2026** par l'audit : les relais ne vérifiaient qu'une session, et le catalogue
donne à chaque compte l'identifiant de tous les titres ; un titre bloqué par tag s'ouvrait par une
adresse de flux fabriquée à la main.

---

## 35. Le volume retenu d'une séance à l'autre

**Règle.** Le volume et le muet du spectateur sont gardés sur l'appareil (`cine:player-volume`) à
chaque changement, et rendus à l'élément vidéo une fois, à son montage, par les deux lecteurs.

**Porteur.** `restoreRememberedVolume` (`src/lib/rememberedVolume.ts`), qui porte aussi la clé.

**Appelants.** `ExperimentalPlayerHost` (effet de montage, à côté de `videoElRef`) et `PlayerHost`
(effet de montage du lecteur serveur). `PlayerControls` écrit la valeur, sur `volumechange`.

**Tests.** `remembered-volume.test.tsx` ; `decisions-partagees.test.ts` (« un seul endroit rend le
volume retenu »).

**Voulu.** Rendu au montage de l'élément, pas dans `PlayerControls` : les contrôles se remontent à
chaque passage plein écran ↔ réduit et reposeraient l'ancienne valeur par-dessus celle qu'on vient de
régler. Le lecteur natif garde le même élément à travers ses reconstructions (seul le pipeline
change) : une reconstruction ne le repose pas. Une valeur hors de [0, 1] est ignorée.

**Trouvé le 29/09/2026** par l'audit : seul le lecteur serveur relisait la valeur ; dans le lecteur
natif, chaque film repartait à plein volume, le son coupé oublié.

## 36. Une séance close

**Règle.** Une fois la croix appuyée, la séance est close : elle ne se ferme qu'une fois (une seule
ligne `stop`, un seul arrêt Jellyfin, une seule relecture des vues) et n'enchaîne plus l'épisode
suivant, même si son décompte arrive à zéro pendant le fondu de 200 ms.

**Porteurs.** Deux, chacun dans l'état de son hôte :
- hôte natif : `PlayerLifecycle.noteClosing()` (`src/lib/playerLifecycle.ts`), vrai la première
  fois seulement, et `isOver()`, vrai dès la croix ;
- lecteur serveur : `closedRef` dans `PlayerHost`.

**Appelants.** `handleClose` et `handleAdvance` de `ExperimentalPlayerHost` et de `PlayerHost`.

**Tests.** `native-close-once.test.tsx` (hôte natif) ; `playerLifecycle.test.ts`.

**Voulu.** Pas de fonction commune : l'hôte natif range « close » avec le reste de sa machine à
états (`isOver` refuse aussi reconstructions, nouveaux essais réseau et bascule pendant le fondu),
le lecteur serveur n'a pas cette machine. `isOver()` est aussi vrai après avoir passé la main au
lecteur serveur : l'hôte natif n'enchaîne rien non plus dans ce cas, c'est le lecteur serveur qui
porte alors la séance.

**Trouvé le 29/09/2026** par l'audit : le lecteur serveur tenait la garde depuis le 27/09, l'hôte
natif non — un épisode suivant monté puis démonté aussitôt pendant le fondu (faux `stop unmount`,
avance automatique comptée, flash), et deux relectures des vues pour deux appuis sur la croix.

## 37. Ce qu'une erreur du catalogue prend à l'écran

**Règle.** Une erreur du catalogue ne prend tout l'écran que si le catalogue manque. Catalogue en
main — SWR garde la donnée quand une revalidation échoue et pose l'erreur à côté —, l'écran reste
et l'erreur tient en une ligne.

**Porteur.** `catalogueErrorView(error, data)` (`src/lib/swr.ts`) : `"plein"`, `"ligne"` ou `null`.

**Appelants.** `CinemaClient` (écran plein des films, ligne dans le volet des films, ligne du volet
des séries) et `CinemaMobileClient` (ligne des films).

**Tests.** `CinemaClient-catalogue-error.test.tsx` ; `decisions-partagees.test.ts` (« une seule
règle pour l'erreur du catalogue »).

**Voulu.** Seul le catalogue des films du bureau a un écran plein d'erreur : le téléphone et le
volet des séries du bureau montrent une ligne dans les deux cas, parce que leur écran existe sans
ce catalogue.

**Trouvé le 29/09/2026** par l'audit : le bureau testait l'erreur seule, et une revalidation ratée
pendant un redéploiement démontait l'accueil et les fiches ouvertes ; le téléphone gardait ses
rangées.

## 38. La saison qu'ouvre une fiche de série

**Règle.** Une fiche de série ouvre la première saison possédée, spéciaux en dernier (règle de
`defaultSeason`) ; une saison manquante n'est ouverte que si la série n'en possède aucune. Le choix
se fait une fois et ne bouge plus quand la liste des manquants arrive.

**Porteur.** `openingSeason(possédées, manquantes)` (`src/lib/seasonOrder.ts`).

**Appelants.** `CinemaEpisodeBrowser` (bureau, figé au montage — le focus posé au montage va sur
cette saison, puisque le focus choisit la saison) et `CinemaMobileDetail` (téléphone, figé à la
première réponse des épisodes qui permet de choisir).

**Tests.** `opening-season.test.tsx` ; `decisions-partagees.test.ts` (« une seule règle pour la
saison ouverte »).

**Voulu.** La liste des pastilles réunit toujours possédées et manquantes (`orderSeasons`) : seule
l'ouverture les distingue. Le bureau reçoit les saisons possédées dès le montage, le téléphone les
attend : c'est pourquoi l'un fige au montage et l'autre à la première réponse.

**Trouvé le 29/09/2026** par l'audit : le téléphone décidait sur la réunion des deux listes à
chaque rendu, et une série dont seule la saison 15 est là sautait à la saison 1, vide, à l'arrivée
des manquants ; le bureau décidait sur les possédées, mais posait le focus sur la première saison de
la liste, ce qui la choisissait aussi quand les manquants étaient déjà connus.

## 39. La clé de la grille complète

**Règle.** La grille « Voir tout » d'un genre est un écran à part (règle 1 du cycle de vie des
fiches) : son instance est clée par type et par genre, et un autre genre la remonte, réglages
compris.

**Porteur.** `browseSheetKey(mediaType, genre)` (`src/lib/cinemaBrowse.ts`).

**Appelants.** `CinemaClient` et `CinemaMobileClient`, sur leur `<CinemaBrowseSheet>`.

**Tests.** `browse-sheet-key.test.tsx` ; `decisions-partagees.test.ts` (« une seule clé pour la
grille complète »).

**Voulu.** Tri, décennie, durée et recherche restent des états locaux de la grille, hors de
l'adresse : trier ne change pas d'écran. Seul un changement de genre ou d'onglet les remet au
défaut.

**Trouvé le 29/09/2026** par l'audit : le bureau avait la clé, le téléphone non ; rouvrir « Voir
tout » sur un autre genre pendant la sortie de la grille précédente y gardait ses réglages.

## 40. La recherche de la fenêtre « Ajouter » de la gestion

**Règle.** Une recherche d'ajout (un titre soumis, cherché chez Radarr ou Sonarr) a trois issues, et
la fenêtre dit chacune : des résultats, « aucun résultat », ou un échec avec le message du serveur
et de quoi réessayer. Jamais « rien trouvé » — ni rien du tout — pour une recherche qui a échoué.

**Porteur.** `useLookupSearch(endpoint)` (`src/lib/useLookupSearch.ts`), qui lit par `fetcher`.

**Appelants.** `AddMovieModal` (`radarr/page.tsx`) et `AddSeriesModal` (`sonarr/page.tsx`).

**Tests.** `gestion-ajout-recherche.test.tsx` ; `decisions-partagees.test.ts` (« une seule
recherche d'ajout de la gestion »).

**Voulu.** Pas de SWR : la question est posée à la soumission, ce n'est pas une clé qu'on suit, et
le `keepPreviousData` global y rendrait les résultats d'une autre frappe (voir §7 cinquies). Seule
la dernière question soumise répond.

**Trouvé le 29/09/2026** par l'audit : les deux fenêtres faisaient `setResults(await res.json())`
sans lire `res.ok` ni rattraper l'erreur ; sur un 502 elles restaient vides et muettes, une réponse
vide ne disait rien non plus, et une coupure réseau devenait un rejet non géré.

## 41. La signature de l'application

**Règle.** Une ligne discrète — « CineApp 8.1 par LK59 · GitHub » — s'affiche à trois endroits et
à trois seulement : tout en bas du panneau Compte du cinéma, sous le formulaire de la page de
connexion, et en bas du menu de la gestion. La version est celle du build (`displayVersion(APP_VERSION)`,
« dev » hors build) ; seul « by » se traduit (« par », « por », « von ») ; « GitHub » mène au dépôt
dans un nouvel onglet (`noopener noreferrer`). Pas de pied de page global.

**Porteur.** `AppSignature` (`src/components/AppSignature.tsx`) ; le nom, l'auteur et l'adresse du
dépôt dans `src/lib/appBuild.ts` (`APP_NAME`, `APP_AUTHOR`, `APP_REPOSITORY_URL`) — `package.json`
n'a ni `author` ni `repository`.

**Appelants.** `PlayerAccountPanel`, `app/login/page.tsx`, `Sidebar` (gestion au bureau) et
`MobileNav` (feuille « Plus », la gestion sur téléphone n'ayant pas de barre latérale).

**Tests.** `AppSignature.test.tsx` ; `decisions-partagees.test.ts` (« une seule signature »).

**Voulu.** La page de connexion est publique et la montre quand même : la version s'y lit déjà par
`/sw.js?v=`. Au bureau, alignée à gauche sous « Déconnexion » ; ailleurs, centrée.

## 42. L'instant qu'une ligne du journal du lecteur décrit

**Règle.** Le serveur date chaque ligne de `player.log` à son arrivée (`timestamp`), jamais le
navigateur. Une ligne qui arrive en retard le dit par `lateByMs` — l'écart, mesuré sur l'appareil,
entre ce qu'elle décrit et son envoi — et se lit à `timestamp − lateByMs`. Deux sortes en portent :
le bilan perdu (`stop`, `why: "lost"`) et, depuis le 01/10/2026, toute ligne renvoyée après un échec
d'envoi (`resent: true`). Un `lateByMs` sur une autre ligne est ignoré.

**Porteur.** `lineLateByMs` (`src/lib/activity/seances.ts`). Côté écriture, `logPlaybackEvent`
(`src/lib/playerLog.ts`) garde `resent` et `lateByMs` en tête, hors plafond de champs, bornés.

**Appelants.** `lineTime` (`buildSeances`, et par elle le diagnostic) et `friseModel`, qui trie ses lignes
par cet instant.

**Tests.** `activity-diagnosis.test.ts` (bilan perdu, ligne renvoyée), `playerLog.test.ts`,
`decisions-partagees.test.ts` (« un seul instant pour une ligne en retard »).

**Voulu.** Le fichier reste dans l'ordre d'arrivée — il est lu par `tail` et tourne par taille ;
c'est la lecture qui replace. La file des lignes en attente (`src/lib/unsentLines.ts`) et celle des
bilans (`src/lib/unsentStop.ts`) restent deux : un bilan est réécrit toutes les 30 s tant que la
séance vit et n'est déclaré perdu qu'après deux minutes de silence ; une ligne ordinaire est écrite
une fois, et n'entre en file que sur un échec d'envoi.

**Trouvé le 01/10/2026** : un redémarrage du conteneur à 19:47:06 a emporté un point de réserve
d'une séance en cours ; seul le bilan avait un filet.

## 43. La minuterie de veille

**Règle.** Une durée (15, 30, 60, 90 min) se compte en temps de film : seulement pendant la
lecture. Trente secondes avant la fin, une ligne « Arrêt dans 30 s · Continuer » ; « Continuer »
relance la même durée en entier. Les cinq dernières secondes, le son descend ; à zéro, le film se
met en pause — le lecteur reste ouvert —, le volume du spectateur est rendu à l'élément arrêté, la
position part à Jellyfin tout de suite et une ligne `pause` (`why: "veille"`, `sleepTimer`) au
journal ; la minuterie retombe à « off ». « Fin de l'épisode » (proposée seulement quand un épisode
suit) retire la carte de l'épisode suivant et son décompte, et retient l'épisode à sa fin. La
minuterie appartient à la séance : elle survit à l'épisode suivant, aux reconstructions et au
relais vers le lecteur serveur ; fermer le lecteur ou ouvrir un autre titre l'efface ; elle n'est
gardée nulle part sur l'appareil.

**Porteur.** `src/lib/sleepTimer.ts` — les règles en fonctions pures (`tickSleepTimer`,
`sleepVolumeFactor`, `sleepTimerDue`, `sleepWarningSeconds`, `continueSleepTimer`,
`blocksAutoAdvance`, `sleepTimerLogFields`) et le magasin hors de React (`sleepTimerStore`) ;
`src/lib/useSleepTimer.ts` — le moteur (battement, descente du son, pause, `holdAtEnd`).

**Appelants.** `PlayerControls` (l'entrée du menu ⋮, la ligne des trente secondes, la carte de
l'épisode suivant) ; `ExperimentalPlayerHost` et `PlayerHost` (`useSleepTimer`, la ligne `pause`,
`sleepTimer` sur la ligne `stop`, `savePaused` de `usePlaybackSession`) ; `PlaybackProvider`
(`clear` dans `play` et `close`) ; `logPlaybackEvent` (`sleepTimer` hors plafond, valeurs du menu
seulement).

**Tests.** `sleepTimer.test.ts`, `useSleepTimer.test.ts`, `PlayerControls.test.tsx` (« la minuterie
de veille »), `PlaybackProvider.test.tsx`, `playerLog.test.ts`, `serverPlayerLog.test.ts`,
`decisions-partagees.test.ts` (« une seule minuterie de veille »).

**Voulu.** Le moteur est dans les hôtes, pas dans les commandes : elles ne sont montées ni en
mini-lecteur ni pendant une reconstruction, et la minuterie doit courir dans les deux. À la fin
retenue d'un épisode, le lecteur natif montre son écran de fin (« Revoir », « Retour ») ; le lecteur
serveur, qui n'en a pas, reste sur la dernière image — en mini-lecteur, il se ferme comme à la fin
d'un film. Sur iPhone et iPad, `volume` est en lecture seule : la pause a lieu, pas la descente. Le
rechargement de page qu'impose WebKit pour changer de piste sur le lecteur serveur la perd, comme
le reste de la séance (docs/cycle-de-vie-lecteur.md).

## 44. La suite d'une saga à la fin d'un film

**Règle.** Quand un film finit, l'écran de fin propose le premier film **après** lui dans l'ordre de
sa saga — l'ordre de la rangée de la fiche —, que le cinéma sait ouvrir et que le spectateur n'a pas
vu (« vu » de Jellyfin). Rien pour le dernier de la saga, un film hors saga, ou quand tout ce qui suit
a été vu ; jamais un film d'avant. Une carte « Suite · titre · Lire maintenant », de la forme de celle
de l'épisode suivant, **sans décompte ni lecture automatique**. Lire passe la position lue chez
Jellyfin pour ce film — un nombre, zéro s'il n'a jamais été commencé (§1).

**Porteur.** `collectionSuite` (`src/lib/collectionSuite.ts`), qui dit aussi sur quel film elle
attend l'état « vu » (`ask`). La saga vient de `useCinemaCollection` (`CinemaCollectionRow.tsx`),
qui rend désormais `all` (la saga entière, le film ouvert compris) à côté de `parts`.

**Appelants.** `PlayerEndScreen` (`CollectionSuiteCard` / `SuiteAsk`, l'état par
`useJellyfinItemState`), lancé par `ExperimentalPlayerHost` (`onPlayNext` : fermeture comme à la
croix, puis `playback.play`).

**Tests.** `collectionSuite.test.ts`, `PlayerEndScreen.test.tsx`, `decisions-partagees.test.ts`
(« une seule suite de saga »), `resumeContract.test.ts`.

**Voulu.** Les requêtes de la saga et de l'état « vu » partent pendant que le film tient l'écran
(`whilePlaying` → `playerBootstrapOptions`) : SWR y est suspendu, et une requête suspendue est
abandonnée. Un film jamais ouvrable ici (absent du catalogue du cinéma) est sauté, pas proposé. Le
lecteur serveur n'a pas d'écran de fin — il se ferme à la fin d'un film — et ne propose donc rien.

## 45. Le verre liquide : matière, geste, menus, barre du bas

**Règle.** Le lecteur plein écran et la barre de navigation du téléphone portent une seule matière,
le verre « mixte » (reflet et bord du verre clair, flou 20 px saturé, teinte sombre 32 %), et un seul
geste : la surface touchée gonfle et s'étire vers le doigt, puis revient sur un ressort (réponse
0,45 s, amortissement 0,8). Dans une pilule, c'est la pilule entière qui gonfle et s'étire ; le
bouton visé ne fait que s'allumer (`data-lit`). La zone de toucher déborde de 12 px, et l'appui
tient jusqu'à 24 px hors du verre. **Le clic natif n'est jamais remplacé** : il part tel quel quand
le doigt est relâché sur le bouton ; il n'est redirigé vers le bouton visé que s'il tombe à côté
(marge, glissé), et cela depuis le clic natif lui-même, donc dans le geste utilisateur. Un clic du
clavier ou d'un programme n'est pas touché. Les menus du lecteur naissent de la pilule des réglages
(une surface découpée à sa forme qui s'ouvre sur le ressort, l'icône du bouton glisse jusqu'au
titre), hauts de 280 px au plus ; ils se démontent à l'instant où ils se ferment, et une copie inerte
joue la fermeture (200 ms, depuis l'état atteint). Le fondu des commandes est porté par chaque
élément (`player-fade`), jamais par leur conteneur : un parent à opacité < 1 isole le fond, et le
flou n'avait rien à flouter pendant le fondu (la 8.2.4 avait retiré le flou pour cette raison).
La barre du bas a une lentille : une pastille de verre sous l'onglet ouvert, qui glisse sur le
ressort, se soulève sous le doigt et le suit ; la barre gonfle et s'étire moitié moins que le
lecteur. La navigation y part toujours au contact ; un glisser qui finit sur un autre onglet
l'ouvre au relâchement, en remplaçant l'entrée d'historique du premier.

**Porteur.** `src/lib/liquidGlass/liquid.ts` (`createLiquidPress`, `liquidTransform`, `pullFrom`,
`swellFor`, `LIQUID_SPRING`) et `src/lib/liquidGlass/spring.ts` (le ressort simulé une fois et
joué par `element.animate()`). La matière : les variables `--glass-*` et `.player-liquid`,
`.nav-glass` dans `globals.css`.

**Appelants.** `PlayerControls` (délégation sur `[data-liquid]`), `LiquidMenu`, `PlayerBottomBar`
(lentille et barre, avec `liquidTransform`), et la page d'administration « Tests animations »
(`src/components/animlab/`), qui branche le même geste avec ses réglages en direct.

**Tests.** `liquid-press.test.ts` (clic natif intact, marge, annulation, clavier, secours),
`PlayerControls.test.tsx` (pilule entière animée, clic natif, état des commandes par
`data-chrome`), `animlab-spring.test.ts`, `AnimationLab.test.tsx`.

**Voulu.** Le mini-lecteur garde le fumé opaque, sans flou ni geste. Les pilules cachées perdent
leur flou une fois le fondu fini : c'est l'état de presque tout le film, et un flou à opacité nulle
se recalculait quand même à chaque image ; la pilule cachée sous un menu aussi. Pas d'ombre floue
sur une grande surface (mesuré le 26/09 : 5,9 ms par image) — le menu et la barre ont une ombre
courte. « Réduire les animations » garde l'allumage et le clic, sans gonflement ni étirement ;
« Réduire la transparence » donne un fond franc. Le menu qui naît de la pilule la recouvre : passer
d'un menu à l'autre demande de refermer le premier (toucher à côté).

**Le clavier du lecteur, depuis le même jour,** est un jeu fixe : Espace et K pour lire ou mettre en
pause, ← et → pour dix secondes, où que soit le focus ; le reste se fait à la souris ou au doigt. Un
bouton cliqué à la souris ne prend plus le focus, et Espace n'active plus jamais un bouton : après
avoir ouvert les sous-titres à la souris, Espace les rouvrait au lieu de mettre en pause.

**Choisi le 04/10/2026** sur la page « Tests animations », sur iPhone et au bureau.
