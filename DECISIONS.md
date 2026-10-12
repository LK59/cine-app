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
ratée ne doit pas devenir une écriture. **Pour « Vu », remplacé le 06/10/2026 par §51** : Jellyfin
fait toujours foi pour les titres qu'il possède, mais une copie locale garde le vu de chaque compte.

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
d'administration (les seuils de reprise lus chez Jellyfin — sous le minimum, rien ; au-delà du maximum, vu) et le film
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

## 32. Quitter un onglet du cinéma ramène à l'accueil

**Règle.** Échap ramène à l'accueil, comme « Accueil » dans le rail. Sur un écran poussé
(Parcourir, l'activité, les signalements), la flèche et Échap reviennent d'un cran.

**Plein écran à toutes les tailles (07/10/2026).** Sur grand écran, ces écrans étaient des
fenêtres posées sur l'accueil, décollées des bords, qu'une croix ou un clic à côté refermait.
L'accueil restait visible autour — deux écrans à la fois —, et des spectateurs l'ont dit
perturbant ; un flou derrière a été écarté (coûteux sur une grande surface, et il gardait l'accueil
présent). Ce sont des onglets : ils remplacent l'écran sur le noir de l'app, comme sur téléphone,
sans croix ni « dehors ». Leur colonne est centrée et l'en-tête s'y aligne (`contentWidth`) :
étroite pour ce qui se lit ou se remplit (Compte), `PANEL_WIDE` (`panelWidth.ts`) pour les grilles
d'affiches (Recherche, Ma liste, Parcourir), dont les colonnes se multiplient avec l'écran au lieu
d'agrandir les affiches (`player-grid-fluid`) ; le champ de recherche garde une largeur de champ.
Les fiches de titre restent par-dessus, plein écran elles aussi.

**Pourquoi.** Tout passait par `cinemaClose`, un retour dans l'historique : Accueil → Ma liste →
Compte, puis fermer, rouvrait Ma liste — un « fermer » qui ouvre une autre fenêtre.

**Porteurs.** `closeWindow` dans `PlayerPanelFrame`, qui s'appuie sur `openPanel("home")`
(`playerNav.ts`).

**Appelants.** Tous les panneaux montés dans `PlayerPanelFrame` : Recherche, Ma liste, Compte,
Parcourir, Activité, Signalements.

**Tests.** `player-panel-frame.test.tsx` (« Échap », « un onglet plein écran »).

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
(une surface découpée à sa forme qui s'ouvre sur le ressort ; icône, titre et lignes apparaissent
en fondu à leur place — l'icône glissait du bouton jusqu'au titre et bougeait encore dans la boîte
posée), hauts de 280 px au plus ; ils se démontent à l'instant où ils se ferment, et une copie inerte
joue la fermeture (180 ms, depuis l'état atteint). Un doigt posé hors du menu le referme à l'appui,
non au clic, et le clic qui suit est retenu (il cachait les commandes). Les menus bougent eux aussi au doigt
(gonflement, étirement, rebond) sans viser ni arrêter aucun clic (`redirect: false`) : leurs lignes
gardent le leur. Un menu ne gonfle pas (deux réglages de gonflement essayés, jugés étranges) :
il ne s'étire que lorsque le doigt sort de ses bords (`pull: "outside"`), reste étiré tant que le
doigt le tient, revient sur le ressort au relâchement, et le clic qui suivrait un relâchement
dehors est retenu (il refermait le menu). Le doigt reste au geste partout dans le menu, sauf sur une
liste qui a de quoi défiler (`data-scrolls`) — avec `pan-y` sur tout le menu, le premier mouvement
vertical rendait le doigt au navigateur et la boîte étirée revenait d'un coup. L'ouverture rebondit (ressort
0,34 s / 0,72, dépassement lu en échelle, ≈ 2 %) ; pendant l'ouverture la boîte s'allonge vers le haut selon la vitesse du ressort rapportée à son pic (une bosse de 3 %, `openStretch` — bornée à 4 % sur la vitesse brute, elle sautait au plafond dès la première image et s'y bloquait) et ses lignes visibles apparaissent l'une après l'autre (18 ms d'écart, huit au plus) ; la découpe et la transformation sont **une seule** animation, à l'ouverture comme à la fermeture : la découpe ne se joue que sur le fil principal (60 i/s au plus sous Safari), et séparée d'elle la transformation passait au compositeur à 120 i/s — bords et contenu à deux rythmes, lus comme des images manquantes (8.15.7) ; une découpe au compositeur par fenêtres imbriquées a été essayée au banc et écartée (sous Chromium, le flou du verre ignore les coins arrondis des ancêtres) ; le contenu ne fait que des fondus, pour la même raison ; le menu part de la pilule telle qu'on la voit, encore gonflée par le toucher (`pillHandover`) ; une liste tirée au-delà de son bout étire la
boîte verticalement (`scale`, lu sur la position de défilement que le rebond du système porte
hors des bornes — iOS et Safari au pavé tactile ; rien sous Chrome Windows, qui ne rebondit pas). Le fondu des commandes est porté par chaque
élément (`player-fade`), jamais par leur conteneur : un parent à opacité < 1 isole le fond, et le
flou n'avait rien à flouter pendant le fondu (la 8.2.4 avait retiré le flou pour cette raison).
La barre du bas a une lentille : une pastille de verre sous l'onglet ouvert, qui glisse sur le
ressort, se soulève sous le doigt et le suit ; la barre gonfle et s'étire moitié moins que le
lecteur. La navigation y part toujours au contact ; un glisser qui finit sur un autre onglet
l'ouvre au relâchement, en remplaçant l'entrée d'historique du premier. Déjà sur Recherche, le second
appui lève le clavier au relâchement seulement, s'il est resté sur Recherche sans glisser
(`isOnPanel`, `playerNav.ts`) — au contact, il ouvrait le clavier au départ d'un glisser vers un
autre onglet.

**La reprise après une pause n'est pas un chargement** (même jour) : `PlayerControls` reçoit
`resuming` à part de `loading`. Les boutons du centre restent et lecture/pause reste touchable ; un
anneau tourne autour de lui et le fil du haut court en paysage, tous deux après 150 ms ; la
minuterie qui cache les commandes attend la première image. Le délai de chaque reprise est mesuré
dans le bilan `stop` (`resumes`, `resumeWaitMs`, `longestResumeMs`, `SessionTally`) avant de
toucher au recalage du son fait à la pause (`PlaybackGuard`).

**Porteur.** `src/lib/liquidGlass/liquid.ts` (`createLiquidPress`, `liquidTransform`, `pullFrom`,
`swellFor`, `LIQUID_SPRING`) et `src/lib/liquidGlass/spring.ts` (le ressort simulé une fois et
joué par `element.animate()`). La matière : les variables `--glass-*` et `.player-liquid`,
`.nav-glass` dans `globals.css`.

**Appelants.** `PlayerControls` (délégation sur `[data-liquid]`), `LiquidMenu`, `MiniPlayerChrome`
(le mini-lecteur, même verre et même geste depuis le 04/10), `CinemaMobileDetail` (la fiche du
téléphone : croix en verre avec le geste complet ; Lire, Reprendre au début, Bande-annonce, À voir
et Vu avec un geste qui laisse le défilement vertical au navigateur, `data-liquid-pan` — le bureau
attend), et depuis la 8.8.0 la bannière d'accueil du téléphone (Lire, Plus d'infos en verre —
geste « appui » qui rend la main au carrousel et au défilement dès que le doigt bouge), la loupe
de la barre du haut, les croix des fiches personne et découverte, de la visionneuse de photos et
de la bande-annonce, l'écran de fin du lecteur (Revoir en verre, Terminé, la carte de saga) et le
menu de l'appui long (`ActionSheet`, carte de verre qui flotte, arrivée avec un léger rebond). Deux
façons de brancher le geste : `useLiquidDelegation(racine)` (`data-liquid`, `data-liquid-pan` =
`wide` | `icon` | `press`) et `liquidButtonRef` pour un bouton seul, la lentille `useLiquidLens`
(`src/lib/liquidGlass/useLiquidLens.ts`, axe horizontal ou vertical) dans `PlayerBottomBar`,
`PlayerRail` (rail du bureau) et `CinemaModeToggle` (bascule Films/Séries, bureau et téléphone —
une seule pièce, lentille translucide : blanche pleine, un glisser lent montrait des libellés
noir sur noir et blanc sur blanc), et la page d'administration « Tests animations »
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

La carte « Épisode suivant » et les messages (`Toast`) portent le même verre, et entrent avec un
rebond en CSS (`glass-pop`), l'opacité sur la surface elle-même.

**Choisi le 04/10/2026** sur la page « Tests animations », sur iPhone et au bureau.

## 46. Le cinéma répond tout de suite, quitte à montrer qu'il travaille

**Règle.** Un geste a sa réponse visible dans l'image qui suit ; ce qui coûte se construit derrière,
interruptible, avec un fil de chargement fin qui n'apparaît qu'après 150 ms. Trois cas :
- changer d'onglet Films/Séries sur téléphone : la bascule suit l'adresse tout de suite, le contenu
  suit `shownTab = useDeferredValue(mediaType)` ; l'autre onglet est monté d'avance, caché, dans une
  transition, 1,5 s après que son catalogue est là (`useKeptTabs(active, prepared)`) ;
- ouvrir la grille complète : le premier écran (28 cartes) d'abord, la liste entière ensuite
  (`useDeferredValue(shown, firstScreen)`), un filtre changé par le même chemin ;
- les boutons « Voir tout » du téléphone répondent au relâchement du doigt (`useTap`) : juste après
  un défilement, iOS garde le premier `click` pour arrêter l'élan.

**Porteur.** `useDeferredValue` aux deux endroits cités, `useKeptTabs` (`src/lib/keptTabs.ts`),
`useTap` (`src/lib/useTap.ts`) et `TapButton`.

**Appelants.** `CinemaMobileClient` (onglets, « Voir tout » des rangées et du bas de page),
`CinemaBrowseSheet` (bureau et téléphone).

**Tests.** `useTap.test.tsx`, `keptTabs.test.tsx` (onglet préparé), `CinemaBrowseSheet-duration.test.tsx`
(ouverture en deux temps), `decisions-partagees.test.ts` (le décodage anticipé suit la liste dessinée).

**Voulu.** L'adresse, les fiches et la grille suivent toujours l'onglet choisi, jamais l'onglet
affiché : seul ce qui est dessiné prend du retard. Le bureau garde son `click` (la souris n'a pas
l'élan d'un défilement tactile).

**Trouvé le 04/10/2026** : premier passage sur « Séries » lent, et « Voir tous les films » qui
demandait deux appuis au bout de la page.

## 47. Ce que le cinéma montre, et ce qu'il dit « dans la bibliothèque »

**Règle.** Un film avec son fichier, une série avec au moins un épisode, **et** son élément
Jellyfin retrouvé — par le **dossier** d'abord (le nom du dossier, insensible au point de montage
de chacun ; ignoré si deux éléments le partagent), puis par les identifiants, puis par le titre.
Tout ce qui dit « dans la bibliothèque » lit cette même règle : les routes du catalogue, la
recherche (`available`), les rangées TMDB, les personnes, les demandes et les listes
(`playableLibrary`). Un titre hors de la règle s'ouvre sur sa fiche TMDB. Une fiche demandée que le
catalogue, relu au réseau, n'a pas : un message (« pas encore disponible ») et l'adresse nettoyée.

**Porteur.** `matchMovies`, `matchSeries`, `catalogueMembers` (`src/lib/catalogueMembers.ts`) ;
le rapprochement par dossier dans `findJellyfinMovieByTmdb` / `findJellyfinSeriesByTvdb`
(`folderKey`, `src/lib/server-cache.ts`) ; `useMissingTitleNotice` côté écran.

**Appelants.** `/api/cinema/movies`, `/api/cinema/series`, `/api/search`, `playableLibrary` (et
par elle `/api/player/discover`, `/api/player/lists`, `/api/player/title`, `/api/tmdb/person`,
`playerRequests`), `CinemaMobileClient` et `CinemaClient`.

**Tests.** `catalogue-members.test.ts`, `missing-title-notice.test.tsx`, et les tests des routes.

**Voulu.** Jellyfin injoignable : la première moitié de la règle seule — un titre qui ne s'ouvre
pas vaut mieux qu'une bibliothèque qui disparaît des recherches. Le message attend la relecture
du catalogue au réseau : celui gardé sur l'appareil peut dater de quelques jours.

**Trouvé le 05/10/2026** : *The Arena (2026)*, identifiée par Jellyfin comme *The World's Greatest
Arena* ; la recherche la disait dans la bibliothèque, et l'ouvrir ne faisait rien.

## 48. Le déploiement simplifié : réglages dans l'application, assistant de premier lancement

**Règle.** Une valeur de configuration se lit dans cet ordre : réglée dans l'application (table
`app_settings` de `cine.db`), sinon `.env`, sinon défaut. `config.ts` est fait d'accesseurs qui
relisent à chaque accès (deux secondes de cache) ; les clients des services relisent adresse et
clé à chaque appel. Une valeur présente dans `.env` remplit son champ dans l'interface ; la
changer dans l'interface la remplace — l'interface le dit — et « Revenir à la valeur du .env »
efface le réglage. Restent hors de l'interface : le secret de session, le compte administrateur
de `.env`, et les options de déploiement (fuseau, dossier des médias), pour lesquelles l'interface
donne la ligne à ajouter au compose ou au `.env`.
Les secrets absents de l'environnement (session, clés VAPID) sont générés au premier lancement
dans `data/config/secrets.json` (0600) et relus ensuite ; `.env` l'emporte toujours.
Tant que l'assistant n'est pas terminé, toute page y mène. Il commence par « Bonjour » dans les
langues de l'application et le choix de la langue (qui règle celle de l'installation), puis crée
le compte administrateur (haché, scrypt) si aucun n'existe, et ne rend obligatoires que Jellyfin,
TMDB et Radarr ou Sonarr. Son drapeau n'est posé que par « Terminer ». Une installation configurée
par son `.env` avant lui (Jellyfin, TMDB et Radarr ou Sonarr renseignés) est reconnue et marquée
terminée une fois pour toutes ; `SETUP_COMPLETE=true` le force.

**Porteur.** `src/lib/settings/schema.ts` (la liste), `store.ts` (la table), `setup.ts` (valeur,
provenance, vue sans secret, enregistrement tout ou rien, drapeau, compte), `testService.ts`,
`server-boot/firstRunSecrets.mjs`, `config.ts`.

**Appelants.** `proxy.ts` (renvoi vers l'assistant, gardé), `/api/setup/*`, `/api/settings*`,
`/api/auth/login` (compte de l'assistant), `boot.mjs` et `instrumentation.ts` (secrets),
`src/app/setup/page.tsx`, `/parametres/connexions`, `SettingsGroupCard` (commun aux deux).

**Tests.** `settings-setup.test.ts`, `first-run-secrets.test.ts`, `boot-refus-demarrage.test.ts`,
`setup-ui.test.tsx`.

**Voulu.** Le compose minimal (`docker-compose.example.yml`) n'a qu'un service, un port et un
volume nommé — l'image prépare `/app/data` au compte de l'application, si bien qu'un volume neuf
démarre sans rien préparer sur l'hôte ; le modèle annoté devient `docker-compose.advanced.yml`. La
route publique de création du compte se ferme dès qu'un compte existe ou que l'assistant est
terminé ; celle de la langue, une fois l'assistant terminé.

Chaque variable de `.env.example` est réglable, guidée (`DEPLOYMENT_GUIDE` : la galerie, les
sous-dossiers de la bibliothèque, les tailles des affiches, le compte fixé par le `.env`) ou générée
(`GENERATED_SECRETS`) ; `settings-couverture.test.ts` échoue sinon. Le lecteur et son relais vers
Jellyfin sont activés par défaut ; le relais se montre à l'étape Jellyfin de l'assistant, pour
pouvoir le couper dès l'installation. Les deux accueils (assistant, accueil d'un compte) portent le
verre mixte de §45 : flou sur les pilules et les boutons, reflet et bord sans flou sur les cartes ;
la langue s'y choisit par une même pilule à lentille (`LanguageLens`).

Le profil de qualité d'un ajout à Radarr ou Sonarr est une seule règle, `defaultQualityProfile`
(`src/lib/qualityProfile.ts`) : celui réglé dans « Réglages serveur » s'il existe encore chez le service,
sinon le premier de sa liste. Elle sert l'ajout depuis la découverte et, par `defaultQualityProfileId`
des routes `/api/radarr/meta` et `/api/sonarr/meta`, les formulaires d'ajout de la gestion. Avant,
la découverte cherchait un nom contenant « vf » et la gestion prenait le premier profil. Les
demandes Jellyseerr n'envoient aucun profil : Jellyseerr applique le sien.

Le cache des affiches optimisées suit le volume de données : au démarrage, `.next/cache/images`
devient un lien vers `data/image-cache` (`server-boot/imageCache.mjs`) — sauf s'il est déjà monté,
comme dans le modèle avancé, qui monte ce même dossier. Le mot de passe du compte de l'assistant se
change dans « Réglages serveur » (ancien mot de passe exigé, autres sessions fermées) et se réinitialise
par `server-boot/reset-admin-password.mjs` ; hachage et vérification vivent dans un seul module,
`server-boot/adminAccount.mjs`, que lisent l'application et la commande.

**Décidé le 05/10/2026.**

## 49. Annuler une demande

**Règle.** Chacun peut retirer *sa* demande, quel que soit son état ; l'administrateur, n'importe
laquelle. La propriété est vérifiée par l'application, et le retrait fait avec la clé d'API :
Jellyseerr ne laisse un compte ordinaire retirer que ses demandes en attente, et avec l'approbation
automatique il n'y en a jamais — la croix échouait sur toutes (trois refus le 05/10/2026).
Une demande **restée sans suite** — aucun fichier, rien en téléchargement — sort aussi de Radarr ou
Sonarr (sans toucher à aucun fichier) et de Jellyseerr, qui pourra la reprendre plus tard. **En
cours ou déjà là**, seule la demande disparaît. Le titre ne sort de Radarr ou Sonarr que s'il
n'appartient qu'à cette demande : personne d'autre ne l'a demandé (`mediaInfo.requests`), et il a
été ajouté par elle (date d'ajout au plus tôt une minute avant la demande) — pas avant, à la main.
Une vérification qui échoue n'empêche jamais l'annulation ; elle laisse seulement Radarr/Sonarr tels
quels. Annuler demande confirmation, dans la feuille d'actions de verre (`ActionSheet`, affiche et titre en tête) — dessinée sur l'affiche, elle était trop petite. « Rien en téléchargement » se lit dans la file **du titre**
(`getQueueForSeries` / `getQueueForMovie`), jamais sur la première page de la file générale : le
06/10/2026, une série de 263 épisodes remplissait cette page, et l'annulation de *The Kardashians*,
alors en plein téléchargement, l'a retirée de Sonarr en laissant ses torrents orphelins.

**Porteur.** `cancelRequest` (`src/lib/requestCancel.ts`).

**Appelants.** `DELETE /api/player/requests/[id]`, la croix de `PlayerRequestCard`.

**Tests.** `request-cancel.test.ts`, `PlayerRequestCard-confirm.test.tsx`.

**Décidé le 05/10/2026.**

## 50. Le défilement guidé, réglable

**Règle.** L'accueil du cinéma, la fiche film et la fiche série de l'interface ordinateur se calent
sur une rangée ou une page entière (`snap-y snap-mandatory`) tant que le compte ne l'a pas coupé
(Compte → Affichage). Une préférence du compte, rangée avec la langue (`user_preferences.guided_scroll`,
NULL = activé), suivie depuis la clé `/api/user/preferences` déjà chargée au démarrage, avec la
dernière valeur connue de l'appareil avant la réponse.

**Porteur.** `useGuidedScroll` et `guidedScrollClass` (`src/lib/guidedScroll.ts`) — la seule façon
d'écrire les classes du conteneur.

**Appelants.** `CinemaClient` (volet des rangées), `CinemaMovieDetail`, `CinemaSeriesDetail` ;
l'interrupteur dans `PlayerAccountPanel` (`DisplaySection`).

**Voulu.** L'interface téléphone n'a pas de calage vertical et ne lit pas ce réglage. Coupé, la
navigation au clavier reste juste : elle fait défiler jusqu'au début de la rangée ou de la page.

**Tests.** `guided-scroll.test.tsx`, `decisions-partagees.test.ts` (aucun `snap-y snap-mandatory`
écrit à la main dans le cinéma).

**Décidé le 06/10/2026.**

## 51. « Vu » : Jellyfin d'abord, une copie locale toujours

Demandé le 06/10/2026 : faire de « Ma liste » le centre — « À voir », manuel ; « Vu », automatique,
manuel et corrigeable, y compris pour un titre que la bibliothèque n'a pas, et sans jamais perdre le
vu d'un compte quand un titre quitte la bibliothèque. Remplace la part « vu » de §6 et §6 bis.

**Règle.**
- *Le titre est dans Jellyfin* : Jellyfin fait foi. Marquer ou démarquer un film écrit chez lui, une
  lecture complète l'y marque. La table `watched_titles` en garde une copie à jour.
- *Il n'y est pas* (vu ailleurs, ou parti) : la copie locale est la seule trace, et reste.
- *Il arrive* : le vu est reporté chez Jellyfin (écriture automatique autorisée par l'administrateur).
- *Désaccord* tant que le titre est présent : la dernière modification gagne. Un film que Jellyfin
  disait vu au dernier passage et ne dit plus a été démarqué chez lui : la copie suit.
- *Une série* est vue quand tous ses épisodes le sont (Jellyfin), ou marquée vue à la main : un état
  de série, chez nous, **sans cocher aucun épisode** — Jellyfin garde le détail réel. Elle quitte
  « Reprendre » et « À suivre », sauf un épisode entré dans la bibliothèque après le marquage. Une
  série entièrement vue qui ne l'est plus (nouvel épisode) reste vue, comme marquée ce jour-là.
- *Fin de lecture* : le titre entre dans « Vu » ; s'il est dans « À voir », l'écran de fin propose de
  l'en retirer, sans le faire d'office. Lecteur natif seulement (le lecteur serveur n'a pas d'écran
  de fin).
- Jellyfin ou la bibliothèque injoignable : la synchronisation ne décide rien (un index absent ne
  vaut pas une bibliothèque vide).

**Porteurs.** `src/lib/watched.ts` : `setWatched` (le seul chemin d'écriture), `syncWatched` (au plus
une fois par minute et par compte, à la lecture de « Ma liste »), `withoutWatched` (le filtre commun
de « Reprendre » et « À suivre »), `libraryIndex` ; `watchedDb` (`db.ts`).

**Appelants.** `POST /api/player/watched` (fiche de découverte, série depuis sa fiche),
`POST /api/jellyfin/played` (film depuis sa fiche : Jellyfin, puis la copie), `GET /api/player/lists`,
`GET /api/jellyfin/resume`, `GET /api/cinema/next-up`, `GET /api/cinema/progress/[itemId]` (série
marquée ici), `GET /api/player/watched/finished` et `PlayerEndScreen` (`FinishedAsk`),
`useJellyfinItemState`, `useTitleWatched`.

**Tests.** `watched.test.ts`, `watched-routes.test.ts`, `refreshAfterPlayback.test.ts`.

**Migration.** `watched_titles` est créée au démarrage (`CREATE TABLE IF NOT EXISTS`, rien d'autre
ne change) ; la première lecture de « Ma liste » d'un compte y copie ce que Jellyfin sait déjà vu.

**Décidé le 06/10/2026.**


## 52. La disposition de l'accueil, un réglage et non une fourche

**Règle.** Deux options de l'accueil. Le serveur donne la valeur par défaut (gestion → Réglages
serveur → Réglages par défaut, ou `.env`) ; chaque compte la remplace dans Compte → Interface, à
côté du défilement guidé (`user_preferences`, `NULL` = suivre le serveur ; revenir à la valeur du
serveur la suit de nouveau). L'écran du compte ne montre que l'interrupteur.
- `HOME_BROWSE_BUTTON` (activé par défaut) : « Tous les films » / « Toutes les séries », en rond en
  haut à droite (l'aide du clavier se range à sa gauche au bureau). Sur téléphone, la barre du haut
  porte le logo (et le nom s'il y a la place), la bascule au centre, ce bouton à droite — la loupe
  qui y était doublait l'onglet « Recherche » de la barre du bas (retirée le 08/10/2026).
- `HOME_CONTINUE_HERO` (**coupé par défaut** depuis le 08/10/2026) : la bannière montre d'abord les
  reprises (huit au plus au bureau, cinq sur téléphone — `HERO_LIMIT_PHONE`), complétées par
  « À la une » jusqu'à cinq (`HERO_MIN`) ; une rangée « À la une » au moins de cinq titres la suit
  (`spotlightRowItems`) ; le bouton dit « Reprendre » / « À suivre » avec la barre et « S1 · É3 ·
  20 min restantes » (`heroContinueFacts`, `HeroContinueProgress`).

**Par défaut (08/10/2026) : une zone, un rôle.** La bannière fait découvrir (« À la une »), la
première rangée sert à reprendre. L'essai des reprises dans la bannière, avec vignettes, montrait les
mêmes titres trois fois et mêlait deux intentions ; il reste une option.
- **Rangées**, bureau et téléphone : Reprendre / À suivre (mêlés, le dernier lu d'abord, la même
  rangée sur les deux onglets), Ma liste, le classement du jour, les derniers ajouts (« Voir tout » →
  la grille complète, triée par date d'ajout), puis les genres. **Ma liste descend juste avant les
  genres quand elle tient moins de deux titres** (`myListGoesLate`). Pas de « Voir tout » sur Reprendre ni
  sur le classement : ils sont déjà entiers.
- **Téléphone** : l'affiche entière à 86 % de la largeur, les voisines qui dépassent (`peek` de
  `carouselTransform`), les tirets dessous, un passage de 500 ms en longue décélération
  (`CAROUSEL_MS`) ; toucher l'affiche ouvre la fiche (pas le relâchement d'un balayage) ; la piste
  **boucle** — après le dernier, le premier, en continuant dans le même sens, sur
  une copie raccordée sans transition (`loop` de `useCarouselDrag`).
- **Bureau** : la rangée d'affiches qui pilotait la bannière a disparu. La bannière des nouveautés
  porte « Lire » et « Plus d'infos » et `‹ ——— ›` (`HeroBannerControls`) ; ← → y changent de titre, ↓
  redescend, ↑ va à la bascule. Le survol ou le focus d'une affiche y met son aperçu, **sans boutons**
  (un clic sur l'affiche ouvre la fiche) et avec la pastille « ‹ À la une » (`HeroBackToSpotlight`)
  qui ramène les nouveautés en fondu — atteinte aussi par ↑ depuis la première rangée
  (`data-tv-escape-up="hero"`, avant la bascule), qui les ramène et met le focus sur « Lire ». Le logo
  ouvre la fiche.
- Basculer de Films à Séries garde la position de chaque bannière : l'onglet caché n'est plus « hors
  de l'écran » (`heroOffscreen`), sa rotation est en pause.
- « À suivre » ne propose pas une série sur S1 · É1 jamais commencé (`untouchedPilot`, route
  `/api/cinema/next-up`) : Jellyfin en ajoute une à chaque série qui arrive.

**Pourquoi un réglage.** Une installation voulait le catalogue entier à un geste et ce qu'on regarde
en tête. Une copie du dépôt (une image `:alt`) aurait fait deux applications à maintenir.

**Porteurs.** `homeLayout.ts` (`continueHeroTitles`, `heroSource`, `continueTargets`,
`spotlightRowItems`) ; `useHomeLayout.ts` ; `cinemaContinueLabel.ts` (`heroContinueFacts`) ;
`CinemaHero.tsx` (`HeroBannerControls`, `HeroBackToSpotlight`, `HeroTitleLink`) ;
`CinemaBrowseAllButton`, `HeroContinueProgress` ; `useCarouselDrag` (`peek`, `loop`).

**Appelants.** `CinemaClient` (bureau), `CinemaMobileClient` / `CinemaMobileHero` (téléphone).

**Tests.** `home-layout.test.ts`, `heroCarousel.test.ts`, `cinema-next-up-route.test.ts`,
`misc-simple-routes.test.ts`, `misc-routes-batch2.test.ts`, `persistentCache-schema.test.ts`.

**Décidé le 07/10/2026, revu le 08/10/2026.**

## 53. Un genre, un nom

**Règle.** Les genres du catalogue sont ramenés à la clé anglaise des dictionnaires (`genres.*`)
quand le serveur construit le catalogue : « Horreur », « Terror », « horror » deviennent « Horror »,
« Sci-Fi & Fantasy » devient « Science Fiction » et « Fantasy ». Un genre inconnu reste tel quel.

**Pourquoi.** Une source dans une autre langue que Radarr/Sonarr faisait deux genres d'un seul :
deux rangées sur l'accueil, deux entrées dans le filtre de la grille complète, chacune avec la
moitié des titres.

**Porteur.** `canonicalGenres` (`src/lib/genres.ts`), alias tirés des quatre dictionnaires.

**Appelants.** `/api/cinema/movies` et `/api/cinema/series` ; en aval, les rangées par genre, les
libellés et le filtre « Genre » de `CinemaBrowseSheet`.

**Tests.** `genres-canonical.test.ts`.

**Voulu.** Plus strict que la recherche en langage naturel (`GENRE_ALIASES`) : « Suspense » et
« Musical » restent des genres à eux, comme Sonarr les donne.

**Décidé le 07/10/2026.**

## 54. Les tags bloqués d'un compte s'appliquent au catalogue

**Règle.** Chaque réponse du catalogue (`/api/cinema/movies`, `/api/cinema/series`) retire les titres
dont l'élément Jellyfin porte un des `BlockedTags` du compte qui demande — partout : titres,
rangées, sélection, derniers ajouts, classement, genres vidés. La règle est celle de Jellyfin et elle
seule (comparaison sans la casse, rien d'autre de retouché) ; les tags bloqués sont relus toutes les
deux minutes.

**Pourquoi.** Le catalogue est construit une fois pour tout le monde depuis la vue serveur de Jellyfin
(voir la note de `/api/cinema/movies`) : un titre caché à un compte y figurait quand même, et seule
sa lecture était refusée (`assertVisible`). Pour réserver des titres à certains comptes — le tag
« prive », posé le 08/10/2026 sur les programmes de Dieudonné et bloqué sur tous les comptes sauf
deux —, ils ne doivent pas exister pour les autres.

**Partout, pas seulement dans le catalogue.** Les écrans qui parlent en identifiants TMDB — la
recherche, les rangées de découverte, la filmographie d'une personne, les titres similaires, une saga —
marquaient ce titre « dans la bibliothèque » : ils retirent les mêmes titres (`hiddenTmdbKeysFor`,
`movie:603` / `series:1399`). Une personne reste trouvable ; ses titres cachés, non.

**Porteurs.** `blockedTagsOf`, `carriesBlockedTag`, `withoutHidden`, `hiddenForRequest`,
`hiddenTmdbKeysFor` (`src/lib/blockedTags.ts`) ; les tags viennent des listes serveur
(`Fields=…,Tags`).

**Voulu.** Le catalogue entier est construit d'abord, puis filtré : le classement du jour est gardé par
sorte, pas par compte, et un compte bloqué en voit un titre de moins. Un tag posé à la main sur un
élément est verrouillé dans Jellyfin (`LockedFields: Tags`), pour qu'une actualisation des
métadonnées ne l'efface pas. La lecture reste gardée par `assertVisible`.

**Tests.** `blocked-tags.test.ts`.

**Décidé le 08/10/2026.**


## 55. L'accroche et la bande-annonce viennent avec le catalogue

**Règle.** Une fiche montre l'accroche et le bouton « Bande-annonce » dès l'ouverture, sans fondu,
quand le catalogue les connaît. Elle n'attend la description de la fiche (Radarr, Bazarr, OMDb, TMDB)
que pour un titre que le serveur ne connaît pas encore, et dans ce cas elle garde la place réservée et
le fondu. Quand le catalogue connaît la valeur, c'est elle qui s'affiche : voir l'accroche changer sous
les yeux serait pire que d'attendre.

**Pourquoi.** Les deux n'arrivaient qu'avec la description, une demi-seconde après le reste de la fiche,
alors que tout le reste venait du catalogue déjà gardé sur l'appareil.

**D'où elles viennent.** Elles arrivent dans le même appel TMDB que les titres et les synopsis traduits
(`append_to_response=translations,videos`), sans requête de plus par titre. Seule exception : l'accroche
dans la langue d'origine quand ce n'est pas l'anglais, que TMDB ne range pas parmi les traductions. Le
catalogue porte deux champs, `tagline` et `trailerKey`. Un champ absent veut dire « pas encore su » ;
une chaîne vide ou `null` veut dire que le titre n'en a pas.

**Porteurs.** Côté serveur : `extrasFromTranslations`, `getTitleExtras` et `catalogueExtras`
(`src/lib/titleNames.ts`), plus `pickTrailer` et `videoLanguages` (`src/lib/clients/tmdb.ts`), communs
au catalogue et aux deux routes de description. Côté fiches : `sheetLeadFacts` (`src/lib/sheetFacts.ts`).

**La durée d'un épisode** (« 43min/ép. ») suit la même voie depuis le 08/10/2026, parce qu'elle
était le dernier élément à arriver en décalé. Le catalogue des séries porte `episodeRuntime`, calculé
par `tvEpisodeRuntime`, la règle de la fiche, avec la durée de Sonarr. La fiche la lit par
`sheetEpisodeRuntime`.

**Le bouton « Lire » d'une série jamais commencée** est là dès l'ouverture, lui aussi, depuis le
08/10/2026. Ni « Reprendre » ni « À suivre » ne connaissent une telle série : « À suivre » écarte les
S1·É1 jamais lancés. La fiche attendait donc sa liste d'épisodes, qui elle-même attend les résumés
TMDB. Le catalogue porte désormais `firstEpisode`, obtenu en un seul appel Jellyfin pour toute la
bibliothèque (`cachedJellyfinFirstEpisodes`). `localPlayTarget` en fait une supposition
(`guessed`). Le bouton reste à jour : la réponse du serveur remplace la supposition dès qu'elle
arrive, et un appui qui la précède est retenu, puis lance la cible de cette réponse
(`useQueuedPlay`, `waitForServer` sur `PlayButton`). Une supposition n'est jamais lancée telle quelle.

**Le nombre de saisons** (« 3 saisons », fiche du téléphone) suit la même voie. Le catalogue porte
`seasonCount` : les saisons non vides de chaque série, spéciaux compris, comptées en un seul appel
Jellyfin (`cachedJellyfinSeasons`). Mesuré le 08/10/2026 sur les 151 séries, ce compte est identique
à celui de la liste d'épisodes de la fiche. Quand cette liste arrive, son nombre fait foi.

**La bannière du bureau** lit dans le catalogue son synopsis et les noms de sa distribution
(`castNames`, dans le même appel TMDB). Avant, elle les demandait titre par titre
(`/api/cinema/hero/…`) et les préchargeait : jusqu'à cent vingt requêtes à chaque ouverture de
l'accueil, et un léger décalage au survol des affiches restées hors du préchargement. Cette route ne
sert plus qu'aux titres que le serveur ne connaît pas encore (`useHeroInfo`, avec son troisième
argument).

**Appelants.** `CinemaMovieDetail`, `CinemaSeriesDetail`, `CinemaMobileDetail`, `CinemaHero`,
`CinemaSeriesHero`.

**Tests.** `titleExtras.test.ts`, `sheetFacts.test.ts`, `useQueuedPlay.test.tsx`.

**Décidé le 08/10/2026.**

## 56. Les nouveaux comptes reçoivent d'office les tags bloqués

**Règle.** Chaque compte Jellyfin que l'installation découvre reçoit, une seule fois, les tags de
`NEW_ACCOUNT_BLOCKED_TAGS` dans sa politique Jellyfin. Les administrateurs ne sont jamais concernés. Le
réglage se trouve dans « Réglages serveur », groupe « Réglages par défaut » ; vide, il ne pose rien.

**Pourquoi.** Le tag « prive » (§54) n'était bloqué que sur les comptes qui existaient le 08/10/2026. Un
compte créé ensuite naissait sans ce blocage et voyait ces titres, dans Jellyfin comme dans le cinéma.

**Comment.** Toutes les cinq minutes, la liste des comptes Jellyfin est comparée à `known_accounts`. Au
tout premier passage, les comptes présents sont seulement notés, sans rien modifier : ceux qui ont accès
à « prive » le gardent. Ensuite, un compte inconnu reçoit les tags, puis il est noté. Un compte noté
n'est plus jamais modifié : retirer le blocage à la main dans Jellyfin le retire pour de bon. Chaque
pose est inscrite dans `auth.log` (`new-account-tags`).

**Porteurs.** `applyNewAccountTags`, `withTags` et `newAccountTags` (`src/lib/newAccountTags.ts`),
`knownAccountsDb` (`src/lib/db.ts`).

**Tests.** `newAccountTags.test.ts`.

**Décidé le 08/10/2026.**

## 57. `X-Forwarded-For` n'est cru que d'un relais déclaré

**Règle.** L'adresse d'un client, utilisée par les limites de tentatives et les journaux, est celle de la
connexion elle-même, sauf si cette connexion vient d'un relais déclaré dans `TRUSTED_PROXIES`.
Dans ce cas seulement, `X-Forwarded-For` est lu de droite à gauche jusqu'à la première adresse qui
n'est pas un relais. `TRUSTED_PROXIES` accepte des adresses, des réseaux IPv4 (`a.b.c.d/n`) et des noms
de conteneur, résolus toutes les cinq minutes.

**Pourquoi.** Les gestionnaires de route de Next ne donnent pas l'adresse de la connexion : on lisait le
dernier maillon de `X-Forwarded-For`. Or le serveur est aussi joignable sans le relais, par tout
conteneur du même réseau Docker. Un tel voisin pouvait écrire l'en-tête qu'il voulait à chaque essai, et
la limite des tentatives de connexion, comptée par adresse, ne le freinait plus.

**Comment.** Le démarrage (`server-boot/boot.mjs`) pose l'adresse de la connexion dans `x-cine-peer`
sur chaque requête, en écrasant toute valeur envoyée par le client. Il le signale par
`CINE_PEER_HEADER=1` : sous `next dev`, cet en-tête pourrait venir du client et il est ignoré. Sans
`TRUSTED_PROXIES`, la règle ne change pas : on lit le dernier maillon. L'optimiseur d'images laisse
passer sans session la seule boucle locale, celle du préchauffage des affiches.

**Porteurs.** `clientAddressOf`, `fromLoopback`, `addressMatches` (`src/lib/trustedProxy.ts`), lus par
`getClientIp`, `forwardedFor` et `src/proxy.ts`.

**Tests.** `trustedProxy.test.ts`.

**Décidé le 08/10/2026.**

## 58. Le titre de chaque langue suit son pays de référence, et le logo suit le titre

**Règle 1 — le titre.** Chaque langue a ses pays de référence, dans l'ordre : France pour le français,
Espagne pour l'espagnol, Allemagne pour l'allemand, États-Unis puis Royaume-Uni pour l'anglais. Quand
TMDB a une fiche pour l'un de ces pays, c'est la première d'entre elles qui décide. Remplie, on prend son
titre. Vide, on prend le titre original, parce que c'est ce qu'une fiche vide veut dire : « dans ce pays,
on garde le titre original ». S'il n'y a aucune fiche d'un pays de référence, la règle d'avant
s'applique : le premier titre non vide de la langue. Les accroches et les synopsis suivent le même ordre
des pays.

**Pourquoi.** Une fiche de France vide envoyait chercher le titre d'un autre pays francophone, presque
toujours le Québec : « Fiction pulpeuse » pour *Pulp Fiction*, « Le pouilleux millionnaire »,
« Décadence » pour *Saw*, « La fin du p***in de monde ». Mesuré le 09/10/2026 : 182 titres sur 916 de la
bibliothèque, connus en France sous leur nom original.

**Règle 2 — le logo.** Un titre affiché sous son nom original prend un logo de sa langue d'origine ; un
titre traduit prend un logo de la langue de qui regarde. À défaut, un logo sans texte, puis anglais,
puis n'importe lequel. Dans chaque langue, on retient le logo le mieux noté qui se lit sur nos fonds.
Quand plusieurs logos sont à égalité de votes, on retient le plus coloré : la version de marque
plutôt que sa déclinaison blanche. Un logo trop sombre n'est jamais retenu (voir l'écart des logos
sombres du 09/10/2026).

**Pourquoi.** Les logos de TMDB portent une langue, pas un pays. Le logo « français » de *The End of the
F***ing World* était celui du Québec, et noir : invisible, et il disait autre chose que le titre.

**Porteurs.** `namesFromTranslations` et `REFERENCE_COUNTRIES` (`src/lib/titleNames.ts`) ;
`pickLogosByLang`, `logoForLocale` (`src/lib/title-art.ts`) ; `logoLook` (`src/lib/logoLuminance.ts`) ;
`getTitleLogoFor` (`src/lib/title-logo.ts`).

**Appelants.** `/api/cinema/movies`, `/api/cinema/series`, `/api/jellyfin/direct/[itemId]` (le logo du
lecteur), `/api/radarr/movies/[id]/info`, `/api/sonarr/series/[id]/info`. Ils se règlent tous sur la
langue de la requête (`localeOf`), c'est-à-dire celle de qui regarde.

**Voulu.** Le tableau de bord de la gestion et `posterPrewarm` gardent `logoUrl`, l'ancien ordre
(français, anglais, sans texte), puisqu'ils n'ont pas de langue d'affichage. Les entrées de cache des
titres passent en `v3`, et celles des visuels en `v4`. Pendant le recalcul, l'entrée précédente reste
servie : aucun titre déjà connu ne retombe sur celui de Radarr ou Sonarr.

**Tests.** `titleLanguageRules.test.ts`, `titleNames-transition.test.ts`, `titleNames.test.ts`,
`title-art.test.ts`.

**Décidé le 09/10/2026.**

## 59. Effacer les alertes du panneau Activités : une date, jamais une suppression

**Règle.** « Effacer les alertes » pose une date. Ce qui colore le panneau en rouge, orange ou jaune
ne se compte plus qu'*après* elle :
- les incidents des séances terminées avant (blocages, reconstructions, replis, erreurs, sauts lents,
  attentes) ;
- les jetons refusés, les erreurs du navigateur et les erreurs serveur ;
- les connexions refusées et les notifications en échec ;
- les titres du diagnostic dont le dernier échec précède la date.

Un nouvel incident se voit aussitôt. « Réafficher » remet la date à zéro, et tout revient.

**Pourquoi.** Une alerte traitée restait affichée jusqu'à sortir de la fenêtre de sept ou trente jours,
et le panneau restait coloré pour des pannes déjà réglées.

**Ce qui ne change pas.**
- **Les journaux ne sont jamais touchés.** Le diagnostic, les signalements et les vues brutes en
  dépendent : la page Journaux, le détail d'une séance, les connexions et les erreurs d'un compte.
- **Les séances restent listées et ouvrables :** une séance acquittée garde son temps regardé, et
  seuls ses incidents sont mis à zéro (`acknowledgeSeance`).
- **« Jeton plus vu » est un état :** effacé, il ne revient que si Jellyfin revoit le compte puis le
  perd de nouveau.

**Une date pour tout le panneau, pas une par compte.** « Tout est vu » est un seul geste, et les tuiles
de la semaine mêlent tous les comptes.

**Porteurs.** `alertsClearedAt`, `setAlertsClearedAt`, `acknowledgeSeances` et `afterClear`
(`src/lib/activity/alertsCleared.ts`), lus par `listAccounts`, `weekSignals`, `recentSeances`,
`accountDetail` et `household` (`src/lib/activity/accounts.ts`). La route est
`POST /api/admin/activity/alerts` (`clear` / `restore`).

**Tests.** `activity-alerts-cleared.test.ts`.

**Décidé le 09/10/2026.**

## 60. L'ouverture de la lecture : le visuel, le logo, puis le film — jamais un délai de plus

**Règle.** Dès l'appui sur « Lire », et jusqu'au film qui bouge, l'écran montre :
- le visuel du film, net, qui avance lentement (de 1,08 à 1) ;
- son logo, qui paraît en 250 ms, puis une lueur une fois posé ;
- une légende pour un épisode ou une reprise ;
- une ligne de chargement.

Puis un fondu enchaîné vers le film. Les réglages sont ceux validés dans « Tests animations » (lot G)
le 10/10/2026 :

| Réglage | Valeur |
|---|---|
| Fond | « Net », 1 280 px (l'original au-delà de 1 700 pixels physiques de large) |
| Voile | d'origine |
| Apparition du logo | 250 ms, dès l'appui (600 ms après 200 ms d'attente jusqu'au 10/10 au soir) |
| Lueur | oui, une fois le logo posé ; pas du tout si le film part avant |
| Légende | contextuelle |

**Pourquoi.** L'attente d'ouverture était une roue sur fond noir. Le premier essai avait un fond
flou : une image de 300 px agrandie, et « le flou basse résolution se voit ». Le fond net en
1 280 px, sous un voile, fait lire le logo sans rien abîmer.

**Entière dès l'appui, sans seuil.** Dès le montage du lecteur, l'ouverture entière couvre l'écran :
le visuel déjà en mouvement, le logo (ou le titre écrit) qui paraît en 250 ms sans délai, la ligne et
la légende avec lui. Le lecteur vide ne se montre jamais. Ensuite :
- elle **tient jusqu'au film qui bouge** (`phase` → `picture` : la règle de fin plus bas — l'horloge
  partie, ou la lecture automatique refusée), puis s'efface en un seul fondu de 280 ms, en
  décélérant, sur une image qui joue déjà, et la lecture est close (`finishIntro`) ;
- une image décodée qui ne part pas en `COVER_HOLD_MS` (1,2 s ; `imageShown` : `announced` au natif,
  l'image du lecteur serveur) est un vrai blocage : l'ouverture s'efface quand même, et l'attente se
  voit ;
- **une image à l'écran n'est jamais recouverte** : un lecteur monté sur une image déjà là, ou sur
  une ouverture close (mini-lecteur rendu au plein écran, relais), ne pose rien.

Pourquoi sans seuil (10/10/2026, soir) : pendant quelques heures, sous 300 ms, seule une couverture
immobile paraissait — le visuel sans logo ni ligne —, l'ouverture animée ne partant qu'au-delà. Sur
les départs les plus rapides, ces quelques centaines de millisecondes d'image immobile se lisaient
comme un écran figé (Louis, iPhone, 8.31.2 : « pourquoi on met pas directement la barre de chargement
avec le logo ? »). Un logo posé en 250 ms donne au départ le plus bref l'air voulu, et la lueur, qui
attend le logo posé, ne passe pas du tout si le film part avant.

Pourquoi une couverture d'abord (relu le 10/10/2026) : les reprises lues depuis l'appareil s'ouvrent en 34 à 115 ms. La
première image arrivait figée vers 50 ms, Safari mettait quelques centaines de ms à faire partir
l'horloge, et l'ouverture animée — partie à 300 ms parce que sa fin était l'horloge qui avance —
se posait *sur* l'image déjà là, puis s'effaçait un instant plus tard. Avant elle, le lecteur vide
se voyait un instant. Une couverture qui s'efface sur l'image règle les deux.

Puis (8.30.9, même jour) : effacée sur l'image *figée*, la couverture laissait encore voir l'image
arrêtée et, le temps que Safari démarre, la roue des commandes — montée sur `waiting`, sans délai.
D'où la couverture qui tient jusqu'au film qui bouge, et trois silences :
- **la roue de l'hôte** (`openingSpinner`, `resumeSpinner`) ne paraît pas sous le calque, ni pendant
  la grâce du premier départ (`OPENING_SPINNER_GRACE_MS`, 1,2 s) ;
- **la roue et le fil des commandes** suivent la même règle, par la propriété `openingQuiet` que
  l'hôte leur passe (natif : calque ou grâce ; serveur : calque, signalé par `onCoverChange`) — les
  vraies attentes en cours de film les gardent ;
- **le gel des départs du début** est attaqué à la source : la position est redemandée une fois
  100 ms après l'atterrissage de l'ouverture si rien n'a bougé (`OPENING_REASSERT_MS`, `MseSource`),
  au bord du média seulement ; la poussée de 400 ms reste le filet. Mesuré ce jour-là : WarGames, La
  Flamme, Drive ouverts en 14 à 373 ms, figés jusqu'à la poussée (`frozenNudges: 1`), que le chien de
  garde à 250 ms ne livrait qu'à 500 ms. **Jamais sur un élément qui repart** : un `playing` ou un
  `seeked` après l'atterrissage annule la relance, qui ne part que si l'élément saute encore ou n'a
  pas de quoi avancer (`readyState` < 3) ; et la poussée de 400 ms laisse 600 ms à un élément tout
  juste reparti (`OPENING_PLAYING_GRACE_MS`). Mathis, iPhone, 8.32.9 : la minuterie, retardée par le
  fil principal, tombait 283–348 ms après l'atterrissage, dans l'instant même du `playing` de Safari ;
  son pas relançait le saut et coûtait ~1,1 s jusqu'à la première image.

**Ce qu'elle ne fait jamais.**
- **Retarder la lecture.** C'est un calque posé sur l'élément vidéo : le fichier s'ouvre dessous
  comme avant, et le fondu part de la première image.
- **Prendre un appui.** Sa croix est le seul élément qui en reçoive. À l'ouverture du lecteur natif,
  les commandes ne sont pas encore là, et la croix doit l'être.
- **Masquer un écran qui a quelque chose à dire.** Elle s'efface à l'instant pour :
  - une erreur ou la connexion perdue ;
  - l'attente devenue anormale (le rapport de 20 s doit se lire) ;
  - le mini-lecteur.

**Une seule ouverture par lecture, partagée par les deux lecteurs.** Son horloge est posée à l'appui
(`startIntroClock`, clé `${openId}:${itemId}`) et vit hors de React. Quand le lecteur natif passe la
main au lecteur serveur avant la première image, le second reprend au point exact où le premier en
était : même zoom, logo déjà là, même légende (`keepIntroSnapshot`). Une lecture qui a montré une
image (`finishIntro`) ne la rejoue plus : ni une reconstruction, ni un relais en plein film, ni le
retour d'une diffusion.

**Où elle s'affiche, et où non.**

| Cas | Ouverture |
|---|---|
| Lecteur natif et lecteur serveur, ouverture d'un titre | oui, dès l'appui |
| Épisode suivant (enchaînement automatique ou bouton) | oui, dès l'appui : visuel et logo de la série, légende de l'épisode — à la place de l'écran noir du lecteur neuf |
| Séance qui existe pour diffuser | non |
| Retour d'une diffusion, page rechargée pour une piste WebKit | non : reprises en plein film |
| Banc d'essai | non |

**Les données sont déjà sur l'appareil.** `play()` et `advance()` cherchent le visuel dans le cache
de SWR (`resolveIntroArt`), sans requête :
- le catalogue ;
- « Reprendre » et « À suivre » ;
- les listes d'épisodes ouvertes ;
- le premier épisode d'une série (§55).

Un épisode prend le visuel et le logo de sa série. Le visuel et le logo sont demandés dès l'appui
(`preloadIntroArt`). Rien de trouvé : le titre écrit sur fond noir. Le logo de la description du
fichier n'est pas attendu : il a 500 ms de budget côté serveur, et ce que l'ouverture montre est figé
dès l'appui.

**Quand l'ouverture laisse la place au film** (`src/lib/introEnd.ts`) — à la lecture partie, pas au
lecteur prêt (ou à `COVER_HOLD_MS` sur une image qui ne part pas) :
- **lecteur natif** : l'horloge qui avance vraiment, mesurée depuis le dernier placement de la tête
  (l'atterrissage de l'ouverture et la poussée d'une horloge figée sont des sauts) ;
- **lecteur serveur** : plus de saut en cours et `readyState` ≥ 3 (`loadeddata` précède le saut de
  reprise) ;
- **la lecture automatique refusée** : un élément arrêté *sur une image* (`readyState` ≥ 2, aucun
  saut), confirmé sur la durée (1 s au natif, 2,5 s au serveur, où l'attribut `autoplay` laisse
  l'élément arrêté le temps de remplir). Un élément arrêté *sans* image n'en est pas un : c'est une
  reprise dont le média arrive, et l'ouverture effacée là laissait un écran noir sans roue.

Un logo qui ne se charge pas laisse la place au titre écrit.

**Ce qui diffère exprès.** Le banc garde ses curseurs et sa « vidéo » simulée, et rend le même
composant. Le texte « Analyse du fichier… » ne s'y ajoute pas : seul « Toujours en cours… » paraît
sous la ligne, après 8 s.

**Porteurs.**
- `src/lib/playbackIntro.ts` : réglages `PLAYBACK_INTRO`, `introBackdropSrc`, `introVeil`,
  `resolveIntroArt`, `introCaption`, l'horloge et `introAllowedFor`.
- `PlaybackIntro` (`src/components/player/PlaybackIntro.tsx`).
- `useIntroPlaybackStarted` / `useServerIntroPicture` (`src/lib/introEnd.ts`) : la fin de chaque côté.

Ses appelants :
- `ExperimentalPlayerHost` ;
- `ServerPlayerIntro` dans `PlayerHost.tsx` ;
- le lot G de `IntroLots.tsx`.

`PlaybackProvider` pose `introArt` et l'horloge.

**Tests.** `playbackIntro.test.ts`, `PlaybackIntro.test.tsx`, `introEnd.test.tsx`, et la couverture
dans `ExperimentalPlayerHost.test.tsx`.

**Décidé le 10/10/2026.**

## 61. L'ouverture d'une fiche part de l'affiche touchée, et la fermeture y retourne

**Règle.** L'affiche qu'on touche devient le visuel de la fiche, et la fiche y revient en se
fermant :
- **téléphone** : la carte entière grandit depuis l'affiche — la bannière 16:9 en haut, l'encre de
  la carte dessous —, et rétrécit d'une pièce dans l'affiche à la fermeture (le modèle des cartes
  d'iOS) ;
- **iPad** (mise en page large, tactile) : l'affiche grandit jusqu'au visuel plein écran,
  l'accueil recule de 2 % derrière la première fiche ;
- **ordinateur** (survol et pointeur fin) : **pas d'affiche qui grandit** — la fiche relaie
  l'aperçu (voir « Le bureau diffère exprès » plus bas).

**Le bureau diffère exprès : la continuité du fond** (`src/lib/sheetMorph/desktopContinuity.ts`,
10/10/2026). Au survol, l'aperçu du haut montre déjà le visuel et le logo du titre ; faire grandir
l'affiche jusqu'à la fiche reconstruisait sous les yeux le même fond — « au survol on a déjà la
bannière, et au clic la fiche zoome en affichant la même bannière, c'est perturbant » (Louis, sur la
8.31.2). Netflix et l'Apple TV gardent le fond et changent le contenu ; c'est la règle :

| | Ouverture | Fermeture |
|---|---|---|
| Fond | celui de la fiche fond par-dessus celui de l'aperçu, 250 ms — jamais déplacé (les cadrages diffèrent : l'aperçu est calé en haut et masqué) | celui de la copie s'efface sur l'aperçu, 250 ms |
| Logo | celui de la fiche part de la boîte du logo de l'aperçu (même image) et glisse à sa place, sur le même ressort ×0,8 | il regagne la boîte du logo de l'aperçu |
| Texte de l'aperçu | s'efface en 120 ms | revient en 140 ms quand le logo est à 90 % |
| Rangées | descendent de 32 px en s'effaçant, sur le ressort | remontent et reparaissent |
| Contenu de la fiche | d'un bloc à 90 % du trajet du logo, 160 ms | s'efface en 100 ms dès le départ |

Sans logo commun (l'aperçu montre un autre titre, ou la fiche s'ouvre depuis la recherche, une
grille, Ma liste, une fiche du dessous, une filmographie, la fiche TMDB) : le fond fond, et le logo
arrive avec le contenu. Une fiche ouverte par-dessus une autre ne touche pas à l'accueil.
Interruptible comme ailleurs : une ouverture pendant une fermeture la coupe (sa copie s'efface en
80 ms), et l'accueil repart du point où elle l'avait laissé ; retoucher la même affiche fait
repartir le logo d'où il en était.

Le choix est fait une fois, au montage, par `useSheetTransition` (même module), qui appelle
toujours les deux crochets — l'un des deux avec `off`. Fiches qui l'utilisent : `CinemaMovieDetail`,
`CinemaSeriesDetail`, `PlayerDiscoverSheet` (en mise en page large). `CinemaMobileDetail` n'a que le
trajet. La maquette « Bureau » du lot H joue le crochet de production lui-même
(`animlab/ContinuityLot.tsx`), avec l'ancienne version à côté pour comparer. L'accueil marque ses
deux volets : `data-sheet-hero`, `data-sheet-rows` (CinemaClient). Tests :
`sheetMorph-continuity.test.tsx`, `decisions-partagees.test.ts`.

**Au téléphone, la carte entière est la fenêtre** (`cardOpenPoses`, `cardRestPose`, motion.ts ;
`useSheetMorph`, audit du 10/10/2026). Jusqu'à la 8.32.8, la bannière volait seule au-dessus d'un fond
de carte qui montait à part du bas de l'écran ; pour l'y loger, sa cible glissait avec la carte
(`slotRide`), et l'image plongeait vers le bas avant de remonter (y 282 → 626 → 8 px mesurés) ; à la
fermeture, la carte tombait vers le bas de l'écran sur le ressort de l'image — 21 000 px/s, bien plus
vite que le doigt — et laissait l'image au-dessus d'elle (le « décrochement » d'une redescente
rapide). Désormais une seule pièce : la fenêtre a la boîte de la carte (du haut de la fiche au bas
de l'écran), porte l'encre de la carte, et le visuel posé sur la bannière ; elle grandit depuis
l'affiche et y rétrécit. Rien ne peut se décoller. Le contenu arrive d'un bloc à 90 % ; à la
fermeture, la copie (le contenu, la croix) ne bouge pas et s'efface sur le premier quart du trajet.
Lâchée au doigt, la carte repart de là où le doigt l'a mise, lancée à la vitesse du doigt projetée sur
son chemin. Une fiche dont l'image vole porte `data-sheet-flying` : tout visuel ou voile monté pendant
le trajet reste caché (globals.css). Tests : `sheetMorph-hook.test.tsx` (« ne plonge jamais », « d'un
bloc »), `sheetMorph-motion.test.ts`.

**Tout ce qui bouge passe par le compositeur.** Pas de rayon animé (il se peignait sur le fil
principal à chaque image, ses coins en retard sur la transformation) : un rayon fixe en unités de la
fenêtre. La fermeture est créée en pause et part à l'image suivante, une fois la copie mise en page —
lancée dans la tâche même de la fermeture, sa première image peinte tombait déjà à 12–40 % du
trajet. L'arrivée ne fait que l'échange ; les calques rendus au navigateur et le verre de la croix
suivent deux images plus tard. Ce qui est sous la ligne de flottaison de la fiche (saga, titres
similaires, épisodes au-delà des trois premiers) se monte au repos (`settled`, à l'arrivée puis au
premier moment calme), plus sur une minuterie qui tombait en plein vol. La mise en pause de la
bannière d'accueil est différée (`useDeferredValue`) : rendue dans la même tâche, elle alourdissait le
départ du trajet.

**Rien n'est attendu, rien n'est téléchargé pour animer.** Si le visuel de la fiche n'est pas encore
chargé, la vignette touchée vole pleine, le visuel tenu éteint par son propre fondu (`bdFade`) — et
s'il est décodé en plein vol, il paraît sur l'affiche en fondu pendant le trajet, fini à 70 %. À
l'arrivée, si le visuel de la fiche n'est pas *entièrement* chargé, ce que la fenêtre montrait reste
posé sur la bannière (`data-sheet-standin`) jusqu'à lui, puis s'efface en 300 ms : la garde suit
l'image présente (une adresse qui change, un visuel monté plus tard) et ne la rend jamais opaque avant
son chargement — un grand visuel de série rendu opaque trop tôt se peignait par bandes sur une
bannière noire, au premier lancement (Louis, iPhone, 10/10/2026). La fiche garde aussi le visuel
qu'elle avait à l'ouverture (`CinemaMobileDetail`). Pour que ce relais soit rare : la bannière
d'accueil du téléphone garde décodés les visuels de **tous** ses titres dès que sa liste est connue
(`keepSheetBanners`), suspendue hors de l'écran (un film) et en économie de données ; et le visuel
d'une carte part dès que le doigt s'y pose (`data-sheet-backdrop`, `prefetchSheetBannerNow`). Les
cartes de « Reprendre » et du Top 10 sont servies au relâchement du doigt (`useTap`). Tests :
`sheetMorph-hook.test.tsx`, `prefetchBanners.test.ts`, `CinemaMobileHero-prefetch.test.tsx`,
`resume-row-tap.test.tsx`.

**Les minuteurs du mouvement.** Tous passent par `sheetTimeout` / `sheetFrame` (`dom.ts`) :
annulables un par un ou ensemble (`cancelSheetSchedules`), muets sans `window`. Un rappel tombé
après la fin d'une page de test (l'affiche qui retrouvait sa transition deux images plus tard)
faisait échouer la vérification complète sous charge.

La colonne (logo, infos, Lire, synopsis) arrive d'un seul bloc à 90 % du trajet : 160 ms, 8 px de
montée. Ce qui est derrière la fiche s'assombrit avec le trajet.

**Le rythme.** Celui d'UIKit : un ressort amorti critique, sans rebond.

| | Réponse |
|---|---|
| Ouverture | 0,22 s pour un trajet nul → 0,34 s pour la diagonale de l'écran, selon la distance rapportée à l'écran |
| Bureau (pointeur fin) | ×0,8 |
| Fermeture | ×0,7 |

La durée réelle est le temps de se poser à un demi-pixel près : ~400 ms pour une affiche à
mi-écran au téléphone, ~280 ms pour la fermeture. Une fermeture lancée au doigt part à la vitesse
du doigt ; une fermeture qui coupe une ouverture, à la vitesse de celle-ci.

**Les trois façons de se fermer, et quand.**

| Cas | Fermeture |
|---|---|
| L'affiche d'origine est encore visible à moitié au moins | retour vers elle |
| Elle n'est plus à l'écran (rangée défilée, fiche du dessous défilée) | la fiche descend de 48 px en s'effaçant (220 ms) |
| Ce que la fiche découvre n'est pas dessiné (`useSheetBehind` sans `useRouteBehind`) | l'échange d'un coup, comme avant |

La croix, le bouton Retour, Échap et le glissement vers le bas font la même fermeture.

**Rien ne vole quand :**
- la fiche est montée par un retour (`arrivedByBack`) ;
- elle est ouverte sans appui récent (un lien, un rechargement, une adresse écrite) ;
- « Réduire les animations » est demandé : un fondu de 200 ms, rien qui se déplace.

**Pourquoi.** Mis au point en neuf passes sur la page « Tests animations » (lot H), d'après un
iPhone et un Mac. Ce que chaque passe a corrigé est resté dans la forme du code :
- **le compositeur seulement** : la découpe animée (`clip-path`) passait par le fil principal, « un peu
  moins fluide que le reste de l'iPhone » sans qu'on sache dire où. La fenêtre est translatée et
  étirée, son contenu contre-étiré, en images clés échantillonnées une fois (≥ 60) ;
- **le contenu à 90 %** : à 60 %, il se posait pendant que l'image volait encore ;
- **l'affiche sans transition d'opacité** : la règle de base des boutons la faisait remonter en
  150 ms sous la fenêtre qui s'efface, un clignotement plus foncé à la fin de chaque fermeture.

**La fermeture rend l'adresse aussitôt.** Au premier instant d'une fermeture, la fiche est copiée
dans le calque du trajet, son défilement compris. C'est la copie qui s'efface pendant que l'image
revole ; la vraie fiche se cache et rend l'adresse. Au téléphone, la copie est *légère*
(`cloneVisible`) : un bloc entièrement hors de l'écran (la liste des épisodes, les titres
similaires) n'y est qu'un vide de la même hauteur. Copier toute la fiche coûtait une longue image au
départ du retour sur l'iPhone, « un effet laggy alors que ça ne lag pas » (Louis, 8.31.4). Retenue le temps
de l'animation, l'adresse gardait le titre : une affiche touchée pendant le retour empilait une
entrée que la fermeture différée défaisait ensuite. Ainsi, l'accueil répond dès que la fermeture
commence :
- une autre affiche touchée s'ouvre tout de suite, le retour en vol s'efface en 80 ms ;
- l'affiche qui revient, retouchée, retourne la fermeture en ouverture d'où elle en est.

Le `click` qui suit une fermeture au doigt est avalé : la fiche n'ayant déjà plus de pointeur, il
tombait sur l'affiche dessous.

**D'où part une fiche.** Une fiche s'ouvre par l'adresse et se monte un tour plus tard, sans savoir
ce qui l'a ouverte. Le dernier appui est donc noté une fois pour toutes, à la capture
(`src/lib/sheetMorph/source.ts`) :
- un doigt relâché sans avoir glissé ;
- un clic ;
- Entrée.

Il compte seulement sur un élément qui porte une image, et la fiche qui se monte dans la seconde le
reprend. Toutes les rangées, grilles, résultats, rangées de saga et filmographies en profitent
sans rien porter. Au retour, une carte redessinée entre-temps est retrouvée par l'adresse de son
image.

**Le calque.** Le trajet et l'assombrissement vivent dans un calque inséré juste avant la fiche
dans `body`, au même plan. La colonne de la fiche passe donc au-dessus de l'image qui vole, et la
fiche du dessous d'une cascade passe dessous. Au bureau, le fond de la fiche est transparent pendant
le trajet. Au téléphone aussi : la fiche est transparente et immobile, et la **fenêtre est la carte
entière** (voir plus haut) — son encre est dans la fenêtre, sous le visuel. **Fermée pendant l'aller**,
la carte part de la pose peinte à cet instant (le temps du trajet lu sur son animation, `currentTime`,
plus le doigt s'il l'a tirée), avec les opacités peintes du visuel et de l'affiche.

Ce que les portages précédents en avaient fait :
- 8.31.0 : la fiche entière montait, l'image *sous* elle — « le reste de la fiche vient du bas et se
  colle » ;
- 8.31.3 : la fiche entière collée au bas de l'image — « ça arrive sèchement en un bloc » ;
- 8.32.2–8.32.8 : le fond de la carte montait à part sous l'image, le contenu porté par lui
  (`cardRiseTrack`, `contentRideTrack`), la bannière logée dedans (`slotRide`) — l'image plongeait
  avant de remonter, et la carte redescendait plus vite que le doigt (audit du 10/10/2026).
La carte entière qui grandit est une seule pièce : il n'y a plus rien à coller.

**Ce que la fiche marque dans son DOM** :
- `data-sheet-photo` : son visuel ;
- `data-sheet-veil` : ses voiles, copiés dans la fenêtre — posés à leur place, ils assombrissaient
  l'accueil hors de la fenêtre ;
- `data-sheet-content` : la colonne ;
- `data-sheet-settle` : le flou localisé du bureau, posé une fois arrivé ;
- `data-sheet-glass` : le verre de la croix, coupé pendant le mouvement.

L'accueil du bureau porte `data-sheet-home`.

**Ce qui diffère exprès.**
- **Téléphone / iPad** : la carte entière qui grandit d'un côté, le visuel plein écran et l'accueil
  qui recule de l'autre ; la fermeture au doigt moins vive qu'au bureau (`closeResponse` : 0,85 fois
  l'ouverture, au moins 0,26 s, jamais plus lente que l'ouverture) et posée à un pixel près.
- **La fiche TMDB** n'a son visuel qu'avec la réponse du serveur. Sans elle au montage, elle entre
  comme avant, et seule sa fermeture revole vers l'affiche.
- **La fiche personne** garde sa montée simple : il n'y a pas d'affiche à faire devenir une bannière.
- **Le banc** garde sa scène simulée, l'ancien moteur (`clip`) et les durées fixes pour comparer,
  mais joue les mêmes fonctions (`src/lib/sheetMorph/motion.ts`, `dom.ts`).

**Porteurs.**
- `src/lib/sheetMorph/motion.ts` : le ressort, les poses, les images clés.
- `src/lib/sheetMorph/dom.ts` : les lectures et écritures groupées, `posterStyle`,
  `swallowStrayClick`, `visibleFraction`.
- `src/lib/sheetMorph/source.ts` : le geste, la source, sa visibilité au retour.
- `useSheetMorph` (`src/lib/sheetMorph/useSheetMorph.ts`).

Ses appelants : `CinemaMobileDetail`, `CinemaMovieDetail`, `CinemaSeriesDetail`,
`PlayerDiscoverSheet`. Le lot H de `IntroLots.tsx` importe le moteur.

**Tests.** `sheetMorph-motion.test.ts`, `sheetMorph-source.test.tsx`, `sheetMorph-hook.test.tsx`,
`sheetMorph-desktop-sheets.test.tsx`, `cinema-mobile-detail-keys.test.tsx`, `sheet-exit.test.tsx`
et `decisions-partagees.test.ts` (un seul crochet, aucune sortie CSS propre).

**Décidé le 10/10/2026.**

**Ce qui ralentissait encore l'ouverture au téléphone (10/10/2026, soir).** Mesuré sur la prod
(Chromium, iPhone 13, processeur ×4, `scratchpad/ui/latency.mjs`) : entre l'appui et la fiche
montée, une tâche de 80 à 220 ms, puis une seconde jusqu'à 270 ms pendant le trajet. Trois causes,
trois règles :
- **Le Top 10 s'ouvre au relâchement du doigt** (`useTap` dans `CinemaTop10Card`), comme les autres
  affiches : au `click`, iOS retenait le premier appui après un défilement de la rangée.
- **Le bas de la fiche attend que l'ouverture soit posée** (`belowFold` dans `CinemaMobileDetail`,
  depuis `settled` de `useSheetMorph`) : saga, titres similaires, épisodes au-delà des trois premiers. Montés dans la même image
  que l'appui, ils étaient mis en page par la mesure de départ du trajet. Sans trajet (retour, lien,
  mouvement réduit), tout est là d'emblée.
- **Le travail d'arrière-plan attend l'interface au repos** (`src/lib/uiQuiet.ts`, 1,5 s sans geste) :
  l'enregistrement des ouvertures sur l'appareil (`recordTitle`, `useResumeCache`), qui lit l'en-tête
  et l'index Matroska d'un tenant, et le réchauffage du catalogue des séries. La plus longue tâche
  pendant l'ouverture d'une fiche du Top 10 était cette lecture, pas la fiche.

**La fermeture au doigt part de la carte où le doigt l'a mise, à sa vitesse** — une seule pièce
depuis l'audit du 10/10/2026 ; l'élan porté à part (`fingerCarry`) qui le précédait est retiré.
Tests : `sheetMorph-motion.test.ts`, `uiQuiet.test.ts`, `resumeCache-uiQuiet.test.ts`,
`top10-card-tap.test.tsx`, `cinema-mobile-detail-belowfold.test.tsx`.

## 62. Un AAC à PCE : relu, réécrit sans perte quand il le peut, décodé dans le bon ordre sinon

**Règle.** Une piste AAC dont la disposition est un PCE (`channelConfiguration` à 0) passe par une
seule décision, `aacPlan` :
1. **Réécrite et copiée sans perte** quand le PCE décrit exactement une configuration standard —
   mêmes éléments, dans le même ordre, étiquettes canoniques. Seule la configuration change ; les
   trames sont copiées, et ce qui suit le PCE (l'extension 0x2b7) est recopié bit pour bit.
2. **Copiée telle quelle** sur un navigateur qui a prouvé prendre un PCE dans MediaSource : un vrai
   envoi (segment d'initialisation + trame silencieuse), une fois, la réponse gardée par navigateur.
   Mesuré : Chromium refuse, Firefox et WebKitGTK acceptent ; Safari est demandé à son premier PCE.
3. **Décodée puis ré-encodée** sinon, ses canaux rangés dans l'ordre standard : tous, quand l'ordre
   de sortie du décodeur pour cette forme de PCE a été **mesuré** (`MEASURED_DECODED_ORDERS`), par la
   matrice de `standardMatrix` (ITU-R BS.775 : un centre arrière dans les deux ambiances à −3 dB,
   une paire arrière repliée dans les ambiances) ; sinon L R C, la règle de toute disposition
   inconnue.

**Pourquoi.** « Elle s'appelle Ruby » (Fire TV, 10/10/2026) : Chromium dit oui à `mp4a.40.2` et
refuse l'initialisation qui porte un PCE. Le premier correctif décodait et ne gardait que L R C. La
mesure a montré mieux : le PCE de Ruby est octet pour octet celui que l'encodeur de FFmpeg écrit
pour un **5.1** passé par un PCE (`-aac_pce 1`), le « mono de côté » y porte le caisson (canal 4 de
Ruby entièrement sous 200 Hz), et FFmpeg, l'AudioDecoder de Chromium, de Firefox et de WebKitGTK le
rendent tous en L R C LFE Ls Rs. Ruby se livre donc en 5.1 entier.

Le 11/10/2026, la seconde forme de la bibliothèque — `MP/-/PP/1`, les pistes anglaises 7.1 de six
films (Forrest Gump, Deadpool, Walter Mitty, Once Upon a Time in Hollywood, Rocketman, Toy Story),
jusque-là en L R C hors Safari — a été mesurée de la même façon : notre FFmpeg wasm la rend en 7.1
FFmpeg (masque `0x63f`, l'ordre du TrueHD et du DTS 7.1), à 0,05 dB d'`ffmpeg astats` canal par
canal sur les six films, caisson au quatrième rang, tonalités marquées à leur rang. Elle entre dans
`MEASURED_DECODED_ORDERS` en 8 canaux et suit ensuite le chemin de tout 7.1 décodé (repli 5.1 de
`fold` avant l'AAC d'Apple ou de Chrome). `aac-regress-bench` : 38 pistes sur 38 identiques avant et
après, Safari et Chromium ; Safari continue de copier ces pistes telles quelles.

**Côté lecteur serveur.** Jellyfin copie un AAC déclaré lisible quelles que soient les conditions de
profil sur le codec (mesuré : l'esds rendue portait encore le PCE d'origine) ; seul un plafond de
canaux sous la source l'en empêche. Pour un AAC multicanal sans disposition nommée, le profil
plafonne à 5 (`reencodeAudio: "surround"`) : Jellyfin ré-encode par `libfdk_aac -ac 6` (son journal
FFmpeg) et sort un 5.1 en configuration standard (`11 b0`). La stéréo reste le dernier recours de
l'échelle (`forceAudioTranscode`).

**Ce qui diffère exprès.**
- **Safari ne décode pas Ruby dans l'ordre mesuré :** AudioToolbox n'a jamais été mesuré pour un
  PCE (`decodedOrderMeasuredHere`). S'il refuse le PCE à la sonde, il garde L R C ; s'il l'accepte,
  il copie, tous canaux.
- **La première ouverture d'un PCE sur un navigateur sans réponse** prend le chemin sûr (décodé) ; la
  question part en tâche de fond, jamais sur le chemin de l'ouverture.
- **Une forme de PCE jamais mesurée** n'est pas devinée : L R C. Mesurer une nouvelle forme, c'est
  l'ajouter à `MEASURED_DECODED_ORDERS` avec sa preuve (le banc ci-dessous).

**Porteurs.** `aacPlan`, `parseAacConfig`, `standardConfigOf`, `rewriteToStandard`, `standardMatrix`,
`remapPlanes`, `decodedOrderMeasuredHere` (`src/lib/webcodecs/aacConfig.ts`) ; la sonde
`pceCopyAccepted` / `primePceProbe` / `probePceCopy` (`src/lib/webcodecs/aacPceProbe.ts`). Lus par
`trackAacPlan`, `naturalDelivery`, `deliveredAudio` et la description de piste (`remuxer.ts`),
`transcodableAudio` (`audioTranscode.ts`), `aacShaping` (`softwareAudio.ts`). Serveur :
`buildDeviceProfile` (`reencodeAudio`) et `audioNeedsReencode` (`src/lib/deviceProfile.ts`), route
`playback/start`.

**Tests.** `webcodecs-aacConfig.test.ts`, `aacPceProbe.test.ts`, `deviceProfile.test.ts`,
`jellyfin-playback-start-route.test.ts`. Banc : `aac-pce-bench.spec.ts` (réécriture vérifiée par
ffmpeg, segments de la sonde à envoyer à un vrai MediaSource).

**Décidé le 10/10/2026.**

**Révisé le 11/10/2026 — hors Chromium, la sonde ne décide plus rien.** Sous 8.34.0, la sonde avait
gardé `ok:false` pour tout Safari sur l'iPhone de Louis : Ruby s'y décodait (CoreAudio échoue sur
son PCE — « InternalAudioDecoderCocoa decoding failed » — d'où le lecteur serveur) et la piste
anglaise 7.1 de Forrest Gump sortait en L R C, là où tout AAC se copiait avant le 10/10. Une réponse
par navigateur était fausse : l'acceptation dépend de la forme du PCE (CoreAudio décode le 7.1 de
FFmpeg, pas son 5.1), et la sonde n'en essaie qu'une. Désormais (`effectivePceAnswer(asc)`) :
- **WebKit, Firefox, tout moteur hors Chromium** : copie telle quelle d'abord, toujours — le
  comportement d'avant le 10/10. Un refus constaté à l'envoi avant la première image est gardé pour
  CETTE forme (octets de l'AudioSpecificConfig) et ce build (`cine-aac-pce-refus:v1`), la
  reconstruction décode une fois, le lecteur serveur vient ensuite.
- **Chromium** : inchangé (réponse de la sonde, réécriture, décodage).
- L'ancienne clé `cine-aac-pce-mse:v1` n'est plus lue et s'efface ; la sonde écrit `:v2`.
- La ligne `start` porte `aacPcePlan`, `aacPceAnswer` et, après un refus, `aacPceFallback`.

Preuve (banc `aac-regress-bench.spec.ts`, 20 films, 43 pistes, code d'avant le 10/10 contre ce
code) : moteur Safari iPhone, **43/43 octet pour octet** ; moteur Chromium, 35/43 — seules diffèrent
les 8 pistes à PCE (Ruby ×2, pistes anglaises 7.1 de Forrest Gump, Deadpool, Walter Mitty, Once
Upon a Time in Hollywood, Rocketman, Toy Story). Tests : `aacPce-engine-default.test.ts`.

**Révisé le 11/10/2026 (bis) — décodé, un PCE passe par FFmpeg en WebAssembly hors Chromium.**
Sous 8.34.2, l'iPhone de Louis : la copie de Ruby refusée par MediaSource (« Le navigateur a refusé
une opération sur le tampon… », pendant le choix du chemin, `path: "non décidé"`), et l'AudioDecoder
de Safari en échec sur ce PCE la veille — aucun chemin natif, le lecteur serveur à chaque fois. Deux
corrections :
- **Le refus pendant l'ouverture reconstruit aussi.** Il arrivait au `.catch` de l'ouverture, jamais
  au `onError` du pipeline : `takePceCopyRefusal` y est maintenant lu (`ExperimentalPlayerHost`).
- **Le décodeur.** Hors Chromium, un AAC à PCE décodé l'est par le décodeur AAC natif de FFmpeg
  compilé en WebAssembly (`aac/aacWasmAudio.ts`, module `aac/aac-wasm.mjs`, construit à l'identique
  par `tools/aac-wasm/build.sh`, 913 Ko — 386 compressés —, chargé seulement par une telle piste).
  Il lit le PCE, et son ordre de sortie est celui qui a été mesuré : Ruby sort en 5.1 entier
  (`aacShaping(…, ffmpegDecoder)`), puis la chaîne ré-encode comme pour le TrueHD (ordre AAC
  d'Apple sur AudioToolbox). Sur Chromium, l'AudioDecoder du navigateur reste (prouvé, mesuré) ; le
  décodeur WebAssembly n'y sert que s'il refuse la piste. `decodedOrderMeasuredHere` dit donc oui
  partout : AudioToolbox ne décode plus jamais un PCE. L'échelle hors Chromium : copie → (refusée)
  décodage WebAssembly → lecteur serveur.
- La ligne `start` porte `aacRoute` (`wasm-decode` / `browser-decode`) en plus du plan.

Preuves : banc `aac-wasm-bench.spec.ts` — Ruby décodé par le module contre `ffmpeg -af astats`,
mêmes 10 s, à 10:00 et 20:00 (piste française) et 50:00 (piste anglaise) : écart au plus 0,03 dB
sur les six canaux, le caisson au 4ᵉ rang, une quarantaine de fois le temps réel dans Node. Banc
`aac-regress-bench.spec.ts` (22 films, 44 pistes, code d'avant le 10/10 contre ce code) : moteur
Safari iPhone **44/44 octet pour octet** — rien ne change tant que la copie est acceptée, Forrest
Gump compris ; moteur Chromium 36/44, les 8 pistes à PCE seules différant, comme depuis le 10/10.
Tests : `aacWasm-route.test.ts`, `ExperimentalPlayerHost.test.tsx` (« un AAC à PCE refusé pendant
l'ouverture »).

**Révisé le 11/10/2026 (ter) — chasse aux défauts, les garde-fous du refus.** Quatre défauts prouvés
par des tests qui échouaient, corrigés sans qu'aucune piste ne change (`aac-regress-bench`, 19 films,
38 pistes, contre 8.36.3 : 38/38 octet pour octet sur WebKit comme sur Chromium) :
- **Pas de boucle.** Un stockage qui refusait d'écrire le refus faisait recopier et refuser sans fin
  (13 ouvertures au lieu de 2) : le refus est aussi gardé dans la mémoire de la page
  (`refusedHere`), et l'hôte ne reconstruit qu'une fois pour ce motif par chaîne (`pceRebuildRef`,
  remis à faux par la première image).
- **Le refus par forme prime partout**, Chromium compris, sur la réponse globale de la sonde.
- **Une piste à PCE choisie au menu et refusée est essayée décodée**, au lieu de rétablir la piste
  d'avant : « avant la première image » se lit par pipeline (`pipelineShowedPicture`) — mais
  seulement à l'ouverture du film ou après un changement de piste (`pendingSwitchRef`) ; l'échec
  d'une reconstruction de récupération (arrière-plan, source perdue) n'est pas un refus du PCE, sans
  quoi une piste que ce navigateur copiait serait décodée pour toujours.
- **Seul un refus d'envoi compte** (`isPceRefusalMessage` : élément en erreur code 4, `MediaSource
  closed`, envoi refusé) — jamais un échec de décodage (code 3, l'image), un délai ni le réseau.
Tests : `aacPce-refusal-guards.test.tsx`.

## 63. Une image qui échoue réessaie, au lieu d'abandonner jusqu'au redémarrage

**Règle.** Toute image du cinéma qui échoue montre son repli (carré gris, titre écrit, fond uni) et
réessaie : à ~2 s, ~6 s, ~15 s (±20 %), puis plus rien jusqu'au retour du réseau (`online`) ou de
l'appli (`visibilitychange`), où toutes les images en échec réessaient aussitôt et leur échelle
repart. Au plus six essais à la fois, les images à l'écran d'abord ; rien hors ligne ; pendant un
film en plein écran, seulement les images du lecteur. Revenue, l'image remplace son repli en fondu.
Un essai redemande la même adresse (une erreur n'est pas gardée en cache, et la clé de cache des
chargements réussis ne change pas). Avant (relevé le 10/10/2026, itinérance) : un échec passager
laissait affiches grises, logos en texte et bannières sombres jusqu'au redémarrage.

**Une seule fonction.** Le registre `src/lib/imageRetry.ts` et le hook `useImageRetry`
(`src/lib/useImageRetry.ts`) — deux façons de réessayer : `element` (l'élément reste, remonté par
`retryKey`, son repli dessous) et `probe` (le repli remplace l'élément, l'adresse est rechargée hors
du document, l'élément revient une fois l'image en cache).

**Appelants.** `PosterImage` (element) ; `CinemaLogo` (probe — le repli passe par sa prop
`fallback`, que `CinemaHero`, `CinemaSeriesHero`, `CinemaMovieDetail`, `CinemaSeriesDetail` et
`CinemaMobileDetail` lui donnent au lieu de démonter le logo) ; la bannière de `CinemaMobileDetail`
(probe — revenue, elle reparaît par le fondu de la doublure de `useSheetMorph`) ; les couches de
`HeroBackdrop` (element) ; `TitleLogo` (probe) ; le logo de `PlaybackIntro` (probe, `player`).

**Volontairement à part.** `ImagePicker` (les captures d'un signalement : une image locale, pas un
réseau) et les vignettes de la barre de lecture (leur propre préchargement).

**Avec.** Une image servie par le cache du navigateur paraît sans fondu (`imageReveal.ts`,
`servedFromCache` : `deliveryType` ou un transfert nul) — après un redémarrage, une grille relue du
disque refaisait tous ses fondus comme si tout se rechargeait. Et l'affiche d'une série sans affiche
TMDB dans la langue vient de Jellyfin redimensionnée (`jellyfinPoster` via `libraryPoster`, `kind=poster`) plutôt que de
l'original de TheTVDB, servi sans consigne de cache.

Tests : `imageRetry.test.ts`, `imageRetry-components.test.tsx`, `jellyfin-image-etag.test.ts`.

**Révisé le 11/10/2026 — chasse aux défauts.** Un essai sans réponse au bout de 20 s
(`RETRY_TIMEOUT_MS`) compte comme un échec et rend sa place : une affiche hors de l'écran remontée en
`lazy` ne chargeait rien, ni succès ni échec, et six d'entre elles bloquaient pour toujours les essais
des images visibles. **L'affiche d'un titre est la même partout** : `cataloguePoster`
(`src/lib/images.ts`) sert le catalogue films et séries, « Ma liste », « Vus » et `posterPrewarm` —
« Vus » montrait l'affiche d'origine au lieu de celle de la langue (38 films sur 40), « Ma liste »
l'original TheTVDB des séries, et le préchauffage préparait des affiches que l'interface ne montrait
pas. `decisions-partagees.test.ts` interdit `libraryPoster`/`jellyfinPoster` dans ces appelants. Et
les visuels de la bannière gardés décodés (`keepSheetBanners`) sont rendus quand la bannière revient
après un film avec d'autres titres — jusqu'à ~37 Mo de plus sur iPhone à chaque film.
Tests : `bughunt-zone4-imageRetry-slots.test.ts`, `bughunt-zone4-prefetchBanners-leak.test.ts`,
`posterPrewarm.test.ts`.

## 64. Le Chromecast : une télécommande, pas un lecteur — et la reprise gardée même quand la page se tait

**Règle.** Sur Chrome et Edge (ordinateur, Android), le lecteur natif propose un bouton Chromecast à
côté d'AirPlay, marqué « bêta » — à tous les comptes par défaut depuis le 11/10/2026 (8.36.2), aux
seuls administrateurs quand l'installation le referme (`CHROMECAST_FOR_EVERYONE=false`). Ouvert avant
tout essai sur un vrai récepteur, faute d'appareil : un échec rend le film à l'appareil, en pause, et
le journal en garde le code ; la mention « bêta » part quand le journal montre des diffusions réussies. Le récepteur choisi dans la liste de Chrome, la main passe comme pour
AirPlay (`fallToStable("diffusion demandée", { …, cast: true, castTarget: "chromecast" })`) : un choix,
pas un échec, donc un retour possible. Le relais est pris par `ChromecastPlayer`, qui ne lit rien : le
récepteur va chercher lui-même le flux que Jellyfin prépare, à l'adresse signée du serveur (`castUrl`,
laissez-passer de six heures, `castToken.ts`), et la page en est la télécommande — lecture/pause,
saut, volume, pistes, « Reprendre sur cet appareil ».

**Le flux.** Négocié avec son propre profil (`buildChromecastProfile`, `castTarget: "chromecast"` sur
`/api/jellyfin/playback/start`) : H.264 jusqu'au niveau 4.2, 8 bits, SDR, 1080p ; AAC, AC-3, E-AC3
copiés ; DTS, TrueHD, FLAC ré-encodés ; sous-titres texte servis à côté en WebVTT, en images
incrustés. Prudent exprès : la page ne sait rien du modèle du téléviseur, et un écran noir est pire
qu'un transcodage. Le profil d'AirPlay ne change pas (un test le fige), ni son refus des sous-titres en
images. Le récepteur lit depuis le domaine de Google : la route du flux et celle des sous-titres
répondent en CORS (`castCors.ts`, `*` sans identifiants) **seulement** à une requête munie d'un
laissez-passer valable, question préalable `OPTIONS` comprise (`castPreflightFor`, laissée passer par
le proxy). Une lecture dans la page garde ses en-têtes d'avant.

**Les pistes.** Une piste son relance le flux à la même position (nouvelle négociation, comme
AirPlay) ; un sous-titre texte s'allume sur le récepteur sans relance (`editTracksInfo`) ; un sous-titre
en images relance, incrusté.

**La reprise.** Rapportée à Jellyfin depuis la page avec le temps du récepteur (`usePlaybackSession`,
comme les autres lecteurs). Et quand la page se tait — iPhone verrouillé, onglet fermé, ordinateur en
veille — **le serveur prend le relais**, pour le Chromecast comme pour AirPlay (`castProgress.ts`) :
chaque segment HLS servi à un laissez-passer porte sa position (`runtimeTicks`, écrit par Jellyfin),
dont on retranche 30 s d'avance de tampon du récepteur (sous-estimer fait revoir quelques secondes,
surestimer ferait sauter de la scène). Le serveur ne rapporte que si la page n'a rien rapporté pour ce
titre et ce compte depuis une minute (`notePageReport`, appelé par `playing`/`progress`/`stop`), au plus
toutes les 30 s, par `saveAsAdmin` (le filet du jeton refusé, mêmes seuils) ; 90 s sans segment, page
muette : l'arrêt à la dernière position, que Jellyfin traduit en « vu » au-delà de son seuil. État en
mémoire borné (500 entrées), purgé. Jamais sans laissez-passer — le lecteur natif et le lecteur
serveur dans la page ne passent pas par là. Le laissez-passer porte pour cela l'identifiant Jellyfin
du compte (`j`, un identifiant, pas un droit) ; un laissez-passer d'avant n'en a pas, et le serveur se
tait.

**L'application du récepteur.** Le récepteur public de Google (`CC1AD845`) par défaut, gratuit et
sans inscription ; une installation qui enregistre son propre récepteur dans la console Google Cast
met son identifiant dans `CAST_RECEIVER_APP_ID` (réglage de l'application → `.env` → défaut, §48). Pas
un secret. Une valeur mal formée retombe sur celui de Google.

**Une seule fonction par décision.** `chromecastSenderEligible` (qui peut émettre), `useChromecastAllowed`
+ `/api/player/cast` (qui voit le bouton), `startChromecastSender` (le kit, chargé une fois, à la
demande — `framework.ts`), `chromecastNow` (l'aiguillage de `PlayerHost`), `buildChromecastProfile`,
`chromecastMediaSpec` (la demande de chargement), `withCastCors`/`castPreflightResponse`, `CastProgressRelay`.

**Le journal.** Les lignes du Chromecast sont celles du lecteur serveur pour AirPlay (`start`, `cast`,
`fallback` de fin de diffusion, `error`, `stop`), marquées `target: "chromecast"` (absent des lignes
d'AirPlay), avec `device` (le nom du récepteur) et, sur un refus de chargement, `code` (le code Cast).
Le relais du serveur écrit une ligne `cast` `serverRelay: true` quand il prend la main et une à
l'arrêt ; sans identifiant de séance, la page Activité les rattache à la dernière séance du compte et
du titre (« reprise gardée par le serveur »), et nomme le Chromecast d'une séance diffusée vers lui.

**Volontairement à part.** Le bouton n'existe ni sur iPhone (Google ne fournit pas Cast aux pages web
sur iOS), ni sur Safari, Firefox ou la Fire TV ; ni sur le lecteur serveur (un fichier que le natif ne
porte pas : y revenir à la fin de la diffusion rejouerait l'échec, `stepBack` vidant `handedOver`).
Le bouton de diffusion du navigateur (Remote Playback) se tait derrière celui du Chromecast. Un
récepteur à nous — logo, intro, détection du modèle pour annoncer HEVC/HDR, rapport de position par le
récepteur lui-même — reste à faire : seul son identifiant est prévu.

**Ce qui ne se prouve qu'avec un appareil.** Que le récepteur de Google lise le HLS fMP4 de Jellyfin
annoncé ainsi, le volume et les pistes sur un vrai téléviseur, l'avance réelle de son tampon (la marge
de 30 s), et le comportement de Chrome sur Android installé en application.

Tests : `chromecast-profile.test.ts`, `chromecast-playback-start-route.test.ts`, `chromecast-cors.test.ts`,
`chromecast-config.test.ts`, `chromecast-framework.test.ts`, `chromecast-media.test.ts`,
`chromecast-wiring.test.ts`, `ChromecastPlayer.test.tsx`, `PlayerControls-chromecast.test.tsx`,
`PlayerHost-chromecast.test.tsx`, la section « le Chromecast » d'`ExperimentalPlayerHost.test.tsx`,
`castProgress.test.ts`, `castProgress-page-reports.test.ts` ; le kit simulé : `helpers/fakeCast.ts`.

**Révisé le 11/10/2026 — ouvert à tous, et le relais réservé aux téléviseurs.** Le bouton est ouvert
à tous les comptes par défaut (8.36.2), marqué « bêta » sur l'écran de diffusion et dans son
libellé, faute d'essai sur un vrai récepteur ; `CHROMECAST_FOR_EVERYONE=false` le referme aux
administrateurs. Le relais de reprise avait trois défauts, prouvés et corrigés en 8.36.3 avant
d'avoir écrit une seule ligne : le lecteur serveur **de la page** charge aussi l'adresse signée
(`castUrl`), donc toute séance serveur passait par le relais et recevait CORS — relais et CORS ne
valent plus que pour une requête **sans cookie de session**, ce qu'est toujours un téléviseur ; une
page en pause ne bat qu'une fois toutes les 60 à 70 s, et la fraîcheur de 60 s la faisait passer pour
muette — portée à 150 s (`PAGE_FRESH_MS`) ; une page revenue lire en local voyait son arrêt écrasé
90 s plus tard par la vieille position du téléviseur — l'entrée relayée est oubliée dès que la page
reparle. Le CSP n'ouvre de `www.gstatic.com` que les chemins du kit (`CAST_KIT_SOURCES`,
`next.config.js` : `cv/js/sender/`, `cast/sdk/libs/sender/`, `eureka/clank/`).
Tests : `bughunt-zone1-castProgress.test.ts`, `bughunt-zone5-relay.test.ts`.

## 65. Le lecteur : clic à la souris, épisode suivant, récap et bon générique

**Le clic sur l'image.** À la souris, un clic sur une zone vide met en pause ou relance (le même
`togglePlay` que la barre d'espace, icône optimiste comprise) et montre les commandes ; un double-clic
passe en plein écran. Au doigt et au stylet, rien ne change : afficher/masquer. Décidé par l'appui
lui-même (`pointerType` du `click`, sinon du dernier `pointerdown`), jamais par l'appareil : un PC
Windows à écran tactile reçoit les deux, et chacun garde son geste ; un iPad répond au doigt comme un
téléphone et à son trackpad comme un ordinateur. Une media query (`hover`, `pointer: fine`) décrit
l'appareil et se trompe sur ces deux cas. Le simple clic bascule aussitôt — le retarder pour attendre
un éventuel second clic se sentirait à chaque pause ; c'est le double-clic qui paie, par un arrêt
d'un quart de seconde entre ses deux clics (ce que fait YouTube). Un clic qui referme un menu ne
touche pas à la lecture. Quand la souris quitte la fenêtre pendant la lecture, les commandes partent
aussitôt — sauf menu ouvert, glisser en cours ou focus clavier dans les commandes.

**L'épisode suivant à tout moment.** Un bouton dans la pilule des réglages, pendant un épisode qui a
une suite, par le même `onAdvance` que la carte du générique (le stop rapporté est `next`, à la
position courante) ; absent quand la minuterie de veille arrête la série à la fin de l'épisode.

**Le récap.** Les segments `Recap` de Jellyfin (~20 % des épisodes ici) donnent « Passer le récap »,
le même bouton que « Passer l'intro » : `activeSkip` choisit lequel montrer, et, s'ils se
chevauchent, celui qui finit le plus tard.

**Le bon générique.** Deux greffons écrivent des segments (Intro Skipper, Chapter Segments
Provider) : doublons, et faux « Outro » en milieu d'épisode. On prenait le premier « Outro » passé la
première minute — la carte « Épisode suivant » venait 2 min 30 trop tôt sur « Shōgun » S01E06, à
3 min sur « Mentalist ». Désormais : segments trop courts et génériques de la première minute
écartés d'abord, puis passages d'un même type fusionnés (chevauchement ou écart de moins de 20 s :
doublons et morceaux d'un même générique), puis le générique qui se termine le plus tard ; l'intro
et le récap gardent leur premier passage. Mesuré sur 628 épisodes : 8 changent de générique, aucun ne
change de début d'intro.

**Une seule fonction.** `timestampsFromSegments` (`src/lib/clients/jellyfin.ts`) et `playerMarkers` (`src/lib/episodeMarkers.ts`),
lus par les routes `direct/[itemId]` (lecteur natif) et `playback/start` (lecteur serveur), qui
recopiaient chacune la conversion ; `activeSkip`, `surfaceAction`, `isEmptySurface`,
`keyboardFocusWithin` (`src/lib/playerSkip.ts`), lus par `PlayerControls`, commun aux deux hôtes.

**Volontairement à part.** Un élément qui n'est pas l'image le déclare (`data-player-surface-ignore` :
l'écran « vous êtes toujours là ? ») ; boutons, curseurs, menus et cartes ne sont jamais la surface.

Tests : `playerSkip.test.ts`, `player-surface-click.test.tsx`, `jellyfin-mediaSegments.test.ts`.

**Révisé le 11/10/2026 — chasse aux défauts.** Les pilules (`.player-pill`) et les groupes de
commandes (`[data-player-navgroup]`) ne sont plus la surface, marges comprises, ni la barre du bas, la
carte « Épisode suivant » et la pastille de minuterie (`data-player-surface-ignore`) : un clic qui
manquait un bouton du haut mettait en pause, un double-clic sur le titre ou la carte passait en plein
écran. Une sortie de la fenêtre par la barre de progression ne rappelle plus les commandes pour 5 s
(`windowExitHides`, partagé avec le `pointerout` de la fenêtre). Le lecteur ne sélectionne plus rien
(`select-none` sur sa racine, les champs de saisie exceptés ; le second appui d'un double-clic sur
l'image est retenu) : le double-clic du plein écran surlignait le titre et le logo — et un logo n'est
plus glissable (`CinemaLogo`, `draggable={false}`, fiches comprises).
Tests : `bughunt-zone3-player.test.tsx`.

## 66. L'Opus copié tel quel là où le navigateur le prend — jamais sur WebKit

**Règle.** Une piste Opus part telle quelle (entrée MP4 `Opus`, boîte `dOps`) quand le navigateur
répond oui à `audio/mp4; codecs="opus"` et qu'il n'est pas WebKit. Ailleurs, rien ne change : un Opus
mono ou stéréo est décodé puis ré-encodé en AAC, un Opus multicanal part au lecteur serveur.

**Pourquoi.** Avant (le 11/10/2026), un Opus n'était jamais copié : seconde génération avec perte et
calcul sur l'appareil pour le stéréo, lecteur serveur pour le 3.0 — alors que Chrome, Edge, Firefox
et Android prennent l'Opus dans MediaSource. Ici, 190 fichiers (JoJo, saisons 1 à 5) : 152 avec deux
Opus stéréo (japonais, anglais) et une AAC française, 38 avec un Opus 3.0 japonais et une AAC
française. La piste d'ouverture ne change pour personne qui regarde en français : la langue passe
avant tout (§3).

**Ce qui est écrit.** Tout ce qu'un lecteur compare vient du fichier : le `dOps` est l'`OpusHead` que
Matroska garde (ou que `mp4Demux` reconstruit d'un `dOps`), réécrit en big-endian sans « OpusHead » ni
version Ogg (`dOps`, déjà écrit pour l'Opus ré-encodé de Firefox) ; le nombre de canaux de l'entrée
est celui de l'en-tête, pas celui de l'en-tête Matroska ; la fréquence est 48 000, celle que la
boîte exige. Un en-tête illisible (`isOpusHead`) garde le chemin d'avant. Les horodatages des blocs
sont copiés tels quels, comme pour toute piste copiée : le `CodecDelay` de Matroska (le pre-skip,
312 échantillons, 6,5 ms) n'est pas retranché, et le navigateur jette le pre-skip que le `dOps`
déclare — au plus 6,5 ms, très en deçà du seuil de synchronisation.

**Volontairement à part : WebKit.** Safari refusait l'Opus dans MediaSource au recensement du
21/09/2026, et aucun appareil Apple n'a été mesuré sur un Opus copié. WebKitGTK (Playwright, Linux,
moteur GStreamer) l'accepte et le lit — ce n'est pas CoreMedia : un iPhone garde son chemin d'avant
tant que personne ne l'a prouvé sur un vrai appareil. C'est une précaution de moteur
(`opusCopyConsidered`), pas une capacité devinée.

**Preuves.** `aac-regress-bench` (19 films de la liste habituelle + JoJo S01E01 et S05E01, 40
pistes) contre 8.37.0 : moteur WebKit 40/40 octet pour octet ; moteur Chromium 37/40, les trois
pistes Opus seules différant (copiées au lieu d'échouer). La copie décodée par ffmpeg contre la
source aux mêmes secondes : identique à l'échantillon près, écart nul, en stéréo (début et 10:00)
et en 3.0. Chromium et Firefox (Playwright 1.63) : init et segments acceptés par MediaSource,
lecture qui avance, stéréo, 3.0 et départ à 10:00.

**Reste à entendre.** La synchronisation sur un Chrome de bureau et l'ordre des canaux du 3.0 (le
décodeur Opus du navigateur lit lui-même la table de canaux du fichier — rien n'est permuté ici).

**Une seule fonction.** `audioCodecString` / `opusCopyConsidered` (`remuxer.ts`) pour la décision,
lue par `naturalDelivery`, `deliveredAudio`, `plannedMimeTypes` et l'unification par fichier ;
`audioSampleEntryFor` / `isOpusHead` / `dOps` (`mp4SampleEntries.ts`) pour l'entrée.
Tests : `webcodecs-remuxer.test.ts` (« l'Opus copié tel quel »), `webcodecs-mp4SampleEntries.test.ts`
(« une piste Opus copiée »).

## 67. Les reprises du lecteur : une tentative doit changer quelque chose — registre en observation, aucun codec banni

**Règle.** Une reprise automatique (reconstruction du lecteur natif, marche de l'échelle du son du
lecteur serveur, récupération d'hls.js) qui rejoue une tentative déjà échouée — même motif, même
configuration, sans que le film ait joué entre-temps — est inutile. Le registre des tentatives de la
séance (`RetryLedger`, `src/lib/retryLedger.ts`) le dit : une signature (motif + configuration : piste
et position arrondie à dix secondes pour le natif ; codecs exclus, transcodage forcé et position pour
le serveur), `noteFailure`, `notePosition` (trois secondes jouées en continu effacent les échecs —
ni `loadeddata` ni la première image, qui arrivent justement avant l'échec qui se répète), `mayRetry`.

**En observation seulement (étape 2 du plan du 11/10/2026).** Rien ne décide encore d'après lui : les
hôtes notent, le bilan `stop` des deux lecteurs porte `identicalRetries` et `retryMotif` (absents
quand rien ne s'est répété : le budget de champs du journal n'est pas entamé), la trace du natif
écrit « tentative identique n°k », et la page Activité affiche « n reprises identiques ». L'activation
viendra chemin par chemin quand le journal aura dit si la signature est assez fine.

**Pourquoi.** L'inventaire du 11/10/2026 : neuf compteurs, quatre notions de « ça remarche », et trois
chemins sans borne propre, prouvés par des tests qui échouent (`it.fails`, à basculer à l'activation) :
l'échelle du son du serveur, remise à zéro par `loadeddata` (un flux qui se charge puis échoue au même
endroit la remonte sans fin) ; la récupération d'hls.js, dont les compteurs sont remis à zéro par
chaque fragment ; la reconstruction du natif « sur la piste voulue, autre que celle ouverte », hors
budget — près de 2 900 pipelines en 300 tours quand le pipeline rouvre toujours sur une autre piste.

**Aucun codec banni (décision du 11/10/2026).** L'échelle retenait pour toujours, par navigateur
(`cine:audio-codec-blocklist:v1`), les codecs qu'une marche réussie avait exclus — quelle que soit la
cause de l'échec : une coupure ou une image illisible suffisait à faire convertir l'E-AC3 par le
serveur sur cet appareil, à jamais. Désormais chaque séance repart de la marche 0. Ce qu'une marche a
appris vaut pour l'ouverture en cours (`learnedExclusions` : un changement de piste ou l'épisode
suivant ne rejouent pas l'échelle), et traverse le rechargement de page du changement de piste sur
WebKit (`fromReload`, `sessionStorage`, lu par cette seule ouverture rechargée), qui continue la même
séance. L'ancienne clé est effacée une fois par page (`purgeLegacyAudioBlocklist`).

**Porteurs.** `RetryLedger`, `retrySignature`, `positionBucket`, `retryMotif` (`retryLedger.ts`),
tenu par `SessionTally.retries` (`playerSessionTally.ts`, le décompte partagé des deux lecteurs) ; lu
par `restart` (`ExperimentalPlayerHost`, reconstructions automatiques seulement), l'écouteur
d'erreur et les erreurs hls.js de `PlayerHost`. `learnedExclusions`, `purgeLegacyAudioBlocklist`
(`PlayerHost`).

**Volontairement à part.** La coupure réseau (attente sans fin, voulue et visible) ; les gestes du
spectateur (réessayer, piste, plafond HDR) ; `mseSource` et `playbackGuard`, déjà bornés ; le
rechargement WebKit en fin d'échelle, borné par `reloadAttempt`.

Tests : `retryLedger.test.ts`, `PlayerHost-echelle.test.tsx` (caractérisation de l'échelle, aucune
exclusion retenue, boucle (a)1), `PlayerHost-hls-recovery.test.tsx` (caractérisation d'hls.js,
boucle (a)2), `ExperimentalPlayerHost.test.tsx` (boucle (a)3).

## 68. « Améliorer les dialogues » : dans la chaîne audio, sur les canaux livrés — bêta, tous les comptes

**Règle.** Le traitement des voix vit dans le ré-encodage du lecteur natif, entre le repli des
canaux (`fold`) et la permutation de l'encodeur d'Apple (`toCodecChannelOrder`), là où les plans sont
dans l'ordre standard. Il garde les canaux que la chaîne a choisis : un 5.1 reste un 5.1, la stéréo
reste stéréo. Il sépare la **voix** (le centre d'un 3.0, d'un 5.1 ou d'un 7.1 ; le milieu d'une
stéréo ; le canal d'un mono) du **fond** (tout le reste), et **la voix ne dépend jamais du fond** :
- voix : égalisation (coupe-bas 150 Hz, corps 1 kHz, présence 3 kHz), gain fixe, un niveleur qui ne
  fait que remonter une voix faible (piloté par la voix seule, jamais un silence), une compression
  haute pour les cris ;
- fond : gain fixe modéré (caisson davantage), retrait pendant la parole piloté par un détecteur de
  parole sur le canal des voix (énergie 300–3400 Hz contre pleine bande, 40 ms / 450 ms), plafond
  relatif à la voix pendant la parole, compresseur du fond seul — sans rattrapage, rien n'est remonté ;
- deux limiteurs sous −1 dBFS, la voix et le fond.
Toute autre disposition reçoit la compression du fond seule, liée. Deux forces, nommées comme sur l'Apple TV : « Améliorer » (`on`) et
« Améliorer davantage » (`strong`). Activé, une piste copiée telle quelle passe par le ré-encodage si un décodeur d'ici rend
ses canaux dans l'ordre standard (`dialogueCanShape`) : Dolby, DTS, TrueHD et FLAC. Pour l'AAC :
mono, stéréo et 5.1 standard (configuration 6), ce dernier décodé partout par le décodeur AAC de FFmpeg
en WebAssembly (`measuredAacDecoder`), dont l'ordre est mesuré : L R C LFE Ls Rs sur un fichier où
chaque canal porte son niveau, et à 0,06 dB d'ffmpeg sur la VF de « Forrest Gump ». Pour l'Opus,
jusqu'à 3.0 partout, et le 5.1 sur Firefox seulement. Mesuré dans de vrais navigateurs
(`tools/channel-order-bench`) : Chromium 153 rend un Opus 5.1 **désordonné** (L Rs C R Ls LFE), et
Firefox 155 dans l'ordre standard ; un 3.0 sort L R C sur les deux, un AAC 5.1 dans l'ordre standard
sur les deux. Restent copiés : un AAC 7.1 (« 7.1 larges avant » non mesuré), un AAC à PCE (§62), un
Opus 5.1 sur Chromium et un MP3. Pour eux, le menu dit « Sans effet sur cette piste audio ».

**Désactivé, rien ne change, à l'octet près.** Aucun processeur n'est instancié, et `audioDelivery`
rend la décision d'avant (`fileAudioDelivery`). Prouvé avant le déploiement par
`aac-regress-bench.spec.ts` sur 43 pistes, en agent WebKit et Chromium, sorties identiques avant et
après ; et par les tests du transcodeur (l'encodeur reçoit les échantillons du décodeur tels quels).

**Pourquoi pas Web Audio.** La sonde 8.39.0 (`createMediaElementSource` sur l'élément) : sur iPhone,
contexte `running` et niveaux à −∞, sans aucune différence à l'oreille. WebKit ne fait pas passer le
son d'un élément nourri par ManagedMediaSource dans Web Audio. Le ré-encodage est le seul endroit où
le son passe entre nos mains sur tous les navigateurs. La sonde est retirée.

**v2 (12/10/2026) : la voix ne baisse plus avec les explosions.** La v1 avait un seul compresseur
lié sur tous les canaux et un rattrapage de +3/+9 dB. Entendu au casque : en « Améliorer
davantage », sur l'explosion d'« Interstellar » (2:08:50), le son global baissait, et la voix avec ;
sur « Tenet », « ça boost pas que les voix ». Mesuré sur la piste VF 5.1, pendant l'explosion, la
voix (centre, RMS) : original −12,2 dB ; v1 −20,4 / −23,5 dB ; v2 −12,9 / −12,4 dB. Écart voix moins
fond sur la bataille de « Tenet » (2:00:20) : original −5,8 ; v1 −1,0 / +2,4 ; v2 −2,4 / +5,0 — les
deux forces se distinguent (6 à 7 dB de fond en plus en « davantage », contre 3 en v1). Comparaison
directe à l'oreille (trois scènes, cinq versions, bascule au même instant) : v2 retenue.
Coût : environ 2,5 % du temps réel. Sur la bataille de « Tenet », le limiteur de la voix agit 44 %
du temps en « davantage » (1,1 dB en moyenne) : le centre y est déjà très fort.

**Réglages de la v1, mesurés, pas devinés.** Six scènes 5.1 réelles (« Interstellar », « Manchester by the
Sea ») et une stéréo (« Bref »). Mesures : niveau d'ensemble, 10e et 95e centiles du niveau par
fenêtre de 400 ms, centre contre faces. « Améliorer » : niveau moyen −0,6 dB, voix +4 dB. « Encore
plus fort » : −2 dB en moyenne, scènes calmes jusqu'à +11 dB, les plus fortes −10 à −19 dB, voix
+5,7 dB. Un premier détecteur de crête baissait tout de plus de 10 dB : les crêtes d'un film passent
12 à 15 dB au-dessus des voix. Coût : environ 1,4 % du temps réel pour un 5.1.

**Bascule.** Comme le plafond HDR : la reconstruction du lecteur à la même position, avec l'image
figée et la pause respectée. Une ouverture avec le traitement qui échoue avant sa première image
repart une fois sans lui (`dropDialogue`), jamais vers le lecteur serveur pour ça. Le réglage de
l'appareil n'est pas effacé.

**Porteurs.** `DialogueEnhancer`, `DIALOGUE_TUNING` (`dialogueEnhance.ts`) ; `AudioTranscoder.open`
(6e paramètre) et `encode` (`audioTranscode.ts`) ; `RemuxOptions.dialogue`, `audioDelivery`,
`dialogueCanShape` (`remuxer.ts`) ; `RemuxPlaybackOptions.dialogue`, `canShapeDialogue`
(`remuxPlayback.ts`) ; `readDialogueMode` / `writeDialogueMode` (`dialoguePreference.ts`, par
appareil, clé `cine-dialogue`) ; `ExperimentalPlayerHost` (`dropDialogue` ; administrateur seulement jusqu'à la v2) ;
le menu des pistes audio de `PlayerControls` (sous les pistes, comme l'Apple TV ; le bouton audio
apparaît alors même pour une piste seule), marqué « Bêta » : « Améliorer les dialogues », puis une
liste de trois choix (Désactivé, Améliorer, Améliorer davantage). La ligne `start` porte `dialogue` quand il est
actif, et rien sinon.

**Volontairement à part.** Le lecteur serveur (HLS de Jellyfin), où le son ne passe pas par nous. Les
pistes que le traitement ne prend pas, plutôt que de parier sur l'ordre de leurs canaux. La mention
« Bêta » reste tant que le journal n'a pas montré la v2 chez d'autres que l'administrateur.

Tests : `dialogueEnhance.test.ts`, `webcodecs-audioTranscode.test.ts`, `webcodecs-remuxer.test.ts`,
`aacWasm-route.test.ts`, `PlayerControls.test.tsx`, `ExperimentalPlayerHost.test.tsx` (« améliorer
les dialogues »). Mesure de l'ordre des canaux des navigateurs : `sh tools/channel-order-bench/run.sh`.

## 69. Générer des sous-titres : traduire en flux un sous-titre complet du titre, présenté ensuite à Jellyfin

**Règle.** Un sous-titre texte **complet** déjà présent dans le titre (piste du fichier ou fichier
voisin) est traduit vers une langue choisie par une IA en ligne — Anthropic, OpenAI ou Google, au
choix de l'administrateur —, pendant que le film joue, là où regarde le spectateur. Pas de
transcription de la piste son, pas de modèle local. Sans clé, la fonction n'existe pas : aucune route
ne l'annonce (`enabled: false`). La clé ne quitte jamais le serveur — ni dans une réponse, ni dans un
journal ; les réglages la montrent masquée (`secret`).

**La source.** Seulement des pistes texte ; jamais une image. Le drapeau « forcé » ne sert qu'à
l'ordre : un SDH complet peut être marqué forcé, un vrai forcé ne pas l'être, une piste peut n'avoir
aucune langue. Ce qui tranche est le **nombre de répliques** rapporté à la durée (`isFullTrack` :
au moins 50, et 2 par minute), mesuré une fois la piste lue. Ordre d'essai (`orderCandidates`) :
langue de l'audio d'origine, anglais, leurs SDH, autres langues, pistes sans langue, pistes marquées
forcées. La langue d'une piste sans étiquette est vérifiée par l'IA pendant la préparation ; si elle
est déjà la langue voulue, la tâche s'arrête (`exists`). Une langue déjà présente en complet n'est
pas proposée (409).

**Le préfixe stable et le cache.** Chaque requête d'une tâche commence par le même préfixe, octet
pour octet : consignes, glossaire (une fois établi), puis le **texte source complet**, une ligne
`id|texte` par réplique (saut de ligne interne écrit ` / `), sans minutages (`stablePrefix`,
`sourceBlock` ; le glossaire lit le même bloc). Le suffixe variable dit seulement les ~20 traductions
qui précèdent le lot (`Previous translations`, mêmes lignes `id|texte`) et les identifiants à traduire
(« Translate ids a to b. », ou leur liste si le lot est troué — `batchUser`).
Anthropic : point de cache explicite (`cache_control: ephemeral`, 5 min) sur le dernier bloc du
préfixe. OpenAI et Gemini : leur cache implicite des préfixes identiques, rien à poser. Le modèle voit
tout le film — qui parle, tu ou vous, les renvois — pour un coût moindre que des lots isolés. Le
glossaire, produit à la préparation, est **figé** dès qu'il existe : le changer casserait le préfixe.
Les requêtes d'une même tâche partent **en série** (un cache ne se relit qu'une fois la première
réponse commencée) ; la concurrence (3 requêtes) est entre tâches. Deux exceptions. Le **lot de saut**
(ci-dessous). Et le premier petit
lot part pendant la préparation du glossaire, pour afficher vite — la tâche quitte `busy` dès que ses
lignes source sont en base et son statut `running` ; les lots suivants attendent le glossaire
(`awaitingGlossary`). Jusqu'au 12/10/2026, elle restait `busy` pendant tout le glossaire, et
l'ordonnanceur la sautait : première ligne 18,5 s après le clic en prod, pour un lot de 8 qui prend
1,5-2,7 s avec le texte complet. Une pause de plus de 5 min fait
réécrire le cache : accepté, ni TTL d'une heure ni maintien en vie.

**Priorité aux spectateurs** (`nextBatch`). Un spectateur est actif s'il a sondé dans les 30
dernières secondes ; on traduit depuis sa position moins 10 s, à tour de rôle s'ils sont plusieurs,
tant qu'il a moins de cinq minutes d'avance ; puis devant eux jusqu'au bout, puis le début. Premier
lot de 8 répliques (et pour un spectateur qui attend), 40 ensuite. Un saut : la position la plus
récente fait foi, la requête en cours n'est pas annulée.

**Le lot de saut** (`settleSeek`, `seekLane` dans `engine.ts`, `seekBatch` dans `scheduler.ts` ;
décidé le 12/10/2026). Mesuré en prod (8.43.1) : un saut dans une zone non traduite était couvert en
**6,1 s**, parce que le lot de 40 déjà en cours devait finir avant que la zone du saut passe en tête.
Désormais, quand la position d'un spectateur actif saute vers une zone dont la réplique à
position − 10 s n'est ni faite ni en vol, un lot de **8 répliques** part tout de suite à cette
position, **en parallèle** du lot en cours — seule exception à « une requête à la fois par tâche »
avec le premier lot. Même préfixe stable (consignes, glossaire figé, texte source complet) : le cache
est déjà écrit à ce stade et se relit à 0,1× — qualité identique, ~0,0003 $. Glossaire pas encore
figé : même règle que le premier lot (il part sans). Flux, validation, détecteur de décalage, casse :
le même `translateIds`. Ses répliques sont marquées en vol ; le lot en cours n'est pas annulé, et le
lot ordinaire suivant repart de la position du spectateur, après elles. Bornes : **au plus un lot de
saut en vol par tâche** ; un saut pendant qu'il vole attend sa place (`seekPending`), et un saut plus
récent remplace celui qui attendait — pas de file. **Anti-rafale** : la position doit rester stable
**1 s** (`SEEK_SETTLE_MS`) ; chaque nouveau geste (écart de plus de 5 s, mesuré contre la lecture
*et* contre la pause, pour qu'un spectateur en pause ne passe pas pour un saut) relance l'attente —
des appuis sur +10 s répétés ou un défilement de la barre ne déclenchent qu'un lot, à la position
finale. Un saut vers une zone faite ou en vol ne déclenche rien. **Concurrence** : le lot de saut
compte dans `running` et peut porter le total à `MAX_CONCURRENT + 1`, jamais au-delà ; s'il n'a pas
cette place, il attend **en tête de file** (`pump` lance les lots de saut avant tout lot ordinaire).
Choisi plutôt que de passer devant seulement : attendre qu'une requête d'une autre tâche finisse
remettrait l'attente qu'on supprime. Coût compté comme tout lot (`bill`). Journal : `seek` (une ligne
par rafale, au-delà de 30 s ou quand un lot part) porte `fastLane`, `jumps`, `queued` ou `why`
(`done`, `inflight`, `busy`, `retry-wait`…) ; `seekFirst` porte `seekToFirstMs`, du dernier geste
reçu à la première réplique écrite dans la zone (provisoire en flux comprise), et `fastLane` dit si
c'est le lot de saut qui l'a écrite. Rien n'est retraduit : une ligne faite ou en
vol n'est jamais choisie, et l'écriture en base ne remplit que les lignes vides. Sans spectateur, la
tâche va au bout. Une tâche par (fichier, langue), partagée entre comptes.

**Les lots en lignes, pas en JSON** (`prompts.ts`, mesuré le 12/10/2026 sur Haiku 5.5 avec le texte
complet en préfixe, *A.I.*, 1 221 répliques). La réponse est uniquement `id|traduction`, une par
ligne, dans l'ordre, ` / ` pour un saut interne (reconverti en `\n`) ; sans schéma JSON. Le glossaire,
appel unique, reste en JSON structuré. Pourquoi : sur 6 lots de 40, le format
`{"translations":[{"i","text"}]}` en a rendu **2 décalés** — la traduction de la réplique N+1 rangée
sous l'identifiant N, dix lignes d'affilée, avec des identifiants parfaits, donc invisibles à la
validation d'alors ; le format lignes n'a jamais décalé. Il coûte ~25-35 % de jetons de sortie en
moins (≈ 24 contre ≈ 33 par réplique) et ~35 % d'entrée en moins pour la source (21 k contre 32 k
jetons pour ce film). En revanche 2 réponses sur 8 portaient une phrase du modèle (« Wait — I need
to be careful… ») en plus des 40 lignes justes : l'analyse **ignore toute ligne qui ne commence pas
par `<id>|`**, et la dernière occurrence d'un identifiant l'emporte (une réponse avait écrit une
ligne fausse, la remarque, puis repris le lot entier). Un tableau de chaînes sans identifiants a été
écarté : nombre de lignes faux dans les deux essais.

**En flux** (Anthropic, `messages.stream`). Chaque ligne `id|texte` complète et validable seule (id
demandé, non vide, pas trop de lignes) est écrite en base dès réception, **provisoire**
(`subtitle_gen_cues.provisional`) sous une révision nouvelle : le lecteur l'affiche sans attendre la
fin du lot, mais elle ne compte pas dans `done`. À la fin, la validation du lot entier : validé, les
lignes deviennent définitives (révision gardée si le texte est identique) ; refusé, les provisoires
sont effacées et le nouvel essai les réécrit sous une révision plus haute — le lecteur remplace par
rang `i` (§70), il garde la ligne refusée quelques secondes au plus. Une ligne provisoire trouvée au
redémarrage n'est pas faite : elle est retraduite. OpenAI et Gemini : même format lignes, sans flux —
les lignes sont écrites à la fin du lot.

**Validation stricte** (`validateBatch`) : mêmes identifiants, ni manquant (fusion), ni en trop, ni
doublon, texte non vide, au plus **max(2, lignes de la source)** lignes (de vieux SDH ont des
répliques de trois lignes, dont la traduction fidèle ne doit pas être refusée), pas resté dans la
langue source, **pas décalé** (`detectDrift`, sur les seules longueurs visibles — la casse n'y entre
pas) : (1) au moins 3 répliques dont la source fait ≥ 12 caractères avec un rapport de longueur
traduction/source > 2,2 ou < 0,35 ; ou (2) sur 5 répliques consécutives, des longueurs traduites qui
collent nettement mieux aux sources décalées de ±1 ou ±2 qu'aux leurs (gain moyen ≥ 0,5 en
|log(rapport / rapport médian du lot)|). Calibré sur les 12 lots réels du banc (fixtures
`drift-bench-2026-10-12.json`, longueurs seulement) : décalés 6 et 8 répliques hors bornes, gain 0,76
et 1,04 ; sains 2 au plus et 0,25 au plus. Sinon : un nouvel essai, puis le lot coupé en deux, puis la
ligne garde son texte d'origine (journalisée `kept`) ; chaque lot refusé écrit une ligne `retry` avec
sa cause (`drift`, `manquant`, `lignes`…). Un refus du modèle suit le même chemin, sans nouvel essai
(`refusal`) — pas de repli serveur pour Haiku 5.5.

**La casse de la source, par le code** (`matchSourceCase`, `textCase.ts`). Une réplique source « tout
en capitales » (plus de 80 % des lettres en majuscules, au moins 4 lettres) donne une traduction tout
en capitales, par `toLocaleUpperCase` de la langue cible (« ß » → « SS » en allemand, « i » → « İ »
en turc) ; crochets compris, balises laissées telles quelles. Une réplique en casse normale n'est
jamais touchée, et il n'y a pas de normalisation inverse : fidèle à la source. Mesuré le 12/10/2026
sur *La Quatrième Dimension* S00E01 (source SDH à 89 % en capitales) : Haiku n'avait recopié les
majuscules que sur 118 répliques sur 302, un mélange au gré des lots ; une consigne dans le prompt n'y
changeait rien.

**Résilience.** Lignes écrites dès réception (`subtitle_gen_cues`) ; au démarrage, chaque tâche en
cours vérifie le fichier (ETag et taille de la source Jellyfin, comme le cache de reprise) et la piste
source (empreinte de son texte) puis reprend ; un changement la rend **obsolète** (`stale`). Erreurs
passagères (429, 5xx, réseau) : nouvel essai à 2, 5, 15, 30 s, puis pause `unavailable`. Clé refusée
ou modèle inconnu : pause `config` de toutes les tâches. Crédit épuisé (« credit balance is too low »,
`insufficient_quota`) ou budget mensuel atteint : pause `budget`. Reprise par un nouveau POST
(`/resume`), qui ne passe pas outre un budget toujours atteint ni une clé absente.

**Limites.** 50 générations **lancées** par jour et par compte (`DAILY_LIMIT`, 30 au départ, portée à
50 le 12/10/2026) ; rejoindre, reprendre ou refaire une tâche ne compte pas. Budget mensuel global
(5 $ par défaut). Refus nommés : 429 `quota`, 402 `budget`, 409 `exists`, 422 `no-source`, 404
`disabled`.

**Le coût, exact.** Chaque réponse donne ses jetons par catégorie : entrée, écriture du cache,
lecture du cache, sortie (réflexion comprise). Table de prix par modèle (`pricing.ts`, relevés le
12/10/2026) : Haiku 5.5 0,10 / 0,50 $ par million, écriture ×1,25, lecture ×0,1 ; gpt-6-luna 0,10 /
0,50, lecture 0,01 ; gemini-3.8-flash 0,75 / 3,75 jusqu'au 31/12/2026 puis 1,50 / 7,50, lecture de
cache comptée au prix plein faute de tarif relevé. Un modèle inconnu sans prix saisi : la fonction ne
part pas (`priceFor` rend null) — aucun prix inventé.

**Fin de tâche : présenter le sous-titre à Jellyfin** (`present.ts`, décidé le 12/10/2026). Le
`.srt` (minutages d'origine) est écrit dans `data/subtitles/<itemId>/` — la source de vérité — puis
envoyé par `POST /Videos/{itemId}/Subtitles` (langue en ISO 639-2 terminologique, `fra`), qui le pose
à côté du film : la fonction ne dépend ni de Bazarr ni d'un montage de la bibliothèque. Un nom de
fichier déjà pris n'est jamais réutilisé (l'envoi écraserait un sous-titre qui n'est pas le nôtre).
Le nôtre se reconnaît : fichier absent avant l'envoi (liste gardée en base), dans le dossier de la
vidéo, au nom attendu, à la bonne langue (`isOurStream`). Envoi en échec : nouvel essai à 1 min,
5 min, 15 min, 1 h, puis abandon — la copie de `data/` est alors servie (`/api/subtitle-gen/files/…`).
Jellyfin qui tarde à lister le fichier : rafraîchissement demandé après 5 min, abandon après 45. Un
fichier vidéo remplacé ensuite : notre sous-titre n'est supprimé (`DELETE /Videos/{id}/Subtitles/{i}`)
que s'il est le nôtre **avec certitude** — chemin mémorisé et même texte relu chez Jellyfin ; sinon
rien, et le journal le dit (`cleanup`).

**Porteurs.** `src/lib/subtitleGen/` : `engine.ts` (ordonnancement, lots, pauses, fin, présentation,
reprise), `scheduler.ts`, `validate.ts`, `prompts.ts`, `source.ts`, `pricing.ts`, `present.ts`,
`store.ts` (tables créées par `migrate()`), `providers/` (interface `TranslationProvider` ;
Anthropic par le SDK officiel, OpenAI Responses et Gemini `generateContent` en `fetch`), `service.ts`
(le contrat des routes), `direct.ts` (ce que la route `direct` ajoute), `log.ts`
(`data/logs/subtitle-gen.log`, lu par le panneau Activité, jamais la clé ni le texte). Routes :
`/api/subtitle-gen/options`, `/jobs`, `/jobs/<id>/poll`, `/jobs/<id>/resume`, `/files/<id>.vtt`,
`/admin`, `/admin/jobs/<id>/cancel`. Réglages : groupe `subtitles` du schéma (§48) et
`SubtitleGenCard` dans « Réglages serveur ». Libellé de piste : `trackLabel.ts` (`isGenerated`,
`isGenerating` → « Français — généré », « Français — génération… »).

**Appelants.** Le lecteur natif (`/options` pour proposer, `/jobs` pour lancer, `/poll` toutes les
~2 s pour afficher les lignes et donner sa position) ; la route `/api/jellyfin/direct/[itemId]`, qui
marque `generated: true` le fichier voisin reconnu comme le nôtre et n'ajoute la copie de `data/` que
si l'envoi à Jellyfin a échoué pour de bon ; le panneau de la gestion (dépense, tâches, reprendre,
annuler).

**Proxy.** `POST /api/subtitle-gen/jobs` et `POST /api/subtitle-gen/jobs/<32 hex>/(poll|resume)`
sont ouverts aux comptes ordinaires ; `/api/subtitle-gen/admin*` et les réglages sont à
l'administrateur ; `crossSiteWrite` s'applique comme partout.

**Volontairement à part.** Pas de laissez-passer de diffusion sur la route `.vtt` : l'adresse ne
porte pas le titre que `castPassFor` lit dans le chemin ; un téléviseur reçoit le sous-titre par
Jellyfin une fois présenté. Les tâches en cours ne sont pas dans `externalSubtitles` : le lecteur
dessine lui-même son entrée « génération… » à partir de `/options` et `/poll`.

Tests : `subtitleGen-source.test.ts`, `subtitleGen-scheduler.test.ts`, `subtitleGen-validate.test.ts`
(format lignes, phrase parasite, ` / `, décalage sur les lots réels, casse),
`subtitleGen-pricing.test.ts`, `subtitleGen-engine.test.ts` (tâche complète, préfixe identique après
un saut, requêtes en série, lot de saut en parallèle sans doublon ni coût oublié, un seul lot de saut
à la fois et le dernier saut l'emporte, rafale de 5 sauts à 300 ms → un lot à la dernière position
1 s après, saut en zone faite ou en vol → rien, premier lot pendant le glossaire, lignes en flux puis validées, lot refusé
remplacé, casse, reprise après redémarrage, pauses 429/crédit/clé/budget, refus, quota,
présentation simulée, repli `data/`, suppression seulement du nôtre, clé jamais sortie),
`subtitleGen-routes.test.ts`, `subtitleGen-proxy.test.ts`, `trackLabel.test.ts`,
`jellyfin-direct-route.test.ts`.

**Ancrage de la demande et langues (12/10/2026).** Chaque demande de lot recopie le texte source de sa
première et de sa dernière réplique (`batchUser`, `anchor`), et la consigne interdit tout commentaire.
Mesuré sur 10 lots de 40 répliques (film *A.I.*) : consigne seule, 5 lots commentés (« les ids 305 à
344 n'existent pas… ») et 4 à refaire ; consigne renforcée, 2 et 2 ; renforcée et ancrée, 0 et 0. Les
langues cibles passent de 7 à 26 (`TARGET_LANGUAGES`) ; le chinois est le simplifié, `zho` ne
distinguant pas l'écriture. Le calque des sous-titres porte `dir="auto"` pour l'arabe et l'hébreu.

**Lots refaits et descriptions sonores (12/10/2026, deux films entiers).** Une réplique coupée en trois
lignes est recousue (`fitLines`) au lieu de refaire son lot de 40. Le détecteur de décalage compte les
lettres et pas les espaces (un SDH passé par l'OCR, « U n f in ish ed », gonflait la source). Deux
alertes de décalage dont les réponses ont la même forme (`sameShape`) sont acceptées : 30 lots sains
refaits sur *Kompromat*. La consigne disait « rends tel quel ce qui n'est qu'un son » : Haiku laissait
« Une branche craque. » en français ; elle fait désormais traduire les descriptions sonores écrites en
clair, et nomme la langue de la source (28 répliques laissées en français sur un lot, 3 ensuite).

## 70. « Générer des sous-titres » dans le lecteur natif : une entrée temporaire, des messages dits comme des sous-titres, une seule recherche de ligne

**Règle.** Le lecteur natif propose, sous les pistes du menu des sous-titres, « Générer des
sous-titres » quand `/api/subtitle-gen/options` dit `enabled` et qu'au moins une langue cible n'a ni
sous-titres (`existing`), ni génération en cours, ni piste générée dans la liste des externes. La
langue du compte d'abord, d'un geste ; les autres derrière « Autre langue… », nommées par
`Intl.DisplayNames` comme les pistes (`languageName`). Le choix crée la génération (avec la position)
et la sélectionne aussitôt.

- **Une entrée temporaire** par génération en cours, numérotée sous −1 000 000 (`isGeneratingTrack`) :
  ni une piste du fichier (positive) ni un fichier à côté (−1 − index Jellyfin), et négative donc
  jamais transmise au pipeline. Son étiquette passe par `labelSubtitleTracks` (`origin: "generating"`,
  « Français — génération… »), son avancement à part, en petit (`Track.detail` : « 42 % », ou
  « finalisation… » une fois finie mais pas encore présentée par Jellyfin).
- **Sondée seulement active**, toutes les 2 s (10 s en pause ou entre la fin et la présentation),
  **toujours avec la position voulue** (`intendedPosition`, la cible d'un saut comprise) et la séance ;
  pas quand la page est cachée (reprise immédiate au retour) ; tout de suite après un saut. `since`
  est la dernière révision reçue : un hôte neuf repart de 0, donc une entrée reprise après être sorti
  du film redemande tout.
- **Les lignes reçues sont tenues au-dessus des pipelines** (`SubtitleGeneration`, un objet par hôte),
  insérées triées par début, remplacées par rang (`GeneratedCues`) : une reconstruction ne perd rien.
- **Les messages d'état sont dessinés comme des sous-titres** — même place, même style, marqués
  `data-subtitle-notice` — et **seulement dans une zone pas encore traduite** : un instant est
  « fait » s'il est sur une ligne, ou entre deux lignes **consécutives** de la transcription (rangs
  `i` et `i + 1`), avant la ligne 0 ou après la dernière (`total − 1`). « Préparation des
  sous-titres… » (en préparation, ou rien reçu, ou la lecture a rattrapé la traduction), « Reprise de
  la génération des sous-titres… » (après un saut dans une zone pas faite, jusqu'à la première ligne),
  « Génération en pause — <raison> » (`budget`, `quota`, `network`, `config`, sinon « en attente »),
  reprise par le menu (`/resume`). Une vraie ligne qui couvre l'instant l'emporte toujours.
- **La bascule** : finie, la génération reste en entrée temporaire tant que `presented` est faux.
  Présentée — ou, à défaut, un `fileUrl` donné depuis une minute (le repli du serveur) —, la liste
  des externes est relue par un `fetch` nu de `/api/jellyfin/direct/<id>` (jamais la clé SWR du
  pipeline, qui le reconstruirait, ni la description gardée cinq minutes), au plus toutes les 30 s.
  Dès qu'elle contient l'entrée `generated: true` de la langue, la piste choisie devient cette entrée,
  **d'abord sur les lignes déjà en mémoire** (`ExternalSubtitleTrack.fromCues` : aucune seconde sans
  texte), puis sur le fichier de Jellyfin s'il arrive ; l'entrée temporaire disparaît.
- **Aucun échec ne touche la lecture.** 429 → « Limite de N générations par jour atteinte » (N lu dans
  `quota.limit`), 402 budget, 422 rien à transcrire, réseau, génération `failed` : un message passager
  (`showWarning`), comme un fichier externe introuvable. 409 reprend la génération existante. Un
  sondage sans réponse est rejoué à la même révision, sans rien dire. `/options` en échec : rien n'est
  proposé, rien n'est dit.
- **Une seule recherche de ligne** pour tout ce qui est tenu en mémoire : `cueTextAt`
  (`externalSubtitles.ts`), bissection non destructive et marche arrière de 32 lignes, utilisée par
  `ExternalSubtitleTrack` et par `GeneratedCues`.

**Porteurs.** `src/lib/subtitleGen/client.ts` (le contrat des routes, typé ; `SubtitleGenError`) ;
`generatedCues.ts` (`GeneratedCues`, `covers`) ; `generation.ts` (`SubtitleGeneration` : options,
demande, activation, sondage, messages, fin) ; `cueTextAt`, `ExternalSubtitleTrack.fromCues`
(`externalSubtitles.ts`) ; `labelSubtitleTracks` (`origin`, `trackLabel.ts`) ; `ExperimentalPlayerHost`
(`generationMenu`, `showGeneratedAt`, `noticeText`, `generationErrorText`, la bascule) ; le menu des
sous-titres de `PlayerControls` (`SubtitleGenerationMenu` ; le bouton des sous-titres apparaît alors
même pour un film sans aucune piste). Journal : lignes `subtitle-gen` (`demande`, `activation`,
`première-ligne` avec `ms`, `saut-non-traduit` avec `waitMs`, `pause`, `reprise`, `fin`, `bascule`
avec `via`, `erreur`, `échec`).

**Volontairement à part.** Le lecteur serveur, AirPlay et le Chromecast ne voient que le fichier
fini, qui arrive par la liste ordinaire des fichiers externes. Pas de génération proposée pendant un
banc d'essai. Seule la génération active est sondée : une autre, en cours en arrière-plan, garde
l'avancement lu à l'ouverture jusqu'à ce qu'on la choisisse.

Tests : `subtitleGen-client.test.ts`, `subtitleGen-generatedCues.test.ts`,
`subtitleGen-generation.test.ts`, `PlayerControls-subtitleGen.test.tsx`, `trackLabel.test.ts`
(« sous-titres générés »), `ExperimentalPlayerHost.test.tsx` (« générer des sous-titres »),
`decisions-partagees.test.ts` (« une seule recherche de ligne »).

## 71. Télécommande : une seule sélection — le focus — et rien qui la contredise

**Règle.** Dans le cinéma du bureau, ce qui est choisi est **l'élément qui a le focus du document**,
et rien d'autre. La grille aux flèches (`useTvGridNav`) n'a pas de sélection à elle : à chaque touche
elle relit `document.activeElement`, et quand elle bouge elle donne le vrai focus
(`focus({ preventScroll: true })`, puis son propre défilement). Un focus posé par quelqu'un d'autre —
la navigation spatiale de Silk sur Fire TV, la tabulation — est donc adopté sans rien faire : la
rangée, la colonne et la bannière (qui suit `onFocus`) en repartent. Trois choses pouvaient pourtant
contredire cette sélection, et ne le peuvent plus :

- **le défilement au bord** (`installEdgeScroll`, Fire TV) continuait sous un curseur immobile. En
  mode immersif de Silk, le curseur reste, invisible, là où on l'a laissé — au bord, puisque c'est
  ainsi qu'on fait défiler au curseur — et la rangée ou le panneau repartait sous chaque flèche :
  « je ne peux pas aller vers le haut », « au 3e film ça ne fonctionne plus », « si tu switches entre
  les 2 modes ça fonctionne » (Timothé, 11/10/2026). Toute touche, et tout focus déplacé sans appui
  du pointeur, l'arrêtent ; seul un mouvement vers une *autre* position le réarme ; un mouvement au
  centre exact de l'élément focalisé ne compte pas ; la boucle s'arrête au bout du défilement ;
- **le survol sans mouvement** : une carte qui glisse sous une souris immobile recevait
  `mouseenter` et prenait la bannière à celle qui avait le focus (au bureau aussi, souris posée sur
  les rangées pendant qu'on navigue au clavier). `onRealHover` / `hoverDesignates`
  (`pointerHover.ts`) : un survol désigne si la souris a bougé depuis moins de 150 ms, ou s'il arrive
  à une position encore jamais vue (les deux ordres `mouseenter` / `mousemove` sont couverts), ou si
  l'on ne sait rien du pointeur ;
- **le focus dans l'intitulé d'une rangée** (« Voir tout ») — là où la navigation spatiale de
  Chromium le pose en montant depuis les affiches — était lu comme « hors de la grille » : → et ↓
  renvoyaient à la première affiche de l'accueil, ↑ ne faisait rien. La rangée est adoptée : ↓ ← →
  vont à son affiche la plus proche en largeur, ↑ à la rangée du dessus, ou à la bannière.

**Ce qu'on sait de la navigation spatiale de Chromium** (mesuré le 12/10/2026, Chromium 15x lancé
avec `--enable-spatial-navigation`, page de reproduction sous Playwright) : la page reçoit la flèche
**d'abord**, et un `preventDefault` suffit à arrêter la navigation spatiale — aucun double pas ; sans
lui, elle déplace le focus vers un élément *visible* dans la direction et y pose un `mouseover` (pas
de `mousemove`) ; vers une affiche hors de l'écran, elle fait défiler la rangée par petits pas sans
déplacer le focus ; ↑ depuis une affiche va au « Voir tout » de sa rangée. Que Silk soit exactement
celle-là n'est pas établi : c'est ce que dit le relevé ci-dessous.

**Le relevé** (`installRemoteDiag`, `startup.log`, `kind: "télécommande"`) : un par mode de Silk
(`mode: "curseur" | "spatial"`), trois par onglet au plus, deux du même mode. Chaque touche porte
`before` / `after` (le focus avant et après, une affiche décrite par sa rangée et sa colonne, jamais
son titre) et `gridMoved` ; `focusMoves` liste les focus déplacés sans touche ni appui reçus par la
page ; `pointerAtFocus` compte les mouvements tombés au centre de l'élément focalisé ; `edgeScrolls`,
les départs du défilement au bord.

**Porteurs.** `useTvGridNav` (`tvGridMoveCount`, adoption de la rangée), `installEdgeScroll` et
`installRemoteDiag` (`fireTv.ts`), `onRealHover` / `hoverDesignates` / `trackPointer`
(`pointerHover.ts`, suivi posé par `RemoteControlSupport`).

**Appelants.** `CinemaCard`, `CinemaSeriesCard`, `CinemaTop10Card`, `CinemaDiscoveryRow`, la carte
de Reprendre de `CinemaClient` (`onMouseEnter={onRealHover(…)}`).

**Volontairement à part.** Le téléphone et l'iPad n'ont ni survol ni grille aux flèches : la carte
centrée au doigt (`useCentredCard`) pose le focus sans défiler et ne passe pas par ici. La bannière
(`HeroBannerControls`) garde ses propres flèches. La touche Retour n'est toujours pas traduite.

Tests : `firetv-spatial-nav.test.tsx` (la scène de Timothé rejouée : curseur laissé au bord, focus
déplacé sans touche, ← ×3 puis →, ↑ ; « Voir tout » ; survol immobile), `fireTv.test.ts` (relevé par
mode, bornes, focus avant / après), `remote-diag-route.test.ts`, `useTvGridNav.test.tsx`,
`decisions-partagees.test.ts` (« un survol ne désigne une affiche que si le pointeur a bougé »).

## 72. Sous-titres : une taille tirée de la hauteur et de la largeur, une ligne qui ne monte qu'au-dessus des commandes

**Règle.** La taille du texte est la plus petite de deux mesures affines, l'une de la hauteur de la
zone, l'autre de sa largeur, multipliées par le facteur choisi (`subtitleFontPx` en pixels,
`fontSize` en CSS) : à « Normale », le défaut, 37 px sur 1920×1080, 28 px sur 1366×768, 27,5 px sur un
iPad en paysage (1180×820), 17,5 px sur un téléphone en paysage (844×390), 14 px en portrait
(390×844). La ligne du bas repose à 6,5 % de la hauteur (jamais moins de 12 px), plus la zone sûre ;
quand les commandes sont affichées, elle monte juste au-dessus de la rangée du bas — de la hauteur que
`PlayerControls` mesure, pas d'une constante — par un `transform` seul (`.subtitle-lift`, 200 ms). Un
sous-titre placé en haut (`{\an8}`, `subtitlePlacement`) fait la même chose sous la rangée du haut.

**Pourquoi.** « Les sous-titres sont trop gros et trop hauts surtout, ils couvrent trop d'image »
(Louis, 12/10/2026). La taille suivait la largeur seule (`4 vw`) : 25 px sur un téléphone en paysage,
6,5 % de sa hauteur par ligne. Et le calque était à 96 px fixes du bas (`bottom-24`), commandes ou
non : un quart de la hauteur du même téléphone, 12 % d'un portable de 13 pouces. Mesuré sous Chromium
avec deux lignes, commandes cachées, la part de l'image sous la plus haute ligne passe de 42,5 % à
18,8 % sur le téléphone en paysage, de 25,4 % à 16,6 % sur 1366×768, de 18,1 % à 15,9 % sur
1920×1080. Les lecteurs de référence (Netflix, Apple TV) règlent leur taille sur la hauteur, en
proportion plus petite sur un petit écran — d'où la part fixe de chaque mesure — et posent la ligne
entre 6 et 8 % du bas.

**L'échelle centrée sur le modèle** (12/10/2026, « les réglages d'apparence doivent s'accorder sur ce
modèle-là »). Le modèle avait d'abord été calibré sur « Petite » (0,75), le défaut depuis le 23/09 où
l'ancienne « Normale » était jugée trop grosse : le défaut s'appelait « Petite » et « Normale » était
4/3 plus grosse que la référence. Les constantes de `SUBTITLE_FONT` ont été multipliées par 0,75 et le
défaut passé à 1 — le rendu par défaut n'a pas bougé d'un pixel (testé sur les cinq écrans) — et
l'échelle resserrée autour : Très petite 0,75, Petite 0,875, Normale 1, Grande 1,2, Très grande 1,45
(l'ancienne allait de 0,6 à 1,6 d'une base plus grosse : du simple au presque triple autour d'une
taille déjà lisible). Le stockage est versionné (`v: 2` dans `cine:subtitle-style`), puisque 0,75 et 1
existent dans les deux échelles avec des rendus différents ; une valeur non marquée — ou l'ancienne
clé `cine:subtitle-size` — est traduite une fois par `migrateV1Size` vers la taille au *rendu* le plus
proche (ancien v ⇒ v / 0,75 de la nouvelle base, valeur la plus proche numériquement) : 0,6 → 0,75,
0,75 → 1, 1 → 1,45 (1,33 est plus près de 1,45 que de 1,2), 1,3 et 1,6 → 1,45 ; puis réécrite marquée,
et jamais retraduite. Une préférence jamais choisie suit le défaut.

**La zone, pas l'image.** Le calque du lecteur natif est un conteneur de taille (`containerType:
"size"`) et se mesure en `cqh`/`cqw` : c'est l'écran du lecteur. La hauteur réellement occupée par
l'image (bandes noires d'un 2.39:1) n'est pas prise : l'agrandissement automatique (`frameFit`) la
rapproche déjà du bord, et une ligne posée dans la bande noire sous l'image est ce que font aussi les
lecteurs de référence.

**Porteurs.** `subtitleFontPx` / `fontSize` / `SUBTITLE_FONT`, `SUBTITLE_SIZES` /
`DEFAULT_SUBTITLE_STYLE` / `migrateV1Size` / `subtitleStyleStore`, `subtitleRowStyle` /
`subtitleOffsetPx` / `SUBTITLE_REST` / `SUBTITLE_LAYER_STYLE` (`subtitleStyle.ts`) ;
`onChromeEdges` (`PlayerControls`, `null` cachées ou démontées).

**Appelants.** `ExperimentalPlayerHost` (le calque), `cueCss` (via `PlayerControls`, pour les pistes
`<track>` du lecteur serveur).

**Volontairement à part.** `::cue` prend la même taille mais mesurée à la fenêtre (`vh`/`vw`) : il vit
dans l'arbre fantôme de l'élément vidéo, où rien ne le rattache à un conteneur, et le lecteur serveur
remplit la fenêtre. Sa *position* reste celle du navigateur : `::cue` n'accepte aucune propriété de
placement, et déplacer chaque cue (`line`) au gré des commandes réécrirait les pistes en direct pour
un lecteur de secours ; le navigateur la pose déjà près du bas. L'Apple TV, en AirPlay, dessine
elle-même. Le mini-lecteur n'affiche pas de sous-titres.

Tests : `subtitleStyle.test.ts` (cibles par écran, rendu par défaut identique à l'ancien défaut,
migration de chaque ancienne taille, valeur marquée jamais retraduite, hauteur ou largeur qui borne, proportions entre
tailles, plafond, repos à 6,5 %, montée au-dessus des commandes, placement en haut, même règle pour
`::cue` et le calque), `PlayerControls.test.tsx` (« ce que les commandes occupent » : bords mesurés,
`null` une fois cachées puis démontées ; « Normale » cochée par défaut dans « Apparence »).

## 73. Les Nouveautés : une page par version, un numéro vu par compte, une fenêtre au lancement

**Règle.** Chaque page de Nouveautés publiée reçoit un numéro d'ordre croissant (`seq`, à la
publication — pas l'identifiant : un brouillon commencé avant un autre peut sortir après lui) ; chaque
compte retient le dernier qu'il a vu (`news_state.seen_seq`). Il reste à voir les pages publiées au-delà.
La fenêtre s'ouvre au lancement, sur l'accueil du cinéma seul — jamais pendant un film (plein écran ou
réduit), jamais par-dessus une fiche (y compris ouverte par lien profond : elle attend le retour à
l'accueil), un panneau ou la grille complète, jamais avant ni par-dessus l'écran d'accueil d'un compte,
jamais sur l'assistant, la connexion ou la gestion —, après 1,2 s d'accueil seul à l'écran, une fois par
chargement. Le drapeau s'éteint **à l'affichage** (`POST /api/release-notes/seen`), quelle que soit la fermeture
ensuite. Deux pages ou plus de retard : empilées dans la même fenêtre, de la plus récente à la plus
ancienne, chacune sous sa version en intertitre. Un compte jamais croisé reçoit sa ligne à son premier
passage, réglée juste sous la dernière page : il voit celle-là, pas l'historique fusionné.

« Relancer » redescend le numéro sous la dernière page — pour un compte, ou pour tous —, jamais plus bas :
un compte en retard de deux pages le reste. Publier allume le drapeau de tous sans rien leur écrire,
puisque chaque numéro vu est forcément plus bas. Modifier une page publiée ne republie rien et ne
réarme personne.

**La page initiale vit dans le code.** « 8.44 » (texte validé par Louis le 12/10/2026, traduit une fois
en en/es/de dans `initialPage.ts`) est publiée par la migration (`seedInitialNews`, db.ts) : toute
installation l'a à son premier démarrage — l'image publique comprise, une installation neuve aussi —,
sans geste de l'administrateur et sans appel à un fournisseur d'IA. Un marqueur `migrations_done`
(`news-seed-8.44`), posé dans la même transaction, l'empêche de revenir : un redémarrage ne la recrée
pas, ne la republie pas, ne réarme personne, et une page modifiée ou supprimée par l'administrateur n'est
jamais réécrite. Aucun compte n'a de ligne à ce moment-là : le drapeau est donc allumé pour tous, existants
comme futurs.

**Le contenu.** Par langue : des sections (titre en petites capitales, entrées icône + titre en gras +
phrase courte, une pastille facultative), une phrase pour « Optimisations et corrections de bugs », et la
liste complète, par groupe. Le titre de la section Améliorations et de son entrée viennent du dictionnaire,
pas du contenu. Une phrase qui commence par une minuscule ou une ponctuation *continue* le titre sur la
même ligne (« **Le logo du titre dans le lecteur**, en bas à gauche. ») ; sinon elle passe dessous. Une
langue vide retombe sur le français (`contentFor`). Les icônes sont des noms à nous (`NEWS_ICONS`), traduits
en icônes lucide côté navigateur seulement : la base ne dépend pas du nom d'un composant.

**« Voir plus ›».** Dans la fenêtre, l'entrée des corrections ne montre que sa phrase ; « Voir plus » ferme
la fenêtre (`closedBy: "voir-plus"`) et ouvre Compte → Nouveautés (`#nouveautes=corrections:<id>`, la
page la plus récente) sur la liste complète. Compte → Nouveautés rouvre tout : la dernière page entière,
puis les précédentes, repliées (dépliée d'office si c'est elle que « Voir plus » vise).

**Mesures.** Au journal des ouvertures (`startup.log`, `kind: "nouveautés"`, avec compte, appareil,
`build` et `version` comme les autres lignes) : `event: "fenêtre"` (`noteIds`, `shownMs` — page visible
seulement, `VisibleStopwatch` —, `closedBy` `ok`|`echap`|`dehors`|`voir-plus`, `scrolled`, `auto` — faux
quand c'est une relance de l'administrateur), `event: "voir-plus"`, `event: "page"` (`shownMs`, `section`
la plus loin atteinte : `nouveautés`, `corrections`, `historique`). Le dernier affichage de chacun est aussi
gardé en base pour l'activité. `keepalive`, sans file : `unsentLines` est celle du journal du lecteur (sa
route, ses identifiants), une mesure perdue ne coûte qu'une ligne, et le drapeau est déjà éteint.
Limites par compte : 20 mesures et 10 « vu » par minute (`writeLimits`).

**L'activité.** `#activite=nouveautes` (et un résumé sur la vue d'ensemble) : par compte, la dernière
page vue, quand, combien de temps, fermée comment, défilée, « Voir plus », page consultée ; la synthèse de
la dernière page (vue par n/total, médiane du temps d'affichage, part « pas lue » sous 2 s, part « Voir
plus ») ; « Relancer pour tous » et par compte ; l'éditeur — saisie en français, « Traduire » (un seul
appel au fournisseur des sous-titres générés, mêmes réglages et même clé, sortie structurée qui ne contient
que les textes dans la forme du français : icônes recopiées, forme différente refusée ; coût ajouté à la
dépense du mois ; sans clé, saisie manuelle), chaque langue retouchable, aperçu, brouillon puis
« Publier ».

**Porteurs.** `shouldOfferNews` (decide.ts) — la décision, seule, pour le bureau et le téléphone ;
`newsDb` / `newsFor` (news/store.ts) ; `seedInitialNews` (db.ts) ; `sanitizeContent` / `contentFor` /
`continuesTitle` (news/content.ts) ; `VisibleStopwatch` / `sendNewsEvent` / `markNewsSeen` (news/events.ts) ;
`translateNews` / `rebuild` (news/translate.ts) ; `newsAccounts` / `newsSynthesis` (news/summary.ts) ;
`accountScreenOpen` (cinemaRoute.ts) — l'activité, les signalements et les Nouveautés, énumérés une fois
pour `coversGrid`, `heroOffscreen`, `activePanel` / `isOnPanel` et la bannière du téléphone.

**Appelants.** `NewsGate` (monté par `PlayerShell`, commun au bureau et au téléphone) → `NewsDialog` ;
`PlayerNewsPanel` (Compte → Nouveautés) ; `NewsContentView`, le même dessin pour les deux ;
`ActivityNews` et le panneau de `ActivityOverview`. Routes : `/api/release-notes`, `/api/release-notes/seen`,
`/api/release-notes/event` (ouvertes à tout compte, n'écrivent que pour l'appelant) ; `/api/admin/release-notes*`
(administrateur seul, lecture comprise : `ADMIN_ONLY_READS` et `adminOnly`).

**Volontairement à part.** La fenêtre n'a pas de flou d'arrière-plan : une grande surface (§45, flou
des grandes surfaces écarté le 26/09) — le reflet, le bord et la teinte du verre liquide sur un fond plus
franc (`.news-card`). Les touches sont prises en capture sur `window` et arrêtées là : la grille dessous
écoute aussi les flèches et « / ». Les titres masqués (§54) ne sont mentionnés nulle part : voulu par Louis.

Tests : `news-store-routes.test.ts` (base vide → page publiée et drapeau pour tous, second démarrage sans
effet, compte qui l'a vue pas réarmé, page supprimée jamais réécrite, fusion, compte neuf = dernière page,
relance un/tous, mesures au journal, synthèse, éditeur → traduction simulée → publication → drapeau rallumé,
langue vide → français, routes réservées), `news-proxy.test.ts`, `news-decide.test.ts` (chaque écran qui
empêche la fenêtre, chronomètre, continuation du titre), `NewsDialog.test.tsx` (fusion et intertitres, les
quatre fermetures et leur mesure, défilement, touches gardées, télécommande, aperçu muet, `NewsGate`, « Voir
plus » → la bonne section), `decisions-partagees.test.ts` (une seule décision, un seul montage).

## 74. Une fiche est une entrée de la pile : son identité est son cran d'ouverture, pas son titre

**Règle.** Rouvrir une fiche déjà présente dans la pile (la même personne depuis un de ses films, la
même série depuis la filmographie d'un de ses acteurs) **empile une nouvelle fiche** : une nouvelle
entrée d'historique, et une nouvelle instance React. Le retour retrouve l'ancienne telle qu'on l'avait
laissée. Chaque fiche porte le cran (la profondeur d'historique) où elle a été **ouverte**
(`SheetOrigins` : un cran par étage — titre de bibliothèque, personne, découverte), écrit dans
`history.state` par `cinemaNavigate` : une fiche nommée par un `push` est ouverte à ce cran ; sinon elle
hérite du cran de l'entrée d'où l'on part (une fiche de bibliothèque sous une personne ou une fiche TMDB
reste la même fiche, avec son défilement et ses titres similaires). Un `replace` qui la renomme à
l'identique ne l'ouvre pas. L'entrée recouverte (`SheetRef`, `useRouteBehind`) emporte ses crans.

Écarté : revenir à la fiche existante en dépilant ce qui est au-dessus. Le geste est une ouverture —
on touche une affiche, une carte monte — et le retour doit ramener au film d'où l'on a rouvert l'actrice,
pas sauter deux crans plus bas.

**Le défaut (iPhone, 8.45.0).** Série → actrice → un de ses films → la même actrice, fermée au doigt, puis
le film fermé : écran sombre, plus rien ne répond. La coquille rendait la fiche personne sous la clé
de l'acteur seul ; l'actrice du cran 2 (sous le film) et celle du cran 4 étaient donc une seule instance.
Le geste l'avait jetée hors de l'écran (`dismissed`, `translateY(hauteur)`, pointeurs coupés) ; elle
redevenait fiche du dessous avec cet état, puis fiche du dessus au cran 2 : invisible, transparente aux
pointeurs, au-dessus d'une série rendue inerte par sa présence et d'un accueil inerte. Même cause pour un
film absent de la bibliothèque (fiche découverte), et la même clé par titre seul existait pour les fiches
de bibliothèque (série → acteur → la même série).

**Et un état de geste ne contredit plus l'adresse.** `useSwipeToDismiss(…, { addressed: true })` : une
fiche jetée au doigt que l'adresse nomme encore une seconde plus tard (`ADDRESS_GRACE_MS`) — la fermeture
n'a pas eu lieu, par exemple refusée par `cinemaClose` parce qu'un retour était déjà en vol — revient en
place. Ce que l'adresse décrit est dessiné et touchable ; le voile d'une fiche n'existe qu'avec elle.

**Les fonctions.** `cinemaRoute.ts` : `nextOrigins` (le calcul, dans `cinemaNavigate`), `useSheetOrigins`,
`behindOrigins`, `behindIsSameTitleSheet` (l'entrée recouverte montre-t-elle *la même fiche* : même titre
**et** même cran), `personSheetKey` / `titleSheetKey` / `discoverSheetKey`. Une entrée sans crans (lien
direct, historique écrit avant) lit `UNKNOWN_ORIGIN` partout : mêmes clés qu'avant.

**Les appelants.** `PlayerShell` (fiche personne dessus ou dessous, fiche découverte), `CinemaMobileClient`
(pile du téléphone et sa garde « jamais derrière elle-même »), `CinemaClient` (piles films et séries du
bureau, même garde, même fonction). `useSwipeToDismiss` avec `addressed` : `PlayerPersonSheet`,
`PlayerDiscoverSheet`, `CinemaMobileDetail`, `useSheetGrip` (fiches du bureau au toucher). Les prototypes
d'animation (`IntroLots`) gardent l'ancien comportement : leur fermeture ne passe pas par l'adresse.

**Ce qui diffère à dessein.** Le téléphone dessine l'actrice du cran 2 sous le film ; le bureau ne la
dessine pas (sa sortie est un fondu). Rouvrir la même actrice au-dessus d'un film démonte l'instance du
cran 2 (un seul emplacement) : elle est remontée sous le film une fois l'actrice du cran 4 sortie.

**Tests.** `sheet-stack-reopen.test.tsx` (la vraie coquille, la vraie fiche personne, l'historique de
jsdom : la séquence signalée, par la croix, par une fiche découverte, la même actrice depuis deux films,
deux fermetures dans la même image, un retour du navigateur pendant la sortie — quatre échouaient avant),
`cinemaRoute.test.tsx` (`useSheetOrigins` : crans, même série rouverte, fiche TMDB posée sur un film,
`replace`, retour, entrée ancienne), `useSwipeToDismiss.test.tsx` (l'adresse l'emporte),
`sheet-stack-under-discover.test.ts` (les deux piles passent par `behindIsSameTitleSheet`).
