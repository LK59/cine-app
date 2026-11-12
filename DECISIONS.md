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

**Plus de lecteur serveur choisi par compte (13/10/2026).** La préférence « lecteur legacy »
(`legacyPlayer`, réglage de `/parametres`), qui envoyait toutes les lectures d'un compte au lecteur
serveur, a disparu : le natif est toujours le premier chemin. Aucun compte ne l'avait activée en
production ce jour-là. La colonne `user_preferences.legacy_player` reste en base sans être lue ni
écrite ; la route `direct` ne refuse plus personne pour elle ; `PUT /api/user/preferences` ignore
`legacyPlayer` (400, rien d'écrit). Le chargeur des préférences (`useAccountPreferencesLoader`,
ex-`useLegacyPlayer`) reste monté par `PlayerHost`, qui ne l'attend plus. Le repli automatique
(`PLAYER_SERVER_FALLBACK`) n'est pas touché.

**Tests.** `webcodecs-pathSelector.test.ts`, `ExperimentalPlayerHost.test.tsx` (« un fichier que
le chemin natif ne porte pas »), `lecteur-legacy-retire.test.ts`, `jellyfin-direct-route.test.ts`,
`misc-routes-batch2.test.ts`.

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
fiche film et la fiche série du bureau, la fiche du téléphone. Corrigé le 21/09 : les deux envoyaient
`tmdbId ?? 0`, la route répondait 400 et la fiche en affichait l'erreur brute, en français. La fiche
film du bureau s'en passait, « toujours munie d'un identifiant Radarr → TMDB » : faux depuis §89 — un
film que Jellyfin a seul et que TMDB ne connaît pas porte `tmdbId: 0` ; elle le demande aussi depuis
le 23/10/2026. Tests : `decisions-partagees.test.ts`, `fiche-film-a-voir-sans-tmdb.test.tsx`.

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

**Le départ du geste (06/11/2026).** Le « rebond d'iOS » des films du 06/11 était le relais de
l'ouverture (§61, « Saisie au doigt pendant l'ouverture ») : aucune garde de toucher n'est nécessaire, la
poignée a `touch-action: none` (celle posée en 10.13.23–10.13.25 a été retirée). Deux règles restent,
dans `useSwipeToDismiss`, donc pour toutes les fiches qui se tirent (bibliothèque, découverte, personne,
hors ligne, livre, poignée du bureau) :
- **le premier mouvement est retranché**, jusqu'à `FIRST_MOVE_SLOP_MAX_PX` (48 px) : WebKit n'envoie le
  premier `pointermove` qu'une fois sa tolérance passée (filmé : quatre images immobiles puis ~45 px
  d'un coup) ; la carte part du point où le geste est reconnu et suit le doigt pixel pour pixel —
  comme une vue défilante d'iOS. La décision au relâché compte le chemin entier du doigt, seuils
  inchangés ;
- **la carte suit le doigt sans React** (option `card`) : chaque `pointermove` posait l'état et toute
  la fiche se redessinait — la carte ne bougeait qu'une image sur deux. Le crochet écrit `transform` sur
  la carte ; `offset` ne change qu'à l'appui et au relâché ; au retour en place, le crochet écrit
  lui-même le zéro après le rendu qui a rétabli la transition (un `offset` resté à 0 ne se réécrirait
  pas). Ce qui suit la carte passe par `follow` : l'ombre des fiches du téléphone (`phoneSheetFollow`,
  sheetMotion.ts), le voile de la fiche personne. Le rayon ne grandit plus sous le doigt (il repeignait
  la carte à chaque image) : 16 px pendant le geste, celui du décalage final au relâché. À l'appui, le
  crochet annonce la saisie à la carte (`SHEET_GRAB_EVENT`, §61). Appelants : `CinemaMobileDetail`,
  `PlayerDiscoverSheet`, `OfflineTitleSheet`, `BookSheet`, `PlayerPersonSheet`, `useSheetGrip`
  (`DesktopSheetShell`) ; le banc d'animations garde l'ancien chemin (sans `card`).

**Tests.** `useSwipeToDismiss.test.tsx`, `sheet-exit.test.tsx`, `cinema-mobile-detail-keys.test.tsx`,
`decisions-partagees.test.ts`.

### 7.3 Le lecteur tient le clavier

**Règle.** Une fiche restée montée sous le lecteur n'écoute aucune touche tant que le film est en
plein écran.

**Porteur.** `playerHoldsKeyboard(playback)` (`src/lib/playerKeyboard.ts`). Appelants :
`CinemaMobileDetail`, `CinemaMovieDetail`, `CinemaSeriesDetail`, `CinemaEpisodeBrowser`, et
`gridIsTop` (`src/lib/cinemaGridTop.ts`) pour la grille du bureau — flèches, « / », carte centrée —,
et depuis le 15/10/2026 `PlayerPanelFrame` (Échap d'un panneau, par `usePlaybackMode`, qui vaut
« fermé » hors du fournisseur) : Échap pendant une scène lancée depuis la Recherche refermait la
Recherche sous le film.

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

**L'ordre du panneau Compte (13/10/2026).** Préférences (langue de l'application, langues de
lecture) ; Compte (mot de passe, appareils connectés) ; Notifications ; Interface (reprises dans la
bannière, défilement guidé) ; Aide ; Administration (Activité, Maintenance, Banc d'essai, Tests
animations, Ouvrir la gestion) ; puis « Se déconnecter » et la signature. **L'Aide est à plat** :
une seule liste de lignes de même dessin (`Row` — icône, titre, aide, geste à droite), sans section
ni carte dans la carte du groupe — Nouveautés, Revoir l'écran d'accueil, État des services, les
questions fréquentes dépliables, Vider le cache de l'appareil (venu de Compte), Signaler un problème,
Mes signalements.

**Tests.** `PlayerOnboarding.test.tsx`, `onboarding-db-routes.test.ts`,
`player-notification-choices.test.tsx`, `player-account-panel.test.tsx` (ordre, Aide à plat).

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

**Appelants.** `CinemaMovieDetail`, `CinemaSeriesDetail`, `CinemaMobileDetail`, et la fiche d'un lien de
partage, `ShareTitleSheet` (§112 — pas quand les lectures du lien sont prises). Lecteur natif :
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

**L'en-tête aussi (28/10/2026).** Après une seconde de fiche, le même titre fait lire l'en-tête et
l'index de son fichier (`scheduleSheetHeaderWarmup`, `src/lib/sheetHeaderWarmup.ts`), gardés là où
l'ouverture les cherche déjà — le cache d'en-têtes de `parseMatroska`, sous `mediaHeaderKey`, comme
l'épisode suivant (`warmNextEpisode`). Mesuré du 20 au 28/10 : un titre lu depuis le réseau bougeait
2,4 s après l'appui (médiane, 10,8 s au neuvième décile), contre 1,2 s depuis l'appareil, et
l'en-tête avec l'index en prenait 1,1 s (6 s sur un lien lent). Un fichier à la fois ; arrêté à la
fermeture de la fiche, quand un film s'ouvre, page cachée ou économiseur de données ; rien écrit sur
l'appareil, les octets lus meurent avec la source (`close(false)`) — reste l'en-tête analysé.
**Jamais au prix du relais** : un film tout juste fermé laisse ses octets à sa réouverture
(`handover`), et `HttpByteSource.open` les prendrait ; `holdsHandover` le dit sans les prendre. Effet
à part dans `usePlaybackPrefetch` : relancé à la fermeture d'un film, il ne redemande pas l'état du
spectateur. Tests : `sheetHeaderWarmup.test.ts`, `usePlaybackPrefetch-warmup.test.tsx`.

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

**Les invitations flottantes à les activer (23/10/2026).** Une seule bannière du bas, `PushResumePrompt`
(`src/components/player/PushResumePrompt.tsx`), pose l'une de deux questions, jamais les deux ensemble :
la *reprise* (« vous les aviez activées avant de vous déconnecter », `pushOnSignOut`) passe d'abord ;
sinon l'*application installée* — quand l'application tourne installée (`isInstalledApp`,
`src/lib/iosInstall.ts` : `display-mode: standalone` ou `navigator.standalone`) et que cet appareil n'a
aucun abonnement. Un abonnement appartient au contexte qui l'a pris : réglées dans un onglet de Safari,
les notifications n'abonnaient pas l'application installée ensuite — ni une nouvelle adresse (§118).
Communes : 3 s après le lancement, jamais pendant l'écran d'accueil (`/api/onboarding` en attente, qui
a sa propre étape), seulement si le navigateur sait s'abonner (service worker, `PushManager`), jamais
avec une permission refusée, jamais avec un abonnement actif ; le même `PushToggle`, la même fermeture.
L'invitation de l'application installée se fait **une fois par appareil** : `cine:push-installed-offered`
dans `localStorage`, posé à l'affichage (pas à la décision : l'écran d'accueil peut la retenir) ; une
fermeture ou un refus ne la reposent pas ; un stockage illisible vaut « déjà faite ». Tests :
`push-installed-prompt.test.tsx`, `InstallPrompt.test.tsx` (emplacement partagé).

**Où l'on peut les proposer : `canOfferPush()` (`src/lib/iosInstall.ts`, 23/10/2026).** Une seule
fonction dit si une invitation — la bannière (reprise comme application installée), l'étape de l'écran
d'accueil, le bouton « Activer » de `PushToggle` — a le droit de paraître : sur iPhone et iPad
(`isAppleTouchDevice`, l'iPad qui se dit Mac compris), **jamais hors de l'application installée** ;
ailleurs, dès que le navigateur sait s'abonner (service worker, `PushManager`), comme avant. Là où elle
répond non sur iPhone, l'étape d'accueil et l'interrupteur disent la phrase d'installation
(`useInstallHintText`), la bannière se tait. Trouvé sur l'iPhone du propriétaire en 10.0.0 : « Passer »
(§119) ouvre la nouvelle adresse dans la vue intégrée de l'ancienne application installée ; cette vue
se dit « standalone » et expose `PushManager`, et la bannière « l'application installée ne reçoit pas
encore de notifications » y est apparue à la place de l'aide à l'installation — dans un contexte qu'on
allait quitter, dont l'abonnement n'aurait jamais servi à l'application Laterna. D'où aussi la règle de
`isInstalledApp` : sur iPhone/iPad, un onglet **ouvert par un lien de passage** (`cine:passage-link-tab`
dans `sessionStorage`, posé par `PassageEntry` dès qu'il lit le jeton) n'est pas l'application de
l'écran d'accueil, quoi qu'en dise `display-mode` — iOS n'ouvre jamais une application de l'écran
d'accueil par un lien. Sur Android, où un lien peut ouvrir l'application installée, rien ne change.
Les trois copies du test « service worker et `PushManager` » ont disparu ; `decisions-partagees.test.ts`
empêche qu'elles reviennent (et que l'iPhone soit reconnu ailleurs qu'à `isAppleTouchDevice` dans ces
écrans). Tests : `push-offer-ios.test.tsx` (règle, bannière, interrupteur), `PlayerOnboarding.test.tsx`
(étape des notifications).

**Dans la langue de chaque appareil (25/10/2026).** Une notification peut être écrite par langue
(`LocalizedPush`, `push.ts`) : chaque abonnement la reçoit dans la langue de son interface (colonne
`lang` de `push_subscriptions`), le français quand elle est inconnue ; le journal garde la version
française. La langue vient du cookie `cine-lang` quand l'appareil renvoie lui-même son abonnement
(`/api/push/subscribe`), et, pour les abonnements d'avant ce jour, de l'ouverture du cinéma
(`/api/startup-timing`, `fillMissingLang`, qui ne remplit qu'une langue vide) — **jamais un
réabonnement demandé** pour l'obtenir. Seule « Votre demande est disponible » s'en sert pour
l'instant, titre traduit compris (`getTitleNames`, le titre de Radarr/Sonarr à défaut), et elle est
vérifiée toutes les 5 minutes (`REQUEST_CHECK_MS`) au lieu de toutes les heures : un film arrivé juste
après un passage attendait jusqu'à une heure. Tests : `push-realdb.test.ts`, `notificationJobs.test.ts`,
`push-subscribe-route.test.ts`.

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
(le choix hls.js / natif, le remontage de l'élément, le rechargement au changement de piste) et
`src/components/player/server/useElementErrorLadder.ts` (le rechargement en fin d'échelle).

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
et `rewound` ; `openingSpan(position, durée)` pour ce qu'on garde d'avance, sur `rewound`. La lecture
notée (`noteWatching`) et le recul après une longue pause, pour les deux lecteurs : `habitWatch`
(`src/components/player/session/habitWatch.ts`, depuis le 23/10/2026, §115).

**Appelants.** `ExperimentalPlayerHost` (la position d'ouverture), le lecteur serveur
(`ActivePlayer` dans `PlayerHost.tsx`, depuis le 27/09/2026 : il ouvrait pile à la position, et
ne retenait pas quand un titre venait d'être joué — il note désormais `noteWatching` comme le
natif, par `useServerPositionWatch`, `player/server/`) et `targetsFrom` (`src/lib/resumeCache/useResumeCache.ts`, ce qu'on garde). Deux calculs viseraient deux positions :
les octets gardés ne seraient plus ceux que le lecteur lit, et l'ouverture redeviendrait « mixte »
sans que rien ne casse — seul le journal (`openedFrom`) le dirait.

**Tests.** `resumeRewind.test.ts`, `resumeCache-core.test.ts`, `resumeCache-run.test.ts`,
`decisions-partagees.test.ts` (ni l'hôte ni la reprise instantanée n'appellent `awayFrom` eux-mêmes ;
l'hôte passe par `openingPosition`, la reprise instantanée par `openingSpan`).

**Voulu.** Le lecteur serveur ne recule pas un relais (la position exacte où le natif s'est
arrêté, ou le retour d'une télé), ni un rechargement pour changer de piste ; et, faute de durée
connue avant la négociation, il ne connaît pas l'exception de fin de film.

**Le retour d'une pause de plus de dix minutes** pendant la lecture recule aussi, dans **les deux
lecteurs**, par `pauseRewindTarget(pauseDébut, maintenant, position, durée)` (sur `rewound`) : c'est un
autre moment (l'élément joue déjà), et rien n'y est gardé d'avance. Le natif le faisait seul ; le lecteur
serveur repartait pile où il s'était arrêté, une différence que personne ne pouvait voir venir — aligné
le 22/10/2026 (`PlayerHost-audit-22-10.test.tsx`). Les gardes restent à l'appel : ni après la fin, ni
pendant un saut, ni au banc. Le lecteur serveur ne compte qu'une pause sur une image
(`readyState ≥ HAVE_CURRENT_DATA`) — la même garde que sa note `noteWatching` à la pause (a3733215) :
un changement de source vide l'élément et émet un `pause` qui n'est pas celui du spectateur. Le natif
n'a pas ce cas (il reconstruit sans mettre l'élément en pause sur une source vide) et note toujours.

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
doivent avoir la même forme. Depuis le 23/10/2026, cela vaut aussi pour « À voir » et « Vu » : mêmes
mots, mêmes icônes, même ordre, même message (§117.4).

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
porte alors la séance. La suite qui vient après la garde, elle, est commune aux quatre hôtes
(`closePlayerSession`, `advanceTo`, §114) : chaque hôte lui passe sa garde.

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

**Voulu, chez l'invité (§112) : la saison de l'épisode à suivre.** La fiche d'un lien de partage au
téléphone (`PhoneEpisodes`, `ShareTitleSheet.tsx`) ouvre la saison de l'épisode « À suivre » du compte
du lien, et ne retombe sur `openingSeason` (sans manquantes : un lien ne demande rien à Sonarr) que si
cet épisode n'est dans aucune saison. L'invité n'a que ce titre, et y revient pour reprendre où il en
est ; le foyer garde la première saison possédée. Décidé par Louis le 23/10/2026 (audit des fiches,
V8) : écart gardé, pas étendu au foyer.

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

**Règle.** Une ligne discrète — « Laterna 9.4 par LK59 · propulsé par Lumen · GitHub » (« CineApp 8.1
par LK59 · GitHub » avant le renommage, §118) — s'affiche à trois endroits et
à trois seulement : tout en bas du panneau Compte du cinéma, sous le formulaire de la page de
connexion, et en bas du menu de la gestion. La version est celle du build (`displayVersion(APP_VERSION)`,
« dev » hors build) ; seuls « by » (« par », « por », « von ») et « powered by » (« propulsé par »,
« impulsado por », « angetrieben von », `signature.poweredBy`) se traduisent ; le rôle du moteur
(« Moteur de lecture », `signature.engineRole`) est l'info-bulle de « propulsé par Lumen » ; « GitHub »
mène au dépôt dans un nouvel onglet (`noopener noreferrer`). Pas de pied de page global.

**Porteur.** `AppSignature` (`src/components/AppSignature.tsx`) ; le nom, l'auteur et l'adresse du
dépôt dans `src/lib/appBuild.ts` (`APP_NAME`, `APP_AUTHOR`, `APP_REPOSITORY_URL`) — `package.json`
n'a ni `author` ni `repository`.

**Appelants.** `PlayerAccountPanel`, `app/login/page.tsx`, `Sidebar` (gestion au bureau) et
`MobileNav` (feuille « Plus », la gestion sur téléphone n'ayant pas de barre latérale).

**Tests.** `AppSignature.test.tsx` ; `decisions-partagees.test.ts` (« une seule signature »).

**Voulu.** La page de connexion est publique et la montre quand même : la version s'y lit déjà par
`/sw.js?v=`. Au bureau, alignée à gauche sous « Déconnexion » ; ailleurs, centrée.

**La vitrine (23/10/2026).** La signature mène aussi à `laterna.fr` (`APP_WEBSITE_URL`, `appBuild.ts`), le site du projet : « Laterna 10.0 par LK59 · propulsé par Lumen · laterna.fr · GitHub ».

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

**Une séance que la page tient encore n'est jamais déclarée perdue par elle** (22/10/2026,
`livingHere` dans `unsentStop.ts`, `saveUnsentStop(…, { livesHere: true })` par les deux hôtes) : un
Mac endormi des heures en plein film, réveillé, passait la minuterie des bilans en plan avant celle de
la séance et envoyait son propre bilan « lost » une seconde avant le vrai `stop "close"` — 13 séances
ainsi en octobre. Seule une page tuée, dont le module disparaît avec elle, laisse un bilan au
lancement suivant.

**Voulu.** Le fichier reste dans l'ordre d'arrivée — il est lu par `tail` et tourne par taille ;
c'est la lecture qui replace. La file des lignes en attente (`src/lib/unsentLines.ts`) et celle des
bilans (`src/lib/unsentStop.ts`) restent deux : un bilan est réécrit toutes les 30 s tant que la
séance vit et n'est déclaré perdu qu'après deux minutes de silence ; une ligne ordinaire est écrite
une fois, et n'entre en file que sur un échec d'envoi. Depuis le 13/10/2026 (§84), le bilan n'est
plus réécrit toutes les 30 s que s'il a changé — un signe de vie (`touchUnsentStop`) le garde frais
entre deux — et son `lateByMs` part de ce dernier signe de vie.

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
clavier ou d'un programme n'est pas touché, ni celui d'une surface qui ne porte aucune des cibles
du geste (15/10/2026 : « Passer l'intro », `data-liquid` sans être une cible du lecteur, voyait son
clic retenu comme « tombé dans la pilule » — mort depuis le 04/10 ; `PlayerControls-geste-clic.test.tsx`). Les menus du lecteur naissent de la pilule des réglages
(une surface découpée à sa forme qui s'ouvre sur le ressort ; icône, titre et lignes apparaissent
en fondu à leur place — l'icône glissait du bouton jusqu'au titre et bougeait encore dans la boîte
posée), hauts de 280 px au plus, ouverts sur leur ligne retenue (`revealChosen`, la coche
`data-option-on` amenée dans le cadre — 15/10/2026, la sixième piste audio restait hors de vue) ; ils se démontent à l'instant où ils se ferment, et une copie inerte
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

**La pilule du bas, une seule pièce pour les deux interfaces (13/10/2026).** `LiquidNavPill`
(`src/components/LiquidNavPill.tsx`) porte le verre (`nav-glass`), la lentille (`nav-lens`), le geste
(`useLiquidLens`) et l'allure des onglets (`liquidTabClass`, `LiquidTabLabel`) ; la barre du cinéma
(`PlayerBottomBar`) et celle de la gestion sur téléphone (`MobileNav`) la branchent, et seul ce que
fait un onglet leur reste. La gestion n'en avait que l'allure (§81) : un onglet allumé, sans lentille
ni glisser. Même comportement : la page change au contact, un glisser parcourt les onglets et
navigue au relâchement, à la place de la première page ouverte (`router.replace`), et le clic qui
suit l'appui est retenu. Différent exprès : « Plus » ouvre sa feuille au clic et non au contact —
le voile apparaîtrait sous le doigt et prendrait le clic qui la referme — et au relâchement d'un
glisser ; les onglets de la gestion sont à la mesure de leurs mots (`fit` : « Téléchargements »),
et sa pilule garde le verre brillant du cinéma sous le verre en sourdine de la gestion (§83,
`.gestion-liquid .nav-glass`). Tests : `MobileNav-pill.test.tsx` (pièce partagée, contact, glisser,
« Plus »), `player-bottom-bar.test.tsx` inchangé, `useLiquidLens.test.tsx`.

**Focus à l'ouverture, commun aux deux lecteurs (13/10/2026).** `usePlayerFocus` (`src/lib/usePlayerFocus.ts`) pose le focus sur lecture/pause dans le lecteur natif comme dans le lecteur serveur, et vérifie qu'il est pris (les commandes natives restent `inert` jusqu'à la première image). Avant, seul le lecteur serveur le faisait : sous le lecteur natif, Entrée (le centre d'une télécommande Fire TV) actionnait le bouton « Lecture » de la fiche restée montée dessous. Tests : `ExperimentalPlayerHost.test.tsx`.

## 46. Le cinéma répond tout de suite, quitte à montrer qu'il travaille

**Règle.** Un geste a sa réponse visible dans l'image qui suit ; ce qui coûte se construit derrière,
interruptible, avec un fil de chargement fin qui n'apparaît qu'après 150 ms. Trois cas :
- changer d'onglet Films/Séries sur téléphone : la bascule suit l'adresse tout de suite, le contenu
  suit `shownTab = useDeferredValue(mediaType)` ; l'autre onglet est monté d'avance, caché, dans une
  transition, 1,5 s après que son catalogue est là (`useKeptTabs(active, prepared)`) ;
- ouvrir la grille complète : le premier écran (28 cartes) d'abord, la liste entière ensuite
  (`useDeferredValue(shown, firstScreen)`), un filtre changé par le même chemin ;
- les boutons « Voir tout » du téléphone répondent au relâchement du doigt (`useTap`) : juste après
  un défilement, iOS garde le premier `click` pour arrêter l'élan. Le `click` de compatibilité qui
  suit un appui servi est retenu s'il tombe sur un autre élément (15/10/2026) : il visait « Lire »
  de la fiche ouverte sous le doigt, et le film partait sur Android. Borné par 700 ms et par le
  prochain `pointerdown` ; un clic clavier (`detail` 0) passe toujours.

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


**Des transitions allégées (20/10/2026, Louis : « lentes, lourdes sans raison »).** Les durées ne
changent pas — le poids venait de ce qui se faisait pendant elles. La grille complète n'insère le
reste de ses cartes qu'après son fondu d'entrée (`ENTRY_SETTLE_MS`, 240 ms) : le premier écran reste
immédiat. La remise à zéro de la bannière « hors écran » est différée sur les deux accueils, comme sa
pause. Ce qu'on ouvre depuis le Compte (activité, signalement, nouveautés) se pose sur lui au lieu
d'un fondu croisé qui montrait l'accueil à mi-chemin ; le code et la vue d'ensemble de l'Activité sont
demandés dès l'ouverture du Compte (administrateur), le code des téléchargements dès le premier temps
libre. Les cartes d'un onglet plein écran n'ont plus de flou d'arrière-plan (invisible sur un fond
uni, recalculé à chaque image), les téléchargements ne refont plus un fondu par carte ni ne sautent de
18 px à l'arrivée de l'estimation de place. Au doigt, une surface liquide n'a plus de transition CSS
sur `transform` (le verre traînait derrière le doigt). La sortie des écrans pleins est en `ease-out`.
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
(`folderKey`, `src/lib/server-cache.ts`) ; `useRepairUnresolvedSheet` côté écran — le message est dit à sa
conclusion, après la relecture du catalogue (un crochet à part, `useMissingTitleNotice`, concluait
avant elle et rendait « indisponible » un titre importé pendant la séance ; retiré le 13/10/2026).

**Appelants.** `/api/cinema/movies`, `/api/cinema/series`, `/api/search`, `playableLibrary` (et
par elle `/api/player/discover`, `/api/player/lists`, `/api/player/title`, `/api/tmdb/person`,
`playerRequests`), `CinemaMobileClient` et `CinemaClient`.

**Tests.** `catalogue-members.test.ts`, `repair-unresolved-refresh.test.tsx`, `decisions-partagees.test.ts`, et les tests des routes.

**Voulu.** Jellyfin injoignable : la première moitié de la règle seule — un titre qui ne s'ouvre
pas vaut mieux qu'une bibliothèque qui disparaît des recherches. Le message attend la relecture
du catalogue au réseau : celui gardé sur l'appareil peut dater de quelques jours.

**Trouvé le 05/10/2026** : *The Arena (2026)*, identifiée par Jellyfin comme *The World's Greatest
Arena* ; la recherche la disait dans la bibliothèque, et l'ouvrir ne faisait rien.

**Étendu le 14/10/2026 (§89).** La règle compte aussi ce que **Jellyfin a seul** : un élément qu'aucun
titre de Radarr/Sonarr ne revendique (film avec un fichier, série avec au moins un épisode réel), sans
identifiant commun avec un titre du catalogue — jamais rapproché par le titre. Il reçoit un identifiant
de la plage réservée et entre partout où « dans la bibliothèque » se lit. Et le rapprochement par dossier
devient **le** lien d'un élément Jellyfin vers son titre (`CatalogueMembers.byJellyfinId`), que
« Reprendre », « À suivre » et le « vu » lisent au lieu des identifiants de Jellyfin. Voir §89.

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
TMDB et Radarr ou Sonarr. (Depuis le 14/10/2026, Jellyfin et TMDB seulement : Radarr et Sonarr sont
facultatifs, §89.) Son drapeau n'est posé que par « Terminer ». Une installation configurée
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

Chaque variable de `.env.example` est réglable, guidée (`DEPLOYMENT_GUIDE` : les
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

**Complété le 13/10/2026** (essai d'une installation neuve, sans `.env`). *Un service non configuré
n'est jamais interrogé* : `serviceConfigured.ts` (côté serveur de `configuredServices`) — le client
qBittorrent refuse avant tout réseau (`ServiceNotConfiguredError`), le suivi des torrents
(`pollTorrentWatch`), `/api/sse`, le contrôle d'état (`ifConfigured`) et la vue d'ensemble passent
leur tour ; l'adresse de qBittorrent n'a plus de défaut (`http://gluetun:8080`, celle d'une
installation particulière, appelée toutes les quinze secondes par les autres, avec le risque d'un
bannissement d'adresse). La vue d'ensemble nomme à part ce qui n'est pas configuré, sans le compter
« hors ligne ». *« Suivant » teste* chaque service renseigné de l'étape (`groupsToTest`,
`runServiceTest`) et, sur un échec, dit pourquoi et propose « Continuer quand même » ; une adresse
sans `http://` est « adresse invalide » au test comme à l'enregistrement (`urlProblem`). Une option
de déploiement (`inApp: false`) se montre telle que l'environnement la donne (`settingValue`), et la
page Déploiement dit si `TRUSTED_PROXIES` et `COOKIE_SECURE` sont posés. Tests :
`service-non-configure.test.ts`, `DashboardClient-non-configure.test.tsx`,
`correctifs-installation-neuve.test.ts`, `setup-ui.test.tsx`.
La page Santé et la page d'état publique suivent la même règle : un relevé non configuré porte
`configured: false` (`ifConfigured`, et TMDB, MDBList, VAPID), une fonction dont un service *requis*
n'est pas configuré aussi (`computeCapabilities` ; une dépendance souple absente ne dégrade rien), et
l'état d'ensemble les écarte (`overallStatus`, `statusOverall.ts` — la seule formule, lue par
`/api/health`, `buildStatusPayload` et `anonymousStatus`). Le cron n'en écrit rien dans l'historique ;
les tests d'API de la page Santé sautent les groupes d'un service non configuré. Présentés « Non
configuré », neutres ; le lien vers Connexions n'existe que dans la gestion. Tests :
`etat-non-configure.test.ts`, `etat-non-configure-ui.test.tsx`.

**Complété le 20/10/2026** (sécurité). *Une adresse changée ne reçoit pas le secret enregistré* :
un secret laissé vide reprend celui qui est gardé, au test comme à l'enregistrement — et changer la
seule adresse d'un service envoyait sa clé (Jellyfin administrateur, Radarr, Sonarr, Jellyseerr,
Bazarr, Jackett, mot de passe qBittorrent) à l'hôte saisi : un cookie administrateur volé valait
toutes les clés. Quand `<GROUPE>_URL` diffère de l'adresse en vigueur (comparées sans espaces ni
barre finale, schéma et hôte en minuscules : `normalizeServiceUrl`), chaque secret *déjà renseigné*
du groupe doit être ressaisi ; sinon 400, `code: "settings-secret-required"`, `fields`, et
`errors[clé] = "secret-required"` que la carte affiche sous le champ. Une seule règle,
`secretsToResubmit` (`setup.ts`), lue par `saveSettings` et `/api/settings/test` ; adresse inchangée
ou secret encore vide : rien ne change. Le déplacement est écrit par `logAdminAction` (hôte avant et
après, sans identifiant ni secret). *Le compte administrateur de l'assistant exige un code
d'installation* (`setupCode.ts`) : tiré au démarrage tant qu'aucun administrateur n'existe, gardé dans
`data/config/setup-code` (0600), écrit dans les journaux du conteneur à chaque démarrage
(`[setup] One-time setup code: …`), comparé en temps constant par `/api/setup/admin` et effacé
dès le compte créé. Avant, le premier visiteur d'une installation neuve en devenait l'administrateur.
Le compose minimal ne publie plus le port que sur `127.0.0.1`. Tests : `settings-secret-url.test.ts`,
`setup-code.test.ts`, `setup-ui.test.tsx`, `trustedProxy.test.ts` (§57 : sans `TRUSTED_PROXIES`,
`X-Forwarded-For` n'est cru que d'une connexion locale ou privée).

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
(Compte → Interface). Une préférence du compte, rangée avec la langue (`user_preferences.guided_scroll`,
NULL = activé), suivie depuis la clé `/api/user/preferences` déjà chargée au démarrage, avec la
dernière valeur connue de l'appareil avant la réponse.

**Porteur.** `useGuidedScroll` et `guidedScrollClass` (`src/lib/guidedScroll.ts`) — la seule façon
d'écrire les classes du conteneur.

**Appelants.** `CinemaClient` (volet des rangées), `CinemaMovieDetail`, `CinemaSeriesDetail` ;
l'interrupteur dans `PlayerAccountPanel` (`DisplayRows`).

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

**Règle.** Une option de l'accueil. Le serveur donne la valeur par défaut (gestion → Réglages
serveur → Réglages par défaut, ou `.env`) ; chaque compte la remplace dans Compte → Interface, à
côté du défilement guidé (`user_preferences`, `NULL` = suivre le serveur ; revenir à la valeur du
serveur la suit de nouveau). L'écran du compte ne montre que l'interrupteur.
- **Le bouton « Tous les films » / « Toutes les séries » est toujours affiché** (13/10/2026 —
  l'option `HOME_BROWSE_BUTTON` et la préférence de compte `browseButton` ont disparu ; la colonne
  `home_browse_button` reste en base sans être lue, une valeur restée dans `.env` ou dans les réglages
  n'est plus lue non plus, et `PUT /api/user/preferences` ignore `home.browseButton`). En rond en
  haut à droite (l'aide du clavier se range toujours à sa gauche au bureau). Sur téléphone, la barre
  du haut porte le logo (et le nom s'il y a la place), la bascule au centre, ce bouton à droite — la
  loupe qui y était doublait l'onglet « Recherche » de la barre du bas (retirée le 08/10/2026).
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
- **La découverte (14/10/2026)** : « Recommandé pour vous » et « Tendances films » sur Films, « Tendances
  séries » sur Séries (`discoveryRowsFor`), **sous les derniers ajouts**, avant Ma liste descendue et les
  genres — bureau et téléphone. Le bureau les mettait après le dernier genre et n'affichait pas « Parce
  que vous avez regardé X » (`discoveryEyebrow`, commun). Au bureau, survoler ou désigner une de leurs
  cartes **ne touche plus la bannière** : elle garde le dernier titre de la bibliothèque montré (le
  focus la rendait au carrousel — l'aperçu et « ‹ À la une » s'effaçaient en descendant d'un genre).
  L'ouverture ne change pas (`openDiscoveryItem`).
- **L'étiquette de « Recommandé pour vous » nomme ce qui l'a semée (14/10/2026)** : « D'après
  Interstellar, Dune et Premier contact » (« D'après X », « D'après X et Y » quand il y en a moins).
  Elle disait « Parce que vous avez regardé Interstellar » — le dernier film vu seul — alors que les
  trois derniers (`SEED_COUNT`) remplissaient la rangée. La route `/api/player/discover` renvoie
  `basedOn: string[]` (au lieu de `becauseOf`) : les noms Jellyfin des films regardés qui ont un
  identifiant TMDB **et** ont apporté au moins un titre resté dans la rangée, tags bloqués filtrés
  compris, le plus récent d'abord ; un titre déjà apporté par une graine plus récente ne compte que
  pour elle. `discoveryEyebrow(row, t, locale)` les joint par `Intl.ListFormat` (conjonction, langue
  de l'interface), clé `cinema.basedOn` (`cinema.becauseWatched` retirée). Une ligne, tronquée par
  `truncate` (texte entier en `title`). Une réponse d'avant restée sur l'appareil (`becauseOf`) ne
  donne pas d'étiquette ; `PERSISTED_CACHE_SCHEMA` 15 l'écarte de toute façon.
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
`spotlightRowItems`, `discoveryRowsFor`, `discoveryEyebrow`) ; `useHomeLayout.ts` ; `cinemaContinueLabel.ts` (`heroContinueFacts`) ;
`CinemaHero.tsx` (`HeroBannerControls`, `HeroBackToSpotlight`, `HeroTitleLink`) ;
`CinemaBrowseAllButton`, `HeroContinueProgress` ; `useCarouselDrag` (`peek`, `loop`).

**Appelants.** `CinemaClient` (bureau), `CinemaMobileClient` / `CinemaMobileHero` (téléphone).

**Tests.** `home-layout.test.ts`, `heroCarousel.test.ts`, `cinema-next-up-route.test.ts`,
`misc-simple-routes.test.ts`, `misc-routes-batch2.test.ts`, `persistentCache-schema.test.ts`,
`discovery-rows-home.test.tsx` (ordre des deux accueils, bannière gardée, flèches, étiquette « D'après »
en fr/en et ancien cache), `player-discover-route.test.ts` (`basedOn` : graines qui ont contribué) et
`decisions-partagees.test.ts` (« les rangées de découverte »).

**Décidé le 07/10/2026, revu le 08/10/2026, le 13/10/2026 (bouton toujours affiché) et le 14/10/2026
(découverte).**

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

**Pendant une panne de Jellyfin (14/10/2026, relecture de §92).** `hiddenTmdbKeysFor` lisait les tags
des titres dans les listes Jellyfin de l'administrateur ; après un redémarrage de cine-app (ou une panne
plus longue que la copie périmée en mémoire), ces listes manquaient, l'ensemble rendu était vide, et un
titre « prive » réapparaissait dans la recherche, la découverte et sa fiche. Il garde désormais sur disque
(`kv_cache`, `blocked-tags:tmdb-index`), à chaque calcul réussi et seulement quand il change, l'index
« tag → clés TMDB » des titres portant un tag bloqué de quelqu'un (comptes déjà lus, tags d'office) — pas
les mots-clés de TMDB. Listes absentes : cet index. Tag que l'index ne connaît pas, ou aucun index : rien de plus
n'est caché (décision de Louis, 14/10/2026, « priorité au fonctionnement et au catalogue ») — la première
règle cachait alors toute la bibliothèque (Radarr/Sonarr) au compte restreint, recherche et découverte
comprises, pour un cas qui demande à la fois une panne et un tag jamais vu ; « prive », posé d'office
(`unknownBlockedTags`), est toujours dans l'index dès un premier calcul réussi. L'attente de Jellyfin (tags du compte et listes, en parallèle) est bornée à 1,5 s
(`HIDDEN_JELLYFIN_WAIT_MS`), comme la recherche. Tests : `blocked-tags-hidden-restart.test.ts`.

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

**YouTube : la fenêtre du bouton, et rien d'autre (13/10/2026).** `trailerKey` ne sert qu'au bouton
« Bande-annonce » des fiches, qui ouvre `TrailerModal` (un cadre `youtube-nocookie`). La bande-annonce
de fond de la bannière du bureau — déjà éteinte, mais dont le code restait — est supprimée :
`CinemaTrailerBackdrop`, `loadYoutubeIframeApi` (l'API iframe `YT.Player`). La CSP ne garde que
`frame-src https://www.youtube-nocookie.com` : `www.youtube.com` sort de `script-src`, `connect-src`
et `frame-src`, `img.youtube.com` d'`img-src` et `connect-src`. Le type du catalogue ne change pas.
(`frame-src` a gagné `'self'` le 28/10/2026, pour le lecteur de livres — §128 ; YouTube y reste seul hôte.)

**Tests.** `titleExtras.test.ts`, `sheetFacts.test.ts`, `useQueuedPlay.test.tsx`,
`youtube-fenetre-seule.test.ts`.

**Décidé le 08/10/2026, revu le 13/10/2026.**

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
  100 ms après l'atterrissage de l'ouverture si rien n'a bougé (`OPENING_REASSERT_MS`, `FrozenClockWatch` dans `mseFrozenClock.ts`),
  au bord du média seulement ; la poussée de 400 ms reste le filet. Mesuré ce jour-là : WarGames, La
  Flamme, Drive ouverts en 14 à 373 ms, figés jusqu'à la poussée (`frozenNudges: 1`), que le chien de
  garde à 250 ms ne livrait qu'à 500 ms. **Jamais sur un élément qui repart** : un `playing` ou un
  `seeked` après l'atterrissage annule la relance, qui ne part que si l'élément saute encore ou n'a
  pas de quoi avancer (`readyState` < 3) ; et la poussée de 400 ms laisse 600 ms à un élément tout
  juste reparti (`OPENING_PLAYING_GRACE_MS`). Mathis, iPhone, 8.32.9 : la minuterie, retardée par le
  fil principal, tombait 283–348 ms après l'atterrissage, dans l'instant même du `playing` de Safari ;
  son pas relançait le saut et coûtait ~1,1 s jusqu'à la première image. **Depuis 10.2.3**
  (26/10/2026), cette poussée d'après `playing` a sa propre minuterie (`armOpeningGracePush`) : elle
  attendait le passage suivant du chien de garde, 750 ms en médiane au lieu de 600 (43 départs figés
  sur iPhone, 69 % des départs du début en Dolby Vision). Le seuil ne change pas.

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
- `ServerPlayerIntro` (`src/components/player/server/ServerPlayerIntro.tsx`), monté par le lecteur serveur ;
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
fermeture, le contenu de la copie part avec la carte (emporté avec son coin haut gauche, effacé avant
mi-chemin), la croix et le partage avec son coin haut droit (voir « Les effacements de la fermeture suivent le trajet » plus bas).
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
- `data-sheet-glass` : le verre de la croix (et du partage au téléphone), coupé pendant le mouvement,
  emporté avec le coin de la carte à la fermeture.

L'accueil du bureau porte `data-sheet-home`.

**Ce qui diffère exprès.**
- **Téléphone / iPad** : la carte entière qui grandit d'un côté, le visuel plein écran et l'accueil
  qui recule de l'autre ; la fermeture au doigt moins vive qu'au bureau (`closeResponse` : 0,85 fois
  l'ouverture, au moins 0,26 s, jamais plus lente que l'ouverture) et posée à un pixel près.
- **La fiche TMDB** n'a son visuel qu'avec la réponse du serveur. **Au téléphone**, elle n'attend plus
  cette réponse pour voler (06/11/2026, sixième film : ~1,3 s d'écran noir, une croix et une roue, puis
  la fiche d'un coup) : l'affiche touchée se pose sur la bannière et y reste comme image de relais
  (`standInUntilLoaded`) jusqu'au visuel de la réponse ; le bloc de contenu est là dès le montage,
  avec ce que la carte savait (titre, année — `discoverPreview.ts`, noté par `openDiscoveryItem`) et
  une roue à la place des actions, et le reste s'y dépose en fondu (`useLateArrival`). Une ouverture
  qui n'a rien noté (filmographie, recherche, saga) vole pareil, sans titre en attendant. **Au bureau
  et à l'iPad**, rien ne change : la fenêtre y est la fiche entière, et sans visuel elle n'aurait rien
  sur quoi se poser — elle entre comme avant, et seule sa fermeture revole vers l'affiche. La route
  (`/api/player/title`) lance ensemble tout ce qui ne dépend de rien (tags bloqués, TMDB,
  bibliothèque, logo) ; Jellyseerr attend seulement les tags bloqués, la progression du
  téléchargement la bibliothèque — §54 inchangé, un titre caché n'est ni demandé, ni possédé, ni en
  téléchargement. La fiche personne entre en montant, sa roue dans la carte : pas le même cas.
  **Septième film (06/11/2026)**, « bien mais pas parfait » :
  - *une bande sombre en haut de l'écran pendant le trajet* : le fond uni qui tient la place d'un
    visuel absent (`bg-surface`) n'était ni visuel ni voile, donc peint à sa place dès le montage. Il
    porte `data-sheet-settle` (caché pendant le trajet) — fiche découverte, fiche de bibliothèque et
    fiche hors ligne du téléphone ;
  - *l'affiche effacée à l'arrivée, un écran noir pendant toute l'attente* : sans visuel, l'image de
    relais était posée en tête de la bannière, **sous** ce fond uni. Elle se pose désormais juste sous
    les voiles (`standInUntilLoaded`), au-dessus de lui ;
  - *le visuel d'un coup, en deux images* : monté par React au-dessus de l'image de relais, il était
    rendu opaque d'un coup. Un visuel monté au-dessus est tenu caché jusqu'à son relais, et le relais
    décode d'abord (`img.decode()`) puis fait **un** fondu — celui de l'image de relais s'il est dessous,
    le sien s'il est au-dessus ; la colonne de la réponse se dépose en 300 ms, le même temps ;
  - *~1,5 s d'attente à la première ouverture* : le logo. Un titre jamais vu se le voit choisir en
    téléchargeant et en mesurant chaque logo candidat, langue après langue (`pickLogosByLang`,
    `logoLook`) — TMDB répond en ~270 ms, Jellyseerr en ~100 ms. La route ne l'attend plus que
    `TITLE_ART_WAIT_MS` (150 ms) : lu sur disque il est là, calculé il continue en arrière-plan pour la
    prochaine ouverture, et la fiche écrit le titre en attendant.
  Toutes les ouvertures d'une fiche découverte notent ce que la carte savait (`noteDiscoverPreview`) :
  rangées de découverte, recherche, filmographie, saga, Ma liste, ajout à une liste.
  Tests : `sheetMorph-hook.test.tsx` (« sans visuel au montage »), `discover-sheet-phone-wait.test.tsx`,
  `player-routes.test.ts` (« un logo qui se calcule ne retient pas la réponse »).
  **Huitième film (06/11/2026)** :
  - *les logos perdus* : une réponse partie sans son logo (encore en calcul) le gardait pour de bon —
    `SWRProvider` dédoublonne dix secondes et ne relit pas au retour au premier plan, si bien que les
    réouvertures suivantes resservaient la même réponse, titre écrit (Star Trek, cinq fois). Un logo
    déjà calculé, lu sur disque sans attente d'entrée-sortie, ne perd jamais la course des 150 ms. La
    réponse dit désormais `logoPending` ; la fiche la relit toutes les 1,2 s tant qu'il l'est (son
    dédoublonnage descendu sous cet intervalle), et le logo paraît dans la même fiche, en fondu, dans une
    place tenue à sa hauteur dès l'attente (`LateLogoTitle`) ; gardée par SWR, la réponse avec logo sert
    d'emblée la réouverture ;
  - *l'image restée sur l'accueil après une fermeture rapide* : l'image de relais, posée sur la bannière
    à l'arrivée en attendant le visuel, était reproduite par la copie de la fermeture à la place de la
    bannière — immobile au-dessus de l'accueil tout le temps du retour, puis partie d'un coup avec la copie.
    La fermeture la retire de la fiche (`standInUntilLoaded` rend de quoi l'annuler : observateur coupé,
    visuel tenu caché rendu), la copie n'en garde rien, et c'est elle que la fenêtre emporte. Un démontage
    l'annule aussi.
  Tests : `sheetMorph-hook.test.tsx` (« une fermeture rapide ne laisse rien derrière elle » : à q ≈ 0,3,
  à q ≈ 0,9, arrivée sans visuel décodé — ni calque, ni image de relais, ni minuterie),
  `discover-sheet-phone-wait.test.tsx` (« le logo arrivé après la réponse »), `player-routes.test.ts`.
- **La fiche personne** garde sa montée simple : il n'y a pas d'affiche à faire devenir une bannière.
- **Le banc** garde sa scène simulée, l'ancien moteur (`clip`) et les durées fixes pour comparer,
  mais joue les mêmes fonctions (`src/lib/sheetMorph/motion.ts`, `dom.ts`).

**Porteurs.**
- `src/lib/sheetMorph/motion.ts` : le ressort, les poses, les images clés.
- `src/lib/sheetMorph/dom.ts` : les lectures et écritures groupées, `posterStyle`,
  `swallowStrayClick`, `visibleFraction`.
- `src/lib/sheetMorph/source.ts` : le geste, la source, sa visibilité au retour.
- `useSheetMorph` (`src/lib/sheetMorph/useSheetMorph.ts`).
- `useSwallowEntryRepeatClicks` (`src/lib/sheetMorph/entryClicks.ts`, 15/10/2026), posé par
  `useSheetMorph` : pendant 600 ms après l'arrivée d'une fiche, un clic portant `detail ≥ 2` (la
  suite d'un double-clic sur l'affiche) est retenu — il ouvrait le résumé, ou cochait « À voir »,
  de la fiche toute neuve. Un clic simple passe toujours.

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

**Les effacements de la fermeture suivent le trajet, jamais une horloge ; le verre voyage avec le
coin de la carte (06/11/2026).** Filmé à 60 i/s sur l'iPhone : Mr. Robot fermé d'un jet vers sa vignette
de « Reprendre » — `flickResponse` raccourcit le ressort, la carte est posée à l'œil en ~100 ms. Le
contenu de la copie s'effaçait sur `max(100 ms, quart du trajet)` et la croix sur le double : à +17 ms,
le texte de la fiche pleine taille au-dessus des rangées, la carte déjà rétrécie ; à +100–120 ms, la
croix et le partage seuls à côté de la vignette posée. Et entre les deux, un rectangle sombre de la
largeur de la fenêtre qui débordait sous la vignette sur la rangée suivante : la fenêtre allait en ligne
droite de la carte (jusqu'au bas de l'écran) à l'affiche, l'image de la bannière à l'affiche, si bien
que l'encre de la carte restait sous l'image sur (1 − q) × (bas de l'écran − bas de la bannière) —
encore 27 à 50 px à 90 % du trajet, où un ressort amorti critique passe plus de la moitié de sa durée.
Trois règles, au téléphone :
- **le contenu** s'efface en `1 − (q / 0,7)²`, sur les instants mêmes de la fenêtre et coupé là
  (`CONTENT_OUT_Q`, `fadeOutAt`, `progressTrack`, motion.ts) : à la croix (~350 ms), c'est à quelques
  centièmes près la courbe des 100 ms d'avant ; d'un jet, il suit la carte au lieu de l'horloge ;
- **la croix et le partage** (`data-sheet-glass` — le partage porte la marque depuis ce jour,
  `sheetGlass` de `ShareButton` : il paraît donc aussi avec la croix à l'ouverture, son flou coupé
  pendant le trajet) passent dans la copie sous une enveloppe unique (`glassRide`, useSheetMorph.ts)
  qui suit le coin haut droit de la fenêtre et sa largeur, sur les mêmes poses, et s'efface à 90 %
  (`GLASS_OUT_Q`) — choix de Louis entre « effacés plus tôt » et « emportés par la carte » ;
- **le corps de la carte** rejoint le bas de l'image entre 45 et 85 % du trajet (`collapseCardBody`,
  `CARD_BODY_OUT`) plutôt que de s'effacer : seules les images clés de la fenêtre changent, aucun
  élément animé de plus, la carte reste une seule pièce, et rien n'a à disparaître à l'arrivée.
Aucune animation créée par la fermeture ne finit après le trajet (le relais `HANDOVER_MS`, qui
commence à l'arrivée, à part). Coût : sept éléments animés comme avant (fenêtre, contenu intérieur,
visuel, affiche, assombrissement, contenu, verre) — le verre est une enveloppe au lieu de la croix
seule, et le partage, qui ne bougeait pas, y est compris ; contenu et verre passent de 2 images clés à
celles du trajet jusqu'à leur fin (≤ celles de la fenêtre) ; une couche promue de plus (l'enveloppe),
rendue au relais. Tests : `sheetMorph-hook.test.tsx` (« la fermeture finit avec son trajet » : à la
croix, d'un jet, sur un trajet court, et au bureau).
Toutes les fiches qui volent en profitent, la règle étant dans `useSheetMorph` : la fiche de
bibliothèque du téléphone (film et série, `CinemaMobileDetail`), la fiche découverte, la fiche hors
ligne et celle d'un livre au téléphone. **Au bureau et à l'iPad** (`layout: "desktop"` : fiches film et
série de `DesktopSheetShell`, fiche découverte large), la copie entière s'effaçait sur 100 ms
d'horloge pendant que le visuel plein écran revolait vers l'affiche — même plancher, même risque d'un
retour lancé au doigt sur l'iPad : elle s'efface désormais sur le trajet, avec la même courbe
(`CONTENT_OUT_Q`). **La continuité du fond de l'ordinateur** (`desktopContinuity.ts`) garde ses 100 ms :
rien n'y rétrécit, aucun doigt n'y règle l'allure, et son trajet dure au moins 250 ms
(`BACKDROP_FADE_MS`) — rien ne peut y survivre. **La fiche personne** ne vole pas : elle sort d'une
pièce, sa croix dedans (`sheet-out`, ou le prolongement du doigt), et n'a donc ni contenu ni verre
qui puisse rester derrière.

**Le contenu part avec la carte (second film, 06/11/2026, choix de Louis).** Effacé en
`1 − (q / 0,7)²` mais immobile (10.13.23), il restait opaque pendant que la fenêtre le quittait : deux à
quatre images du grand logo de « her » et de sa ligne d'infos pleine taille au-dessus des rangées, la
carte déjà dans l'affiche ; Mr. Robot, logo et boutons deux à trois images. Le bloc de contenu de la
copie est désormais **emporté avec le coin haut gauche de la fenêtre**, à l'échelle de sa largeur et
autour de ce coin (`rideTrack`, useSheetMorph.ts — la même piste que le verre, ancrée à gauche), sur les
poses et les instants de la fenêtre, et **effacé en tête du trajet** : `(1 − q / 0,5)²`, 0,25 d'opacité
au quart du chemin, rien à mi-chemin (`fadeOutEarly`, `CONTENT_OUT_Q = 0,5`). Au bureau et à l'iPad, la
copie entière fait de même avec le visuel (le décalage de la poignée gardé devant le trajet). Coût :
aucun élément animé de plus — le bloc de contenu (un par fiche) animait déjà son opacité, il anime
aussi sa transformation ; au bureau, la copie est maintenant promue le temps du trajet (elle bouge).
Tests : `sheetMorph-hook.test.tsx` (« le contenu part avec la carte » : à chaque image clé, la
translation et l'échelle du bloc sont celles de la fenêtre au même instant).

**Saisie au doigt pendant l'ouverture (06/11/2026, troisième et cinquième films).** Une fiche du
téléphone saisie dans la demi-seconde qui suit son ouverture (« her » à 0,2 s, « Drive » à 0,4 s) :
pendant 80 à 100 ms la bannière restait clouée en haut de l'écran pendant que le reste de la carte
descendait sous le doigt, une bande noire entre les deux, pas d'accueil derrière — puis tout se
recollait. Le visuel était encore dans la fenêtre du trajet (le calque à part, que la transformation de
la carte n'emporte pas), la fiche encore transparente, l'encre de la carte dans la fenêtre à sa place
de repos. Ce qu'on avait pris pour le rebond d'iOS au départ du geste (§7.2) était ceci — la garde de
toucher posée pour lui a été retirée. `useSwipeToDismiss` annonce la saisie à la carte
(`SHEET_GRAB_EVENT`, à l'appui, avant tout mouvement), et `useSheetMorph` choisit selon le trajet
restant :
- **au plus `GRAB_SETTLE_PX` (4 px)** : l'ouverture finit d'un coup (`settleNow`) — ses animations à leur
  fin, puis le relais ordinaire de l'arrivée (`settleOpen` : visuel, ou image de relais, dans la
  bannière ; fiche rendue opaque ; fenêtre retirée ; assombrissement à sa valeur posée). Le saut ne se
  voit pas ;
- **au-delà** : rien ne saute. Sauter à la fin faisait, saisie tôt (5,52 s et ~8,1 s du cinquième
  film), grandir la carte d'un coup jusqu'à sa taille entière (différence d'image de 62). L'ouverture
  continue sur son propre ressort, et le calque du trajet reçoit le même `translateY` que la carte,
  écrit directement à chaque mouvement (`SHEET_DRAG_EVENT`, émis seulement quand la carte porte
  `data-sheet-drag-follow`) ; contenu et verre sont dans la carte. Arrivée pendant le geste : le relais
  ordinaire, calque et carte au même décalage, puis le calque reprend sa place. Relâchée avant
  l'arrivée : « reste », le calque revient avec la transition même de la carte ; « ferme », la fermeture
  part de la pose de l'aller plus le doigt (chemin prévu pour une fiche tirée pendant l'aller), le
  calque remis à sa place avant qu'elle bâtisse sa fenêtre. L'assombrissement dépasse d'un écran vers
  le haut, pour qu'un calque translaté ne découvre jamais de bande claire. Préféré à un trajet raccourci
  : rien n'est recréé, le ressort reste celui de toute ouverture, et le coût est une écriture de plus
  par mouvement (le calque, promu le temps du geste), sans rendu ni lecture de mise en page.
Toutes les fiches qui volent et se tirent : bibliothèque (film, série), découverte, hors ligne, livres
au téléphone ; et la poignée de l'iPad (`useSheetGrip`, même carte, mêmes annonces). Tests :
`sheetMorph-hook.test.tsx` (« la fiche saisie pendant son ouverture » : presque arrivée, avant le
départ, tôt — rien ne saute, la fenêtre suit le doigt — puis relâchée en place ou jetée, sans rien
laisser derrière ; après l'arrivée, rien).

**Le relâché ne fige plus la carte (06/11/2026, sixième film).** 13 fermetures au doigt sur 13 : la
carte restait immobile deux à trois images (35 à 50 ms) là où le doigt l'avait laissée, puis le retour
partait. Tout se faisait dans la tâche même du relâché — rendu de la fiche, copie et mise en page —,
l'écran gardait la dernière image tant qu'elle durait, et le retour, lancé une image plus tard depuis
sa pose de départ, en redonnait une immobile. Désormais `useSwipeToDismiss` lance la carte sur le
compositeur dès le relâché, à la vitesse du doigt (`BRIDGE_MS`, linéaire), avant tout rendu, et ne
demande la fermeture que deux images plus tard (`flushSync`), quand ce pont roule déjà : il continue
pendant la tâche lourde. La carte est alors posée où le pont l'a menée, et le retour en part ; son
horloge part de cet instant (`continueFrom`, `startTogether(…, from)`), pas de l'image où il démarre.
À la croix, à Échap, au retour, rien ne change (la carte est au repos). Le retour en place d'un geste
trop court non plus. Une fiche saisie tôt, dont le calque du trajet suit le doigt, ferme sans pont.
Le `click` qui suit le relâché est avalé dès le relâché (`swallowStrayClick`). Toutes les fiches à
carte menée par le doigt : bibliothèque, découverte, hors ligne, livres au téléphone, fiche personne
(sa sortie glisse depuis la place du pont), poignée de l'iPad. Tests : `sheetMorph-hook.test.tsx`
(« le relâché d'une fermeture au doigt »).

**La fermeture au doigt part de la carte où le doigt l'a mise, à sa vitesse** — une seule pièce
depuis l'audit du 10/10/2026 ; l'élan porté à part (`fingerCarry`) qui le précédait est retiré.
Tests : `sheetMorph-motion.test.ts`, `uiQuiet.test.ts`, `resumeCache-uiQuiet.test.ts`,
`top10-card-tap.test.tsx`, `cinema-mobile-detail-belowfold.test.tsx`.

**La fiche découverte du bureau a les deux pages de la fiche film (14/10/2026).** Capture de Louis,
« Matchbox – Le film » ouvert pour « Demander » : le titre se dessinait sous le bouton Retour, et la
distribution occupait le premier écran. La fiche découverte avait sa propre mise en page, et elle avait
dérivé : une seule section, la rangée de visages *dans* la colonne d'un premier écran qui tient dans la
fenêtre et se cale en bas (`SECTION_CLASS`, `h-full overflow-hidden justify-end`) — la colonne débordait
donc par le haut. **Une écriture pour les trois fiches du bureau** (`CinemaDetailPages.tsx`) :
`CinemaDetailPages` (défilement guidé, premier écran, rappel de défilement, second écran),
`CinemaDetailTitle` (logo, sinon le titre écrit), `CinemaDetailCastLine` (« Avec » trois noms et le
décompte, sa fenêtre comprise) ; Haut/Bas du menu par `detailMenuArrowNav` (`detailMenu.ts`), que la
fiche découverte n'avait pas. Le logo vient de `/api/player/title` (`logo`, `getTitleArt` +
`logoForLocale`, la même entrée de cache que le catalogue). Appelants : `CinemaMovieDetail`,
`CinemaSeriesDetail`, `PlayerDiscoverSheet` (film et série TMDB). Le téléphone ne change pas ; la fiche
personne, carte centrée à croix à droite, n'avait pas le défaut. Tests : `discover-sheet-desktop.test.tsx`,
`decisions-partagees.test.ts` (« les deux pages des fiches du bureau »), `player-routes.test.ts`.

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

**Révisé le 14/10/2026 — FFmpeg 7.1.5 dans les deux modules WebAssembly (7.1.2 avant).** Aucune
règle ne change : l'ordre de sortie mesuré (`MEASURED_DECODED_ORDERS`) reste celui du module. Le diff
des sources ne touche, côté AAC, que des chemins d'erreur (use-after-free USAC, trame sans
fréquence). Preuve, `ffmpeg-wasm-regress-bench.spec.ts` : 45 pistes AAC (les 13 à PCE de la
bibliothèque, LC et HE ordinaires de la mono au 7.1), 180 fenêtres de 60 s, **identiques à l'octet**
avant et après ; `aac-regress-bench` identique sur WebKit et Chromium ; Ruby à ≤ 0,03 dB de
`ffmpeg astats` comme avant. Côté TrueHD, les 65 pistes de la bibliothèque à l'octet aussi ; seul
change le TrueHD mono ou stéréo à un sous-flux, illisible en 7.1.2 (aucune piste de la bibliothèque),
lu désormais (`webcodecs-truehd.test.ts`). Voir DOC-TECH « Audio delivery ».

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

**L'écran de l'épisode suivant** (10.2.0, 26/10/2026) remplace la petite carte du générique : la
surface de l'image (`data-player-picture` dans le natif, l'élément dans le serveur) est réduite par un
`transform` (`player-squeezed`, globals.css), l'épisode suivant est mis en avant (miniature, code,
résumé, durée — la liste du menu « Épisodes »), « Lire » porte le décompte en anneau, « Regarder le
générique » et un appui sur l'image réduite rendent l'image entière. Le moment, le décompte, « Vous êtes
toujours là ? » et la minuterie de veille ne changent pas (`PlayerControls`). Pendant une diffusion, la
petite carte reste : l'image est sur le téléviseur. `PlayerNextUp.tsx` ; tests `player-next-up.test.tsx`.

**L'épisode suivant à tout moment.** Un bouton dans la pilule des réglages, pendant un épisode qui a
une suite, par le même `onAdvance` que la carte du générique (le stop rapporté est `next`, à la
position courante) ; absent quand la minuterie de veille arrête la série à la fin de l'épisode.

**Le récap.** Les segments `Recap` de Jellyfin (~20 % des épisodes ici) donnent « Passer le récap »,
le même bouton que « Passer l'intro » : `activeSkip` choisit lequel montrer, et, s'ils se
chevauchent, celui qui finit le plus tard.
**Retiré le 14/10/2026** : les 1 622 segments `Recap` de la bibliothèque (7 608 épisodes) commencent
tous à 0 s, et le premier épisode d'une première saison en porte autant que les autres (36 sur 156) —
c'est l'ouverture, pas un « précédemment ». Le bouton paraissait à la première seconde d'une série
neuve. `timestampsFromSegments` ne lit plus ce type ; le reste du chemin est gardé, sans source.

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

**Une seule fonction.** `audioCodecString` (`remuxer.ts`) / `opusCopyConsidered` (`browserEngine.ts`) pour la décision,
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
d'erreur (`useElementErrorLadder`) et les erreurs hls.js (`wireServerHls`) du lecteur serveur
(`src/components/player/server/`). `learnedExclusions` (`PlayerHost`), `purgeLegacyAudioBlocklist`
et les marches (`player/server/audioLadder.ts`).

**Volontairement à part.** La coupure réseau (attente voulue et visible — bornée à 48 s de silence en pleine lecture depuis le 15/10/2026, §97) ; les gestes du
spectateur (réessayer, piste, plafond HDR) ; `mseSource` et `playbackGuard`, déjà bornés ; le
rechargement WebKit en fin d'échelle, borné par `reloadAttempt`.

Tests : `retryLedger.test.ts`, `PlayerHost-echelle.test.tsx` (caractérisation de l'échelle, aucune
exclusion retenue, boucle (a)1), `PlayerHost-hls-recovery.test.tsx` (caractérisation d'hls.js,
boucle (a)2), `ExperimentalPlayerHost.test.tsx` (boucle (a)3).

**hls.js 1.7.3 (14/10/2026) : une récupération par incident, à la position d'alors.** Montée depuis
1.5.17 (épinglée exacte, import dynamique hors WebKit inchangé, pas de `hls.js/light`). Lu dans ses
sources et vérifié sur la vraie bibliothèque (`hls-contrat.test.ts`) :
- `MEDIA_SOURCE_REQUIRES_RESET` (nouvelle) : l'`ErrorController` d'hls.js appelle lui-même
  `recoverMediaError()` (drapeau `ResetMediaSource`), puis, sans variante SDR pour prendre le relais, la
  déclare fatale et appelle `stopLoad()` — tout cela avant nos écouteurs. L'écouteur de `PlayerHost`
  rappelait `recoverMediaError()` : deux détachements et deux tentatives du budget pour un incident.
  Désormais (`hlsResetItself`, `hlsRecovery.ts`) : non fatale, la remise à zéro d'hls.js est seulement
  comptée (registre, motif « hls.js : média » inchangé, et `mediaRetryCount`, pour que des remises à
  zéro en série restent bornées) ; fatale, on ne fait que relancer le chargement ; au bout du budget,
  `detachMedia()` pour que la MediaSource neuve ne recharge pas sous l'écran d'erreur.
- Toute relance passe la position (`startLoad(position)`, `hlsRecoveryPosition` : l'élément, sinon la
  position relevée à `MEDIA_DETACHING`, sinon `lastKnownTime`). Sans elle, `startLoad()` et le
  rattachement après une fatale repartaient de `config.startPosition` : le point d'ouverture d'une séance
  préchauffée (§78). Défaut déjà présent en 1.5.17, invisible hors préchauffage.
- Une requête restée sans réponse (statut 0) est réessayée par hls.js (1, 2, 4, 8, 8, 8 s) avant toute
  fatale, là où 1.5.17 la déclarait fatale aussitôt. Marquée coupure (`reconnecting`) dès la première :
  sans cela ces ~30 s n'étaient ni dites ni protégées, et une attente y était jugée lenteur (§78).
  Conséquence voulue, conforme à « la coupure : attente visible » : l'écran « connexion perdue » vient
  après ~4,5 min de coupure au lieu de ~48 s, et une coupure de 60 s reprend seule (~8 s après le
  retour du réseau) au lieu de laisser l'écran. Les six relances et leurs délais sont inchangés.
  **Revu le 15/10/2026 (Louis) : l'écran final revient à ~48 s.** Mesuré hors ligne (Chrome,
  `setOffline` de Playwright) : hls.js 1.7, `navigator.onLine` faux, attend le réseau **sans fin**
  (`retryDate = Infinity`) et ne déclare aucune fatale — l'écran ne venait jamais (image figée sous
  « hors ligne » après 5 min 30). La borne est à nous : `NETWORK_OUTAGE_GIVE_UP_MS` (PlayerHost), 48 s
  depuis le premier signe (première requête sans réponse, ou première fatale réseau), effacée au premier
  fragment accepté ; à l'échéance, hls.js arrêté et détaché, « La lecture a été interrompue… ».
  « Connexion perdue ou instable… » reste dite dès le premier signe ; une coupure plus courte reprend
  seule ; « Réessayer » repart de `lastKnownTime`, la position où l'image s'est figée. Les politiques
  d'hls.js ne sont pas touchées : réduire `fragLoadPolicy.errorRetry` ne met pas fin à l'attente hors
  ligne (prise dès que `maxNumRetry` > 0 sur un flux à niveau unique), et zéro supprimerait aussi ses
  nouveaux essais silencieux d'une erreur HTTP passagère ; `manifestLoadPolicy` / `playlistLoadPolicy`
  ne servent qu'à l'ouverture (VOD), couverte par le chien de garde des 20 s ; `keyLoadPolicy` est sans
  objet (flux non chiffré). Nos six relances (45 s) gardent la main là où hls.js déclare la fatale.
  Tests : `PlayerHost-hls-recovery.test.tsx` « une coupure a sa borne ».
- Mesuré sur une instance de test contre le vrai Jellyfin (Chrome 155, lecteur serveur, avant/après) :
  démarrage, préchauffage repris (`startPosition` respecté), coupures 5 s / 60 s / hors ligne 60 s, saut
  avant 600 s et arrière 15 s dans le tampon, changement de piste, flux 4K HDR converti SDR, erreur de
  décodage (`endOfStream("decode")`) dans une séance ordinaire et dans une séance préchauffée. Le reste
  identique ; sur Chrome l'erreur de décodage lève aussi l'`error` de l'élément, dont l'échelle du son
  renégocie à la position (~5 s, déjà le cas en 1.5.17). Non vérifiables ici : Fire TV, Android, une
  variante HDR servie telle quelle (la seule où la double récupération se produisait en vrai).
- **1.7.4 (06/11/2026)**, épinglée exacte. Diff relu : `ErrorController`, `recoverMediaError()` et
  `onMediaAttached` inchangés, le contrat ci-dessus tient. Ce qui peut nous toucher, sur un flux VOD
  à niveau unique et sans piste son séparée : un `stopLoad()` qui interrompt un fragment laisse
  désormais hls.js arrêté (notre borne de coupure appelle `stopLoad()` puis `detachMedia()`) ; une
  requête du premier fragment interrompue avant toute image le redemande à la position de départ ;
  les fragments marqués « trou » survivent à un `recoverMediaError()` ; une MediaSource fermée parce
  que l'élément a pris une autre source n'est plus recréée par-dessus (nos `releaseHlsElement` vident
  `src` : rien de changé). Le reste (LL-HLS, EME, interstitiels, IMSC1, pistes son séparées, démuxeur
  TS et chargement progressif — Jellyfin nous sert du fMP4, `deviceProfile.ts`) est sans objet ici.
  Banc navigateur (moyen + toutes les séances hls.js du complet, 19) : une seule différence due à la
  montée, reproduite 3 fois sur 3 contre 0 sur 3 en 1.7.3 — l'épisode en MP2 dans WebKit pour Linux
  (profil iPhone émulé), qui ne montre jamais d'image dans les deux versions : 1.7.4 y lève une erreur
  média (« hls.js : média », 20 fois), l'échelle du lecteur serveur monte ses quatre marches, et
  l'écran « Le chargement prend trop de temps » vient ~17 s plus tard. Même issue ; Safari réel prend
  le HLS natif, et la même séance dans Chromium est identique.

Tests : `hls-contrat.test.ts` (vraie bibliothèque : ordre des écouteurs, drapeau, fatale), et dans
`PlayerHost-hls-recovery.test.tsx` « hls.js 1.7 » — chacun échoue sans le correctif.

**La marche de l'image (20/10/2026).** Après l'échelle du son, une erreur de décodage (`error` de
l'élément code 3, ou les erreurs média de hls.js à bout de budget) relance une fois par ouverture
avec l'image en H.264 seul (`H264_RUNG`, `videoH264Only` → la route déclare le seul H.264 et passe par
le profil de la version allégée : SDR, 1080p au plus). Jamais pendant une diffusion. Et un fragment ne
rend le budget des erreurs média que si l'élément tient une image (`readyState` ≥ 2) — la boucle (a)2
prouvée ci-dessus est fermée. Pourquoi : un Android (Chrome 155) annonçait le HEVC 10 bits sans
jamais le décoder ; le lecteur serveur copiait l'image HEVC et l'échelle ne changeait que le son —
sept séances, de 4 à 109 reprises identiques, toutes à zéro seconde, quand ses films H.264 passaient.
Tests : `PlayerHost-hls-recovery.test.tsx` (marche H.264, boucle (a)2 en `it`),
`jellyfin-playback-start-route.test.ts` « la marche H.264 du client ».

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

*Amendé le 09/11/2026 (§140) : le budget mensuel est le plafond commun de toutes les fonctions payantes, la
table de prix a été relevée à nouveau (paliers longs, cache de Gemini à son prix).*

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

**Une page discrète** (27/10/2026, `seedQuietNewsPage`, page « 10.5 »). Publiée par le code comme les
autres, mais chaque compte qui avait tout vu est réglé sur elle dans la même transaction : elle s'ajoute
à Compte → Nouveautés sans ouvrir la fenêtre (consigne du propriétaire : mettre à jour les Nouveautés
sans les republier). Un compte qui avait déjà des pages à voir garde son retard — elle s'empile avec
elles —, et un compte jamais croisé la reçoit comme toute page récente. Le registre des corrections
vise désormais cette page (`page: "10.5"`) ; elle reprend au mot près celles de la 10.1 à la 10.5,
que le registre ne double pas en les versant ensuite (`withLedgerEntry`).
Une seconde page discrète, « 10.37 » (11/11/2026, `page1037.ts`), remplit l'historique des 10.14 à 10.37 :
seulement ce que tout compte a déjà (« Précédemment », les fiches du bureau en une page) — ni les fonctions
encore réservées aux administrateurs, annoncées à leur ouverture (brouillon « 10.33 »), ni le « Lab bêta »,
ni le mode caché. Les entrées suivantes du registre visent cette page (`page: "10.37"`).

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

**Pages suivantes et premier affichage (12/10/2026, 8.48).** Chaque page annoncée avec une version est écrite dans le code et publiée une fois par son marqueur (`seedNewsPage`, db.ts ; `src/lib/news/page848.ts`). Un compte qui n'a encore rien vu reçoit les dernières pages fusionnées, au plus `FIRST_VIEW_PAGES` = 3 (store.ts) — c'était la dernière seule : à la 8.48, les comptes qui n'avaient pas ouvert l'appli depuis la 8.44 l'auraient perdue (3 comptes sur une vingtaine l'avaient vue). Un compte qui a vu la 8.44 ne voit que la 8.48.

**Page complétée et republiée (19/10/2026, 8.68).** Une page déjà publiée par le code peut être complétée dans son fichier puis republiée une fois par un second marqueur (`republishNewsPage`, db.ts) : contenu et version remplacés, nouveau `seq` — chaque compte la revoit comme une page neuve, sans toucher `news_state`. Une installation qui ne l'avait pas encore la reçoit complète de `seedNewsPage` ; une page supprimée n'est pas recréée. Premier cas : la 8.67.2 (« Plus d'épisodes ») devenue 8.68 avec la rotation en paysage (`news-republish.test.ts`).


**L'historique des corrections (20/10/2026, demande de Louis).** La liste « Optimisations et
corrections de bugs » de chaque page publiée est complétée par un registre dans le code
(`src/lib/news/fixesLedger.ts`) : chaque correction qu'un spectateur peut remarquer, avec la version
qui l'a livrée et la page qui la couvre, dans les quatre langues. `applyFixesLedger` (db.ts) verse au
démarrage chaque entrée encore absente (un marqueur par entrée) dans sa page, sur toute installation :
la page garde son rang, la fenêtre ne se rouvre pour personne, rien n'est réécrit ni doublé. Une page
nommée encore en brouillon fait attendre ses entrées. Rétroactif pour les 8.37 à 9.1.2 (relevé dans
l'historique le 20/10/2026) ; actif ensuite : chaque déploiement qui corrige quelque chose de visible y
ajoute ses entrées, pour la dernière page publiée. Hors du registre : l'administration, les outils,
les fonctions nouvelles (leur place est la section « Nouveau »), un défaut introduit puis corrigé dans
la même série de déploiements, et toujours les titres masqués. Tests : `news-fixes-ledger.test.ts`.
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


## 75. Une série remonte avec son dernier épisode — et sa pastille dit pourquoi

Demandé le 12/10/2026 : une série datait de son ajout dans Sonarr et rien d'autre ; *Ted Lasso*,
ajoutée en avril, recevait sa saison 4 sans jamais reparaître dans « Récemment ajoutés », quand Jellyfin,
lui, la remontait.

**Règle.** La date d'une série (`addedAt` du catalogue) est, **pour le compte qui demande**, la plus
tardive de : sa date propre (la plus tardive de l'ajout dans Sonarr et de l'entrée de la série dans
Jellyfin — une série demandée il y a un an dont les premiers fichiers arrivent aujourd'hui est une série
nouvelle), et l'entrée dans Jellyfin (`DateCreated`) de son épisode le plus récent — **sauf si ce compte
l'a déjà vu** (`UserData.Played` de Jellyfin), ou s'il est entré hors de la fenêtre de « récent »
(`NEW_BADGE_DAYS`, trente jours, inchangée). Une série jamais commencée remonte : elle n'a pas vu cet
épisode (choix de Louis). Cette date sert partout où « récent » parle d'une série : la rangée « Récemment
ajoutés », la bannière des nouveautés (`spotlight`), la pastille, le tri « récents » de la grille complète
(`cinemaBrowse`). **Le palmarès du jour garde la date Sonarr**, la même pour tous : il départage ses
ex-aequo par la date, et deux comptes auraient lu deux top 10.

**La pastille** (`arrival`, absente quand rien n'est récent) : « Nouvelle série » si la série elle-même
est dans la fenêtre — quoi qu'il soit arrivé depuis ; sinon « Nouvelle saison » si le dernier ajout ouvre
une saison, « Nouvel épisode » sinon. Le dernier ajout est le lot des épisodes de la série entrés dans le
jour qui précède le plus récent (`ARRIVAL_BATCH_MS` : une saison s'importe en moins d'une heure, un épisode
hebdomadaire arrive seul) ; il ouvre une saison s'il porte l'épisode 1 d'une saison au-delà de la première,
ou plusieurs épisodes d'une telle saison sans qu'aucun ne soit entré avant le lot. La saison 1 ouvre une
série, les spéciaux (saison 0) n'ouvrent rien. Les films gardent « Nouveau ». Même forme pour les quatre.

**La source et son coût.** Jellyfin, parce que c'est ce qui est réellement jouable. Il n'a pas de filtre
« créé après » : `getRecentEpisodesAdmin` lit les épisodes triés par `DateCreated` décroissant, par pages
de 500, jusqu'à la première qui sort de la fenêtre — une lecture pour toute la bibliothèque, jamais une
par série. Mesuré le 12/10/2026 (7 535 épisodes) : 1 925 dans les trente jours (plusieurs séries entières
importées), quatre pages, 520 ms et 1,7 Mo ; une semaine ordinaire tient dans la première page (≈ 90 ms).
La bibliothèque entière d'un appel coûtait 660 ms et 6,4 Mo. Gardée dix minutes, projetée sur cinq champs
(`cachedJellyfinRecentEpisodes`). Sonarr était écarté : l'historique des imports sur trente jours coûtait
2 s et 2,8 Mo, et sa date de fichier ne suit pas un fichier remplacé — ni Jellyfin d'ailleurs : un fichier
réencodé ou amélioré reçoit un nouveau `DateCreated` (*Wonka*, 12/10), ce que le « déjà vu » rattrape pour
qui l'avait regardé (Jellyfin garde le vu d'un épisode à travers le remplacement de son fichier).

**Où se décide le « déjà vu ».** Dans la route du catalogue des séries, qui connaît le compte
(`hiddenForRequest` rend son `jfId`) : l'appareil n'a aucun état « vu » par épisode en main, et le
catalogue est commun et figé. Un appel Jellyfin par compte pour toute la liste des derniers épisodes
(`getPlayedAmong`, `Ids=`, 150 ms mesurés pour quarante éléments, gardé deux minutes) ; s'il échoue, rien
n'est tenu pour vu et la série remonte. La réponse préparée (`cachedJson`) a donc une entrée par compte —
bornée par le nombre de comptes, pas par les ensembles « vu ». Conséquence assumée du catalogue figé : un
épisode qu'on vient de finir garde sa pastille jusqu'au prochain chargement du catalogue.

**Porteurs.** `latestArrivals` / `seriesFreshness` (`src/lib/seriesArrival.ts`) — la décision, seule ;
`newBadgeKey` (`cinemaRails.ts`) — les mots de la pastille ; `getRecentEpisodesAdmin` / `getPlayedAmong`
(client Jellyfin) ; `cachedJellyfinRecentEpisodes` / `cachedJellyfinPlayedAmong` (`server-cache.ts`).

**Appelants.** `GET /api/cinema/series` ; `CinemaNewBadge`, commun au bureau (`CinemaSeriesCard`,
`CinemaSimilarRow`) et au téléphone (`PosterRow` de `CinemaMobileClient`) — aucune vue ne refait la
décision, elles lisent `addedAt` et `arrival`. `PERSISTED_CACHE_SCHEMA` 11.

**Tests.** `seriesArrival.test.ts` (série ancienne + épisode récent → « Nouvel épisode » ; E01 d'une
saison 2 → « Nouvelle saison » ; série récente → « Nouvelle série » ; déjà vu → ne remonte pas ; jamais
commencée → remonte ; hors fenêtre → ne remonte pas ; pagination arrêtée à la fenêtre ; un appel pour le
vu), `cinema-series-arrival-route.test.ts` (rangée et bannière, vu par compte, coût indépendant du nombre
de séries, Jellyfin muet).

**Décidé le 12/10/2026.**

**Sur les rangées de nouveautés (12/10/2026).** « Récemment ajoutés » et « À la une » coupaient la pastille (`showNewBadge={false}` : écrire « Nouveau » sur chaque carte d'une rangée de nouveautés ne dit rien) — or c'est là que remonte une série pour un épisode. Elles passent en mode `"reason"` (`NewBadgeMode`) : une série remontée y dit « Nouvel épisode » ou « Nouvelle saison », un film ou une série elle-même nouvelle reste sans pastille. Bureau et téléphone par le même `CinemaNewBadge`.

**Les films aussi, depuis le 03/11/2026.** Un film datait de son ajout dans Radarr seul : *Primetime* et
*Resident Evil*, demandés fin septembre et sortis le 03/11, entraient dans la bibliothèque avec plus d'un
mois d'âge — ni « Récemment ajoutés », ni bannière, ni pastille. Sa date est désormais la plus tardive de
l'ajout dans Radarr et de l'entrée de l'élément dans Jellyfin (`movieAddedAt`, `cinemaRails.ts`, appelé
par `toCinemaMovie`) — la « date propre » des séries ci-dessus. Pas `movieFile.dateAdded` de Radarr :
il bouge à chaque remplacement de fichier (meilleure version, réencodage) et aurait ramené en tête des
films là depuis des mois ; `DateCreated` de Jellyfin garde la première arrivée (mesuré : 8 films sur 899
changent de date, tous des demandes arrivées tard). Une `DateCreated` plus ancienne que l'ajout (la date
du fichier d'un dossier existant) ne recule rien. Pas de « vu par compte » ici : un film arrive une fois.
Le palmarès du jour départage donc ses films sur cette date, la même pour tous. Tests : `cinema-rails.test.ts`.

## 76. Les listes de lecture HLS partent compressées, et rien d'autre ne change

Relevé le 12/10/2026 dans le journal du relais inverse : une spectatrice sur Edge, connexion à ~40 Ko/s,
n'a eu ni image du lecteur natif ni du lecteur serveur (« pas de première image en 20 s », trois fois).
hls.js avait téléchargé `master.m3u8` puis `main.m3u8` — **954 782 octets, non compressés** — plusieurs
fois, sans jamais demander un segment ; Jellyfin n'avait pas lancé ffmpeg. Jellyfin recopie toute la
requête (codecs, profils `*-rangetype`, `TranscodeReasons`…) dans chaque ligne de segment, et le relais y
ajoute le laissez-passer (`withCastPass`) : ~1,1 Ko par segment de 3 s.

**Règle.** La route de flux compresse toute liste `.m3u8` d'au moins 1 Ko selon `Accept-Encoding` :
brotli (niveau 4) si accepté, sinon gzip, sinon en clair comme avant ; `Vary: Accept-Encoding` toujours,
`Content-Length` du corps envoyé. Le texte décompressé est **octet pour octet** celui d'avant : adresses,
place et forme du `castToken`, variantes de diffusion, en-têtes CORS d'un téléviseur — rien n'est
touché. Les segments, les sous-titres et le fichier lu par plages ne sont pas compressés.

**Pourquoi ici.** Next compresse ses réponses (`compress: true`), mais son module `compression` ne touche
qu'aux types que mime-db dit compressibles, et `application/vnd.apple.mpegurl` ne l'est pas ; il laisse
passer une réponse qui porte déjà son `Content-Encoding` (comme `cachedJson`). Le relais inverse est
partagé avec d'autres sites : on n'y touche pas.

**Mesuré** sur les vraies listes de Jellyfin (épisode de 41 min, 826 segments ; *Kill Bill*, 253 min,
5 067 segments), avec laissez-passer : épisode 920 Ko → 10 Ko en gzip, 4,0 Ko en brotli ; *Kill Bill*
5,6 Mo → 56 Ko en gzip, 19 Ko en brotli (14 ms, dans le pool de libuv, pas sur la boucle d'événements).

**Écarté pour l'instant (choix de Louis : aucun risque sur le lecteur serveur).** Raccourcir les adresses
des segments (porter la requête commune une seule fois, dans le chemin de la variante) et ne plus répéter
le laissez-passer sur chaque ligne : la liste en clair tomberait à ~70 Ko, mais cela touche ce que
Jellyfin, Safari, AirPlay et le Chromecast lisent. Et un message « connexion trop lente » quand le débit
reçu pendant l'attente de la première image est trop bas.

**Porteurs.** `encodePlaylist` / `playlistEncodingFor` (`src/lib/playlistEncoding.ts`).
**Appelant.** `GET /api/jellyfin/stream/[itemId]/[...path]` (branche manifeste seule).
**Tests.** `playlist-compression.test.ts` (sans `Accept-Encoding` en clair ; gzip et brotli décompressés
identiques ; téléviseur sans cookie : même contenu signé, mêmes en-têtes CORS ; petit maître en clair ;
segments jamais compressés ; `q=0` respecté).

**Décidé le 12/10/2026.**

## 77. « Connexion trop lente » : une cause dite seulement quand les mesures la prouvent

> Le verdict mesuré reste ; ce qu'on en fait à l'écran — message chiffré, relais au lecteur serveur —
> est remplacé par §78 (pas de chiffres à l'écran, préchauffage et bascule automatique sur la version
> allégée, écran final sans relais).

Relevé le 12/10/2026 : Augustine, Edge sous Windows, *The Rookie* S08E18. Le PC recevait ~40 Ko/s
(≈ 0,3 Mbit/s) derrière la même box que son iPhone, qui avait joué le même épisode 25 min sans une
attente (3,9 Mbit/s demandés). Le lecteur natif a renoncé à 35 s (« aucune image », chemin non décidé),
le lecteur serveur a échoué trois fois (« pas de première image en 20 s »), et l'écran disait « Le
chargement prend trop de temps. Réessaie. » — vrai, sans le pourquoi. Le passage au serveur ne pouvait
rien : il demandait le même débit au même lien.

**Règle.** Au moment où l'un des deux lecteurs allait de toute façon renoncer (natif : 35 s sans image ;
serveur : chien de garde de 20 s), on regarde ce que le lien a réellement livré, mesuré côté navigateur
pendant l'attente. Les trois conditions ensemble, sinon rien ne change :
- au moins **10 s de réception** (des en-têtes au dernier octet, union des requêtes parallèles — l'attente
  d'un serveur qui prépare sa réponse n'est pas comptée, ce qui ne peut qu'avantager le lien) ;
- au moins **256 Kio reçus** — en dessous, c'est une coupure, qui garde son écran « connexion perdue » ;
- un débit **sous la moitié** du besoin : poids / durée du fichier pour le natif, débits vidéo + son du
  flux négocié pour le serveur.
Alors : écran « Connexion trop lente pour ce film (≈0,3 Mbit/s reçus, il en faut environ 4). Réessaie
quand la connexion sera meilleure. » avec Réessayer, et la ligne `fallback`/`error` porte
`reason: "connexion trop lente"`, `recvMbps`, `needMbps`, `measuredS`, `bytes` (et `serverCanCarry` côté
natif). Le natif ne passe la main au serveur que si la version la plus réduite que celui-ci sait demander
(`CRAWL`, 1,5 Mbit/s) passe par le lien mesuré — et le serveur demande alors ce débit (`capForSlowLink`,
par titre, dix minutes) ; sinon l'écran, sans relais.

**La mesure.** Natif : un compteur armé tant qu'aucune image n'est prête (`armOpeningMeter`, réarmé à
chaque reconstruction) ; pendant ce temps seulement, `HttpByteSource` lit le corps au fil de l'eau
(`readCounted`, les mêmes octets qu'`arrayBuffer()`, toujours recopiés dans un tampon à soi). Hors
ouverture le compteur n'existe pas et la lecture est celle d'avant. Serveur : `xhrSetup` d'hls.js ajoute
des écouteurs (`meterXhr`) sans toucher aux siens ; Safari lit son HLS lui-même et n'en dit rien — pas
de mesure, ancien comportement. Rien de tout cela ne lève (« A check that runs on someone else's error
path must not become the error »).

**Ce qui en est montré.** Le panneau d'infos techniques (menu ⋮) des deux lecteurs : débit reçu, débit
demandé, verdict (suffisante / trop lente / pas encore mesurée) par le même critère, en direct, et figé
au moment d'un échec. `stall` et `stop` natifs portent `diag.linkVerdict` et `diag.linkS` à côté de
`diag.recvMbps` / `diag.linkMbps` / `diag.needMbps` qui y étaient déjà ; le bilan du lecteur serveur porte
les mêmes noms sous `diag.*`. Panneau Activité : ces séances sont comptées à part (`Seance.slowLinks`,
étiquette « connexion trop lente »), hors `failuresOf` — le lien du spectateur n'accuse pas le fichier
dans le diagnostic « fichier ou appareil » — et la raison se lit telle quelle sur la séance.

**Ajouts du même chantier, mesure et journal seulement.**
- *Démarrage du lecteur serveur* (`ServerStartup`) : `startup.*` sur `start` (négociation), `error` et
  `stop` — liste maître et variante (ms, Ko), premier segment demandé, reçu (ms, Ko, Mb/s), tampon,
  première image, depuis la demande ; `startup.stage` (`liste` / `segment` / `décodage` / `image`) dit où
  en était un échec. hls.js : ses événements et leurs `stats` ; Safari : les entrées de ressources du flux.
- *Chronologie* (`PlaybackTimeline`) : toutes les 5 s, en mémoire, un échantillon compact (position,
  secondes depuis le départ, Mb/s reçus sur 5 s, tampon devant, réserve, état L/A/P/S/H) dans un anneau de
  24 ; `reportPlayback` le joint en un champ `timeline` aux lignes `stall`, `error`, `fallback`,
  `rebuild`, `network`, `stop` — **aucune ligne de plus** (la décision du 08/10 sur les points `reserve`
  tient). La route le garde hors du plafond de 40 champs, borné à 1 000 caractères. Le détail d'une
  séance l'affiche en tableau.

**Porteurs.** `slowLinkVerdict`, `LinkMeter`, `readLink` (`src/lib/slowLink.ts`) ; `ServerStartup`
(`src/lib/serverStartup.ts`) ; `PlaybackTimeline`, `timelineFields` (`src/lib/playbackTimeline.ts`).
**Appelants.** `ExperimentalPlayerHost` (`giveUpOnOpening` dans `playerNative/useNativeSlowLink.ts`,
l'écran, le panneau), `HttpByteSource`
(`fetchWithRetries`), `PlayerHost` / `ActivePlayer` (chien de garde, `xhrSetup`, bilan, panneau),
`reportPlayback`, `playerLog.clean`, `activity/seances.ts`, `playbackDiagnosis` (`diag.link*`).
**Tests.** `slowLink.test.ts`, `ExperimentalPlayerHost.test.tsx` (« le lien, mesuré » : connexion
normale inchangée, lente validée sans relais, relais avec débit réduit, mesure impossible, rien reçu,
coupure), `PlayerHost-connexion-lente.test.tsx`, `activity-connexion-lente.test.ts`,
`playbackTimeline.test.ts`.

**Décidé le 12/10/2026.**

**Mesure sans toucher à la réception (12/10/2026, choix de Louis).** La première version lisait le corps des réponses au fil de l'eau pendant chaque ouverture (`readCounted`) : même octets, mais un chemin de réception neuf pour toutes les ouvertures, Safari iOS compris, jamais validé sur appareil. `HttpByteSource` lit de nouveau d'un bloc (`arrayBuffer()`, comme avant §77) et compte chaque morceau une fois arrivé ; le morceau encore en vol n'apporte que son temps, ce qui ne peut qu'abaisser la mesure d'au plus un morceau — sans effet sur le verdict d'un lien comme celui du 12/10 (morceaux de 1 Mio en 2, 7, 14, 25 s). `readCounted` reste dans `slowLink.ts`, testée, non branchée.

**Le coût d'une reprise, au bilan du lecteur serveur (15/10/2026, LECTEUR-2).** `startup.pictureMs` est la
première image du flux, prise au `loadeddata` — **avant** le saut à la position de reprise posé juste après. Ce
que la reprise coûtait vraiment (hls.js chargeait le début du film, puis Jellyfin relançait ffmpeg au segment
de la reprise : 3,8 s relevées sur *L'Exorciste* à 2 205 s) ne se lisait nulle part. Une séance ouverte à une
position porte au `stop`, sous `diag` (hors du plafond des quarante champs) : `resumeAt` (s), `resumeSeekMs`
(saut posé) et `resumePictureMs` (le `seeked` de ce saut : l'image à la position), en ms depuis la demande —
`resumePictureMs` absent avec `resumeAt` présent, la séance s'est arrêtée avant. Tous les chemins (hls.js,
HLS natif, lecture directe) ; `ServerStartup.resumeFields`. **Tests** : `PlayerHost-connexion-lente.test.tsx`
(« la reprise du lecteur serveur »).

**Une reprise par hls.js part du segment de la reprise (15/10/2026, LECTEUR-2, choix de Louis).** Sans
préchauffage, hls.js demandait l'init puis le segment 0, et le saut de reprise n'était posé qu'au
`loadeddata` : Jellyfin lançait ffmpeg au début du film, puis le relançait au segment voulu — deux jobs
FFmpeg.Transcode par séance (le premier sans `-ss`). Poser `startPosition` seul ne suffit pas : la demande de
l'init lance déjà ffmpeg au début ; le préchauffage (§78, §93) ne marchait que parce qu'il demande le segment
de la position **avant** tout le reste. Désormais, quand une séance hls.js s'ouvre à une position (> 0) sans
préchauffage repris, `ActivePlayer` fait, après sa négociation ordinaire et avant de construire hls.js, ce que
fait le préchauffage — la même fonction, `warmSegmentAt` (`lighterPrewarm.ts`, extraite de `startPrewarm`
sans changement de son comportement) : maître, variante, puis le segment de la reprise **jusqu'à ses
en-têtes** — Jellyfin ne répond qu'une fois le segment produit, ffmpeg tourne alors à cette position ; le corps
est abandonné, hls.js le demande aussitôt (le lire ici l'aurait fait payer deux fois sur un lien lent : sous
Playwright, 4 s de plus à 20 Mbit/s) ; hls.js part ensuite de ce segment (`startPosition`). Un seul ffmpeg par
séance, lancé au bon endroit. **Transcodage seulement** (`playMethod === "Transcode"`) : DirectStream (vidéo
copiée) reste tel quel tant qu'un gain n'y est pas mesuré — Chrome n'y passe pas par hls.js dans cette
bibliothèque. Garde-fous : Safari en HLS natif et la lecture directe sont inchangés (branches prises avant) ; ni
pour une diffusion, ni pour le banc d'essai, ni quand un préchauffage est repris ; une erreur ou une réponse en
échec (`strict`) ne pose aucune position — l'ouverture d'avant, à l'octet ; la requête est interrompue
(`resumeKick`) par une négociation qui remplace celle-ci, par le chien de garde des 20 s et au démontage ; ses
requêtes sont comptées par le compteur du lien comme celles d'hls.js. **Mesuré le 15/10/2026** (instance de
test, Chrome, *American Beauty* HEVC 10 bits → H.264, reprise à ~1 520 s ; négociation → image à la reprise) :
avant 2,87 / 2,82 / 3,41 s, après 2,38 / 2,27 / 2,53 s ; lien bridé à 20 Mbit/s : avant 9,09 / 8,84 s, après 7,0 /
7,6 s. Jellyfin, FFmpeg.Transcode : avant, chaque séance ouvre deux jobs (`start_number 0` sans `-ss`, puis
`-ss 00:25:…` une à deux secondes plus tard) ; après, un seul (`-ss 00:25:…`, `start_number` du segment). Journal : `diag.resumeKickMs` et
`diag.resumeKickSegment` au bilan, à côté de `diag.resumePictureMs`. **Tests** :
`PlayerHost-connexion-lente.test.tsx` (« la reprise par hls.js part du segment de la reprise » : ordre des
requêtes avant hls.js, `startPosition`, sans reprise inchangé, segment en erreur, fermeture pendant le
chargement, Safari inchangé), `lighterPrewarm.test.ts` (inchangé).

**Dire la lenteur pendant le chargement — informer tôt, ne jamais abandonner tôt (12/10/2026, choix de
Louis).** Le verdict attendait le renoncement (35 s / 20 s) alors que le lien se savait lent bien avant.
Pendant l'ouverture, le lien est lu chaque seconde (`openingLinkState`) — mesure et affichage seulement,
aucune requête de plus, aucun abandon anticipé (une première version renonçait dès 10 s sous le quart du
besoin ; écartée avant livraison) :
- *Indice* — dès **5 s de réception** (`HINT_MEASURED_MS`), des octets reçus, et un débit **sous la
  moitié** du besoin : « Connexion lente… » sous la ligne de chargement de l'ouverture (§60, `note` de
  `PlaybackIntro`, avant « Toujours en cours… » ; aussi le mot sous la roue quand l'ouverture n'est pas
  là). Sans chiffres. Retiré dès que le débit remonte.
- *Message chiffré* — les preuves du verdict (10 s de réception, 256 Kio) **et** un débit **sous le
  quart** du besoin (`NOTICE_SHARE` ; le cas du 12/10, ≈0,3 Mbit/s pour 3,9, est sous 10 %) : à la place
  du mot, « Connexion trop lente pour ce film (≈X Mbit/s reçus, il en faut environ Y). » (`notice` de
  `PlaybackIntro`), chiffres tenus à jour, avec **« Version allégée »** — présent seulement si
  `serverCanCarry` (≥ `CRAWL`, 1,5 Mbit/s) et qu'il y a un lecteur serveur — et **« Fermer »**. Le
  chargement continue derrière : la première image arrivée, le film part seul et le message s'en va avec
  l'ouverture. Montré, il reste tant que le débit est sous la moitié (pas de clignotement autour du
  quart) et s'efface au-dessus. Côté natif, il garde l'ouverture au-delà de 20 s (`STUCK_AFTER_MS`) : il
  explique déjà l'attente.
- *Choix* — « Version allégée » : natif, `noteSlowLink` puis `fallToStable` avec
  `reason: "connexion trop lente (version allégée demandée)"` (`SLOW_LINK_LIGHTER_REASON`) et les
  chiffres ; serveur, une négociation neuve au débit abaissé (`start`, `why: "lighter"`, chiffres en
  `trigger`). « Fermer » : la fermeture ordinaire. Le panneau Activité range le motif allégé avec les
  connexions trop lentes (`isSlowLinkReason`), jamais comme un échec du fichier.
- *Renoncement* — inchangé : 35 s (natif) / 20 s (serveur), verdict chiffré, Réessayer, règle de relais,
  y compris quand le message était affiché.
- *Journal* — aucune ligne de plus. Natif : apparitions et retraits de l'indice et du message dans la
  trace ; `slowNoticeAt` (ms depuis le montage) et `slowChoice` (`"allégée"` / `"fermer"` / `null`) sur
  les lignes `opening`, `stop`, et celles du renoncement ou du relais — seulement quand le message a paru.
  Serveur : les mêmes champs sur `stop`.
Serveur : hls.js seulement (Safari HLS natif et la lecture directe ne mesurent rien : inchangés). Rien
pendant une coupure (« connexion perdue » garde son écran ; le lien n'est plus lu) ni sous une erreur.
**Tests** : `slowLink.test.ts` (« pendant l'ouverture »), `ExperimentalPlayerHost.test.tsx` (« le lien,
mesuré » : bon réseau sans indice ni requête de plus ; < 10 % → indice à 5 s, message à ~10 s sans
« Version allégée », chargement poursuivi, renoncement à 35 s ; première image tardive ; « Version
allégée » ; « Fermer » ; 35 % → indice seul ; débit qui remonte ; coupure totale),
`PlayerHost-connexion-lente.test.tsx` (« pendant le chargement », Safari compris),
`activity-connexion-lente.test.ts`.

## 78. La connexion lente : mesurée, préchauffée, basculée d'elle-même — jamais confondue avec une coupure

Prolonge §77 (le verdict mesuré) d'après les décisions de Louis du 12/10/2026. Le lecteur ne *propose*
plus rien : sur un problème **visible** dû au lien (pas d'image aux délais de l'ouverture, ou blocages en
pleine lecture), il prépare la version allégée en arrière-plan puis bascule de lui-même, par la
reconstruction habituelle. **Aucun chiffre à l'écran** (journal et panneau technique seulement), et une
coupure (plus aucun octet) n'est jamais traitée en lenteur. Simple, une seule machine, la stabilité avant
tout : en cas de doute, le comportement de 8.47.0.

**La machine** (`src/lib/slowLinkPolicy.ts`, pure, une seule copie pour les deux lecteurs) :
mesure → indice → préchauffage → bascule → écran final. `decideOpening` (ouverture, et saut resté sans
image 10 s) et `decidePlayback` (saccades) rendent une action — `none`, `prewarm`, `switch`, `screen`,
`giveUp` — qu'une seule exécution commune applique (`SlowLinkRunner`, §79) ; chaque hôte n'y ajoute que
sa bascule : `ExperimentalPlayerHost` → `fallToStable` avec un relais `lighter` qui porte le palier,
`ActivePlayer` → `startPlayback` `why: "lighter"`.

- *Mesure* — ouverture : la moyenne de toute la réception (une ouverture dure 35 s au plus : sa moyenne
  est la moyenne récente ; 10 s glissantes oscilleraient, le natif comptant ses morceaux de 1 Mio une fois
  arrivés, 28 s chacun à 0,3 Mbit/s). Lecture : 30 s de réception (`PLAYBACK_MEASURE_WINDOW_MS`, la
  fenêtre de la ligne `stall` — 10 s ne verraient parfois aucun morceau à 1–2 Mbit/s).
- *Indice* « Connexion lente… » — 5 s de réception sous 50 % du besoin ; retiré au-dessus.
- *Préchauffage* (`lighterPrewarm.ts`) — dès **8 s** sous 50 % : `/playback/start` au palier (marqué
  `prewarm`, rien n'est annoncé à Jellyfin), puis maître, variante et **le** segment qui contient la
  position — sa demande fait partir ffmpeg. Annulé (listes et segment interrompus, `AbortController` ; et
  le transcodage arrêté : route d'arrêt `prewarm`, `DELETE /Videos/ActiveEncodings` par l'appareil et la
  séance lus dans l'adresse, **seulement** pour une séance que la route de démarrage a retenue en
  préchauffage pour ce compte et cet appareil, `prewarmSessions.ts`) si la première image arrive, et au
  démontage : aucun job orphelin (Jellyfin ne les tue pas seul — 90 s observées).
- *Bascule* — très lente (< 25 %, preuves 10 s / 256 Kio) dès 10 s, ou dès que le préchauffage est prêt
  s'il l'est plus tard ; moyenne (25–50 %) à 20 s ; au délai du renoncement (35 s natif, chien de garde de
  20 s serveur) si la lenteur est prouvée. Le lecteur serveur **reprend le préchauffage tel quel**
  (`takePrewarm` : même `PlaySessionId`, mêmes adresses) et hls.js part du segment préchauffé
  (`startPosition`).
- *Saut* — un saut fait en lecture et resté 10 s sans image suit les règles de l'ouverture, mesurées depuis
  le saut ; un saut fait en pause, jamais. Suivi seulement tant qu'un saut attend (armé sur `seeking`,
  arrêté à l'image ou sur `seeked` en pause) : aucun minuteur permanent.
- *En lecture* (`StutterWatch`) — un blocage visible de plus de 5 s, ou le 3e de plus d'1 s en 3 min (la
  fenêtre du budget de reconstructions), classés *réseau* (`playbackDiagnosis` ; serveur : tampon vide au
  début de l'attente) sous un débit mesuré inférieur au besoin. Jamais calcul/décodeur, jamais une attente
  de saut. Préchauffage à la position courante, bascule dès qu'il est prêt, à la position d'alors (la même
  seconde si l'image est restée figée). Une lenteur mesurée sans problème visible ne déclenche **rien**.
  Le préchauffage part **dès le 2e** blocage de plus d'1 s (`waitEndedSignal` → `"prewarm"`,
  `decidePlayback` `early` : préchauffer, jamais basculer ; `SlowLinkRunner.armPlayback` tient le
  déclenchement) — la bascule reste décidée par la règle ci-dessus et trouve le préchauffage prêt. Sans
  déclenchement dans les 60 s (`EARLY_PREWARM_MS`), il est annulé (transcodage arrêté chez Jellyfin). Fil :
  « préchauffage (2e blocage) ». (12/10/2026.)
- *Rechargement WebKit* (`serverReload.ts`) — sur WebKit avec HLS natif (`playsHlsNatively`, la condition
  des deux autres rechargements), une bascule du lecteur natif vers le lecteur serveur — allégée ou repli
  ordinaire — **recharge la page tout de suite** (`shouldReloadDirect`, dans `PlayerHost` `handOver`) au
  lieu d'essayer le HLS natif dans la page : le 12/10/2026 sur iPhone, chaque bascule allégée donnait code 4
  en 1,8 s, trois marches de l'échelle audio, puis le rechargement de dernier recours qui marchait (~10 s
  perdues sur 15,8 ; Safari chargeait les listes et ne demandait aucun segment). L'intention porte position,
  piste, `attempt: 1`, et `carry` : palier, sous-titre du relais, séance du journal poursuivie, instant de
  la décision ; le préchauffage prêt passe la page (`carryPrewarmAcrossReload`, `sessionStorage`, 60 s au
  plus — même `PlaySessionId`, mêmes adresses), un préchauffage pas prêt est arrêté. Jamais pour une
  diffusion, le banc, une ouverture directe au lecteur serveur, ni hls.js ; une fois par séance (une page
  rechargée qui échoue suit l'échelle et l'écran d'avant). Journal : `start` `why: "reload-direct"`,
  `reloadGapMs` (décision → première image) au bilan, plus aucune `ladder` dans ce cas.
- *Palier à travers un rechargement* — `audio-reload`, `retry-reload` et `reload-direct` emportent le palier
  en cours dans l'intention (`carry.lighter` : cible, palier, `real` = vraie bascule ou seulement hérité),
  repris par `play` (`reloadedLighter`, « Automatique » seulement) **à la place** de la mémoire des deux
  minutes : une séance allégée reste allégée après un changement de piste, même la mémoire expirée. Un
  palier hérité le reste (`lighterCarried`, ne réarme rien) ; `lighterReloaded` sur le `start`.
- *Dégressif* — sur le lecteur serveur déjà allégé, les mêmes règles visent le palier suivant :
  `max(1,5, min(précédent / 2, mesuré / 2))` ; au plancher, plus de palier.
- *Écran final* « Lecture impossible : la connexion est trop lente. » (Réessayer · Fermer, qui ferme le
  lecteur) — seulement quand plus aucune bascule n'est possible : réglage « Originale », version allégée
  non permise, ou plancher atteint. Sans lenteur prouvée : l'ancien renoncement, l'ancien motif.
- *Coupure* — une plage qui réessaie (`HttpByteSource`, 4 tentatives à 200 / 600 / 1 500 ms, inchangées) le
  dit à l'hôte (`networkTrouble.ts`, une notification) : « Connexion perdue ou instable… » sous la ligne ou
  sous la roue d'une attente visible ; ni indice, ni préchauffage, ni bascule ; le renoncement attend leur
  issue. Toutes épuisées : l'écran « connexion perdue » (Réessayer, Fermer). hls.js : « Reconnexion… »
  devient ce même message ; Safari inchangé.
- *Message de bascule* « Passage en vidéo allégée en raison d'une connexion lente. » — bref (5 s), en bas
  à gauche au-dessus des commandes (`onChromeEdges`), verre des menus ; une génération de sous-titres en
  cours au passage est dite de même, brièvement.
- *Arrière-plan, mini-lecteur* — page cachée : aucune mesure ne vaut ; une ouverture revenue au premier
  plan repart de zéro (natif `measureEpoch` ; serveur : compteur et chien de garde réarmés). Les blocages
  page cachée ne comptent pas.
- *Qualité* (menu ⋮, `playbackQuality.ts`, par compte et par appareil) — **Automatique** (défaut) ou
  **Originale** (jamais de bascule : l'indice, puis l'écran final). Pas de « vidéo allégée » à la demande.
- *Existence* — bascule et préchauffage seulement avec un lecteur serveur (`PLAYER_SERVER_FALLBACK`) et
  le transcodage vidéo permis au compte (`Policy.EnableVideoPlaybackTranscoding`, `transcodePolicy.ts`,
  relu toutes les 2 min ; l'ouverture ne l'attend jamais plus de 300 ms — au-delà, la dernière réponse
  connue, sinon oui —, une seule lecture en vol par compte) ; sinon le comportement « Originale ». Jamais
  pour le banc d'essai (il mesure le lecteur natif), jamais pour une négociation de diffusion (AirPlay :
  le téléviseur a son propre lien).
- *La cible* (`buildDeviceProfile`, option `lighter`, décidée par le serveur) — débit = moitié du mesuré,
  plancher 1,5 Mbit/s, toujours sous le besoin (30/5 → 2,5 ; 16/10 → 5 ; 0,3 → 1,5). HEVC (Main 8 bits,
  `hvc1`) si l'appareil lit le HEVC 10 bits — le maître de Jellyfin annonce le profil de la *source*
  (Main10) pour une sortie Main —, sinon H.264 ; SDR (mappage de tons) ; largeur maximale par une
  condition `Width` (`MaxWidth` dans PlaybackInfo est ignoré) : HEVC 720p jusqu'à 2,5 Mbit/s puis 1080p ;
  H.264 720p sous 6 Mbit/s (Jellyfin ne sort pas de 1080p en H.264 en dessous) puis 1080p ; jamais plus.
- *Choix gardés* — position, piste audio, sous-titre (index Jellyfin : adresse du fichier à côté, ou rang
  parmi les pistes du conteneur, `embeddedSubtitleIndexes`). Le relais `lighter` est hors `handedOver` :
  la lecture suivante repart sur le natif.
- *D'une lecture à l'autre* — le film reste allégé jusqu'à sa fin. Une lecture lancée moins de 2 min
  après une séance allégée, quel que soit le titre, démarre allégée au dernier palier (`carriedLighter`,
  `playbackQuality.ts`, posé par `PlaybackProvider` ; mémoire de page et `sessionStorage`, liée au compte,
  jamais persistante). C'est **la seule** mémoire de la version allégée : le palier d'une bascule voyage
  sur le relais (`lighter`), et seule une séance réellement allégée le retient à son arrêt. Effacée par
  « Originale » (jamais lue ni écrite hors « Automatique »), et si la *capacité* du lien (débit pendant
  la réception, 10 s) a tenu 110 % du besoin du fichier d'origine pendant 10 s (`LinkRecovery`) :
  `lighterCleared` au bilan.
- *Position* — un battement ou un arrêt que Jellyfin ne reçoit pas garde la position sur l'appareil
  (`unsentPosition.ts`) ; un rapport accepté l'efface ; le reste part au retour du réseau, au lancement et
  chaque minute, par la route d'arrêt `late` (`recoverLostPosition`, n'avance jamais qu'une position).

**Mesuré sur la prod (12/10/2026, i7-8700, UHD 630, QSV).** Réemploi : un seul ffmpeg (même PID, un seul
journal FFmpeg.Transcode) pour préchauffage et lecture, à 5 s comme à 25 s ; segments rejoués en 6 à 9 ms ;
le préchauffage lui-même coûte ~1,3 s (premier segment). Sans `startPosition` (hls.js) ou en HLS natif
Safari, le lecteur demande d'abord le segment 0 puis saute : deux démarrages de ffmpeg, ~1,85 s de plus —
Safari ne peut pas être piloté ici (non vérifié sur appareil). Premier segment seul : 0,9 à 1,7 s ; vitesse
5–6× (4K → 720p), ~5× (4K → 1080p), 12–17× (1080p) ; ffmpeg régulé à ~3 min d'avance. Capacité : le moteur
vidéo du GPU est la limite (~6× de 4K → 720p, ~5× de 4K → 1080p au total) — 4 sessions 4K simultanées
tiennent (720p ≈ 1,4×, 1080p ≈ 1,2× chacune). HEVC et H.264 coûtent pareil ; à 5 Mbit/s le HEVC donne du
1080p, le H.264 du 720p. Le son ré-encodé (AAC 5.1) prend l'essentiel du CPU.

**Simulateur** (page « Tests animations », lot S, administrateur) — un film, lu dans le vrai lecteur sous
un débit réglé à la main (0,2–50 Mbit/s), coupure totale ou de 5 s, et le fil en direct. Bridage dans le
navigateur seulement (`linkSimulator.ts` : `HttpByteSource` et un chargeur hls.js), armé par la page dans
l'onglet courant ; ailleurs `simulatorActive()` est faux et aucune de ses branches n'est prise.

**Journal** — aucune ligne de plus : `slowLink` (fil borné) et `slowChoice` ; `lighterMbps`, `lighterTier`,
`lighterCarried`, `lighterReloaded`, `lighterCleared`, `switch.*` (cause, position avant/après), `prewarm.*`
(débit, palier, état, codecs, résolution, délai, `carried` repris après un rechargement), `switchGapMs`
(interruption jusqu'à l'image du serveur), `reloadGapMs` (rechargement direct : décision → image), `why:
"reload-direct"`, `quality` sur les lignes de bascule et de renoncement. Activité : tout motif commençant par « connexion trop lente » est
rangé avec les connexions lentes, jamais contre le fichier.

**Porteurs.** `slowLinkPolicy.ts` (`openingAdvice`, `decideOpening`, `decidePlayback`, `StutterWatch`,
`nextLighter`, `lighterMaxWidth`, `LinkRecovery`, `SlowLog`), `slowLinkRunner.ts` (§79), `lighterPrewarm.ts`
(`prewarmStatusOf`), `networkTrouble.ts`, `unsentPosition.ts`, `transcodePolicy.ts`, `prewarmSessions.ts`,
`playbackQuality.ts` (`carriedLighter`), `serverReload.ts` (`shouldReloadDirect`, `directReloadIntent`,
`reloadedLighter`), `linkSimulator.ts`, `slowLinkMonitor.ts`. **Appelants.** `ExperimentalPlayerHost`, `PlayerHost` / `ActivePlayer`,
`PlaybackProvider`, `PlayerControls` (Qualité), `usePlaybackSession`, `HttpByteSource`, routes `direct`,
`playback/start`, `playback/stop`. **Tests.** `slowLinkPolicy.test.ts`, `lighterPrewarm.test.ts`,
`linkSimulator.test.ts`, `ExperimentalPlayerHost.test.tsx` (« §78 », « les saccades »),
`PlayerHost-connexion-lente.test.tsx`, `deviceProfile.test.ts`, `jellyfin-playback-start-route.test.ts`,
`playback-stop-late.test.ts`, `unsentPosition.test.ts`, `networkTrouble.test.ts`,
`webcodecs-byteSource.test.ts`, `PlaybackProvider.test.tsx`, `transcodePolicy.test.ts`,
`PlayerControls.test.tsx`, `activity-connexion-lente.test.ts`, `playbackQuality.test.ts`,
`playback-stop-late.test.ts`, `rechargement-direct-webkit.test.tsx`.

**Différent exprès.** Le serveur renonce à 20 s (son chien de garde), le natif à 35 s. Safari en HLS natif
ne mesure rien : inchangé. Le préchauffage n'est pas bridé par le simulateur (seule la lecture l'est).

**Le saut de reprise d'une renégociation n'est pas un saut du spectateur** (22/10/2026,
`resumeSeekPendingRef` dans `PlayerHost.tsx`) : sur hls.js, l'élément n'est pas remonté, et le saut
posé par `startPlayback` après un changement de piste en place, « Réessayer », une marche de l'échelle
ou une bascule allégée comptait `seeks: 1` au bilan et armait `runner.seekStarted()`. Il annule
toujours une attente en cours, sans compter. Les bilans hls.js comptent donc moins de sauts
qu'avant cette date. WebKit n'était pas touché (son décompte repart à chaque négociation).

**Décidé le 12/10/2026.**

**Le panneau d'infos techniques dit ce qui est diffusé (12/10/2026, relevé de Louis).** En version allégée, « Fichier » décrivait la source (4K HEVC Dolby Vision 30 Mbit/s) pendant que l'appareil recevait du HEVC 720p SDR à 1,5 Mbit/s, le titre disait « Transcodage » sans la cause, et le rechargement direct effaçait la note « a cédé la main ». Pour toute lecture transcodée par le lecteur serveur, une section **« Diffusé »** (`describeJellyfinPlayback`, `playbackPanel.ts`) : codec et plage annoncés par la liste maître (`CODECS`, `VIDEO-RANGE` — hls.js : ses niveaux, `attrs` brut car son `videoRange` répond « SDR » par défaut ; Safari : la route les lit dans le maître qu'elle préchauffait déjà, `masterVariantFacts`, aucune requête de plus ; repris d'un préchauffage : son maître), taille décodée (`videoWidth × videoHeight`, suivie au `resize`), débit visé par Jellyfin (`VideoBitrate` + `AudioBitrate` de son adresse, `streamBitrate`). Plage sans maître : SDR en allégée (toujours convertie) ou d'une source SDR, sinon pas de ligne. « Fichier » devient « Fichier d'origine » (avec la plage de la source). Titre « Version allégée » + « Connexion lente : la vidéo est réencodée par le serveur à {débit}… » ; notes « Bascule automatique (connexion lente) à {position} » ou « reprise de la lecture précédente » (règle des deux minutes). La cause du relais et la position de la bascule voyagent dans l'intention (`carry.reason`, `carry.lighter.at`) à travers tout rechargement. **Le besoin du flux serveur** (`streamNeedBps`) est désormais ce débit visé quand Jellyfin transcode : `MediaStreams` décrit la source (vérifié sur la prod — une allégée à 1,5 d'un fichier à 6,8 y gardait 6,1 + 0,4), si bien qu'une séance allégée était jugée contre le débit d'origine (panneau « trop lente » sur un lien suffisant, palier suivant décidé contre le mauvais chiffre). Lecture directe et remultiplexage inchangés. Panneau natif : plus de « SDR » avant que le fichier soit décrit. **Tests** : `panneau-technique-allegee.test.tsx`, `jellyfin-playback-start-route.test.ts` (« panneau technique »).

**Rechargement direct limité aux bascules allégées (12/10/2026, choix de Louis).** `shouldReloadDirect` ne recharge que si le relais porte un palier allégé : les replis ordinaires du lecteur natif vers le serveur sur WebKit gardent leur passage dans la page (5 des 6 replis de « Ruby » sur iPhone y ont marché), les bascules allégées sur iPhone y échouaient toutes (code 4 ×3).

**Retour au premier plan : échéance du premier octet (13/10/2026).** `HttpByteSource` pose l'échéance de 5 s du saut (`SEEK_FIRST_BYTE_MS`) aux requêtes muettes pendant les 15 s qui suivent un retour au premier plan (`WAKE_FIRST_BYTE_WINDOW_MS`), y compris celles déjà en vol, une fois par morceau. Cas réel : iPhone, écran verrouillé 2 min, ~13 s sans un octet au retour, l'avance de 21 s épuisée, 5 s de blocage. La relance se fait pendant que la lecture continue sur son avance ; sur un lien vraiment lent, elle ne change rien. Tests : `webcodecs-byteSource.test.ts` (« retour au premier plan »).

**Un préchauffage appartient à qui le prend, et ne sert qu'à ce pour quoi il a été fait (13/10/2026, chasse aux bugs).** Pris par le lecteur serveur (`takePrewarm`), un préchauffage est à lui seul : prêt quand son segment arrive même s'il a été pris en cours (la bascule des 35 s n'attend pas qu'il soit prêt — il se résolvait « en échec », d'où un second ffmpeg et une séance jamais refermée) ; écarté, il est refermé par `discardTakenPrewarm` — `cancelPrewarm` ne touche jamais un préchauffage pris. Il n'est repris que s'il **convient** (`prewarmFits`) : même palier **et même piste audio**, gravée dans l'adresse du transcodage (un préchauffage du 2e blocage suivi d'un changement de piste jouait l'ancienne piste sous le menu de la nouvelle). Pris ou abandonné ailleurs, il n'est plus tenu par l'exécution (`prewarmGone`, `SlowLinkRunner.status`) : tenu « en cours », il bloquait toute bascule du reste de la séance. Un saut sans image ne reprend qu'un préchauffage fait **à sa position** (à 1 s près) : sinon il est refermé et refait là (un second saut ramenait le spectateur au premier) ; côté serveur, la position d'un saut est la cible de l'élément (`seeking`), la position connue ne bougeant pas tant qu'il n'a pas d'image. Un préchauffage qui ne servira plus est refermé aussi quand le chien de garde du serveur renonce (écran), et dès qu'une décision rend `none` en « Originale ». Hors §78 strict, du même chantier : la position gardée d'une coupure est rangée par compte (`unsentPosition.ts`, l'ancienne clé encore lue) ; le réglage Qualité suit l'événement `storage` (un autre onglet). **Tests** : `lighterPrewarm.test.ts`, `slowLinkRunner.test.ts`, `PlayerHost-connexion-lente.test.tsx`, `unsentPosition.test.ts`, `playbackQuality.test.ts`.

**Le plafond ordinaire ne lit plus `downlink` (15/10/2026, LECTEUR-10, choix de Louis).** `pickMaxBitrate`
(`networkBitrate.ts`), le `MaxStreamingBitrate` de toute négociation ordinaire du lecteur serveur (`ActivePlayer`
et le préchauffage de zone §93), prenait toute valeur de `navigator.connection.downlink` sous 10 pour une
mesure : plafond 0,75 × `downlink`, plancher 1,5 Mbit/s. Relevé sur la prod : 22 % des séances Chrome / Edge /
Android annonçaient moins de 10 (1,45 ; 1,55 ; 4,8…) sur des liens que le lecteur natif du même onglet
mesurait à 15–110 Mbit/s — l'estimateur de Chrome part d'une valeur par défaut et n'apprend rien d'un hôte
proche. Le Grinch (2,5 Mbit/s, 1080p) en sortait ré-encodé en 720p à 1,5 Mbit/s : la charge que le plafond
devait éviter, créée par lui. Désormais seule la classe compte : `slow-2g`/`2g` → `CRAWL` (1,5), `3g` →
`THREE_G` (6,4), tout le reste — `4g`, inconnu, pas d'API (Safari) — `UNCONSTRAINED`. La mesure du lien est
celle de l'app, et elle n'agit que sur un blocage réel (règle ci-dessous). `downlink` reste au journal
(`diag.downlinkMbps`, `downlinkMinMbps`), lu, jamais suivi. **Tests** : `networkBitrate.test.ts` (« ne lit
jamais downlink comme une mesure », « garde la classe 3g quel que soit downlink »).

**Seul un blocage réel agit ; un chiffre ne fait que le qualifier (15/10/2026, règle de Louis).** Indice,
préchauffage, bascule, palier suivant, écran final : chacun part d'un blocage que le spectateur subit — une
ouverture ou un saut **sans image** depuis un délai, une **attente** (`waiting`) en pleine lecture, tampon vide
ou horloge figée. Le débit mesuré et le besoin du flux ne font que dire si ce blocage tient au réseau (et
choisir le palier) ; seuls, ils ne déclenchent jamais rien — ils vont au journal et au panneau technique.
*Pourquoi* : deux chiffres faux ont suffi à agir. `downlink` sous 10 bridait le plafond ordinaire sans que
rien ne bloque (paragraphe précédent) ; et le « besoin » d'un transcodage sans plafond valait 100 Mbit/s, le
plafond que Jellyfin recopie dans `VideoBitrate` (LECTEUR-9) — tout lien y paraissait « trop lent », si bien
qu'une attente de décodeur était rangée « réseau » et pouvait basculer. Le besoin est désormais le débit visé
quand il en est un (`transcodeTargetBps`, `slowLink.ts` : une somme à 95 % du plafond envoyé, hors version
allégée et sans source plus lourde, rend `null` — le besoin retombe sur la source) ; le panneau ne dit plus
« Diffusé 100 Mb/s » pour un fichier de 2,5.

*Ce qui décide d'une action, et ce qui la déclenche* (relu dans les deux hôtes le 15/10/2026) :
- ouverture, chaque seconde tant qu'aucune image (`decideOpening` ; natif : intervalle arrêté à `ready` ;
  serveur hls.js : `linkWatch`, arrêté à `loadeddata`) — préchauffage à 8 s, bascule à 10 s / 20 s :
  **l'ouverture sans image** depuis ce délai ; la mesure (< 50 %, < 25 %) qualifie ;
- renoncement (minuteur des 35 s du natif, chien de garde des 20 s du serveur) — bascule ou écran : **pas
  d'image au délai** ; `slowLinkVerdict` qualifie ;
- saut (`SlowLinkRunner.seekTick`) — **un saut en lecture resté 10 s sans image** (jamais en pause) ;
- en lecture (`StutterWatch` → `decidePlayback`) — **une attente** de plus de 5 s, ou la 2e / 3e de plus
  d'1 s en 3 min, après la première image, hors saut ; classée réseau (natif : `playbackDiagnosis`,
  serveur : tampon vide) **et** sous un débit mesuré inférieur au besoin ;
- préchauffage prêt (`playbackDecision`) — ne bascule que si la règle de lecture a déjà joué
  (`armPlayback`) ;
- mémoire des deux minutes (`carriedLighter`) — posée seulement par une séance réellement basculée ;
- plafond ordinaire (`pickMaxBitrate`) — la classe annoncée, jamais `downlink` (corrigé ce jour).
**Seule exception, voulue** : `LinkRecovery` *efface* la mémoire des deux minutes sur la seule mesure (110 %
du besoin d'origine tenus 10 s). Elle ne fait que lever une restriction — la lecture suivante revient au
comportement ordinaire —, jamais en poser une. **Tests** : `ExperimentalPlayerHost.test.tsx` et
`PlayerHost-connexion-lente.test.tsx` (« un lien mesuré très lent sans aucun blocage : ni préchauffage ni
bascule »), `jellyfin-playback-start-route.test.ts` (« débit visé : le plafond recopié… »),
`networkBitrate.test.ts`.

**Les vignettes de la barre après la première image (15/10/2026, LECTEUR-6, choix de Louis).** `PlayerControls`
préchargeait toutes les planches trickplay au montage, avant le film : sur un lien à 2 Mbit/s, neuf planches
(≈ 7 Mo) tenaient le lien de 13 à 39 s, l'init du film n'était demandée qu'à 30 s, la première image venait à
42 s. Le préchargement reste automatique (le « premier toucher » du 08/10 reste écarté) ; il part au `playing`
de l'élément, ou dès `readyState` ≥ 3 hors d'un saut (film mis en pause à l'ouverture, commandes remontées sur
un film qui joue) — jamais sur le `canplay` de la position 0 que le lecteur serveur a avant son saut de
reprise. La planche de la position d'abord, puis les plus proches, **une requête à la fois**
(`trickplayTileIndex`, `trickplayTileOrder`, `trickplayTile.ts` ; l'effet vit dans `useTrickplay`). Sur un bon lien, toutes sont là en une ou
deux secondes. **Tests** : `PlayerControls.test.tsx` (« les vignettes de la barre, préchargées après la
première image »).

## 79. La connexion lente s'exécute à un seul endroit pour les deux lecteurs

**La règle.** Ce que `slowLinkPolicy.ts` décide (§78) est exécuté par **une** classe, `SlowLinkRunner`
(`src/lib/slowLinkRunner.ts`) : tenir le préchauffage (un seul), le lancer, le laisser tomber (à l'image,
à la fermeture, à l'écran final), montrer l'écran « Lecture impossible… », renoncer comme avant, et suivre
le saut resté sans image (le « saut traité comme une ouverture » : 10 s, puis 35 s — `SEEK_AS_OPENING_MS`,
`SEEK_GIVE_UP_MS`). L'état du préchauffage pour la décision s'écrit une fois, `prewarmStatusOf`
(`lighterPrewarm.ts`). Seule la **bascule** reste à chaque hôte, parce qu'elle est réellement différente :
le natif passe la main (`fallToStable`, relais `lighter` qui porte le palier), le lecteur serveur
renégocie (`startPlayback`, `why: "lighter"`). Chacun rattache ce qu'il sait de lui (`attach`) : sa mesure,
sa position, son écran.

**Pourquoi.** Écrite dans les deux hôtes le 12/10/2026, la même exécution avait divergé en un jour : un
saut fait en pause effacé côté serveur et pas côté natif (dix secondes plus tard, un film en pause se
faisait préchauffer et basculer), deux intervalles d'une seconde permanents, la conversion de l'état du
préchauffage écrite quatre fois. Relevé par une relecture indépendante.

**Appelants.** `ExperimentalPlayerHost`, `ActivePlayer` (PlayerHost.tsx).

**Tests.** `ExperimentalPlayerHost.test.tsx` (« les saccades » : saut en pause, minuteur de 5 s qui meurt
avec le pipeline, banc d'essai), `PlayerHost-connexion-lente.test.tsx`, `lighterPrewarm.test.ts`
(`prewarmStatusOf`, abandon interrompu). `decisions-partagees.test.ts` fait échouer le retour d'un
`startPrewarm`, d'une conversion d'état ou d'un délai de saut dans un hôte, et d'une seconde mémoire du
palier.

**Différent exprès.** Le serveur compte un saut depuis le premier d'une série (il ne relance pas le compte
à chaque `seeking`), le natif depuis le dernier — le comportement de chacun avant le partage. Le serveur
n'a pas de `giveUp` : son chien de garde des 20 s renonce lui-même.

**Décidé le 12/10/2026.**

## 80. Les refus du serveur s'affichent par leur code, dans la langue du compte

**La règle.** Une route qu'un spectateur atteint répond `{ error, code }` : `error` en français pour le
journal et l'administration, `code` pris dans `API_ERROR_CODES` (`src/lib/apiErrorCodes.ts`, qui reprend
`upstream_unreachable` et `file_missing`). L'écran ne cite jamais `error.message` lui-même : il passe
par `apiErrorText` (`src/lib/apiErrorText.ts`, ou le crochet `useErrorText`) — code connu →
`errors.codes.<code>` ; sans code, le message n'est cité qu'à un compte en français, les autres lisent le
repli de l'écran ou `errors.generic`. Côté serveur, `HttpError` porte un `code` que `withErrorHandling`
renvoie ; les refus de Jellyseerr à une demande sont nommés par `withRequestRefusalCode`
(`requestRefusal.ts` : 409 déjà demandé, 403 « quota », autre 4xx refus ; un 401 reste sans code).

**Pourquoi.** « Le nouveau mot de passe est identique à l'actuel », « Jellyseerr ne reconnaît pas encore
ce compte », « 409 Conflict: {…} » arrivaient tels quels aux comptes en anglais, espagnol et allemand
(chasse aux bugs du 13/10/2026).

**Appelants.** `usePlayerTitleActions`, `useAddToWatchlist`, `useTitleWatched`, `useJellyfinItemState`,
`PlayerAccountPanel`, `NotificationChoices`, `PlayerOnboarding`, `PushToggle`, `PlayerPersonSheet`,
`PlayerDiscoverSheet`, la négociation de `PlayerHost`, et `errorMessage` (`upstreamError.ts` : catalogue
des deux accueils, informations du fichier du lecteur natif), qui garde « la bibliothèque ne répond pas ».

**Tests.** `apiErrorText.test.ts` : route → `apiAction` → texte, pour un compte en anglais (mot de passe
identique ou refusé, demande déjà faite, quota, compte non reconnu, Ma liste) ; un message sans code ne
laisse passer aucun français ; chaque code a son texte dans les quatre langues.

**Différent exprès.** Les écrans de gestion (`/gestion`, administrateur, en français) citent toujours le
message du serveur, détail technique compris. Les signalements gardent leurs propres codes
(`reportErrorText`). Les raisons internes du lecteur (refus du remux, écran d'erreur natif) ne sont pas des
réponses de route et restent hors de ce mécanisme.

**Décidé le 13/10/2026.**

## 81. Répartition des réglages et des deux interfaces

**La règle.** Trois endroits, chacun pour un sujet, et un seul passage dans chaque sens entre les
deux interfaces :
- **Compte** (cinéma, tous les comptes) : ce qui est *personnel* — langue, notifications, sessions,
  sous-titres, interface, Ma liste. L'administrateur règle les siennes là, comme tout le monde.
- **Compte → Administration** (cinéma, administrateur) : *CineApp et ses utilisateurs* — l'Activité
  (comptes, séances, signalements, journaux), la maintenance, les Nouveautés, les bancs d'essai.
- **Gestion** (`/gestion`, administrateur) : l'*installation*, en deux parties —
  **Infrastructure** (accueil en tableau de bord : téléchargements en cours, état des services,
  disque, résumé de l'Activité ; puis Films, Séries, Téléchargements, Calendrier, Statistiques,
  Imports, et les pages des services) et **Configuration** (Connexions, Lecture, Diffusion et
  hors-ligne, Livres ; les Fonctions intelligentes ; Nouveaux comptes, Administrateur, et en dernier
  Déploiement — ce qui exige de toucher au compose, expliqué avec la ligne à copier). La répartition
  des pages de la Configuration elle-même, et la façon dont une fonction dit ce qui lui manque : §142.
- **Les ponts** : « Ouvrir la gestion » dans le panneau Compte ; « Retour au cinéma » en tête de la
  navigation de la gestion (barre latérale et feuille du téléphone). Aucun autre lien ne traverse,
  sauf le lien discret « Vos préférences sont dans Compte » sous la Configuration, et le résumé de
  l'Activité de l'accueil qui ouvre le panneau Activité.

**Pour tout futur réglage.** S'il ne vaut que pour la personne qui le touche → Compte. S'il dit
comment l'installation se comporte pour tous et peut changer à chaud → schéma des réglages
(`src/lib/settings/schema.ts`, lu par `config.ts` : réglage de l'application → `.env` → défaut, §48)
et une carte de la Configuration ; s'il ne prend effet qu'au redémarrage, son libellé le dit. S'il
demande un volume, un port ou un secret de démarrage → `DEPLOYMENT_GUIDE` (jamais réglable dans
l'application : `SESSION_SECRET`, `TRUSTED_PROXIES`, `COOKIE_SECURE`, les clés VAPID générées). Une
couleur ou une apparence n'est pas un réglage d'administrateur : la couleur d'accent a été
supprimée, l'accent est fixe (une préférence restée sur un appareil n'est plus lue) — violet ce
jour-là, blanc neutre depuis (§83).

**Pourquoi.** La page « Paramètres » de la gestion mêlait la langue, la couleur d'accent et les
sessions de l'administrateur aux adresses et clés de l'installation ; les notifications s'y
réglaient en double avec le Compte jusqu'au 23/09. L'accueil de la gestion refaisait le cinéma en
moins bien (bannière, Reprendre, Ma liste, affiches récentes) et coûtait un logo TMDB et une note
IMDb par titre à chaque rafraîchissement. Et « Activité récente » (`/timeline`, les imports de
Radarr et Sonarr) portait le nom du panneau Activité du cinéma : elle s'appelle **Imports**.

**Porteurs.** `src/components/navItems.ts` (`NAV_GROUPS` avec `part`, `NAV_PARTS`, `activeNavHref`),
`src/components/gestion/NavBridge.tsx` (`BackToCinema`, `AccountPreferencesLink`),
`src/components/settings/ConfigurationSection.tsx` (les cartes d'une page de Configuration),
`src/lib/activity/summary.ts` (`liveAccounts`, `pendingReports`, `activityDigest` — la règle de
« présent / regarde / en attente », partagée avec `ActivityOverview`).

**Appelants.** `Sidebar`, `MobileNav`, `DashboardClient`, les pages `src/app/(dashboard)/parametres/**`
(`/parametres/connexions` redirige vers `/parametres`).

**Tests.** `navItems.test.ts` (deux parties, ordre, pont, Imports dans les quatre langues, ni
langue ni sessions ni accent dans la gestion, plus de thème), `activity-summary.test.ts`,
`dashboard-route.test.ts` (plus de bannière ni de Reprendre), `design-tokens.test.ts` (étendu à la
gestion), `settings-couverture.test.ts`, `settings-config.test.ts`.

**Différent exprès.** La gestion reste en français pour ses messages techniques (§80) ; son
vocabulaire peut parler de services et de déploiement, mais pas de « tableau de bord » à l'écran
(`vocabulaire.test.ts`) : l'accueil s'appelle « Vue d'ensemble ».

**Décidé le 13/10/2026.**

---

**Galerie retirée le 13/10/2026, tag `fin-galerie-clara-2026-10-13`.** La page personne enrichie
(galerie de photos, diaporama public, actualités), ses routes (`/api/gallery/clara/*`,
`/api/news/clara`, `/api/vip/[id]`), son option `CLARA_GALLERY_ENABLED` et son montage sont
supprimés ; toute personne ouvre la fiche ordinaire. La version de format du cache sur l'appareil
passe à 12 (`claraGallery` quittait la configuration publique). Le tag garde le dernier état complet.

---

## 82. L'Activité : le direct relu à chaque appel, seuls les appareils Jellyfin gardés une minute

**La règle.** La vue d'ensemble de l'Activité (`/api/admin/activity`, relue toutes les vingt
secondes page ouverte, et par le résumé de l'accueil de la gestion) relit **à chaque appel** ce qui
vit : les comptes et les lectures en cours chez Jellyfin (`/Users`, `/Sessions`), la présence, les
séances du journal du lecteur (lu par sa fin, `logReader.ts`), les signalements. **Seule** la liste
des appareils Jellyfin passe par un cache — `cachedJellyfinDevices` (`server-cache.ts`) : gardée une
minute, puis rendue telle quelle pendant qu'une relecture part en arrière-plan
(`withBackgroundRefresh`), et attendue de nouveau après dix minutes sans lecture. La fiche d'un
compte lit la même.

**Pourquoi.** Mesuré le 13/10/2026 depuis le conteneur : `/Devices` répond en 780 à 990 ms (93 Ko),
`/Users` en 95 à 185 ms, `/Sessions` en 5 à 20 ms ; le calcul sur les journaux réels (13 300 lignes
du lecteur sur trente jours, 1 291 séances) coûte 35 à 52 ms à chaud, 266 ms à froid — une fois par
démarrage (`activite-bench.spec.ts`). L'ouverture attendait donc surtout les appareils, qui ne servent
qu'à dater le dernier passage d'un compte chez Jellyfin : l'alerte « Jellyfin ne le voit plus » ne
compare qu'à un jour d'écart, et la fiche affiche une date absolue — une minute d'âge n'y change rien.
Les statistiques de la semaine et du foyer ne sont **pas** mises en cache : elles se recalculent en
moins de 50 ms, et un cache invalidé par la taille des journaux serait vidé à chaque ligne d'un
spectateur en train de regarder — de la complexité pour rien, et le risque d'un chiffre périmé.

**Porteurs.** `withBackgroundRefresh`, `cachedJellyfinDevices` (`src/lib/server-cache.ts`).

**Appelants.** `listAccounts` et `accountDetail` (`src/lib/activity/accounts.ts`).

**Tests.** `activity-direct-serveur.test.ts` (une séance qui démarre puis s'arrête se voit à l'appel
suivant, trois appels pour une seule liste d'appareils ; le contrat de `withBackgroundRefresh`),
`activity-overview-direct.test.tsx` (la page ouverte montre la séance démarrée puis arrêtée à la
relecture suivante, sans recharger).

**Différent exprès.** Les comptes (`/Users`) restent lus à chaque appel bien qu'ils coûtent 100 ms :
un compte désactivé ou créé doit se voir à la relecture suivante.

**Décidé le 13/10/2026.**

---

## 83. L'accent est blanc neutre ; la couleur ne dit qu'un état

**La règle.** L'interface n'a plus de couleur à elle : ce qui est principal, sélectionné, en cours,
mis en avant ou focalisé est **blanc**, façon Apple TV (les états personnels — vu, dans ma liste,
reprise, compteurs — sont passés au violet de la marque le même jour : voir « Option B » plus bas) —
boutons principaux (fond blanc, texte noir,
grisé d'un cran au survol et à l'appui), barres de progression (Reprendre, épisodes, lecteur,
mini-lecteur, téléchargements, jauges), pastilles et compteurs (fond blanc, chiffre noir),
interrupteurs activés (rail blanc, pastille noire), puces retenues, cases et curseurs natifs
(`accent-color` hérité depuis `html`), anneaux de focus, liens et icônes mis en avant. Le rouge,
l'orange et le vert ne disent qu'un **état** : `danger`, `warning`, `success`. Les couleurs de séries
des graphiques et les catégories du journal (bleu des sauts, violet des séances servies par le
serveur) ne sont pas des états et gardent leurs teintes.

**Comment.** Au niveau des jetons : l'échelle `--accent-*` reste nommée ainsi — ses centaines
d'emplois ne bougent pas —, mais elle est un gris pur, et 400 à 600 sont du blanc plein. Seuls les
endroits où un texte blanc était posé sur un fond d'accent plein ont changé (`text-ink`) ; un fond
d'accent translucide (`/15`, `/22`) sous un texte blanc reste lisible et n'a pas bougé. Là où l'accent
se posait sur le sélecteur blanc des fiches (barre de « Reprendre » d'une ligne de menu, pastille
d'une action accomplie), il suit désormais la couleur du texte (`bg-current`). Les icônes de
l'application et les écrans de lancement sont redessinés en blanc sur gris neutre, depuis
`public/icon-flat.svg`.

**Le verre de la gestion, en sourdine.** Le même jour : dans la gestion (`.gestion-liquid`, et les
fenêtres ouvertes depuis elle — `body:has(.gestion-liquid)`), `--glass-fill` devient un voile plat à
peine plus clair que le noir et `--glass-edge` un liseré fin d'un seul trait, sans reflet en haut.
Le reflet et le bord brillant du verre de §45 sont faits pour des pilules posées sur une image qui
bouge ; sur des dizaines de cartes alignées, ils devenaient un effet. Le cinéma garde son verre.

**Porteurs.** `src/app/globals.css` (`:root` de l'accent, `btn-primary`, `chip-on`, `accent-color`,
le verre de la gestion), `src/components/Toggle.tsx`, `MENU_BADGE_ACTIVE` (`detailMenu.ts`).

**Tests.** `design-tokens.test.ts` : chaque teinte de l'échelle est un gris pur, 400 à 600 sont
blancs, et aucun fond d'accent ou blanc à 50 % et plus ne porte un texte blanc ou clair dans la même
chaîne de classes — variantes comprises (`hover:bg-accent-600` sur un `text-white` de base).

**Différent exprès.** `btn-on` (l'option retenue d'un bouton discret : « dans ma liste ») reste un
voile blanc à 22 % et non un blanc plein : plein, il se lirait comme l'action principale de l'écran.
Le badge rouge « Nouveau » et les couleurs des sites liés depuis une fiche personne restent ce qu'ils
étaient (§ « une couleur par état »). Le laboratoire d'animations garde ses matières d'essai.

**Décidé le 13/10/2026.**

**Option B : blanc = action, violet de marque = état personnel, couleurs = états système (Louis,
13/10/2026, le même jour).** Tout blanc, « vu » ne se distinguait plus de « marquer vu », ni une
barre de reprise d'une barre de téléchargement. La règle devient à trois termes :
- **Blanc** : ce qu'on *fait* — boutons principaux, focus, onglets et puces retenus, interrupteurs,
  liens, la pilule des barres de navigation. Inchangé.
- **Violet de la marque** (celui du logo) : ce qui est *à moi* — la coche et l'état « Vu » (cartes,
  fiches, épisodes, menus des fiches), « Dans ma liste » (bouton `btn-mine`, icônes, pastille du
  menu), les barres de progression de reprise (cartes Reprendre, bannière, fiches, épisodes, ligne
  « Reprendre » du menu), les pastilles
  de compteur (signalements, réponses non lues, Activité). Le téléchargement en cours, une jauge,
  un graphique ne sont pas « à moi » et restent blancs ou à leurs teintes.
  **Sauf la partie lue de la barre du lecteur (et du mini-lecteur), rendue au blanc le 14/10/2026
  par Louis** : violette un jour, seul élément coloré pendant un film ; un lecteur façon Apple
  s'efface devant l'image, et dans le lecteur la barre est forcément la sienne. `design-tokens.test.ts`.
- **Rouge, orange, vert** : `danger`, `warning`, `success`, et rien d'autre — « Vu » en vert dans
  les fiches de la gestion passe au violet, « déjà dans la liste » aussi.

Deux teintes, deux jetons (`globals.css`, `@theme`) : `brand` = `rgb(155 140 255)`, le violet du
logo, pour une coche, une icône ou une barre posée sur le noir (7,2:1 sur `ink`) ; `brand-strong` =
`rgb(110 90 230)` pour un fond plein sous un texte ou une icône blanche (4,9:1 — `brand` sous du
blanc ne fait que 2,8:1). La pastille d'état du menu des fiches (`MENU_BADGE_ACTIVE`) est un fond
`brand-strong` à icône blanche à elle : lisible au repos comme sous le sélecteur blanc, où la ligne
devient noire. La barre « Reprendre » d'une ligne de menu est `brand-strong` pour la même raison ;
celle du bouton principal blanc, un voile `brand/35`. La pastille qu'on saisit sur la barre du
lecteur reste blanche : c'est une action. `btn-on` reste le voile blanc d'une option retenue
(onglets, vues) ; `btn-mine` est son pendant pour un état personnel.

Porteurs : `ProgressFill` (toutes les barres de reprise des cartes, de la bannière et des épisodes),
`MENU_BADGE_ACTIVE` (`detailMenu.ts`), `PlayButton`, `btn-mine` et `.player-seek` (`globals.css`),
`NavDot`. Tests : `design-tokens.test.ts` (« le violet de la marque dit ce qui est à moi » : teintes
et contrastes, chaque surface porte le violet, **aucun violet hors d'une liste de fichiers tenue à
la main**, jamais de texte blanc sur `brand`), `cinemaDetailMenu.test.ts`.

**Seule exception : le logo de l'application reste violet (Louis, 13/10/2026).** Icônes PWA (`public/icon-*.png`, SVG), favicon, écrans de lancement et logo de la page de connexion (qui affiche `icon-512.png`) gardent le clap violet : c'est la marque. Tout le reste de l'interface suit l'accent blanc neutre. *(Remplacé le 23/10/2026 : voir « L'or » plus bas.)*

---

**Le faisceau (23/10/2026, nouveau logo).** La barre de progression d'une vignette (`ProgressFill` : cartes,
rangées, bannière, épisodes) porte le dégradé du logo, violet → bleu (`bg-beam`, globals.css). C'est la
seule surface qui le porte, sur décision du propriétaire : un premier essai l'étendait au voile du bouton
Reprendre, aux marques « vu » / « à voir », aux pastilles et à la partie lue du lecteur ; il a été retiré
le jour même. Ces surfaces gardent le violet, et la barre du lecteur reste blanche. Test :
`design-tokens.test.ts` (« le faisceau ne sert qu'à la barre de progression des vignettes »).

**L'or (23/10/2026, décision du propriétaire).** « Ce qui est à moi » passe du violet à l'**or**, et le
logo devient « aplat et faisceau or » (§118) : **le logo : L blanc, faisceau or — la lumière de la
lanterne est la couleur de ce qui est à moi.** Raison : sortir du registre violet/cyan des produits
d'IA. L'accent reste blanc, la barre du lecteur reste blanche ; la règle à trois termes ne change pas,
seule la couleur du deuxième terme change. Les paragraphes plus haut qui disent « violet » se lisent
« or » depuis ce jour, avec les valeurs qui suivent.
- `brand` = `rgb(251 191 36)` (`#fbbf24`), l'or plein : icône, coche, point ou barre sur le noir
  (11,8:1 sur `ink`), **et fond plein sous une icône ou un chiffre noir** (`text-ink`, 11,8:1). Le blanc
  sur l'or ne fait que 1,7:1 : il n'y en a nulle part. Pastille d'état des menus (`MENU_BADGE_ACTIVE` :
  `bg-brand text-ink ring-1 ring-brand-strong`), coche d'un épisode vu (fiches bureau, téléphone,
  hors ligne, partage, menu « Épisodes » du lecteur : or plein, `Check` noire), compteurs du panneau
  Compte (or, chiffre noir), `btn-mine` (or plein, texte et icône noirs ; survol `bg-brand/85`).
- `brand-strong` = `rgb(180 83 9)` (`#b45309`), un ambre sombre de la même famille : là où l'or se pose
  sur du blanc — la barre « Reprendre » d'une ligne de menu, lisible sous le sélecteur blanc (5,0:1
  contre le blanc, 3,9:1 sur `ink`, où l'or plein ne ferait que 1,7:1 sous le sélecteur) et le liseré
  de la pastille d'état. Un blanc y serait lisible (5,0:1), mais l'or plein à icône noire est préféré
  partout où une surface porte un signe : l'ambre brun sous du blanc paraît terne.
- Le voile du bouton Reprendre reste `brand/35` sur le bouton blanc, texte noir (plus de 15:1).
  « Vu » dans les fiches de la gestion : `bg-brand/15 text-brand` (était `bg-brand-strong/30`).
- `bg-beam` (la barre de progression des vignettes, `ProgressFill`, seule porteuse) : dégradé or de
  gauche à droite, `#f59e0b` → `#fde68a` (9,2:1 et 15,9:1 sur `ink`).
- **Les graphiques quittent la couleur de la marque** : les séances par jour de l'Activité (barres et
  légende), les ajouts mensuels, la qualité, les langues et l'encodage des Statistiques portaient le
  violet depuis le 14/10 ; une barre de graphique n'est pas « à moi », et l'or y aurait touché le
  `warning` (`#fcd34d`) des problèmes posés sur les mêmes barres. La série principale y est un blanc
  neutre (`bg-white/60` pour une série seule, `bg-white/80` à côté des séries bleues et vertes, que
  le reste garde). Ces trois fichiers sortent de la liste de `design-tokens.test.ts`.
- À surveiller à l'œil : l'or plein (`#fbbf24`) et le `warning` (`#fcd34d`) sont voisins. Aucune
  surface ne les met aujourd'hui côte à côte ; un état d'alerte posé sur une vignette à barre or
  serait le premier.

Tests : `design-tokens.test.ts` (« l'or de la marque dit ce qui est à moi » : l'or vaut `#fbbf24` et se
lit sur le noir, il porte une icône noire et pas une blanche, `brand-strong` se lit contre le blanc et
reste chaud ; chaque surface porte l'or ; aucun or hors de la liste ; jamais de texte blanc sur l'or
plein ; **ni d'icône blanche dans une pastille or** — nouveau, le test d'avant ne voyait pas l'icône
enfant ; le faisceau : ses deux arrêts, lisibles sur le noir, une seule porteuse),
`cinemaDetailMenu.test.ts` (la pastille active est `bg-brand`, liseré `brand-strong`, texte `text-ink`).

**L'or, discret (23/10/2026, le propriétaire).** « L'or discrètement, pas en énorme sur les boutons de reprise » : le bouton Reprendre porte un trait or de 3 px à son pied (`bg-brand-strong`, 5,0:1 contre le blanc) au lieu d'un voile sur toute sa hauteur ; « Dans ma liste » (`btn-mine`) est un bouton fantôme à icône et texte or (`bg-white/10 text-brand`) et non un aplat or ; la pastille d'état des menus est un rond sombre cerclé d'or à icône or (`bg-ink text-brand ring-brand/60`), lisible sur la ligne sombre comme sous le sélecteur blanc. Les petites marques (coches d'épisode vu, compteurs) gardent l'or plein à signe noir.

## 84. Pendant un film, un seul battement — et rien au journal qui ne soit lu

**Règle.** Pendant une lecture, le navigateur ne parle au serveur que lorsque quelque chose arrive,
plus un battement de progression toutes les **30 s** en lecture sans événement (60 s en pause). Tout
événement part à l'instant : pause, reprise, saut (relus chaque seconde, sans réseau), changement de
piste (`reportNow`), page cachée, `pagehide`, fermeture, épisode suivant (une nouvelle séance), retour
du réseau (`online`, et la file `unsentPosition`). Ce battement **porte la présence** (la route de
progression l'enregistre, `recordPlaybackBeat`) **et l'état de maintenance** (`noteMaintenanceState`) :
tant qu'un battement a réussi depuis moins de 90 s (`progressBeatFresh`), `PresencePinger` ne fait plus
son signal de la minute pendant le film et `/api/maintenance` n'est plus interrogée sous un film plein
écran ; le battement cessant, les deux reprennent d'eux-mêmes. Hors film, rien ne change (présence à la
minute, maintenance à 15 s), et les signaux immédiats de la présence (ouverture et fermeture d'un film,
arrière-plan, `pagehide`) restent.

Au journal du lecteur, **la réserve d'avance n'écrit plus en marche** : ni `reserve/point`, ni
`reserve/départ`, ni l'`arrêt` ordinaire. Son plafond et son débit voyagent sur `start`
(`reserveAllowedMB`, `reserveSpeedMbps`) ; son bilan sur `stop`, sous `diag.*`, cumulé sur tous les
pipelines de la séance (`reserveNetMB`, `reserveBursts`, `reserveEmptied`, `reserveEmptiedMB`,
`reserveMaxAheadMB`, `reserveMaxAheadS`, `reserveS`, `reserveFetchMbps`, `reserveRuns`, `reserveIdle`).
Restent `reserve/erreur` et l'`arrêt` que la réserve décide seule (session partie). Le bilan de secours
(`unsentStop`) est écrit exact et entier à chaque passage en arrière-plan et à `pagehide` ; entre deux,
il n'est réécrit — centiles lus sur un échantillon de 200 valeurs — que s'il a changé (un événement, ou
deux minutes de plus regardées), un signe de vie de quelques octets sinon. Les `steps` des `opening` et
`seek` réussis, et toutes les lignes d'incident, restent tels quels.

**Pourquoi.** Relevé du 13/10/2026, par heure de film : ≈ 320 POST de progression (battement de 10 s),
73 `/api/presence`, 60 `/api/maintenance`, ≈ 59 envois au journal du lecteur (≈ 40 Ko), dont 34
`reserve/point` que rien ne lisait — ni la page Activité, ni le banc, ni le plan du banc — et des
`départ`/`arrêt` qui redisaient `start` et `stop.diag.reserve*`. Chaque requête réveille la radio d'un
téléphone entre deux rafales de la réserve. Et toutes les 30 s, `saveUnsentStop` triait jusqu'à 2 000
valeurs (médiane, 90e centile, ~1,5 ms) et réécrivait ~2 Ko dans `localStorage` pour une copie qui ne
sert qu'à une page tuée. Estimation après : ~120 battements, 0 présence, 0 maintenance, ~25 envois au
journal par heure de film.

**Porteurs.** `usePlaybackSession` (`HEARTBEAT_MS`, `WATCH_MS`, `reportNow`) ; `progressBeat.ts`
(`noteProgressBeat`, `progressBeatFresh`, `forgetProgressBeat`) ; `recordPlaybackBeat`
(`src/lib/activity/presence.ts`) appelé par `/api/jellyfin/playback/progress` ; `maintenanceFedByPlayback`
(`useMaintenance.ts`) ; `MemoryReserve` (`reservePlanFacts`, `ReserveRun`) et `diagReserve` /
`diagSessionFacts({ exact })` (`playbackDiagnosis.ts`) ; `touchUnsentStop` (`unsentStop.ts`).

**Appelants.** `ExperimentalPlayerHost` (ligne `start`, bilan de secours — `playerNative/useNativeSessionRecord.ts` —,
`reportNow` aux changements de piste), `PlayerHost` (`reportNow` aux changements de piste), `ChromecastPlayer` (le même battement),
`PresencePinger`, `useMaintenance`.

**Tests.** `usePlaybackSession.test.ts` (30 s sans événement, ~120 par heure ; pause, reprise, sauts à la
seconde ; `reportNow` ; `online` ; `visible` et fraîcheur du battement), `battement-presence-maintenance.test.tsx`
(présence et maintenance muettes tant que le battement passe, reprises quand il cesse, inchangées hors
film), `playback-progress-route.test.ts` (présence enregistrée, titre gardé), `webcodecs-memoryReserve.test.ts`
(ni départ, ni point, ni arrêt ordinaire ; l'arrêt pour session partie reste), `webcodecs-playbackDiagnosis.test.ts`
(bilan cumulé sur deux pipelines, centiles approchés), `unsentStop.test.ts` (signe de vie, bilan perdu
entier), `ExperimentalPlayerHost.test.tsx` (« ne réécrit le bilan que s'il a changé »).

**Différent exprès.** Le relais du serveur pour une diffusion (`castProgress.ts`) ne change pas : la page
qui bat toutes les 30 s (60 s en pause) reste « vivante » sous `PAGE_FRESH_MS` (150 s), et la séance
d'un lecteur sans annonce (lecteur serveur, diffusion) envoie son premier battement dès la première
seconde, comme avant dans les dix. L'Activité ne lit aucun battement pour dire une séance terminée : la
présence expire à 150 s (`PRESENCE_TTL_MS`), au-dessus des 60 s du battement en pause. Le prix
accepté : pendant un film, l'avis de redémarrage arrive en 30 s au plus (10 s avant), et une page
plantée en plein écran sans passer en arrière-plan perd au plus 30 s de position et deux minutes de
`watched` dans son bilan perdu.

**Différent exprès entre les deux hôtes (déclaré le 22/10/2026).**
- *Le bilan gardé.* Le natif le réécrit seulement s'il a changé, sinon `touchUnsentStop` ; copie exacte
  à `pagehide`. Le lecteur serveur le réécrit entier toutes les 30 s et au passage en arrière-plan,
  rien à `pagehide` : son bilan est petit (~1 Ko, sans centiles triés) et ne sert qu'à environ une
  séance sur six. Aligner demanderait la signature du natif pour un gain de quelques octets.
- *Une page mise en cache par le navigateur (bfcache).* Le natif envoie toujours `stop "page"` à
  `pagehide`, et un `pageshow` persistant rouvre la séance (`lifecycle.reopenStop`) ; le lecteur
  serveur n'envoie rien sur un `pagehide` persistant, le bilan gardé suffit (faf15338). Les deux
  aboutissent au même dernier `stop` par séance, que la lecture garde ; le natif peut écrire un
  `stop "page"` provisoire suivi d'un autre.

**Décidé le 13/10/2026.**

## 85. La grille complète est faite de paquets de rangées entières

**Règle.** « Tous les films », « Toutes les séries » (`CinemaBrowseSheet`) ne sont plus une seule
grille CSS : la liste est coupée en paquets de `ROWS_PER_CHUNK` (8) rangées, chacun sa propre grille,
empilés à l'écart d'une rangée. Le paquet porte `content-visibility: auto` (hauteur supposée : ses
rangées × la hauteur mesurée d'une carte, plus les écarts), ses cartes aussi. **Un paquet tient
toujours un nombre entier de rangées** — sinon une rangée incomplète trouerait le milieu de la liste :
le nombre de colonnes n'est donc plus laissé à `auto-fill`, il est calculé (`gridColumnsFor`, même
règle que `grid-cols-3 … player-grid-fluid`) et posé sur chaque paquet. Paquets et colonnes viennent
du même nombre.

**Pourquoi.** Ligne `fluidite` du 13/10/2026 (iPhone de Louis, 8.53.3, 800 films, trois colonnes) :
978 images en 20 s, 95e centile 30 ms, mais neuf images de 120 à 133 ms, toutes en remontant près du
haut, sept sur dix avec une rangée passée de rendue à sautée dans la même image. Huit cents cartes
enfants d'une seule grille : chaque changement d'état relançait la mise en page de toute la grille.
WebKit (Playwright, 390 × 844, mise en page forcée autour d'un changement d'état) : une rangée coûtait
1,4 ms à 25 cartes, 2,1 à 212, 3,1 à 800, 10,3 à 3 000 ; en paquets, 1,8 ms à 800 comme 2,0–2,3 à 3 000.
Sans `content-visibility` sur les cartes, rendre un paquet coûtait 5,6 ms (24 cartes d'un coup) : elles
le gardent. Géométrie des 800 cartes et captures aux jonctions identiques au pixel près, à 390 et
1 440 px.

**Porteurs.** `src/lib/gridChunks.ts` (`gridColumnsFor`, `chunkList`, `useGridColumns`, `gridCards`,
`firstGridCard`, `chunkRowsIn`, `chunkCardsOf`, `GRID_CHUNK_ATTR` dont la valeur est le nombre de
colonnes) ; `.grid-chunks` / `.grid-chunk` (globals.css).

**Appelants.** `BrowseGrid` ; `useDecodeAhead` (suit les paquets rangée par rangée — un paquet sauté
ne met pas ses cartes en page et l'observateur n'en voyait aucune : 24 cartes proches au lieu de 45 ;
`PINNED_FIRST` compte les premières *cartes*, à cheval sur deux paquets) ; `useMeasuredCardHeight`
(première carte du premier paquet). `usePanelArrowNav` n'a pas changé : il lit `data-nav-item` et la
géométrie, les paquets lui sont invisibles. `scrollProbe` écoute toujours la racine en capture.

**Tests.** `gridChunks.test.tsx` (colonnes, paquets multiples des colonnes, structure de la feuille à
390 et 1 100 px, décodage par rangées et cartes tenues à cheval, mesure, flèches d'un paquet à
l'autre), `useMeasuredCardHeight.test.tsx`, `useDecodeAhead.test.tsx`.

**Différent exprès.** Recherche, Ma liste, filmographie gardent leur grille d'un seul tenant
(`.player-grid`, cartes en `content-visibility`) : d'autres composants, des listes de quelques
dizaines à deux cents cartes, où le coût ne se voit pas.

**Décidé le 13/10/2026.**

## 86. « Reprendre » se dessine depuis l'appareil et se corrige en glissant

**Règle.** À l'ouverture, la rangée « Reprendre » (films et épisodes mêlés, §33) est dessinée tout de
suite depuis le cache de l'appareil (`persistentCache.ts`, par compte), puis corrigée par la réponse
du serveur sans saut : une carte qui change de place glisse (FLIP, transform seulement, 280 ms), une
carte qui part s'efface sur place (opacité + échelle, 220 ms, sans pointeur ni clavier) puis ses
voisines glissent dans le trou, une carte qui arrive se pose, une barre de progression glisse vers sa
valeur (`ProgressFill`, clés stables par titre). « Réduire les animations » : la rangée est remplacée
telle quelle. Au-delà de huit cartes changées, la rangée entière se remplace en fondu (`CATALOGUE_FLIP`).

**Garde-fou.** Une carte, la bannière ou son bouton Lire dessinés depuis le cache ne lancent jamais
la position du cache. Un appui qui précède la réponse fraîche de « Reprendre » et d'« À suivre » est
retenu (`playWhenFresh`, le dernier appui seulement) puis part avec ce qu'elle dit. Un titre sorti de
la liste fraîche part **sans** position — le serveur décide, la règle de `bannerResumeAt` (§1) ; un
épisode remplacé dans « À suivre » par le suivant de sa série part sur celui-là. Une réponse en
échec, ou 4 s sans réponse (`FRESH_WAIT_MAX_MS`), libèrent l'appui, toujours sans position. Une carte
qui a une fiche ouvre la fiche, comme avant : rien n'y attend.

**Pourquoi la rangée attendait le réseau.** Ce n'était pas voulu : « Reprendre » et « À suivre » sont
gardés sur l'appareil depuis le 25/09/2026, et `feedResumeAt` / `isAwaitingFresh` (§29) existaient
précisément pour qu'une liste du cache ne lance jamais sa position. Mais l'hydratation ne posait
jamais ces deux clés : elle sautait toute clé « déjà connue de SWR » (`cache.get(clé) !== undefined`),
et SWR 2.4 inscrit `{ _k: clé }` dans son cache **au montage de tout crochet**, même un crochet qui ne
demande rien (`followOnlyOptions`). `useResumeCache`, monté par la page avant que le cinéma n'attende
le cache, suit justement ces deux flux. Le catalogue, lui, s'affichait du cache. Mesuré : 1,7 à 4,8 s
de rangée vide sur l'iPhone de Louis (`resumeNetworkMs`, startup.log du 13/10/2026). L'hydratation ne
saute plus qu'une clé qui tient une donnée, une erreur ou une requête en vol (`swrEntryHolds`) — ce
qui garde son motif d'origine : une donnée posée sous une requête en cours ferait jeter sa réponse.

**Mesure.** La ligne d'ouverture de `startup.log` porte `resumeFromCache` et, une fois les deux flux
frais, ce que la réponse a corrigé : `resumeAdded`, `resumeRemoved`, `resumeMoved` (cartes restées
dont le rang relatif a changé), `resumeProgressed` (barres qui ont bougé). Aucun envoi de plus : la
ligne attend la correction, au plus 8 s après le catalogue.

**Porteurs.** `src/lib/useContinueRow.ts` — `useContinueRow` (les deux flux en `liveFeedOptions`,
l'ordre, la place tenue, les cartes partantes, le FLIP, `playWhenFresh`, le compte rendu),
`withLeaving`, `continueChanges`, `movieStartFrom`, `episodeStartFrom`, le type `CinemaResumeItem`
(qui était écrit deux fois) ; `swrEntryHolds`, `onFeedSettled`, `noteContinueReconciled`
(`persistentCache.ts`) ; `.continue-leaving` (globals.css).

**Appelants.** `CinemaClient` (rangée, bannière Reprendre / À suivre, « Lire » de la bannière des
nouveautés, carte sans fiche) et `CinemaMobileClient` (rangée, « Lire » de la bannière, carte sans
fiche).

**Tests.** `useContinueRow.test.tsx` (rendu immédiat malgré un crochet suiveur monté avant — rouge
sans `swrEntryHolds` —, autre compte, correction animée et compte rendu, réduction des animations,
appui retenu puis lancé à la position fraîche, titre disparu, échec), `decisions-partagees.test.ts`,
`resumeContract.test.ts`, `persistentCache-swr.test.tsx`, `useFlipGrid.test.tsx`.

**Différent exprès.** La bannière lit la liste vraie (`entries`), pas les cartes partantes. Le
retrait par le menu (« Retirer de Reprendre ») passe par le même effacement. `refreshAfterPlayback`,
le cache par compte effacé à la déconnexion et `PERSISTED_CACHE_SCHEMA` sont inchangés : aucun type
gardé n'a bougé.

**Décidé le 13/10/2026.**

---

## 87. Deux sous-titres à la fois : un second au-dessus du principal, qui ne le déplace jamais

**Règle.** Le menu des sous-titres ouvre « Deux sous-titres » : un principal et un second, choisis
chacun dans sa liste, cochés comme le reste des menus (`OptionCheck`). Le second est une piste texte
du titre autre que le principal, « Aucun », ou — lecteur natif — « Générer — <langue> ». Pas de second
sans principal ; prendre le second comme principal les échange ; éteindre le principal, ou
« Désactiver », revient à un seul sous-titre. Chaque piste garde ses propres lignes et son horloge, et
a son propre décalage (même pas de 0,5 s que celui du principal).

**Affichage.** Le principal reste à sa place et à sa taille (§72). Le second se pose juste au-dessus,
à 80 % de sa taille, d'une teinte plus douce — blanc légèrement grisé sous un principal blanc, jaune
pâle presque crème sous un principal jaune —, avec le même contour ou la même boîte. Les deux vivent
dans une rangée ancrée par son bas dont le **dernier** enfant est le principal : le second qui
apparaît, grandit ou se tait ne le fait jamais bouger. Quand seul le second parle, une ligne vide de
la hauteur du principal garde la place de celui-ci : sans elle, le second tombait à la ligne du bas
puis remontait d'un cran à la réplique suivante. Dans une zone plus haute que large (téléphone en
portrait), les deux rétrécissent d'un dixième et ne passent pas deux lignes chacune (`.subtitle-dual`,
requête de conteneur) — ce facteur dépend du **mode**, pas de la présence d'une réplique du second,
sinon le principal changerait de taille à chaque ligne du second. Le second ne descend jamais sous 11 px
(`SECOND_SUBTITLE_MIN_PX`, ni au-dessus du principal) : rendu fidèle mesuré le 14/10/2026 à 390 × 844,
il tombait à 10,1 px sous un principal de 12,6 px. Une réplique placée en haut
(`{\an8}`) y reste.

**Les deux lecteurs.** Natif : une seconde voie tenue au-dessus des pipelines comme la première ; une
piste du fichier se lit dans les lignes déjà recueillies (`RemuxPlayback.subtitleAt(at, piste)` —
toutes les pistes texte sont recueillies d'un passage, le filtre du principal n'est pas touché), un
fichier à côté du film se télécharge au choix. Serveur : un seul sous-titre reste une piste `<track>`
dessinée par le navigateur, comme avant ; à deux, `::cue` ne permettant aucun placement, les deux
pistes passent en `hidden` (chargées, répliques actives tenues, rien de dessiné) et la page dessine
les deux par le même calque que le natif (`useServerDualSubtitles`). Ses décalages déplacent les
répliques de chaque piste (`PlayerControls.shiftCues`), comme celui du principal l'a toujours fait.

**Génération.** Une seule génération est sondée et dessinée à la fois (`SubtitleGeneration.activate`) :
celle du principal ou celle du second (`generationLane`). Le second en génération reçoit les mêmes
messages d'état, à sa place à lui, les mêmes refus passagers, et bascule sans à-coup sur le fichier
final présenté par Jellyfin. Quand le principal est lui-même une génération, le second ne propose ni
autre génération ni entrée temporaire. Rien d'autre ne change à §69/§70.

**Mémoire.** Comme l'apparence, par appareil (`cine:dual-subtitles`, `v: 1`) : les deux *langues* du
choix — un numéro de piste ne veut rien dire d'un fichier à l'autre. Au film suivant, une fois par
lecteur natif (à chaque négociation côté serveur, qui repose ses `<track>`), le second revient si sa
langue existe en piste complète (ni forcée, ordinaire de préférence à SDH), à côté du principal déjà
choisi — ou de celui de la langue retenue s'il n'y en a pas — et pas dans la même langue que lui.
Sinon un seul sous-titre, et la mémoire reste pour la suite. Jamais de génération relancée d'office :
elle coûte. Écrite seulement par un geste sur le second, ou sur le principal pendant que le mode est
actif.

**Diffusion.** AirPlay et le Chromecast ne reçoivent que le principal ; le menu le dit quand une
diffusion est possible. Pendant AirPlay, le lecteur serveur rend le principal au navigateur et ne
dessine rien. Le `ChromecastPlayer` n'a pas d'entrée « Deux sous-titres ».

**Porteurs.** `src/lib/dualSubtitles.ts` (`secondOverlayCss`, `primaryDualCss`, `SECOND_SUBTITLE_TINT`,
`dualSubtitleMemory`, `rememberDual`, `pickRememberedDual`) ; `SubtitleLayer`
(`src/components/player/SubtitleLayer.tsx`) ; `useServerDualSubtitles` ; `SecondSubtitleMenu` et les
vues `dual` / `dualPrimary` / `dualSecond` et `pickPrimary` (`menuViewsDual.tsx`, appelées par
`PlayerSettingsMenu`), `OffsetRow` (`menuRows.tsx`), tous dans `src/components/playerControls/` ;
`.subtitle-dual`, `.subtitle-dual-text` (globals.css) ; les deux règles « le second survit-il au
nouveau principal » et « ce second est-il permis » dans `secondSurvives` / `secondAllowed`
(`src/components/player/session/dualSubtitleRules.ts`, depuis le 23/10/2026, §115).

**Appelants.** `ExperimentalPlayerHost` (`chooseSecond`, `showSecondAt`, `generationLane` — dans
`playerNative/useNativeSubtitleLanes.ts` —, `applyDualMemory`) ; `PlayerHost` (`changeSecondSubtitle`, ré-application dans `startPlayback`).

**Tests.** `PlayerControls-dualSubtitles.test.tsx` (porte, choix, coches, échange, désactiver, décalage
par l'hôte et sur la piste, génération, liste imposée, note de diffusion), `dualSubtitles.test.tsx`
(apparence, empilement, place gardée, mémoire), `ExperimentalPlayerHost.test.tsx` (« deux sous-titres à
la fois », « générer comme second »), `PlayerHost-deuxSousTitres.test.tsx`, `decisions-partagees.test.ts`.

**Différent exprès.** Le mini-lecteur n'affiche toujours aucun sous-titre. Un seul sous-titre ne
change rien au rendu d'avant, ni dans le natif (même arbre) ni dans le serveur (le navigateur dessine).
Le second n'est pas transmis lors d'un passage du natif au serveur : la mémoire le réapplique à
l'ouverture du serveur.

Seul le lecteur serveur compte `subtitleSwitches` (principal **et** second) dans son bilan, et
appelle `reportPositionNow` sur un changement du second (sans effet : le second n'est rien pour
Jellyfin). La page Activité ne compte donc les changements de sous-titres que pour lui — déclaré le
22/10/2026, à ajouter au natif (`SessionTally`) le jour où on les lit.

**Décidé le 14/10/2026** (validé par Louis).

---

## 88. La recherche de répliques : un index à part, lu par les Cues, qui se tait pendant un film

**Règle.** Films seulement (pas les séries pour l'instant). Une option de la Configuration
(`REPLIQUES_ENABLED`, **coupée par défaut**, §48), qui ne s'allume que si le dossier des films est
monté et lisible dans le conteneur (`checkMoviesMount` : `MOVIES_PATH` lisible, Radarr joignable, un
échantillon de films trouvé au chemin déduit) — la page grise l'interrupteur et dit pourquoi, le
serveur refuse de toute façon (`PUT /api/settings`). Les films lus sont ceux du catalogue
(`matchMovies`), au chemin de Radarr ramené sous `MOVIES_PATH` (`containerPathOf`, la règle de
`libraryKey`) — jamais les seeds ni les téléchargements.

**Une seule mécanique pour l'initiale et la nuit.** Chaque passe compare chaque film à sa signature
dans l'index (taille et date du fichier, fichiers de sous-titres posés à côté, langues voulues),
relit ce qui a changé — un film nouveau, réencodé par FileFlows, un `.srt` ajouté —, réessaie les
films en erreur et retire ceux qui ont disparu. L'initiale part du bouton « Lancer », à toute heure ;
la nuit (`REPLIQUES_NIGHTLY`, plage `REPLIQUES_NIGHT_START`–`END`, défaut 2 h–6 h, heure du
conteneur) ne part qu'une fois par nuit, **et seulement après une initiale terminée** — activer
l'option ne déclenche jamais seule une passe complète. L'état est écrit à chaque film : un redémarrage
reprend au film suivant (le film interrompu est effacé puis relu) ; une pause demandée est retenue.
Pas d'ETag Jellyfin dans la signature : la taille et la date du fichier disent déjà qu'il a changé.

**La source, par film et par langue** (français + VO par défaut, `REPLIQUES_LANGUAGES`) :
1. un fichier posé à côté (`.srt`, `.vtt`, `.ass`, `.ssa`), langue lue dans le nom, jamais un forcé ;
2. sinon la piste texte intégrée — complète (pas une forcée seule ; la SDH si c'est la seule complète ;
   une piste non marquée mais quatre fois moins fournie que la plus fournie de sa langue est traitée
   comme forcée) —, lue **par l'index** : une lecture de 4 Kio par réplique, à
   `CueClusterPosition + 4 + taille + CueRelativePosition`, la largeur de la taille devinée (1 à 8
   octets) en vérifiant le numéro de piste du bloc, l'instant pris de `CueTime` ;
3. sinon (piste absente de l'index, ou bloc introuvable où l'index le dit) la lecture complète en
   flux par le `SampleReader` du lecteur.
Les images (PGS, VobSub) sont ignorées. Un MP4 n'a que ses fichiers posés à côté.

**Mesuré le 14/10/2026.** Le premier essai lisait l'en-tête de grappe et le bloc d'un tenant :
762 Mo pour les 5 093 répliques des *Huit Salopards*. La lecture par fenêtre de 4 Kio : 11 à 41 Mo
par film (1 300 à 5 000 lectures, 41 Mo pour ce même film), 6 à 23 s par film sur ces disques — le
coût est le nombre de déplacements de tête, pas les octets. Vérifié identique à la lecture complète du même fichier sur
13 pistes de 7 films (`repliques-bench.spec.ts`, `REPLIQUES_BENCH_VERIFY`). Un fichier posé à côté :
0,3 s.

**La base** `data/repliques.db`, à part (`store.ts`) : reconstructible, donc hors de la sauvegarde
quotidienne (qui ne copie que `cine.db`), et « Reconstruire l'index » supprime le fichier au lieu
d'effacer des millions de lignes. Une ligne = élément Jellyfin, identifiant Radarr, langue, début et
fin en ms, texte affiché, texte normalisé. FTS5 sur le texte **normalisé** (`fold` : minuscules, sans
accents, `œ` → `oe`), `unicode61 remove_diacritics 2`. **Pas de table trigramme** : mesurée sur
trois échantillons (30, 14 et 10 films, français + anglais), la base fait 400 à 475 Ko par film
(≈ 300 à 340 Mo pour 720 films en deux langues) et le trigramme y ajoutait 270 à 320 Ko par film
(+66 %, ≈ +200 Mo) pour une tolérance que le vocabulaire donne déjà. Les fautes passent par le **vocabulaire** (`terms`, le
nombre d'occurrences de chaque mot) : un mot inconnu est remplacé par ses voisins à distance
d'édition 1 (4–6 lettres) ou 2 (au-delà), même première lettre ; le dernier mot vaut aussi comme
début de mot. Recherche : 1 à 8 ms sur 87 000 lignes réelles, ~30 ms sur 750 000 lignes
synthétiques faites des mêmes mots partout (le pire cas) ; pas de fil à part pour elle.

**Jamais la boucle tenue.** Écritures par tranches qui s'ajustent pour rester sous 12 ms, une main
rendue entre deux, `synchronous = OFF` (une base reconstructible n'a pas à payer `fsync` : avec
`NORMAL`, 1 265 tranches sur 2 000 dépassaient le budget), `wal_autocheckpoint = 200`, et les fusions
FTS5 faites par nous, 64 pages à la fois (`automerge = 0`, `crisismerge = 2000`) : laissées au commit,
une fusion de haut niveau tenait la boucle 70 ms sur 750 000 lignes. Mesuré sur 750 000 lignes :
17 306 tranches, la plus longue 19 ms, une seule au-delà de 12 ms. La normalisation rend la main toutes
les 500 lignes. Les lectures de fichiers sont asynchrones. L'analyse de l'en-tête et de l'index, servie
depuis la mémoire, était une seule chaîne de micro-tâches : 151 ms de boucle tenue sur un vrai film
(dont une part dans `parseMatroska`, qui lit tout l'index pour le lecteur) ; `mkvText` relit donc
l'en-tête lui-même et rend la main toutes les 256 lectures (`YieldingSlice`). Banc sur dix vrais
films : plus long retard de la boucle 29 ms, écriture la plus longue 8 ms.

**La priorité et les lectures.** Une seule lecture à la fois. Le parallélisme n'est permis qu'entre
fichiers sur des disques physiques **prouvés** distincts (`disks.ts` : périphérique remonté dans
`/sys/dev/block` jusqu'aux disques entiers, partitions et RAID compris ; sous mergerfs, la branche lue
dans `user.mergerfs.basepath`). Relevé sur la production : `/mnt/media/video` est un mergerfs de trois
branches sur trois disques distincts, mais le conteneur ne peut pas lire l'attribut (ni `getfattr`
dans l'image, ni `getxattr` dans Node) et les branches n'y sont pas montées : **pas de preuve, une
file**. Le moindre fichier sans preuve, ou deux groupes qui partagent un disque, ramènent à une file.
`ionice -c 3` n'aurait aucun effet ici (lectures faites par le démon mergerfs, ordonnanceur
`mq-deadline`) : chaque lecture est précédée d'un repos de 2 ms et le débit d'une lecture complète est
plafonné à 25 Mo/s.

**Pause pendant une lecture** (`playbackActivity.ts`), vérifiée avant **chaque lecture de fichier** :
une séance Jellyfin avec un `NowPlayingItem` rapporté depuis moins de cinq minutes (voit tout : le
lecteur de CineApp, le lecteur du serveur, le cast, les applications Jellyfin des téléviseurs ; demandé
au plus toutes les 20 s), une requête au relais de flux dans la minute (`noteMediaRead`, instantané),
ou un battement de lecture vivant (`anyPlaybackBeat`). Reprise cinq minutes après le dernier signal.

**La recherche** (`search.ts`, `/api/repliques`, `dialogueSearch.ts`, `DialogueResults`). Dans le
panneau de recherche du cinéma, le même pour le bureau et le téléphone : les titres d'abord,
inchangés ; la section « Répliques » dessous, par sa propre requête, lancée 350 ms après la frappe,
abandonnée quand la frappe change, à partir de trois mots — ou dès trois lettres avec la puce
« Répliques ». Elle n'existe que si l'option est active et l'index non vide (`GET /api/repliques` sans
`q`). Groupée par film (trois répliques, « voir plus » demande celles du film), vignette trickplay de la
scène, horodatage `h:mm:ss`, mots trouvés mis en évidence ; un appui lance le film à
`dialogueResumeAt` = début − 5 s, jamais négatif (un nombre, §1). Les films cachés par les tags
bloqués du compte sont retirés **dans la requête** SQL (§54) ; session exigée, 120 recherches par
minute et par compte.

**Porteurs.** `src/lib/repliques/` — `engine.ts` (passes, `gate`, `startIndexing`, `pauseIndexing`,
`rebuildIndex`, `repliquesStatus`, `nightlyDue`), `indexFilm.ts`, `mkvText.ts` (`openMatroskaText`,
`readTextTracks`, `bestTextTrack`), `sidecar.ts`, `fileSource.ts`, `store.ts`, `search.ts`,
`disks.ts` (`diskOf`, `planQueues`), `playbackActivity.ts`, `library.ts` (`libraryFilms`,
`containerPathOf`, `checkMoviesMount`), `languages.ts`, `text.ts` ; `src/lib/dialogueSearch.ts` ;
`src/lib/trickplayTile.ts` (le calcul de vignette, partagé avec `useTrickplay`, `src/components/playerControls/`).

**Appelants.** `instrumentation.ts` (`startRepliquesEngine`), `/api/repliques/admin` (réservée,
`ADMIN_ONLY_READS`), `/api/repliques`, `PUT /api/settings`, le relais de flux (`noteMediaRead`),
`DialogueSearchCard` (Configuration → Recherche de répliques), `PlayerSearchPanel`.

**Tests.** `repliques-index.test.ts` (Matroska fabriqué en mémoire : lecture ciblée, taille de grappe
sur 8 octets, lecture complète en repli, choix de piste, fichiers posés à côté, Windows-1252, ASS),
`repliques-search.test.ts` (accents, faute de frappe, expression exacte, films cachés, tranches qui
rendent la main), `repliques-engine.test.ts` (option coupée par défaut, montage exigé, pause pendant
une lecture, pause demandée et reprise, film modifié relu, film disparu retiré, erreurs, parallélisme),
`repliques-disks.test.ts` (preuve des disques, signaux de lecture), `repliques-library.test.ts`,
`repliques-settings-route.test.ts` (réglage refusé sans montage), `repliques-proxy.test.ts`,
`repliques-routes.test.ts` (session, disponibilité, tags bloqués, borne),
`player-search-dialogue.test.tsx` (titres d'abord, requête à part et abandonnée, puce, −5 s,
mise en évidence) ; banc `repliques-bench.spec.ts`.

**Différent exprès.** Les séries ne sont pas indexées. Le lecteur n'est pas touché : son analyseur est
réutilisé en lecture, son index des grappes n'apprend rien de nouveau (`mkvText` relit les Cues pour
les positions relatives et les durées que le lecteur n'a jamais eu besoin de garder). Seul
`PlayerControls` change, et à l'identique : son calcul de vignette trickplay passe par
`trickplayTile.ts`, partagé avec les répliques.

**Décidé le 14/10/2026** (Louis).

**Forcer l'indexation (14/10/2026, Louis).** Un bouton « Forcer » / « Ne plus forcer » à côté de
Lancer/Pause, avec l'avertissement que les lectures en cours peuvent saccader. Forcée, la passe ne
demande plus `mustWaitForPlayback` dans `gate` — et seulement cela : pause demandée, option coupée,
repos de 2 ms, débit plafonné des lectures complètes et écritures par tranches restent. L'état est
`RunState.forced`, écrit avec la passe (il survit à un redémarrage, reprise comprise) et remis à
`false` à sa fin : une nouvelle passe repart sans. Une passe en attente d'un film est réveillée tout
de suite (`wakeAll`, une attente par file). **Jamais la nuit** : `setIndexingForced` refuse une passe
de nuit (`nightly`), `gate` ne lit le forçage que pour une initiale, et une passe de nuit reprise
efface le drapeau. Sans passe inachevée : refusé (`no-run`). La page dit « En cours (forcée) » ;
`waiting-playback` n'y apparaît plus. `server.log` : « indexation forcée » / « forçage retiré ».
Porteurs : `setIndexingForced` (`engine.ts`), actions `force` / `unforce` de `/api/repliques/admin`
(admin seul et même page, par le proxy), `DialogueSearchCard`. Tests : `repliques-engine.test.ts`
(« Forcer l'indexation » : lecture ignorée et réveil, retiré = attend de nouveau, redémarrage et fin
de passe, nuit jamais forcée), `repliques-proxy.test.ts` (refusé à un `user`, refusé d'une autre page).

**Audit de la recherche (14/10/2026), mesuré sur une copie de l'index réel** (1,98 M répliques, 599
films ; banc `repliques-search-bench.spec.ts`, sauté sans `REPLIQUES_SEARCH_DIR`) :
- *L'index était écrit en double* pour 217 films (deux passes concurrentes, avant le moteur unique) :
  514 000 répliques en trop, et *Passengers* vide malgré sa fiche à 2 390. Signatures intactes : aucune
  passe ne les aurait relus. Désormais `plan` compare la fiche à l'index (`filmLineCount`) ; les doubles
  exacts sont retirés sur place, par tranches (`dedupeFilmLines`, vocabulaire décompté — 75 s pour les
  514 000 sur la copie, plus longue tranche 40 ms) ; un écart qui reste fait relire le film. Pas de
  changement de format, pas de migration : la réparation se fait à la préparation de la passe suivante.
- *Les coupures d'apostrophe singeaient des mots courants* : « the » cherchait aussi « t he », et ses
  premières réponses étaient « ain't he ». Une lettre seule n'est un morceau que là où une apostrophe la
  détache ; un mot connu n'est coupé que s'il n'est pas plus fréquent que le plus rare des morceaux.
- *Une phrase coupée entre deux sous-titres* (10 % des répliques finissent sans ponctuation) se trouve :
  une réplique et la suivante (`id + 1`/`+ 2`, même film et langue, ≤ 4 s), seulement si moins de trois
  films répondent, et seulement si les mots s'y suivent.
- *Un mot faux ou de trop* (« life **is** like a box of chocolates », le film dit *was*) : quand rien ne
  répond, les mots rares seuls puis chacun en moins, trois sur cinq au moins, marqués `approximate` (l'écran
  le dit). Entre guillemets : l'expression exacte, sans correction.
- *Que des mots très courants* (« the », « je », « a » : 200 à 340 ms de boucle tenue) : rien n'est cherché,
  `tooCommon`, l'écran le dit. Seuils proportionnels à la taille de l'index (référence 2 M).
- *Coût* : les mots rares seuls passent par FTS5 et les courants sont vérifiés dans les lignes ramenées
  (`rareFirstRows`, borne 5 000) ; le tri par BM25 se fait avant la jointure. Sur 62 requêtes × 7 :
  p50 14,9 → 5,0 ms, p95 298 → 72 ms, max 338 → 97 ms (les rattrapages ont 40 ms de budget). Sur
  10,3 M lignes (l'index recopié sept fois, cas pessimiste) : p50 53 ms, p95 250 ms.
- *L'écran* : réponses précédentes gardées, estompées, pendant la suivante (plus de clignotement à la
  frappe) ; place de la vignette gardée au téléphone pendant son chargement ; le nom de chaque bouton
  porte la réplique ; « voir plus » compte des moments, plus des lignes doublées par langue.


**Relecture du moteur et santé de la base (14/10/2026, Louis : tout corriger, rien relire).** Contrôlée
sur une copie de la production (sauvegarde SQLite, l'original en lecture seule) : `integrity_check`,
`quick_check` et l'`integrity-check` de FTS5 bons ; 1 958 103 répliques, 809 films (795 `ok`, 14 `empty`),
aucune ligne orpheline, aucun film `ok` sans lignes, `films.lines` égal au compte réel partout, aucun
double restant. **Seul le vocabulaire était faux** : `deleteFilmLines` effaçait les lignes sans décompter
leurs mots (seul `dedupeFilmLines` décomptait), et chaque film relu les ajoutait une seconde fois —
43 143 mots sur 133 570 surcomptés, 13,23 M occurrences pour 12,14 M réelles (+9 %), « a » à 282 764
pour 259 581, 5 mots sans plus aucune réplique. Les seuils de la recherche (`TOO_COMMON`, `RARE`,
`PREFIX_MAX`) et l'ordre des corrections lisent ces nombres.
- *Effacer décompte* : `deleteFilmLines` et `dedupeFilmLines` passent par un seul chemin (`removeLines`),
  qui décompte dans la même transaction et retire un mot tombé à zéro.
- *Réparation en place* (`repairIndex`, `store.ts`) : le vocabulaire recalculé **depuis les lignes
  stockées**, aucun film relu ; versionnée dans `meta` (`repair`, version 1 — une base neuve naît à la
  version courante), idempotente (relancée, elle refait le même calcul), par tranches sous 12 ms, le
  vocabulaire corrigé en place (jamais vidé : une recherche pendant ce temps lit des comptes justes ou
  encore faux, jamais une table vide). Lancée 30 s après le démarrage si la base existe ; **une passe
  l'attend avant de préparer quoi que ce soit** et « Reconstruire » avant d'effacer (`ensureRepaired`,
  `engine.ts`) : un comptage étalé sur des secondes ne supporte pas d'écriture concurrente. Mesurée sur
  la copie : 3,7 s de bout en bout, 771 tranches, la plus longue 9,6 ms, plus long retard de la boucle
  9,7 ms ; 43 138 comptes corrigés, 5 mots retirés ; après coup, les mêmes contrôles sont bons et le
  vocabulaire égal au recalcul exact (12 141 833).
- *Pas de `VACUUM` ni d'`optimize` FTS5* : mesurés sur la copie, 13 316 pages libres (54 Mo, 11 %) ; un
  `VACUUM` ramène 495 → 402 Mo (2 s de boucle tenue d'un bloc), `optimize` puis `VACUUM` 383 Mo (1,1 s de
  plus), pour une recherche FTS5 brute à p50 7,9 → 6,0 ms et p95 inchangé (~250 ms). Les pages libres
  sont reprises par les écritures suivantes, la base est reconstructible : le gain ne vaut pas une
  opération qui tient la boucle plusieurs secondes.
- *Un état par serveur, pas par copie de module* (Next charge chaque module deux fois : le moteur par
  `instrumentation.ts`, les routes) : les signaux de lecture (`playbackActivity.ts` — après un
  redémarrage, la passe reprise n'entendait plus le relais de flux ni le battement, seulement
  Jellyfin), les battements de présence (`presence.ts`), la connexion à la base (après « Reconstruire »,
  la copie du moteur restait ouverte sur le fichier supprimé) et `writeStats` (la page lisait les zéros
  de la copie des routes) sont sur `globalThis` (`Symbol.for`), comme l'état du moteur.
- *Un arrêt attend toutes les files* (`Promise.allSettled`) : avec `Promise.all`, le premier arrêt finissait
  la passe, le `finally` effaçait l'arrêt, et une file encore occupée repartait au film suivant — une passe
  fantôme, le mécanisme des doublons. Une file en erreur arrête les autres au film suivant.
- *« Pause » puis « Reprendre » aussitôt* : « Reprendre » n'annule plus un arrêt en cours (la demande de
  pause attendait alors toute la passe) ; la passe finit son film, s'arrête, et une nouvelle repart au
  film suivant — sauf si une nouvelle demande est venue entre-temps (`live.requests`). La pause attend
  l'arrêt au plus 10 s (`PAUSE_WAIT_MS`).
- *Recherche* : l'indice de coupure d'une phrase entre deux sous-titres s'appelait `k`, comme le facteur
  d'échelle qu'il masquait — le seuil de mot courant valait `TOO_COMMON` × 2, × 3… selon la coupure.
Tests : `repliques-repair.test.ts` (réparation, idempotence, tranches, effacement qui décompte, connexion
partagée), `repliques-engine-queues.test.ts` (deux files, pause/reprise, réparation attendue),
`repliques-disks.test.ts` (signaux partagés entre copies), `repliques-search.test.ts` (seuil à chaque coupure).

## 89. Jellyfin seul, et la règle de vérité

Demandé le 14/10/2026, après une mesure de la bibliothèque : les 806 films étaient tous rattachés à
Radarr par leur dossier, mais trois séries rangées à la main dans Jellyfin, hors Sonarr, étaient
jouables et absentes du cinéma (*La casa de papel*, *Berlin et La Dame à l'hermine*, *Le Flambeau*) ;
et une quinzaine de titres étaient **mal identifiés par Jellyfin** — bon dossier, mauvais TMDB (*Cure*
lu comme *La Cure*, *Shōgun* 2024 comme celui de 1980, *The Seven Deadly Sins* comme sa suite). Le
« vu », « Reprendre » et « À suivre » suivaient l'erreur : ils reliaient Jellyfin au catalogue par les
identifiants que Jellyfin avait compris.

**Règle de vérité** (validée par Louis) :
- *quels épisodes existent, et leur rangement* (saisons, numéros) : **le disque**, donc Jellyfin ;
- *l'identité* (quel film, quelle série) : **Radarr/Sonarr, par le dossier** — Jellyfin s'aligne ;
- *les noms et résumés d'épisodes* : **l'épisode que Sonarr a rattaché au fichier** (épisode ↔ fichier),
  sinon Jellyfin ;
- *un titre absent de Radarr/Sonarr* : **Jellyfin seul**.

**Jellyfin seul.** `jellyfinOnlyMovies` / `jellyfinOnlySeries`, après `matchMovies` / `matchSeries` :
les éléments non revendiqués — un film avec un `Path`, une série avec au moins un épisode réel
(`countEpisodesAdmin`, `IsMissing=false` : la vue serveur ne remplit pas `ChildCount`) — dont aucun
identifiant (TMDB, IMDb ; TVDB pour une série) n'est celui d'un titre du catalogue. **Jamais de
rapprochement par le titre.** Identifiant de fiche : `1 000 000 000 + FNV-1a(Id Jellyfin) mod 10⁹`
(`jellyfinOnlyId.ts`), le même d'un chargement à l'autre ; une collision prend le suivant libre, dans
l'ordre des identifiants Jellyfin, et s'écrit dans `server.log` (`catalogue-reserved-id`). Les cartes
portent `source: "jellyfin"`. Leurs métadonnées passent par le TMDB que Jellyfin leur donne (titres et
synopsis traduits, logo, accroche — les caches du catalogue), sinon par les champs de Jellyfin (nom,
synopsis, genres) ; l'affiche et le grand visuel de Jellyfin quand TMDB n'en a pas dans la langue ;
`addedAt` est `DateCreated`. Les tags bloqués s'appliquent (§54). Ils entrent dans les rangées, la
recherche, `playableLibrary` (la fiche TMDB et la recherche les ouvrent dans la bibliothèque, jamais
« Demander »), les nouveautés (§75).

**La fiche d'un titre que Jellyfin a seul n'a rien de la gestion.** Les adresses de description
(`/api/radarr/movies/<id>/info`, `/api/sonarr/series/<id>/info`) répondent pour un identifiant réservé
sans rien demander à Radarr, Sonarr ni Bazarr (`jellyfinOnlyInfo`) : TMDB et OMDb, pas de sous-titres,
pas de téléchargement. `usePlayerSeriesRequests` ne demande pas à Sonarr ce qui manque.

**Voulu : les doubles rangements.** *Le Flambeau* est aussi la saison 2 de *Burning Love (FR)* ;
*Berlin et La Dame à l'hermine*, la saison 2 de *Berlin (2023)*. Deux dossiers, deux identités : chacun
garde sa fiche (option a, choisie par Louis). *La casa de las flores*, dossier vide que Sonarr suit sans
fichier, reste invisible. Radarr (ou Sonarr) injoignable : aucun titre « Jellyfin seul » de ce côté — tout
Jellyfin paraîtrait non revendiqué, et huit cents films changeraient d'identifiant le temps d'une panne.

**Un seul lien d'un élément Jellyfin vers son titre.** `CatalogueMembers.byJellyfinId` : le
rapprochement par dossier, plus les titres que Jellyfin a seul. Le lisent `catalogueLinks` /
`cinemaHrefOf` / `seriesCatalogueIds` (`sonarrLink.ts`) pour « Reprendre » et « À suivre »,
`libraryIndex` et `syncWatched` pour le « vu » (le TMDB du catalogue ; un élément hors du catalogue garde
celui de Jellyfin sans jamais prendre la place d'un lien), `hiddenTmdbKeysFor` (les deux TMDB d'un élément
bloqué), la liste des épisodes (le TMDB du complément).

**Les épisodes.** Dans la liste d'une série (`arrangeEpisodes`, `episodeDisplay.ts`) : un épisode sans
numéro prend celui de son nom de fichier (`S04E01`), sinon la fin de sa saison — jamais « É0 » en tête ;
un titre égal au nom du fichier ou de la série devient « Épisode N » dans la langue de qui regarde. Pour
une série Sonarr (`applyAttachedEpisodeText`) : si Sonarr a rattaché le fichier au même épisode et que
Jellyfin identifie la série comme lui, le texte de Jellyfin (déjà traduit) ; sinon le texte de
**l'épisode de Sonarr**, par TMDB au TMDB de Sonarr (langue de qui regarde, puis anglais), à défaut celui
de Sonarr (« TBA » ignoré) — le numéro affiché reste celui du disque. Le reste est complété par
`fillEpisodeText` **au TMDB du catalogue**, seulement là où TMDB a la saison : une saison absente (404)
est gardée vide une semaine au lieu d'être redemandée à chaque ouverture.

**Réparé au passage.** Les listes d'administration de Jellyfin demandent `DateCreated,Genres,Overview,
OriginalTitle` : la date propre d'une série (§75, `libraryAddedAt`) lisait jusque-là toujours `undefined`.

**Les métadonnées dans Jellyfin (14/10/2026, à la main).** Réalignés sur Radarr/Sonarr par
`RemoteSearch/Apply` (identifiants, puis actualisation complète, images comprises) : *Cure*, *A
Separation*, *The Hunt* (2012), *The Party* (*La Boum*), *Forsaken* (*L'Abandon*), *Cocorico 2* (IMDb),
*The Wailing*, *Dollhouse*, *Balloon* ; *The Seven Deadly Sins*, *Spiral* (*Engrenages*), *Shōgun* (2024),
*LOL France*. Les « vu » et reprises des 28 comptes comparés avant/après : identiques. **Pas touchés** :
*Aliens* et *November* — leurs fichiers sont *Alien³* (Special Assembly Cut) et *Novembre* (2022),
Jellyfin avait raison, c'est Radarr qui a rangé le mauvais fichier ; le cinéma les montre sous l'identité
de Radarr, comme la règle le dit, jusqu'à ce que le fichier soit remplacé. *La casa de papel* : noms et
résumés des saisons 2 à 5 posés depuis le groupe d'épisodes TMDB « Parts (edited version) » (ordre
Netflix, celui du disque) et verrouillés (`LockedFields: Name, Overview`) — les saisons 2 et 3 portaient
les noms des parties 3 et 5.

**Porteurs.** `catalogueMembers`, `jellyfinOnlyMovies`, `jellyfinOnlySeries`, `jellyfinOnlyTitle`
(`catalogueMembers.ts`) ; `jellyfinOnlyId.ts` ; `jellyfinOnlyCinemaMovie` / `jellyfinOnlyCinemaSeries`
(`jellyfinOnlyCatalogue.ts`) ; `jellyfinOnlyInfo` ; `movieTmdbFacts` / `seriesTmdbFacts`
(`titleInfoShape.ts`, la forme TMDB des descriptions, une fois) ; `sonarrLink.ts` ;
`episodeDisplay.ts` ; `applyAttachedEpisodeText` (`episodeFallback.ts`) ; `cachedSonarrEpisodeTexts`,
`cachedJellyfinEpisodeCount` (`server-cache.ts`).

**Appelants.** `/api/cinema/movies`, `/api/cinema/series`, `/api/cinema/series/[id]/episodes`,
`/api/search`, `playableLibrary` (et par elle §47), `/api/jellyfin/resume`, `/api/cinema/next-up`,
`watched.ts`, `blockedTags.ts`, les deux routes `/info`, `usePlayerSeriesRequests`. `PERSISTED_CACHE_SCHEMA` 14.

**Tests.** `jellyfin-seul.test.ts` (orphelins visibles avec leurs saisons, série vide invisible,
anti-doublon par identifiants, jamais par le titre, doubles rangements, Radarr muet, identifiants
réservés stables, collision journalisée, tags bloqués, « dans la bibliothèque », vu par le dossier,
description sans Radarr ni Bazarr), `search-jellyfin-seul.test.ts`, `episodes-verite.test.ts` (numéro
lu dans le fichier, fin de saison, remplissage, saison TMDB absente, épisode de Sonarr, TMDB du
catalogue), `resume-route.test.ts`, `cinema-next-up-route.test.ts`, `decisions-partagees.test.ts`.

**Complété le 14/10/2026 (soir), deux règles.**

*L'exception par série : « Faire confiance à Jellyfin pour les noms d'épisodes ».* Les noms d'épisodes
vont à Sonarr quand il rattache un fichier à un autre numéro que le disque — juste si le disque est mal
numéroté, faux si c'est Sonarr qui numérote autrement que le disque *voulu* (l'ordre de diffusion d'un
animé, des parties Netflix rangées en saisons). Ça ne se devine pas : l'administrateur le décide, série
par série, depuis le contrôle de la bibliothèque (§90). Gardé dans CineApp (`episode_text_trust`, par
identifiant Sonarr, `episodeTextTrustDb`) ; quand il est posé, la route des épisodes garde le texte de
Jellyfin tel quel — noms, résumés, verrouillages compris — sans l'épisode rattaché par Sonarr ni le
complément TMDB, exactement comme une série que Jellyfin a seule. L'identité et le catalogue restent
ceux de Sonarr. « Revenir aux noms de Sonarr » le retire. Route : `POST /api/admin/library-check/trust`
(administrateur seul ; un identifiant de la plage réservée est refusé).

*Une installation sans Radarr ou sans Sonarr.* Un service **non configuré** (`serviceConfigured`) n'est
pas une panne : `cachedMovies` / `cachedSeries` rendent une liste vide sans rien demander, et tout ce que
Jellyfin a de ce côté devient « Jellyfin seul ». Avant, l'appel partait vers l'adresse par défaut sans
clé, levait, et la route du catalogue répondait 500 — aucune série. Un service **configuré mais en
panne** garde le comportement de la panne (aucun « Jellyfin seul » de ce côté, le catalogue échoue
comme avant). Ont suivi : `jellyfinOnlySeries` compte les épisodes par lots de huit (`mapInBatches`) —
sans Sonarr, toutes les séries sont candidates ; le calendrier, les Imports, l'activité de la gestion et
l'annonce des épisodes importés ne demandent plus rien à un service non configuré ; le calendrier et les
statistiques disent ce qui manque (`NotConfiguredNote`) ; les pages Films, Séries et Téléchargements
avaient déjà leur état « non configuré » (`ServiceNotConfigured`, dont le texte renvoie maintenant à
Configuration → Connexions). **Radarr et Sonarr deviennent facultatifs dans l'assistant** : seuls Jellyfin
et TMDB sont exigés (`missingRequired`, `setupDone`), l'étape Bibliothèque les présente comme tels, et
l'écran de fin résume ce qui sera disponible ou non (`availableFeatures`, `SERVICE_FEATURES`) ; le
niveau « Radarr ou Sonarr » (`need: "library"`) a disparu du schéma des réglages.

Tests : `instance-sans-arr.test.ts` (listes vides sans appel, tout Jellyfin au catalogue, routes du
catalogue, calendrier et Imports sans appel), `episodes-verite.test.ts` (l'exception, posée puis
retirée), `settings-setup.test.ts`, `library-check-ui.test.tsx` (écran de fin de l'assistant).

**Décidé le 14/10/2026** (Louis).

## 90. Le contrôle de la bibliothèque : où les sources se contredisent, en lecture seule

Demandé le 14/10/2026, après la mesure qui a mené à §89 : les désaccords entre Jellyfin, Radarr/Sonarr,
TMDB et le disque s'étaient trouvés à la main, par des scripts jetables. Ils ont maintenant une page :
**Gestion → Infrastructure → Contrôle de la bibliothèque** (`/controle`), et une ligne dans la Vue
d'ensemble.

**La règle.** Le contrôle **lit et conseille** ; il n'écrit chez aucun service. Pour chaque désaccord :
ce que dit chaque source, qui a probablement raison (`catalogue`, `jellyfin`, `file`, `unknown`,
`info`), et le geste à faire chez le service, écrit (« Jellyfin → le film → Identifier → TMDB … »). La
seule écriture possible depuis la page est l'exception par série de §89, que l'arbitrage peut
*conseiller* (bouton mis en avant) mais ne pose jamais seul.

**Les catégories.**
- **Identité différente** — bon dossier, autre identité chez Jellyfin (un identifiant présent des deux
  côtés qui diffère, ou aucun chez Jellyfin). Films : la durée du fichier départage entre les deux films
  TMDB (à 10 minutes près au moins), sinon l'année du nom d'origine du fichier si elle est celle d'un
  seul. Séries : l'arbitre TMDB (ci-dessous).
- **Numérotation des épisodes** — fichiers que Sonarr rattache à un autre numéro que le disque (la règle
  de `applyAttachedEpisodeText`), avec leur nombre, ceux qu'il ne rattache pas, le type de série Sonarr.
- **Fichiers peut-être mal rangés** (films) — sans lire le disque : la durée mesurée par Radarr
  (`mediaInfo.runTime`, sinon Jellyfin) très éloignée de celle de TMDB — **30 minutes et 30 %
  ensemble**, ou moins de la moitié ; une version longue annoncée (`movieFile.edition`, ou « Extended »,
  « Director's Cut », « Roadshow »… dans le nom) n'en est pas une si le fichier est plus long — ; l'année
  du **nom d'origine** du fichier (Radarr le garde : `originalFilePath`, `sceneName`) qui n'est pas celle
  du film à un an près — sauf si la durée est juste à trois minutes près — ; ou la durée proche (8 min)
  du film que Jellyfin croit voir et loin (15 min) de celui de Radarr. Jellyfin n'expose pas le titre
  Matroska du conteneur (vérifié sur *Aliens* : `MediaSources.Name` est le nom du fichier, le `Title` de
  la piste vidéo absent) : le nom d'origine le remplace.
- **Jellyfin seul** — informatif ; le geste (Library Import) n'est proposé que si le service est
  configuré.
- **Doubles rangements** — fichiers vidéo à plusieurs liens physiques sous deux dossiers de titre
  (`find … -links +1 -exec stat`, BusyBox, une seconde pour 7 900 fichiers ; les seeds ne sont pas
  parcourus) — « voulu possible ».

**L'arbitre TMDB** (séries), source indépendante de Sonarr qui suit TVDB, et **seulement dans le
contrôle** — jamais dans le rendu des épisodes. Numérotation : pour chaque fichier concerné (huit au
plus), le titre Jellyfin et celui de l'épisode rattaché par Sonarr comparés au titre TMDB **au numéro
du disque** (français puis anglais, la meilleure ressemblance : Jaccard sur les mots sans accents ni
ponctuation ni mots vides, 1 si identiques, 0,8 si l'un contient tous les mots de l'autre) ; score =
moyenne Jellyfin − moyenne Sonarr, ± 0,25 selon que les saisons complètes du disque ont le compte
d'épisodes de TMDB ou de Sonarr. Identité : les titres du disque comparés à la série TMDB de Sonarr, et
les comptes de saisons du disque à la série TMDB de Sonarr, à celle de Jellyfin et à Sonarr. Verdict à
± 0,3 ; deux ou trois exemples d'épisodes affichés. Coût borné : quarante séries arbitrées par analyse ;
les saisons TMDB passent par `seasonText` (une semaine sur le disque, le cache de la fiche), les faits de
titre par des projections `tmdb:check-facts:v1:*` (deux semaines).

**Le calcul.** `startLibraryCheck` : une analyse à la fois, à la demande (« Analyser ») ou d'elle-même
quand la lecture de la route trouve un résultat de plus d'un jour (la Vue d'ensemble la lit toutes les
cinq minutes). Les séries par lots de quatre (Sonarr : épisodes et fichiers, `cachedSonarrEpisodeTexts` ;
Jellyfin : `getEpisodesAdmin`), une respiration de la boucle entre deux lots (`mapInBatches`,
`yieldToLoop`). Le résultat, daté, dans sa table (`library_check`, une ligne, hors de `kv_cache` qu'on
élague à trente jours) ; un résultat d'une autre forme (`LIBRARY_CHECK_VERSION`) est relu comme absent.
Les règles du catalogue sont celles du cinéma (`matchMovies`, `matchSeries`, `jellyfinOnlyMovies`,
`jellyfinOnlySeries`) : Radarr/Sonarr en panne, rien de « Jellyfin seul » de ce côté.

**Mesuré le 14/10/2026 sur la production** (banc `library-check-bench.spec.ts`, en lecture seule,
base jetable) : 58 s à froid, 3 s ensuite. Trois séries « Jellyfin seul » (*La casa de papel*, *Berlin
et La Dame à l'hermine*, *Le Flambeau*), deux doubles rangements (*Berlin* ↔ *Berlin and the Lady with
an Ermine*, 8 fichiers ; *Burning Love (FR)* ↔ *Le Flambeau*, 9), une identité (*November* : Radarr
*Novembre* 2022, Jellyfin *November* 2017 — Radarr a raison, le fichier a été remplacé), un fichier
mal rangé (*A Good Day to Die Hard* : 15 minutes, 208 Mo, pour 98 attendues), aucune numérotation. Le
premier passage signalait aussi *Les Deux Tours* Extended, *Kingdom of Heaven* Roadshow et *Le Chef*
(« Comme.un.Chef.2014 », 85 min pour 84) : d'où l'exception des versions longues et celle de la durée
juste.

**Porteurs.** `src/lib/libraryCheck/analyse.ts` (seuils, `misfiledSignals`, `movieIdentityVerdict`,
`compareNumbering`, `arbitrateNumbering`, `arbitrateIdentity`, `hardlinkPairs`, `analyseLibrary`),
`run.ts` (`startLibraryCheck`, `refreshLibraryCheckIfStale`, `libraryCheckStatus`), `store.ts`
(`libraryCheckDb`, `episodeTextTrustDb`), `types.ts` ; `src/lib/inBatches.ts` ;
`jellyfin.getEpisodesAdmin`.

**Appelants.** `/api/admin/library-check` (GET, POST), `/api/admin/library-check/trust`,
`src/components/gestion/LibraryCheck.tsx` (`/controle`), `LibraryCheckSection` (Vue d'ensemble), la
route des épisodes (l'exception). `proxy.ts` : `ADMIN_ONLY_READS` ; les routes vérifient aussi
(`adminOnly`).

**Tests.** `library-check.test.ts` (seuils sur les cas réels, arbitre, doubles rangements, analyse
entière, table, routes), `library-check-proxy.test.ts`, `library-check-ui.test.tsx`, `navItems.test.ts`,
`design-tokens.test.ts`.

**Voulu.** Aucun geste automatique : un désaccord se lit, se décide, et se corrige chez le service qui a
tort. Les seuils sont prudents exprès — un faux signalement coûte une vérification ; une correction
automatique fausse coûterait un film.

**Décidé le 14/10/2026** (Louis).

## 91. Une scène ouverte depuis une réplique n'est pas une reprise — sauf après dix minutes jouées

**Règle.** Une lecture lancée depuis la recherche de répliques (`PlaybackSession.scene`, posé par
`DialogueResults`) ne modifie ni la reprise ni le « vu » : pas d'annonce ni de battement ni d'arrêt chez
Jellyfin, pas de position gardée sur l'appareil (`unsentPosition`), pas de relecture des vues à la
fermeture (`refreshAfterPlayback`), pas de note pour le recul de reprise (`noteWatching`) ni de recul à
l'ouverture (elle part déjà cinq secondes avant la réplique), pas d'octets gardés pour une reprise
instantanée (`keepOnStop`), pas d'épisode suivant. **Sauf si l'on continue** : au-delà de dix minutes
*jouées* (la pause ne compte pas) depuis l'ouverture, la lecture devient ordinaire, et tout repart de
cet instant — l'annonce (`playing`) d'abord, puis les battements.

**Pourquoi.** Constaté sur téléphone le 14/10/2026 : la position atteinte en regardant une réplique
devenait la reprise du film, qui entrait dans « Reprendre ».

**Porteur.** `src/lib/sceneMode.ts` — `SceneClock` (le temps joué), `sceneClockFor` (une horloge par
lecture, `openId` + titre : un relais natif → serveur continue le décompte), `useSceneMode` (`active`
pour le rendu, `isScene()` pour les écouteurs, `logFields()`), `sceneCarryOf` (ce qu'emporte un
rechargement de page, `ReloadCarry.scene`), `sceneLogFields`.

**Appelants.** `ExperimentalPlayerHost` et `PlayerHost` (`ActivePlayer`) : la séance passée à
`usePlaybackSession` est `null` tant que la scène dure — le lecteur serveur s'annonce lui-même une fois
devenue lecture (`announce`), sa négociation ayant porté `scene: true` (la route `playback/start` n'annonce
alors rien, comme pour le banc) ; `stopOrphanSession` ne part pas. `serverReload.ts` (intention de
rechargement) et `PlaybackProvider` (relecture ; `advance` efface `scene`). `lostStopPosition.ts` : un
bilan perdu marqué `scene` sans `sceneNormal` ne rend aucune position. Journal : toutes les lignes des deux
lecteurs portent `scene: true`, et `sceneNormal: true` une fois la lecture devenue ordinaire.

**Différent exprès.** La diffusion (Chromecast, relais AirPlay `castProgress.ts`) n'est pas couverte :
le téléviseur écrit sa propre position. Le banc d'essai (`bench`) reste à part : il ne devient jamais une
lecture.

**Tests.** `sceneMode.test.tsx` (horloge, séance, rechargement, bilan perdu, passage à une lecture avec le
vrai `usePlaybackSession`), `scene-native.test.tsx`, `player-host-server.test.tsx` (« une scène ouverte
depuis une réplique »).

**La fin d'une scène (14/10/2026, relecture).** Regardée jusqu'au bout, une scène effaçait les octets
gardés pour la reprise instantanée du titre (`forgetResumeCache` à `ended`) : elle n'y touche plus, comme
`keepOnStop`. `scene-native.test.tsx`.

**Décidé le 14/10/2026** (Louis).

---

## 92. Jellyfin en panne : le catalogue reste, la lecture le dit, et la panne ne se paie qu'une fois

**Règle.** Quand Jellyfin ne répond pas :

1. **Le coupe-circuit** (`jellyfinBreaker.ts`). Après un échec *de transport* (aucune réponse, délai
   dépassé), l'hôte est réputé hors ligne 30 s : les appels échouent tout de suite avec la même erreur
   nommée (`upstream_unreachable`) ; passé ce délai, une sonde part **en arrière-plan**
   (`/System/Info/Public`) pendant que les appels échouent encore vite — aucun spectateur ne la paie
   (un nom de conteneur arrêté mettait ~5 s à se dire introuvable). Toute réponse — même un refus HTTP —
   referme. Une adresse réglée autrement repart de zéro. **Jamais pour un film en cours** : relais de
   flux, sous-titres, vérification de visibilité, rapports de lecture et relevé de santé passent outre
   (`passJellyfin`) et ne font que témoigner — leurs octets referment le disjoncteur.
2. **Le catalogue** (`catalogueFallback.ts`). Chaque réponse de `/api/cinema/movies` et `/series` tient
   à jour, sur disque (`kv_cache`, gzip, écrit seulement quand l'étiquette change), **le dernier
   catalogue servi à ce compte**, après le retrait de ses tags bloqués (§54) et avec ses dates « déjà
   vu » (§75) — rien d'un autre compte. En panne : cette copie, `200`, marquée `stale` (et
   `jellyfinDown` si c'est Jellyfin), et jamais recopiée comme fraîche. Une liste encore en mémoire
   pendant la panne est servie marquée `jellyfinDown`. Sans copie : le 502 nommé d'avant.
3. **L'écran** (`catalogueOutage.ts`, `CatalogueOutage.tsx`, les deux accueils). Un bandeau discret
   « Lecture momentanément indisponible — le serveur ne répond pas » ; le catalogue marqué est relu
   toutes les 30 s, page visible (`useCatalogueOutage`, `needsOutageRefresh` — pas le `refreshInterval`
   de SWR, dont la minuterie ne lit la donnée qu'au montage et ne partait jamais), si bien que le
   bandeau part seul au retour, sans recharger.
   `PlaybackProvider.play` refuse d'ouvrir le lecteur pendant la panne et le dit (`playBlockedByOutage`).
   Sans aucun catalogue : un écran « Réessayer » avec un essai automatique annoncé (« Nouvel essai dans
   30 s »), « Mode standard » pour l'administrateur seul. Un titre demandé sans catalogue (`#film=138`)
   affiche un message et rend l'adresse (`useRepairUnresolvedSheet`, `sheetRepairDuring`).
4. **« Reprendre » / « À suivre » / la progression d'un titre** répondent `502 upstream_unreachable`
   au lieu d'une liste vide (ou de « pas vu ») : SWR garde ce qu'il tenait, et l'appareil ne garde pas
   une liste vide (§86). `persistentCache` ne garde pas non plus un catalogue marqué.
5. **Les tags bloqués inconnus** (Jellyfin injoignable, rien en mémoire ni sur disque) ne valent plus
   « aucun » : la copie gardée du compte (mémoire, puis disque `blocked-tags:<jfId>`, qui survit aux
   redémarrages), sinon les tags posés d'office aux nouveaux comptes (`unknownBlockedTags()`, réglage
   `NEW_ACCOUNT_BLOCKED_TAGS`), sinon aucun. Le premier choix — tout titre étiqueté caché — vidait le
   catalogue : Jellyfin range les mots-clés de TMDB dans les tags (562 films sur 650). Corrigé le jour
   même, priorité au catalogue (Louis, 14/10/2026).
   **Contre les fausses alertes (même jour)** : un échec *certain* (nom introuvable, connexion
   refusée) ouvre le coupe-circuit tout de suite ; un échec *ambigu* (délai dépassé, connexion coupée)
   peut n'être qu'un appel lourd sur un Jellyfin vivant — il en faut deux de suite, sans réponse entre
   les deux, à moins d'une minute (`STRIKE_WINDOW_MS`). `jellyfinBreaker.test.ts`.
6. **La recherche** n'accorde que 1,5 s aux listes de Jellyfin (`catalogueMembers({ jellyfinWaitMs })`),
   puis rend Radarr/Sonarr/TMDB avec la règle de panne de `catalogueMembers`.
7. **Le journal** : une panne amont s'écrit au plus une fois par hôte et par minute, la suivante portant
   `suppressed` (le nombre de lignes tues) et `upstream`.
8. **La gestion** : sur une pastille rouge, « Hors ligne depuis HH:MM » passe avant le pourcentage de
   disponibilité ; l'Activité ouvre sur « Jellyfin injoignable depuis … » d'après `service_checks`.

**Pourquoi.** Test isolé du 14/10/2026, Jellyfin pointé vers un nom introuvable puis vers un hôte figé :
le catalogue entier disparaissait alors que Radarr/Sonarr répondaient (écran noir sur le bureau, une
ligne rouge et la seule rangée Tendances sur iPhone) ; un titre de la recherche ne s'ouvrait pas, sans
un mot ; « Reprendre » répondait une liste vide indiscernable de « rien à reprendre » ; chaque appel
repayait huit secondes (recherche à 8 s au lieu de 0,3) ; `server.log` répétait la même ligne ;
« 99,9 % » s'affichait à côté d'une pastille rouge ; l'Activité ne disait rien.

**Porteurs.** `src/lib/jellyfinBreaker.ts` (`throughJellyfinBreaker`, `passJellyfin`, `jellyfinFetch`,
`passJellyfinFetch`, `jellyfinIsDown`, `jellyfinDownSince`) — branché dans `clients/jellyfin.ts` (tout
`fetchJson`, sauf les trois rapports de lecture) et les `fetch` directs (`blockedTags`, `pictureFrame`,
`transcodePolicy`, `newAccountTags`, `jellyfinDevicePrune`, images, vignettes, chapitres en garde ; flux,
sous-titres, `itemVisibility`, `pingJellyfin` en passage). `src/lib/catalogueFallback.ts`
(`catalogueResponse`, `catalogueFallbackResponse`). `src/lib/catalogueOutage.ts` (`outageOf`,
`needsOutageRefresh`, `playBlockedByOutage`, `sheetRepairDuring`). `src/components/cinema/CatalogueOutage.tsx`
(`useCatalogueOutage`, `CatalogueOutageBanner`, `CatalogueUnavailable`). `logger.ts` (limite), `blockedTags.ts`
(`unknownBlockedTags`, `requestJfId`), `statusHistoryDb.serviceDownSince`, `offlineLabel` (CapabilityStatus).

**Appelants.** `CinemaClient` et `CinemaMobileClient` (mêmes pièces, placement seul différent : sous le
sélecteur sur le bureau, en tête du volet sur téléphone). Routes `cinema/movies`, `cinema/series`,
`jellyfin/resume`, `cinema/next-up`, `cinema/progress/[itemId]`, `search`, `admin/activity`.

**Différent exprès.** Le bandeau et les écrans sont noirs et blancs (§83) : une panne passagère n'est pas
une alarme. Le lecteur lui-même n'est pas touché : il savait déjà ne pas passer la main au lecteur serveur
sur `upstream_unreachable`. Une recherche faite pendant la seconde et demie de grâce peut garder 30 s
(son cache) une réponse sans les titres « Jellyfin seul ». Le catalogue de secours d'un compte n'expire
qu'avec le ménage ordinaire de `kv_cache` (30 jours).

**Tests.** `jellyfinBreaker.test.ts`, `catalogueFallback.test.ts`, `blocked-tags-outage.test.ts`,
`resume-route.test.ts` et `cinema-next-up-route.test.ts` (502), `logger.test.ts` (limite),
`catalogueOutage-ui.test.tsx` (bandeau, Réessayer, compte à rebours, Lecture refusée, titre introuvable),
`useContinueRow.test.tsx` (rangée gardée pendant la panne), `decisions-partagees.test.ts`,
`persistentCache-schema.test.ts` (version 16).

**Relecture du même jour (14/10/2026, Louis : tout corriger).**
- *Lecture refusée une seule fois* : le premier refus affichait un toast, le fournisseur se redessinait
  avec une valeur de contexte neuve, l'effet de `useCatalogueOutage` repartait et son nettoyage remettait
  la panne à faux — le second appui ouvrait le lecteur. L'écouteur est posé une fois (message lu par
  référence), le drapeau n'est levé qu'au démontage ; la valeur de `ToastProvider` est mémoïsée.
  `catalogueOutage-toast.test.tsx` (avec le vrai fournisseur).
- *Tags bloqués* : voir la note datée de §54 (index gardé sur disque, attente bornée).
- *Fausses alertes du coupe-circuit* : le contrôle de la bibliothèque (§90) tourne en **témoin**
  (`asJellyfinWitness`, `AsyncLocalStorage`) — ses délais dépassés ne comptent pas, un échec certain si ;
  et un second échec ambigu ne compte que s'il vient d'un appel parti **après** le premier (deux appels
  d'un même lot expirés ensemble = un témoignage).
- *Film en cours* : la négociation (`getPlaybackInfo`, toujours) et la description du lecteur
  (`getItemMediaSources(…, { pass: true })` dans `/direct`, relais vers l'épisode suivant compris)
  passent outre le coupe-circuit. Une première ouverture pendant une vraie panne reste refusée par le
  cinéma.
- *Position inconnue* : `playback-state` répond `502 upstream_unreachable` quand Jellyfin est injoignable
  (zéro affirmait « jamais commencé ») ; `fetchPlaybackState` en fait `positionUnknown`, et les deux
  lecteurs n'ouvrent pas au début sans position affirmée par l'appelant — ils le disent
  (`player.libraryUnreachable`). Une autre erreur garde l'ancienne règle (le début).
- *Vu* : `syncWatched` ne décide rien quand les liens du catalogue sont incomplets
  (`CatalogueMembers.complete`, `catalogueLinksState`) — un vu copié se serait rangé sous le TMDB de
  Jellyfin ; il réessaie à l'appel suivant.
- *Copie de secours* : servie seulement pour une panne amont (`isUpstreamFailure` : injoignable, délai,
  5xx) — un défaut de code sort en erreur nommée comme avant ; préparée à la volée (`preparedUnkept`),
  sans entrer dans la mémoire de `cachedJson`.
- *Deux sous-titres, lecteur serveur* (§87) : l'état n'est reposé que si un texte change.

**Décidé le 14/10/2026** (Louis).

## 93. Une zone illisible dans un fichier : nommée au parsing, relayée au serveur sans reprise, cherchée d'avance

**Pourquoi.** « Le Grinch » (2018), le 14/10/2026 : une release abîmée — des blocs de zéros de 16 Kio
au milieu des grappes. Le lecteur Matroska s'y taisait. Un en-tête illisible au milieu d'une grappe
(`readElementId`/`readVarSize` → `null`) arrêtait la grappe et la lecture sautait à la suivante, l'image
à moitié nulle partant quand même au navigateur (« Media failed to decode ») ; un en-tête de grappe
écrasé finissait la lecture : `readElementAt` → `null`, `finished`, « le remultiplexeur ne produit plus
de segment (fin du fichier) », `endOfStream` — aucune exception, donc aucun repli, et le saut de
`sourceLost` jamais déclenché. Mathis est resté 198 s sur une image figée ; ffmpeg (le lecteur serveur)
franchit la même zone.

**La détection** (`ebml.ts` `readElementHeader` → `UNREADABLE`, `SampleReader` option
`unreadable: "throw"`, `UnreadableZone`). Une zone, c'est un en-tête d'élément dont le premier octet de
l'identifiant ou de la taille n'a aucun bit de marque (0x00 — la seule valeur sans), **lu avec une
fenêtre complète** (tous les octets demandés, ou tous ceux jusqu'à la fin du fichier), ou un bloc lu
entier dont le numéro de piste est dans ce cas — **là où le fichier dit qu'il reste du film** : dans une
grappe de taille déclarée, ou, au niveau des grappes (et dans une grappe de taille inconnue), avant un
point d'index (sans index : dans un segment de taille déclarée). Écartés exprès : une lecture courte
(déjà un échec réseau depuis le 13/10, `byteSource`), un enfant qui dépasse son parent (muxers
fautifs), des octets en trop après la dernière grappe d'un fichier sain, des zéros dans le contenu d'une
image sans en-tête touché (rien ne les distingue d'une image — l'échelle des reprises les gère comme
avant), la durée annoncée. La détection est au parsing : des octets venus du réseau, de la réserve en
mémoire ou des morceaux gardés sur l'appareil sont jugés pareil.

**Seul le lecteur principal du remultiplexeur est strict.** La sonde du son (`describeAudio`),
`completeParameterSets`, les transcodeurs audio (TrueHD, AAC), la reprise instantanée
(`resumeCache/record`) et les répliques (`mkvText`) gardent l'ancien comportement, à l'octet : c'est
le lecteur principal qui atteint une zone le premier (le son ré-encodé est lu derrière l'image), et
un transcodeur qui la verrait à son tour n'a rien à décider.

**Le motif**, écrit une fois (`unreadableZoneMessage`) : « zone illisible dans le fichier vers 234,9 s
(octet 169510505) » — une décimale à virgule, l'octet entier. C'est ce que l'Activité groupe.

**Le relais** (`UnreadableZoneHold.holdAtZone`, `ZoneHandover`, `ExperimentalPlayerHost.handZone`). L'erreur ne
passe **ni** par les reprises d'envoi raté (elle serait relue trois fois), **ni** par la reconstruction
(`lost` reste faux ; une zone arrivée sur une source fermée entre-temps relaie quand même), ni par
« dialogues améliorés » ou le retour de piste. La lecture en avance la rencontre ~30 s avant la tête :
la source s'arrête de lire (rien de plus n'est demandé au remultiplexeur, aucune fin de flux), joue ce
qu'elle a, et prévient l'hôte (`onUnreadableZone`). Le relais part quand la tête atteint `switchAt` —
la fin de ce qui est sûr moins 0,5 s : le début de la grappe dont la fin a pu être touchée (celle de
l'en-tête illisible, ou celle d'avant pour un en-tête de grappe), borné par la fin du tampon, jamais
avant la tête — par `onError(motif, "playback", { unreadableZone, zoneByte, zoneSeconds, resumeAt })` ;
le lecteur serveur reprend à `resumeAt`. Rien à jouer avant (une ouverture ou une reprise tombée dans la
zone, un saut dedans) : tout de suite. Un saut **dans** la zone (entre `switchAt` et le premier point
d'index qui la suit, `Remuxer.resumeAfterByte`) relaie tout de suite, à la cible ; tout autre saut la
quitte (au-delà : la lecture native continue ; en arrière : la lecture la retrouvera).

**Préparé, pas immédiat (Louis, 14/10/2026).** Pendant que la tête finit ce qui est sûr, le lecteur
serveur est **préchauffé** au point du relais par la mécanique de la connexion lente (§78,
`lighterPrewarm.ts` : `startPrewarm` avec `step: null` — la négociation **ordinaire**, au plafond
`pickMaxBitrate`, `prewarm: true` donc rien d'annoncé à Jellyfin, maître, variante et le segment de la
position) ; le lecteur serveur le reprend tel quel (`takeOrdinaryPrewarm` : même titre, même piste, même
position à 1 s près, hls.js, aucune exclusion de son ; sinon arrêté chez Jellyfin et renégocié comme
avant) et hls.js part de son segment (`startPosition`). `takePrewarm` (la version allégée) ne prend
jamais un préchauffage ordinaire, ni l'inverse. Abandonné — arrêté chez Jellyfin, rien ne fuit — à la
pause (refait à la reprise), à la fermeture, à un saut au-delà de la zone ou plus de 90 s avant ; gardé
quand une reconstruction retrouve la même zone. L'interruption est mesurée comme celle d'une bascule
allégée : `switchedAt` sur le relais, `switchGapMs` sur le bilan du lecteur serveur, `prewarm.used`
(`ordinary: 1`) sur son `start`.

**WebKit en HLS natif : le relais tout de suite**, à la tête, sans préchauffage (`mode: "immediate"`).
Safari y relit son segment 0 puis saute (deux démarrages de ffmpeg, §78) : le préchauffage n'épargne que
la négociation ; et une seconde séance HLS dans une page qui a servi le lecteur natif y a déjà échoué
(code 4) quand elle était allégée, alors que le relais ordinaire dans la page y marche. Le plus sûr :
relayer dès la détection, ce qui laisse au lecteur serveur les ~30 s d'avance pour démarrer avant la
zone. Ligne `fallback` marquée `immediate: true`.

**Sans lecteur serveur** (`PLAYER_SERVER_FALLBACK=false`) : rien de préparé ; à l'arrivée sur la zone,
l'erreur propre (`error`, même motif) et l'écran « Ce fichier est abîmé vers 3:54 : il ne peut pas être
lu au-delà sur cette installation » (`player.unreadableZone`, 4 langues). Banc d'essai : rien de
préparé, le repli à l'arrivée. Une scène (§91) reste une scène à travers le relais (relais ordinaire).

**Journal et Activité.** La ligne `fallback` (ou `error`) porte `reason` (le motif), `zoneByte`,
`zoneSeconds`, `resumeAt`, `at`, `resumeAfter`, `prewarm` — aucune ligne de plus. `seances.ts` compte
`fileDefects` ; le diagnostic « fichier ou appareil » rend `{ kind: "file", proven: true }` dès une
seule séance (`fileProven` : « Une zone illisible a été lue dans le fichier lui-même »).

**L'intégrité des fichiers** (Contrôle de la bibliothèque, `src/lib/integrity/`). Une tâche de fond qui
relit les fichiers vidéo de `MOVIES_PATH` et `TV_PATH` — films et épisodes ; titre et lien « Remplacer
dans Radarr/Sonarr » (page de gestion du titre, où la recherche de version remplace le fichier) par le
dossier — avec le **même** lecteur et la **même** détection (`scanMatroska` : `SampleReader` strict,
reprise au point d'index après chaque zone, une zone continue comptée une fois, 50 au plus).
Matroska seulement : un MP4 est lu par son index d'échantillons, sans en-tête en chemin — des octets
abîmés dans son `mdat` n'y ont pas d'équivalent sans tout décoder ; il est compté (« MP4 non
vérifiés »), pas relu. Écartés : fichiers cachés (temporaires), `.part`/`.tmp`/`.fftemp`/`.!qB`…,
modifiés il y a moins de 10 min (en cours d'écriture — relus à la passe suivante). Table
`file_integrity` (chemin, taille, date, statut, zones) et `file_integrity_meta` (état de la passe) dans
`cine.db` ; rien n'est écrit ailleurs, les fichiers sont ouverts en lecture. Ne relit que le nouveau, le
modifié (taille ou date) ou ce qui était en erreur ; oublie ce qui a disparu. Première passe au bouton
« Vérifier l'intégrité des fichiers » (progression, pause, reprise ; une pause demandée survit à un
redémarrage, une passe manuelle interrompue reprend 3 min après le démarrage), puis chaque nuit
(2 h – 6 h, heure du conteneur) pour les fichiers nouveaux, une fois par nuit, seulement après une
première passe terminée.

*Polie avec les disques* : une lecture à la fois, séquentielle, blocs de 8 Mio (24 Mio de mémoire au
plus), boucle rendue toutes les 256 lectures ; avant chaque bloc, la garde des répliques
(`mustWaitForPlayback` : séances Jellyfin, relais de flux, battement — le même mécanisme, reprise
5 min après) ; débit plafonné (`MAX_BYTES_PER_MS`) et 5 ms de repos. **Jamais en même temps que
l'indexation des répliques** : un verrou commun (`backgroundDiskReads.ts`, sur `globalThis`) — un
propriétaire à la fois, l'autre servi avant une nouvelle prise du premier ; l'indexation le prend par
film, la vérification par fichier, le rend pendant une attente de lecture et le cède après 20 s si
l'indexation attend.

**Mesuré le 14/10/2026.**
- *Copies abîmées* (`zone-bench.spec.ts`, extrait de 6 min H.264 + AC-3 d'un film de la bibliothèque,
  copié par mkvmerge hors de la bibliothèque) — avant / après :
  A (zéros à cheval sur deux en-têtes de grappe) : « fin du fichier » à 117,3 s / zone vers 117,2 s ;
  B (16 Kio au milieu d'une grappe) : jusqu'au bout avec un trou de 4,3 s / zone vers 118,2 s ;
  C (un bloc de 16 Kio sur deux) : jusqu'au bout, trou de 8,8 s / zone vers 118,2 s, quatre zones
  trouvées par la vérification ; D (un en-tête de grappe) : « fin du fichier » à 117,3 s / zone vers
  117,3 s. L'extrait sain : 150 segments identiques avant et après.
- *Aucune régression* (`zone-regress-bench.spec.ts`, HEAD contre la copie de travail, onze fichiers
  sains lus en entier : *The Exorcist*, *Dirty Dancing*, *Martin Guerre* (FLAC), *Burn After Reading* et
  *Weird Science* (DTS, H.264), *Dog 51* (TrueHD, DV + HDR10+), *French Twist* (MP4), *Ted Lasso*
  S02E01 (RASL), *The Grinch* (2018, remplacé), *1917* (4K HDR10+), *Wingwomen* (DV)) : segments
  d'initialisation, tous les segments du film, six sauts de quatre segments, et le flux brut de tous
  les échantillons de toutes les pistes par un lecteur strict et un lecteur sans option — empreintes
  identiques octet pour octet, 14,1 millions d'échantillons. `cout.spec.ts` sur *The Exorcist* :
  mêmes lectures et mêmes octets à chaque étape, temps égaux au bruit près.
- *Débit* (`integrity-bench.spec.ts`, en lecture seule) : lecture séquentielle seule 183 Mo/s ; relecture
  complète 173–201 Mo/s, à peine moins — le calcul suit le disque. La bibliothèque : 8 420 fichiers
  vidéo, 14,9 To, dont 8 405 Matroska. Au plafond de 60 Mo/s (un tiers du disque) : ~69 h de lecture
  effective pour la première passe, soit quatre à cinq jours avec les pauses du soir ; une nuit suffit
  ensuite aux fichiers nouveaux. L'analyse de l'en-tête et de l'index (`parseMatroska`, la même que
  celle du lecteur) tient la boucle 60 à 100 ms une fois par fichier ; le reste de la relecture la rend
  toutes les 64 lectures.

**Porteurs.** `src/lib/webcodecs/unreadableZone.ts` (`UnreadableZone`, `unreadableZoneMessage`,
`isUnreadableZone`, `isUnreadableZoneReason`, `zoneSecondsOf`), `ebml.ts` (`readElementHeader`,
`UNREADABLE`, `forEachChild(…, onUnreadable)`), `sampleReader.ts` (`SampleReaderOptions`),
`matroska.ts` (`segmentSized`), `mediaFile.ts` (`createSampleReader(…, options)`), `remuxer.ts` (lecteur
principal strict, `resumeAfterByte`), `mseZoneHold.ts` (`holdAtZone`, `checkZoneArrival`, `arriveAtZone`),
`mseTypes.ts` (`UnreadableZoneNotice`, réexporté par `mseSource.ts`), `mseSource.ts` (`performSeek`), `remuxPlayback.ts`, `src/lib/unreadableZoneHandover.ts` (`ZoneHandover`),
`lighterPrewarm.ts` (`step: null`, `takeOrdinaryPrewarm`), `ExperimentalPlayerHost` (`handZone`,
`zoneHandover`), `PlayerHost` (`ActivePlayer.startPlayback`), `activity/seances.ts`, `activity/diagnosis.ts`,
`Diagnosis.tsx` ; `src/lib/integrity/` (`scan.ts`, `library.ts`, `store.ts`, `engine.ts`),
`src/lib/backgroundDiskReads.ts`, `repliques/engine.ts` (le verrou), `/api/admin/library-check/integrity`,
`IntegrityPanel.tsx` (dans `LibraryCheck`), `instrumentation.ts`.

**Tests.** `unreadable-zone.test.ts` (sain inchangé — strict et sans option identiques sur cinq formes ;
zéros à cheval sur un en-tête de grappe, en-tête de grappe seul, au milieu d'une grappe, numéro de piste
d'un bloc, groupe de blocs, un bloc sur deux ; lecture courte ; octets en trop ; sans index ; motif),
`webcodecs-mseSource.test.ts` (« zone illisible » : ni fin de flux ni relecture, un seul `onError` à la
tête, saut dans la zone, au-delà, en arrière, ouverture dans la zone), `ExperimentalPlayerHost.test.tsx`
(« §93 » : préchauffé puis passé, jamais reconstruit, pause, fermeture, sauts, WebKit immédiat, sans
lecteur serveur, banc), `PlayerHost-connexion-lente.test.tsx` (« zone illisible » : repris tel quel,
préparé ailleurs, Safari, allégé ≠ ordinaire), `scene-native.test.tsx`, `activity-zone-illisible.test.ts`,
`integrity-check.test.ts`, `repliques-engine.test.ts` (le verrou), `library-check-ui.test.tsx`,
`decisions-partagees.test.ts`. Bancs : `zone-bench.spec.ts` (copies abîmées d'un extrait réel),
`zone-regress-bench.spec.ts` (empreintes avant/après), `integrity-bench.spec.ts` (débit).

**L'index audio emporté par un relais** (déclaré le 22/10/2026) : `takeoverNow`, utilisé par chaque
`fallToStable` générique, la diffusion et le relais, prend la piste **qui joue** (`currentAudio`) ; le
relais de zone, la bascule allégée avant la première image et `runner.attach` prennent la piste
**voulue** (`wantedAudioRef`). Ils ne divergent que pendant une reconstruction vers une autre piste,
et seul l'`onError` du moteur peut tomber dans cet intervalle — aucun cas sur 152 `fallback`
d'octobre. Unifier sur la piste voulue serait le bon choix (le serveur transcode n'importe quelle
piste) : c'est une décision de comportement, pas un nettoyage.

**Décidé le 14/10/2026** (Louis).

## 94. Retour ferme le lecteur

**Règle.** Le lecteur plein écran a son entrée d'historique : le geste retour d'iOS, le bouton
Retour d'Android et la touche Précédent du navigateur le ferment, **exactement comme la croix** —
bilan `stop "close"`, arrêt chez Jellyfin, fondu, `refreshAfterPlayback`, téléviseur arrêté en
diffusion —, et la fiche dessous reste telle quelle. La croix, la fin d'un film et la réduction
rendent l'entrée (un `history.back()` reconnu comme le nôtre) : le Retour suivant ferme la fiche,
jamais l'application. Le mini-lecteur n'a pas d'entrée : il vit sous la navigation, Retour y
referme les fiches et le film continue ; agrandi, il reprend la sienne.

**Porteur.** `src/lib/playerHistory.ts` : `holdPlayerEntry` (empile, ou réécrit une entrée de
lecteur déjà là), `releasePlayerEntry`, `installPlayerHistory` (l'écouteur `popstate`, et le jeton
effacé d'une page rechargée sans intention), `usePlayerBackClose` (le lecteur monté s'inscrit avec
sa croix ; le dernier monté répond). L'entrée garde l'adresse et recopie `history.state` (Next et la
pile des fiches y lisent leurs clés), plus un jeton `cinePlayer` propre au chargement de la page.

**Appelants.** `PlaybackProvider` (`play`, `close`, `minimize`, `expand`, l'installation),
`ActivePlayer` (PlayerHost), `ExperimentalPlayerHost` (écran de fin compris), `ChromecastPlayer` ;
`cinemaNavigate` retire le jeton d'une entrée qu'il empile (`withoutPlayerEntry`).

**Cas tranchés.**
- Épisode suivant (`advance`) : rien — une entrée par séance, pas par épisode. Un film qui en
  remplace un autre plein écran (la suite d'une saga) réécrit l'entrée.
- Rechargement voulu (WebKit : changement de piste au lecteur serveur, relais natif → serveur
  direct) : l'intention de rechargement est lue avant tout, et l'entrée gardée par la page est
  **reprise**, jamais doublée. Son Retour charge alors l'entrée d'avant, qui appartenait au document
  d'avant le rechargement : une page rechargée sur la fiche (`stop "page"` au lieu de `"close"`), et
  non un fondu — le prix d'un rechargement, le même que pour une fiche avant ce changement.
- Rechargement ordinaire (F5 en plein film) : l'entrée n'a plus de lecteur, son jeton est effacé
  au démarrage ; elle reste un doublon de la fiche dessous (un Retour sans effet visible).
- Un titre ouvert depuis l'écran de fin s'empile au-dessus de l'entrée du lecteur, sans son jeton :
  la fermeture ne le referme pas. L'entrée restée dessous, ou retrouvée par Suivant, est sautée dès
  qu'on y arrive.
- Retour pendant le fondu de la croix, double Retour rapide : un seul bilan (les gardes de fermeture
  des lecteurs), le second Retour ferme la fiche.
- Aucun lecteur encore monté (la séance attend ses réglages) : la séance se ferme directement.
- Rien ne referme un écran par `cinemaClose` juste après `play()` : son `history.back()` retirerait
  l'entrée du lecteur à peine posée, et le lecteur se fermerait aussitôt. « Plus d'épisodes » au
  bureau le faisait — un clic sur un épisode ne lançait rien (18/10/2026) ; l'écran reste désormais
  ouvert sous le lecteur, comme sur le téléphone (`series-detail-episodes-play.test.tsx`).

**Tests.** `playerHistory.test.tsx` (le vrai `PlaybackProvider` et l'historique de jsdom : chaque
cas ci-dessus), `native-close-once.test.tsx`, `player-host-server.test.tsx` (AirPlay),
`ChromecastPlayer.test.tsx` — Retour = la croix pour chaque lecteur.

**Voulu.** Échap ne ferme toujours pas le lecteur (le clavier du lecteur est un jeu fixe, §45) :
seule la navigation du système le fait.

**Décidé le 15/10/2026** (Louis), après la passe de nuit (LECTEUR-11, ROBUSTESSE-13, MOBILE-12).

## 95. « Demander » se confirme

**Règle.** Une demande (Jellyseerr, approuvée d'office, téléchargement lancé dans Radarr ou Sonarr)
ne part jamais d'un seul geste. L'appui sur « Demander » ouvre une question sobre, en noir et blanc :
la feuille d'actions de verre de l'annulation (§49) au téléphone, une petite fenêtre centrée à
l'ordinateur (`ActionSheet` `centerOnWide`). Elle reprend ce que l'écran montre déjà — titre, année,
affiche — et pose « Demander ce film ? » / « Demander cette série ? », avec « Demander » et
« Annuler » (quatre langues). Le focus d'arrivée va sur « Annuler » (`noAutoFocus`), et la fiche
découverte ne pose pas non plus son propre focus d'arrivée sur « Demander » (`focusFirstAction`,
`data-detail-no-autofocus`) : un double Entrée ne peut plus rien envoyer. Échap ferme la question,
pas la fiche dessous.

**Pourquoi.** Nuit du 15/10/2026 : un seul appui sur « Demander », sur téléphone, a envoyé une vraie
demande — le film a été téléchargé dans l'heure (MOBILE-7) ; au clavier, Entrée-Entrée sur une affiche
« Pas encore là » faisait de même (BUREAU-8). Décision de Louis le matin même.

**Porteur.** `useRequestConfirmation` (`src/components/player/RequestConfirm.tsx`).

**Appelants.** `PlayerDiscoverSheet` — ses deux mises en page (téléphone et ordinateur), film comme
série : c'est la seule fiche du cinéma qui demande. Les saisons ne se demandent pas depuis le cinéma
(`CinemaMissingEpisodes`, 23/09/2026). La gestion (`RequestFlowModal`, `GlobalSearch`) a son propre
parcours d'administrateur, hors de cette règle.

**Tests.** `discover-sheet-desktop.test.tsx` (la question, le focus sur « Annuler », la demande au
second geste seulement).

## 96. Le catalogue se relit au retour au premier plan, et les rangées le montrent sans rien bousculer

**Règle.** Au retour au premier plan (`visibilitychange` vers « visible », et le focus de la fenêtre
sur ordinateur), si la dernière lecture réussie d'un catalogue a **plus de quinze minutes**
(`CATALOGUE_REFRESH_AFTER_MS`), les deux catalogues que l'écran tient sont relus, l'un après l'autre.
Jamais page cachée ; jamais pendant un film (lecteur ouvert, plein écran ou réduit) ni sous la grille
complète ouverte — la règle est relue à leur fermeture, et une échéance passée pendant un film est
rattrapée là, une fois ; une seule relecture en vol ; rien d'autre que ces deux catalogues (celui des
séries, différé, n'est pas demandé pour autant). Pas de bandeau ni de message : un titre arrivé se pose
dans ses rangées, un titre retiré s'efface.

**Pourquoi.** Le catalogue était figé une fois chargé (relu au lancement et à la reconnexion
seulement) : une PWA d'iPhone ne se relance presque jamais, elle revient au premier plan. Un film
supprimé de Radarr restait affiché des heures, un film arrivé dans la journée n'apparaissait qu'au
redémarrage du téléphone (Louis, 15/10/2026).

**La requête.** Envoyée à part, pas par la revalidation de SWR : l'étiquette du dernier catalogue lu
part en `If-None-Match`, écrite par la page — `fetch` ne consulte alors pas son cache HTTP et rend le
304 tel quel (`respondPrepared` le sert déjà). Un 304 ne pose rien, n'analyse rien, ne redessine rien ;
il date la lecture et l'appareil réécrit sa copie (`renewPersisted`). Un 200 d'une autre étiquette est
lu une fois l'interface au repos (`whenUiQuiet`), puis posé par `mutate(clé, donnée, { revalidate:
false })` — le cache de l'appareil le garde comme au lancement (`persistMiddleware`). Une lecture de SWR
aboutie pendant le vol fait foi (la relecture s'efface). Et la lecture ordinaire de SWR (lancement,
reconnexion, filet d'une fiche) profite de la même étiquette : le cache HTTP du navigateur y rend un 200
reconstitué après un 304, et `cinemaFetcher` rend alors l'objet déjà tenu, sans analyser ni comparer un
mégaoctet de JSON (`catalogueUnchanged`).

**Panne (§92).** Une copie de secours (`stale`) gardée par le serveur **avant** notre dernière lecture
vraie (`savedAt` ≤ l'heure de son en-tête `Date`) ne remplace pas nos titres : seules ses marques passent
(bandeau, Lecture refusée), sur les titres tenus — mêmes références, la grille n'a rien à refaire, et la
relecture de 30 s de la panne ne fabrique pas d'objet neuf. Une copie gardée après (un autre appareil du
compte a lu plus neuf) passe telle quelle, et au lancement sans lecture vraie la règle de §92 est
inchangée. L'appareil ne garde jamais une réponse marquée (§92).

**Les rangées** (`useCatalogueRow`). Le glissement des voisines et la carte qui se pose existaient
(`useFlipGrid`, `CATALOGUE_FLIP`) ; s'y ajoutent, une fois pour toutes les rangées du catalogue :
- **une carte qui part s'efface sur place** (opacité et échelle, 220 ms, inerte : ni pointeur ni focus),
  puis ses voisines glissent dans le trou — le placement de « Reprendre » (§86), écrit une fois
  (`interleaveLeaving`, que `withLeaving` appelle) ; au-delà de huit changements, le fondu de la rangée
  (`fadeBeyond`) ;
- **rien ne bouge sous la main** : une rangée qu'on fait défiler (moins de 300 ms depuis le dernier
  défilement), sous un doigt posé, sous la souris, ou qui tient le focus (clavier, télécommande) garde ce
  qu'elle montre ; sa mise à jour se joue à son repos. Défiler une rangée ne la redessine pas : l'état
  « sous la main » n'avertit React que lorsqu'une mise à jour l'attend ;
- un classement compte ses rangs sur les cartes qui restent (`catalogueRanks`).
« Réduire les animations » : la rangée est remplacée telle quelle — mais toujours pas sous la main.
Uniquement transform et opacity.

**La fiche d'un titre retiré** (`useRetainedTitle`). Une fiche ouverte dont le titre sort du catalogue
ne se démonte pas : le dernier titre résolu pour la même adresse est gardé, marqué `retired`. Sa Lecture
est refusée par `PlaybackProvider.play` (`playBlockedByRetired`, à côté de `playBlockedByOutage`) avec
« Ce titre a été retiré de la bibliothèque. » (`cinema.titleRetired`) — rien ne s'ouvre. Une autre
adresse vers un titre absent reste l'affaire du filet (`useRepairUnresolvedSheet`, §47). Un titre revenu
redevient le sien.

**Porteurs.** `src/lib/catalogueRefresh.ts` (`CATALOGUE_REFRESH_AFTER_MS`, `catalogueRefreshDue`,
`catalogueUnchanged`, `noteCatalogueRead`, `reconcileCatalogue`, `refreshCatalogues`) ;
`src/lib/useCatalogueRefresh.ts` ; `readCatalogueBody` et `cinemaFetcher` (`cinemaPayload.ts`) ;
`renewPersisted` (`persistentCache.ts`) ; `src/lib/useCatalogueRow.ts` (`useCatalogueRow`,
`interleaveLeaving`, `catalogueRanks`) ; `src/lib/useRetainedTitle.ts`, `src/lib/retiredTitle.ts`.

**Appelants.** `CinemaClient` et `CinemaMobileClient` (`useCatalogueRefresh(playback.mode !== "closed"
|| route.browse !== null)`, `useRetainedTitle`, `useRetiredTitleGuard`) ; `CinemaRow`,
`CinemaSeriesRow`, `CinemaTop10Row`, `PosterRow` et le classement de `MobileTabRows` (`useCatalogueRow`).

**Différent exprès.** La bannière et « À la une » du bureau gardent leur règle (`useHeroOrder`, 25/09) :
le titre à l'écran y reste, une nouveauté vient au passage suivant. Les rangées de découverte (TMDB, hors
catalogue) gardent `useFlipGrid` seul. La grille complète ne change pas sous les yeux : la relecture
attend qu'elle soit refermée. `PERSISTED_CACHE_SCHEMA` est inchangé : aucun type gardé n'a bougé.

**Tests.** `catalogueRefresh.test.ts` (quinze minutes, `If-None-Match`, 304 sans rien poser, interface au
repos, une seule relecture en vol et une requête à la fois, page cachée ou film, lecture de SWR aboutie
pendant le vol, copie de secours plus ancienne ou plus neuve, retour de Jellyfin),
`useCatalogueRefresh.test.tsx` (vrai SWR : 304 sans aucun rendu, 200 à la même étiquette rendu sous
l'objet tenu, titre arrivé et retiré, page cachée, film puis reprise à la fermeture, focus +
`visibilitychange` en une requête, copie de secours), `useCatalogueRow.test.tsx` (arrivée, départ
inerte puis glissement, défilement, focus, doigt posé, réduction des animations, retour d'un titre),
`useRetainedTitle.test.tsx`, `decisions-partagees.test.ts`.

**Décidé le 15/10/2026** (Louis).

## 97. Une coupure en pleine lecture : dite à l'écran, hors du temps regardé, au journal, bornée à 48 s

Relevé le 15/10/2026 (passe de nuit, LECTEUR-4) : trois séances d'un même compte (Windows, *The
Rookie*, 212 s ; iPhone, *Lucifer*, 129 s et 66 s) figées sans un mot, puis fermées à la croix ; une
seule ligne `network` en production depuis septembre. Le cas réel est un lien mort alors que
`navigator.onLine` reste vrai (Wi-Fi sans Internet, 5G morte en itinérance). Reproduit sur une
instance de test : image figée 100 à 196 s, ni roue, ni mot, ni ligne `stall` ou `network`, et un bilan
`watched: 261` pour un film avancé de 60 s.

**Règle — temps 1, sans toucher au chemin de lecture.**
- *Temps regardé* — l'horloge (`WatchedClock`) s'arrête sur l'événement `waiting` de l'élément et repart
  sur `playing` (ou un `timeupdate` avec de quoi jouer, si un navigateur reprenait sans le dire), dans le
  lecteur natif et le lecteur serveur. L'attente est indépendante de « en lecture » : elle peut arriver
  avant que l'hôte ne l'ait dit, et l'image après une pause ne relance rien. La diffusion Chromecast
  l'excluait déjà (`remote.waiting`).
- *Page cachée* (07/11/2026) — le temps couru page cachée ne compte qu'à hauteur de ce que la position
  de l'élément a avancé (`WatchedClock.away` / `back`, branchés par `watchElementWaits` : natif, serveur,
  hors ligne ; pas Chromecast, où la télé joue page cachée). Et aucune attente n'est comptée page cachée,
  ni au bilan (`SessionTally.waitStarted` rend faux) ni au diagnostic. Un épisode laissé en arrière-plan
  une nuit sur un iPhone — iOS gèle la page sans pause — disait `watched: 44201`, 65 attentes et 318 s
  pour une position passée de 0 à 43 s. Le son qui joue page cachée fait avancer la position : il compte.
- *Le mot* — « Connexion perdue ou instable… » (§78) se dit aussi sous la roue d'une attente en pleine
  lecture (ni ouverture, ni saut, ni reprise après une pause), au même délai que les autres mots
  (`WORD_AFTER_MS`, 3 s) et à la même condition (`networkTrouble` : une plage qui réessaie, ou le
  navigateur hors ligne). Retenu jusqu'à la fin de l'attente : il ne clignote pas entre deux tentatives.
  Une attente sans tentative en échec reste muette — la roue (ou le fil) des commandes suffit.
- *Journal* — la ligne `stall` porte `onLine` (ce que dit le navigateur, absent s'il ne dit rien),
  `netTrouble` (tentatives en échec ou hors ligne) et `relaunch` (« garde 1/4 en attente · échecs 0/3 » :
  la réserve réseau de `keepThroughNetworkFailure` et les échecs comptés avant l'écran). Les lignes
  restées en file (`unsentLines`, §42) partent dès l'événement `online`, puis une seconde passe 5 s
  après (`online` dit l'interface revenue, pas encore le serveur joignable), en plus du tic de la minute.

**Règle — temps 2, le chemin de lecture : la coupure bornée comme celle du lecteur serveur.**
- Une fois que le pipeline a joué (`playing`), une lecture en échec réseau (`NetworkUnavailable`) ne
  passe plus par l'échelle des envois refusés (`appendFailures` / `recover`, qui vidait les tampons
  pour relire sur le même réseau absent, chaque essai relançant la minute de patience de la lecture) :
  le tampon est gardé quelle que soit l'avance et la lecture retentée sans compter (1, 2, 4, 8 s, puis
  toutes les 8 s ; aussitôt sur `online`), le chien de garde ne reprend rien pendant ce temps
  (`holdThroughOutage`, `outageHold`).
- La borne est le temps (`watchForOutage`, au chien de garde) : tête à court de média (moins de 0,5 s
  devant, ou `readyState` < 3), ni pause ni page cachée, et **48 s** sans un morceau reçu sous une
  demande (`NETWORK_OUTAGE_GIVE_UP_MS`, la borne du lecteur serveur). Alors `onError(…, "network")`,
  une fois : l'écran « connexion perdue », la ligne `network` (`reason` « coupure réseau : aucun octet
  reçu depuis 48 s »), et le nouvel essai de l'hôte au retour du réseau, inchangé. Plus rien ne part du
  pipeline rendu (`networkGaveUp`).
- Le silence (`HttpByteSource.networkSilentMs`) part de la première demande restée sans octet, tient à
  travers les lectures qui échouent (un serveur qui refuse aussitôt reste un silence), et s'efface au
  premier morceau arrivé ; `online` et le retour au premier plan le font repartir de zéro. Un lien lent
  n'est jamais un silence : il livre des morceaux de 1 Mio — au-delà des 256 Kio de §77 —, et sous
  ~40 Ko/s l'échéance de 25 s des requêtes le coupait déjà. La patience d'une minute par lecture
  (`OFFLINE_PATIENCE_MS`) et les quatre tentatives d'une plage ne changent pas.
- Le réseau revenu avant la borne : une lecture encore en attente repart aussitôt (≈ 0,4 s, comme
  avant) ; après des lectures en échec, l'essai suivant relit là où la lecture s'était arrêtée.
- Avant la première image de ce pipeline, l'ouverture garde exactement son chemin d'avant : l'hôte a
  le sien (35 s, §77/§78).

**Mesuré le 15/10/2026** sur une instance de test contre le vrai Jellyfin (*Pulp Fiction*, H.264, lecteur
natif ; Chrome 155 et WebKit de Playwright ; 8.62.2 avant, la branche après ; coupure à ~30–45 s d'avance) :
- *Chrome, hors ligne* (`setOffline`) : avant, image figée à 81 s, puis rien pendant 70 s (ni mot, ni
  écran), reprise seule en 0,8 s au retour, `watched` 230 ; après, l'écran « Connexion perdue » à
  l'instant du gel (80,5 s : le silence durait déjà), la ligne `network` partie au retour, reprise par
  reconstruction en 2,7 s, `watched` 158 (le film avait avancé d'autant). Coupé à 30 s d'avance : gel
  à 46 s, écran à 49 s.
- *Chrome, requête pendante, `onLine` vrai* (tout le trafic retenu par Playwright) : avant, gel à 81 s et
  rien ; après, l'écran au gel, puis la relance de l'hôte (en ligne : 0,8 s) rouvre le film, dont
  l'ouverture dit « Connexion perdue ou instable… » 25 s plus tard ; reprise en 1,8 s au retour.
- *WebKit, hors ligne* : avant, gel à 65 s et rien ; après, l'écran à 64,5 s, reprise en 7,2 s.
  *WebKit, requête pendante* (agent de service bloqué — sans cela Playwright ne retient pas ses
  requêtes) : gel à 65 s, l'écran, la reconstruction rejoue ce qu'elle a en mémoire puis le mot sous la
  roue à 92 s, un second `network` à 48 s de silence ; reprise en 0,8 s.
Le prix : au retour du réseau après l'écran, une reconstruction (1,8 à 7 s) au lieu d'une reprise sur
place (0,8 à 2 s) ; avant l'échéance, la reprise sur place est inchangée.

**Porteurs.** `WatchedClock.stall` / `resume`, `watchElementWaits` (`src/lib/playerSessionTally.ts`) ;
`holdThroughOutage`, `watchForOutage`, `retryReadLater` (`mseSource.ts`), `networkSilentMs`
(`byteSource.ts`, relayé par `Remuxer`) ;
`stallAt` / `stallUnstable` / `stallWord` (`ExperimentalPlayerHost`) ; `MseSource.networkFacts` ;
l'effet des envois en retard de `PlaybackProvider`.

**Appelants.** `ExperimentalPlayerHost` et `ActivePlayer` (`PlayerHost.tsx`) pour l'horloge ;
`ChromecastPlayer` garde sa propre condition.

**Tests.** `playerSessionTally.test.ts` (« s'arrête pendant une attente », `watchElementWaits`),
`ExperimentalPlayerHost.test.tsx` (« une coupure en pleine lecture » : temps regardé, mot à 3 s, sans
clignoter, muet sans tentative, hors ligne), `PlayerHost-temps-regarde.test.tsx`,
`webcodecs-mseSource.test.ts` (« l'échelle des reprises » : `onLine`, `netTrouble`, `relaunch` ; « une
coupure en pleine lecture, bornée » : refus à chaque lecture, requête pendante, retour du réseau avant
l'échéance avec et sans lecture en attente, `online`, pause, ouverture inchangée),
`webcodecs-byteSource.test.ts` (« le silence du réseau » : hors ligne, refus immédiat, requête pendante
avec `onLine` vrai, lien lent),
`unsentLines-online.test.tsx`, `decisions-partagees.test.ts` (« le temps regardé s'arrête pendant une
attente »).

**Différent exprès.** Le lecteur serveur garde son propre message (« Reconnexion… » devenu « Connexion
perdue ou instable… », §78) : seul son temps regardé change ici. Le mot reste sous la roue, jamais sur un
film qui joue.

**Décidé le 15/10/2026.**

## 98. L'ordre d'une filmographie : bibliothèque, vrais rôles, note pondérée par les votes

**Règle.** La filmographie d'une personne se trie sur trois clés : les titres de la bibliothèque
d'abord (la fiche les montre à part), puis les vrais rôles avant les apparitions — personnage
« Self », « Himself », « Herself » (et leurs suites « - Guest », « (archive footage) »), images
d'archives, talk-shows et actualités (genres TMDB 10767, 10763) —, puis la note **pondérée par le
nombre de votes** : la moyenne bayésienne d'IMDb, `(v·R + 500·6) / (v + 500)`. Un titre noté 10 par
une personne tend vers 6 ; un film noté 7,7 par 12 000 garde ~7,6. Pas la popularité TMDB : elle mesure
la semaine en cours, et l'ordre changerait d'un jour à l'autre.

**Pourquoi.** Nuit du 15/10/2026 (BUREAU-5) : triée par note moyenne seule, la filmographie de Tom
Hanks commençait, après ses titres de la bibliothèque, par « Nos Bastidores de Hollywood — Self
(archive footage) », « The Last Mile — Self » et des talk-shows ; *Seul au monde* était 37ᵉ, *Toy
Story 2* 44ᵉ ; 158 entrées sur 270 étaient des apparitions. Décision de Louis le 15/10.

**Porteur.** `sortFilmography`, `isAppearance`, `weightedRating` (`src/lib/filmographyOrder.ts`).

**Appelant.** `/api/tmdb/person/[id]` — la seule route qui ordonne une filmographie ; la fiche personne
du cinéma, `ActorModal` et la page personne de la gestion la lisent telle quelle. `vote_count` et
`genre_ids` étaient déjà dans la réponse de TMDB gardée sur disque : aucune clé de cache ne change. Le
genre ne part pas au navigateur.

**Tests.** `tmdb-routes.test.ts` (« hors bibliothèque : note pondérée par les votes, et les apparitions
… en fin »).

## 99. La recherche comprend les décennies

**Règle.** Une décennie dite dans sa tournure est un filtre de la recherche, comme le genre :
« années 80 », « années 1980 », « années quatre-vingt » ; « 80s », « 1980s », « eighties » ; « años 80 »,
« los 80 », « los ochenta » ; « 80er », « 80ern », « 80er Jahre », « achtziger » — reconnues dans les
quatre langues quel que soit le compte. Deux chiffres : 00 et 10 sont 2000 et 2010, les autres le XXᵉ
siècle (« années 20 » = 1920) ; les années 2020 se disent avec quatre chiffres. **Jamais un nombre
seul** : « 2001 », « 2010 », « 1917 », « Apollo 13 » restent des titres (un nombre de quatre chiffres
garde sa double lecture titre/année, 13/10/2026). Le nombre d'une décennie n'est pas une année :
« années 1980 » ne filtre pas sur 1980 seul. Un titre hors de la décennie qui porte la tournure se
trouve quand même (« That '70s Show », 1998), comme un titre qui porte une année.

Dans la bibliothèque (`searchCinemaLibrary`) : `year` dans [1980, 1989]. Vers TMDB (`/api/search`) :
la découverte reçoit `primary_release_date` (films) ou `first_air_date` (séries) bornées ; la clé de
la réponse gardée passe en `search:v12`.

**Pourquoi.** Nuit du 15/10/2026 (BUREAU-25) : « films d'horreur des années 80 » comprenait le genre et
ignorait la décennie — *Resident Evil* (2026), *Obsession* (2026)… alors que la bibliothèque a *The
Thing* et *La Mouche*. La grille et le Top 10 filtraient déjà par décennie. Décision de Louis le 15/10.

**Porteur.** `extractDecade` (`src/lib/search-natural-query.ts`), appelée par les quatre
`parseNaturalQuery*` (champ `decade`) et par `residualTitle` (`cinemaSearch.ts`).

**Appelants.** `searchCinemaLibrary` (recherche du cinéma, assistant de signalement),
`/api/search` (recherche du cinéma et de la gestion) → `tmdb.discover({ decade })`.

**Tests.** `search-decade.test.ts` (tournures, titres à nombre, filtre de la bibliothèque, « That '70s
Show »), `search-route.test.ts` (« décennie »), `tmdb-discover-decade.test.ts` (l'adresse).

## 100. Les épisodes dans la langue du compte

**Règle.** Quand la langue du compte n'est pas celle des métadonnées de Jellyfin
(`PreferredMetadataLanguage` / `MetadataCountryCode` de sa configuration, lus et gardés dix minutes),
le titre et le résumé de chaque épisode viennent de TMDB dans la langue du compte — **une requête par
saison et par langue**, gardée une semaine (`seasonText`, `tmdb:season-text:<langue>:<tmdb>:<saison>`,
la clé et la forme de toujours). Ce que TMDB n'a pas dans cette langue (titre de remplissage, résumé
vide) reste celui de Jellyfin, puis les trous se comblent comme avant (`fillEpisodeText` : langue du
compte, puis anglais). Un compte dans la langue de la bibliothèque ne coûte aucun appel de plus et ne
change pas.

**Seulement si la numérotation est la même.** Une saison n'est traduite que si TMDB, dans la langue
de la bibliothèque, y porte les mêmes titres que Jellyfin pour la moitié au moins des épisodes
comparables — sinon le numéro du disque n'est pas celui de TMDB (ordre de diffusion d'un animé, une
série rangée en parties) et l'on garderait les titres d'autres épisodes. La langue de la bibliothèque
inconnue (Jellyfin muet) : rien n'est traduit. Les exceptions de §89/§90 tiennent : une série que
Jellyfin a seule ou qu'on lui a confiée garde son texte ; un épisode réglé par le rattachement de
Sonarr a déjà le texte TMDB de la langue du compte.

**Pourquoi.** Nuit du 15/10/2026 (BUREAU-15) : en anglais, en espagnol et en allemand, l'interface,
le titre et le synopsis de *Chernobyl* suivaient la langue du compte (§58), ses épisodes restaient
« Veuillez garder votre calme ». Décision de Louis le 15/10.

**Porteur.** `translateEpisodeText`, `libraryMetadataLanguage` (`src/lib/episodeFallback.ts`).

**Appelant.** `/api/cinema/series/[jellyfinId]/episodes` (fiches de série, « Plus d'épisodes »,
épisode suivant du lecteur, qui relit cette liste). **Différent exprès** : « Reprendre »
(`/api/jellyfin/resume`) et « À suivre » (`/api/cinema/next-up`) gardent le nom de Jellyfin — flux
de l'accueil gardés sur l'appareil, qu'aucun appel TMDB ne doit ralentir.

**Tests.** `episodes-langue.test.ts`.

## 101. Session perdue : la connexion dit pourquoi, et rend la page exacte, fiche comprise

**Règle.** Quand la session disparaît sous une page ouverte, l'écran de connexion le dit — « Votre
session a expiré, reconnectez-vous : vous retrouverez la page où vous étiez. » (`auth.reasonExpired`,
quatre langues) — et la connexion ramène à l'adresse complète, **fragment compris** : la fiche ouverte
(`#film=920`, `cinemaRoute.ts`) revient telle quelle. La destination passe toujours par
`safeNextPath` : jamais une autre origine.

**Porteurs.**
- `expiredLoginUrl` (`src/lib/sessionExpired.ts`) : l'adresse de connexion après un 401 marqué
  `x-session-expired` — `/login?reason=expired&next=<chemin + recherche + fragment>`. Appelée par
  `noteUnauthorized`, le seul endroit du client qui réagit à cet en-tête.
- Le proxy (`src/proxy.ts`) : une **page** demandée avec un cookie présenté puis refusé (révoqué,
  expiré, illisible) ajoute `reason=expired` ; sans cookie du tout — une première visite — rien.
- `nextWithFragment` (`src/lib/signOut.ts`) : le serveur ne voit jamais le fragment, mais le
  navigateur le recolle à l'adresse d'arrivée d'une redirection qui n'en a pas
  (`/login?next=%2F#film=920`). La page de connexion le reprend quand `next` n'en nomme pas déjà un.

**Pourquoi.** Passe de nuit du 15/10/2026 (ROBUSTESSE-3) : cookie effacé ou session fermée dans un
autre onglet, puis une fiche ouverte — redirection propre vers `/login?next=%2F`, mais un formulaire
muet, et l'accueil au lieu de la fiche après la reconnexion. `safeNextPath` acceptait déjà le
fragment ; personne ne le lui donnait.

**Tests.** `sessionExpired.test.ts` (fragment et `reason` dans l'adresse), `signOut.test.ts`
(`nextWithFragment`, toujours filtré par `safeNextPath`), `proxy-login-redirect.test.ts` (`reason`
seulement quand un cookie a été présenté).

**Différent exprès.** `reason=jellyfin` (jeton Jellyfin révoqué) et `reason=playback` gardent leurs
propres mots. La redirection du proxy garde `next` = le chemin seul, comme avant.

**Décidé le 15/10/2026** (Louis).

## 102. « Appareils connectés » : cet appareil est nommé, à part des autres

**Règle.** Le panneau Compte montre en tête la session de l'appareil qu'on tient, marquée « Cet
appareil » (`player.account.currentDevice`, quatre langues), avec son appareil et sa date d'ouverture ;
suivent les autres, celles que « Déconnecter les autres » ferme, avec leur « Vue il y a… ».

**Porteur.** `GET /api/auth/sessions` : `sessions` reste la liste des **autres** (et `count` leur
nombre), la session de l'appelant vient à part dans `current` (`{ id: "current", createdAt, lastSeenAt,
device }` ou `null`), lue par `sessionDb.find(jti)` dans sa propre garde. Jamais de `jti` dans la
réponse.

**Pourquoi à part, et non un drapeau dans la liste.** La liste est ce que le bouton ferme ; y glisser
la session courante aurait changé ce que compte un onglet resté sur la version d'avant (« 2 autres
appareils » pour un seul) et ce que vide `setSessions([])` après la fermeture.

**Appelant.** `SessionsSection` (`PlayerAccountPanel.tsx`).

**Tests.** `misc-routes-batch2.test.ts` (`current` sans `jti`, et la liste intacte si la ligne est
illisible), `player-account-panel.test.tsx` (la ligne marquée en tête, hors des autres).

**Pourquoi.** Passe de nuit du 15/10/2026 (BUREAU-27) : treize lignes identiques, rien ne disait
laquelle était celle-ci. L'heure « Vue il y a 5 min » (`sessionSeenLabel`) était déjà faite.

**Décidé le 15/10/2026** (Louis).

## 103. Les onglets de la barre se remplacent ; les fiches, panneaux poussés et le lecteur s'empilent

**Règle.** Changer d'onglet (Accueil, Recherche, Ma liste, Compte — barre du téléphone, rail du
bureau, clavier et télécommande compris) ne coûte jamais plus d'un Retour :
- le premier onglet ouvert depuis ce qui est dessous (l'accueil, une grille, une fiche) empile **une**
  entrée — l'« entrée d'onglet », qui retient dans `history.state` (`cinemaTabBase`) l'adresse
  qu'elle recouvre ;
- passer d'un onglet à un autre **remplace** cette entrée (`replaceState`) ;
- « Accueil », la croix et Échap d'un onglet la rendent par un retour (`cinemaClose`, donc un seul
  `history.back()` en vol) quand ce qu'elle recouvre est l'accueil ; sinon (un onglet ouvert
  par-dessus une fiche, au bureau) ils la réécrivent en accueil, et le Retour suivant retrouve la fiche.
Le premier Retour depuis un onglet ramène donc à ce qu'il y avait avant le premier onglet ; depuis une
fiche ouverte dans un onglet, il ferme la fiche. Les fiches, les écrans poussés depuis le Compte
(activité, signalements, Nouveautés) et le lecteur (§94) continuent d'empiler : `cinemaNavigate` retire
la marque d'onglet de toute entrée qu'il empile.

**Porteurs.** `cinemaSwitchTab` et `cinemaTabHome` (`src/lib/cinemaRoute.ts`).

**Appelant.** `openPanel` (`playerNav.ts`), seule porte des onglets : `PlayerBottomBar`, `PlayerRail`,
`PlayerPanelFrame` (croix et Échap d'un onglet). Le glisser de la lentille garde son `replace` explicite
(§45) : il réécrit l'entrée que l'appui vient d'écrire.

**Tests.** `cinemaRoute-tabs.test.tsx` (le vrai historique de jsdom : la rafale de la passe de nuit,
1, 2, … 10 avant, jamais plus de 1 après ; Retour depuis un onglet ; fiche dans un onglet ; onglet sur
une fiche ; double fermeture), `playerNav.test.ts`.

**Pourquoi.** Passe de nuit du 15/10/2026 (ROBUSTESSE-14) : dix changements d'onglet, dix retours pour
sortir, l'accueil revenu trois fois dans la pile. Décidé par Louis le 15/10/2026 (« remplace »).

**Différent exprès.** Toucher l'onglet courant sous une fiche (Ma liste couverte par un film) referme
la fiche en empilant, comme avant : ce n'est pas un changement d'onglet.

## 104. Le cache de reprise regarde le réseau : rien en économie de données, un titre à la fois en données mobiles

**Règle.** Le passage d'arrière-plan qui garde l'ouverture de « Reprendre » et d'« À suivre » sur
l'appareil (`src/lib/resumeCache/`) lit `navigator.connection` avant chaque titre :
- `saveData` (économie de données) : **rien** n'est téléchargé — les effacements, eux, se font ;
- `type === "cellular"` : le titre en tête (le premier de « Reprendre », sinon d'« À suivre ») tout
  de suite, puis un titre toutes les **deux minutes** (`CELLULAR_SPACING_MS`), mesurées depuis le dernier
  titre gardé dans la page — un passage relancé (retour au premier plan, liste changée) ne repart pas d'un
  « premier » titre immédiat ;
- Wi-Fi, filaire, ou rien de dit : inchangé.
Le budget par titre et total, le repos (`whenIdle`, `whenUiQuiet`), la page visible et l'arrêt pendant
un film (`mustStop`) ne changent pas : l'attente s'y ajoute et s'interrompt avec le passage.

**Où l'API n'existe pas.** `navigator.connection` est propre à Chromium, et `type` n'y est donné que
sur Android et ChromeOS. **Safari (iPhone, iPad, Mac) et Firefox ne disent rien : le comportement y
reste celui d'avant.** Chrome de bureau donne `saveData` si l'extension ou le réglage l'active.

**Porteurs.** `resumeNetworkMode` / `waitBeforeTitle` (`src/lib/resumeCache/network.ts`), lus par
`onePass` (`useResumeCache.ts`). Même lecture que `prefetchBanners.ts` et `decoderWarmup.ts`
(`saveData`).

**Tests.** `resumeCache-network.test.ts` (le vrai `runResumeCache`, minuteries simulées : cinq titres
en Wi-Fi ou sans API, aucun en économie, un puis un toutes les deux minutes en données mobiles, passage
relancé, bascule Wi-Fi → 4G en cours de passage).

**Pourquoi.** Passe de nuit du 15/10/2026 (ROBUSTESSE-12) : 70,8 Mo (ordinateur) et 77,1 Mo (Pixel 7)
en dix secondes au premier lancement d'un profil neuf. Décidé par Louis le 15/10/2026.

**Mesuré le 15/10/2026** sur une instance de test (Pixel 7 simulé dans Chromium, profil neuf, 25 s) :
sans \`connection\` 129 requêtes de flux pour 7 titres (de 6 à 13 s) ; \`saveData\` 0 ; \`cellular\` 7 requêtes,
1 titre. Un premier essai comptait l'écart sur les seuls titres qui rendaient des morceaux gardés : il
ne jouait pas (129 requêtes) — l'écart part de chaque titre tenté.

## 105. Une adresse incohérente est ramenée, là où l'adresse est lue — les adresses valides ne bougent pas

**Règle.** `cinemaRoute.ts` reste le seul endroit qui lit et écrit l'adresse du cinéma, et il nettoie :
- **à la lecture et à l'écriture** : `episodes` n'existe qu'avec `serie` (`parse` et `serialize`) — la
  fermeture du téléphone le laissait dans l'adresse (`#episodes=1` après un Retour), et elle le retire
  désormais comme les deux du bureau ; valeurs illisibles (`#serie=abc`, `#film=-5`), `type` sans fiche
  découverte et paramètres inconnus tombaient déjà à la lecture, mais restaient affichés ;
- **à l'arrivée** (`normalizeArrivedAddress` : premier abonnement et `hashchange`), sur `/` seulement et
  pour une entrée **que l'application n'a pas écrite** (pas de `cinemaDepth` : lien direct, fragment
  tapé) : l'adresse est réécrite sur place (`replaceState`, rien d'empilé) dans sa forme normalisée
  (`normalizeRoute`) — un seul onglet, dans l'ordre où `activePanel` les lit (Recherche, Ma liste, écran
  poussé depuis le Compte, Compte), et un écran poussé (activité, signalement, Nouveautés) remplace le
  Compte. Une adresse qui dit la même chose dans un autre ordre n'est pas réécrite ;
- **l'activité** d'un compte qui n'est pas administrateur se referme (`closeAdminOnlyScreens`, appelée
  par `PlayerShell` dès que `useRole` connaît le rôle ; `replace`) au lieu d'un « Réessayer » qui ne
  peut jamais marcher.

**Différent exprès.** Une entrée écrite par `cinemaNavigate` n'est jamais renormalisée : les Nouveautés
ouvertes au lancement par-dessus la Recherche (`NewsGate`) restent telles quelles au rechargement. Les
titres introuvables (`#film=999999999`) étaient déjà refermés et nettoyés par les fiches.

**Tests.** `cinemaRoute-normalize.test.tsx` (adresses collées réécrites, adresses valides intactes,
fragment tapé, entrée de l'application, hors du cinéma, `episodes` à la fermeture, activité et rôle).

**Pourquoi.** Passe de nuit du 15/10/2026 (ROBUSTESSE-8). Décidé par Louis le 15/10/2026.

## 106. Un appareil touché a l'interface tactile, quelle que soit sa taille — choix par appareil

**Règle.** `useIsMobile` (`useIsMobile.ts`) décide seul entre l'interface tactile (celle du téléphone) et
l'interface ordinateur, dans cet ordre :
- un écran étroit (`max-width: 767px`, ou un téléphone couché) : toujours tactile ;
- le choix de l'appareil, Compte → Interface (Automatique / Tactile / Ordinateur, `localStorage`
  `cine:interface`), là où il est proposé (`canChooseInterface`) : un appareil qu'on peut toucher
  (`any-pointer: coarse`) à grand écran — iPad, tablette, ordinateur à écran tactile —, jamais une Fire TV ;
- sinon automatique : tactile si l'appareil est touché (`hover: none` + `pointer: coarse`, lu une fois au
  chargement), sauf une Fire TV.
Changer de choix recharge la page. En grand, l'interface tactile s'élargit par `useIsTablet` et la
variante CSS `tablet:` (même requête, `globals.css`) : bannière sur l'image de fond, rangées plus larges,
fiche en carte centrée de 46 rem sur l'iPad couché (voile porté par l'ombre de la carte, `--sheet-scrim`,
`phoneSheetShadow`).

**Appelants.** `(player)/page.tsx` (quel écran), `PlayerShell` (barre du bas ou rail), `PlayerDiscoverSheet`,
`PlayerPersonSheet` ; `CinemaMobileClient`/`CinemaMobileHero` (`wide`), `CinemaMobileDetail`.

**Différent exprès.** Le nom `useIsMobile` est resté : six écrans le lisent. `useIsTouch` garde les gestes de
l'interface ordinateur (affiche centrée, poignée des fiches) pour qui la choisit sur un appareil touché.

**Tests.** `interface-choice.test.tsx` (étroit, iPad, ordinateur à souris, Fire TV, choix sur iPad et sur PC
tactile, choix sans effet sur un téléphone).

**Pourquoi.** Sur iPad, l'interface ordinateur supposait une souris : Safari simule un survol à chaque toucher,
la bannière qui suit le survol change et le clic est parfois avalé (touchers perdus de Lucas, 16/10/2026) ;
Louis l'a jugée inadaptée au doigt au simulateur d'iPad et a choisi l'interface tactile mise à l'échelle,
sur maquette validée le 16/10/2026.

## 107. Le lecteur : « Épisodes » pour changer d'épisode, « Télécharger le fichier » au bureau

**Règle.**
- **Épisodes.** Un bouton dans la pilule du lecteur, avant « Épisode suivant », pour un épisode seulement
  (`seriesId` de `/api/player/item`, `usePlayerItem`) et seulement si le lecteur sait changer d'épisode
  (`onPlayEpisode` — absent pendant une scène §91 et un banc d'essai). Il ouvre la saison en cours
  (`PlayerEpisodesMenu`, liste de `/api/cinema/series/{id}/episodes`, relue à l'ouverture), centrée sur
  l'épisode en cours, inerte. Un autre épisode part par `handlePlayEpisode` des deux lecteurs : le même
  passage que l'épisode suivant (arrêt `next`, `advance`), jamais `play()` puis une fermeture (§94).
  `advance` prend la position de l'épisode choisi (`episodeResumeAt`, la même fonction que les deux
  fiches série), zéro sinon.
- **Télécharger le fichier.** La dernière ligne du ⋮, au bureau seulement (`!useIsMobile()`, §106) et pour
  un compte que Jellyfin autorise (`Policy.EnableContentDownloading`, `contentDownloadingAllowed` — non
  dans le doute). Le fichier d'origine, par `/api/player/download/{id}` → `/Items/{id}/Download`, plages
  relayées (reprise du navigateur) ; la route vérifie session, visibilité (`assertVisible`) et droit
  elle-même. Une ligne `scope: "download"` au journal du serveur par téléchargement commencé.

**Pourquoi.** Demandés le 19/10/2026 par l'administrateur d'une autre installation, validés par Louis :
un bouton de casque qui passe à l'épisode suivant par erreur, et aucun moyen de revenir sans quitter le
film ; récupérer un fichier sur son ordinateur sans passer par Jellyfin. Pas sur téléphone : un fichier de
plusieurs dizaines de Go, et une PWA iOS sans gestionnaire de téléchargements — le hors-ligne dans l'app
reste un chantier à part (`docs/telechargement-hors-ligne.md`).

**Préparé d'avance (19/10/2026, 8.70.2).** Le menu s'ouvre rempli : `usePrewarmEpisodes` demande la liste
puis les miniatures de la saison en cours, comme les planches de prévisualisation — après la première image
(`afterFirstPicture`, `firstPicture.ts`, la même fonction que les planches), une requête à la fois, l'épisode en
cours et ses voisins d'abord, rien en économie de données. Les miniatures restent décodées en mémoire
(`episodeThumbs.ts`, 120 au plus) : sur iPhone, chaque ouverture redécodait des `<img>` neuves, chargées
paresseusement — la liste apparaissait vide puis se remplissait. Les `<img>` du menu ne sont plus paresseuses.

**Ce qui diffère exprès.** Le Chromecast (`ChromecastPlayer`, une télécommande) n'a ni l'un ni l'autre.

**Tests.** `PlayerControls-episodes-download.test.tsx`, `player-item-download-routes.test.ts`,
`playback-advance-resume.test.tsx`, `transcodePolicy.test.ts`.

## 108. La barre de progression : au doigt, un glissement relatif ; à la souris, un saut au curseur

**Règle.** Au toucher (`onTouchStart/Move/End/Cancel` du conteneur de la barre, `PlayerSeekBar`) :
poser le doigt n'importe où sur la barre ne déplace rien — elle s'épaissit et la vignette montre la
position **actuelle** ; glisser déplace la tête de lecture du même déplacement que le doigt (un pixel de
doigt = un pixel de barre, `touchStartRef`), bornée à [0, durée] ; un toucher qui bouge de moins de
`TOUCH_SLOP_PX` (6 px) ne saute pas ; au lever, un seul saut à la position visée (`commitSeek`, le même
chemin qu'avant), l'écho souris ignoré (`isTouchEcho`) ; repris par le système, rien n'est validé et la
barre revient à la position du film. La **souris** et le **clavier** ne changent pas : un clic saute là
où est le curseur, le glissement suit le curseur (`updatePreview`).

**Pourquoi.** Louis, 19/10/2026 : comme l'app TV d'Apple et Photos. Le doigt cache la barre ; sauter
sous lui faisait perdre sa place à qui voulait reculer d'un peu. Il remplace le saut sous le doigt du
23/09/2026 (6e226cbb), qui répondait à une barre sans pastille visible où toucher ne faisait rien.

**Avec elle (même jour).** La barre a une ombre douce (`.player-seek-rail`, globals.css) pour les scènes
claires, invisible sur du noir, sans flou de surface.

**Tests.** `PlayerControls.test.tsx` (« au doigt, un toucher sans glisser ne déplace rien… », « …glisser
de +X px avance de X/largeur × durée depuis la position… », l'écho souris, la reprise par le système, le
tremblement).

**Sans pastille (même jour, Louis).** Plus aucun point sur la tête de lecture, au doigt, à la souris ni au
clavier : la partie blanche s'épaissit (8 → 12 px) quand on la saisit, comme l'app TV d'Apple. Le pouce
natif de l'input garde sa taille mais n'est jamais dessiné (`::-webkit-slider-thumb`, `::-moz-range-thumb`,
transparents à `opacity: 0` dans tous les états) ; le contour `:focus-visible` reste pour le clavier
(`seek-bar-no-thumb.test.ts`).

**Rien de l'input au doigt (8.70.1, même jour).** L'input natif pose sa valeur au point touché (pointerdown
sur Chromium, souris rejouée après le touchend sur iOS) ; son `change` faisait aller la partie lue jusqu'au
doigt un instant, sans saut. `inputPointerRef` retient ce qui a saisi l'input en dernier (`pointerType`,
`keyboard`) : tant que c'est un doigt, son `change` est ignoré — la position affichée ne vient que du
glissement relatif. La souris rejouée n'émet pas de pointerdown et ne l'efface donc pas.

## 109. Le téléchargement hors ligne (bêta) : Jellyfin prépare, l'appareil garde, un lecteur à part

**La règle.** Un film se télécharge pour une lecture sans réseau depuis sa fiche (Lire, Bande-annonce,
puis Télécharger). Une fenêtre demande toujours la piste son — préchoisie dans la langue du compte — et la
qualité — Standard préchoisie —, validées par « Télécharger ». Deux qualités : Standard, 2 Mb/s (Jellyfin
choisit le 720p), Haute, 4 Mb/s (le plus bas débit où il garde le 1080p), tranchées à l'œil sur quatre
extraits (lot « Qualité hors ligne » des tests divers) : pas de différence visible avec un encodeur
réglé à la main, donc Jellyfin plutôt qu'un encodeur dans l'image. Ouvert à tous les comptes — ce n'est
pas le fichier d'origine du §107, que seul le droit Jellyfin ouvre —, coupé pour toute l'installation
par `OFFLINE_DOWNLOADS`. Marqué « Bêta » partout où il paraît.

**Le serveur** (`src/lib/offline/jobs.ts`, tables `offline_jobs` / `offline_requests`). Jellyfin
transcode en MP4 fragmenté ; l'application l'écrit dans `data/offline/<id>.mp4` au fil de l'eau, et
l'appareil télécharge déjà ce qui est écrit (`/api/offline/jobs/<id>/file`, plages bornées à l'écrit).
Une version (titre, ETag du fichier, piste, qualité, codec) sert tous les comptes qui la demandent ;
gardée trois jours après le dernier téléchargement ; effacée dès que plus personne ne l'attend si elle
n'est pas finie. Deux préparations à la fois (`MAX_RUNNING`, à mesurer). N'est « prête » qu'une
préparation dont le dernier fragment arrive dans les trente dernières secondes du film ; deux minutes
sans octet, c'est un échec. Un redémarrage reprend de zéro sous une nouvelle `generation`, et l'appareil
recommence.

**L'appareil** (`deviceStore.ts`, `downloads.ts`). OPFS, `cine-offline/<compte>/<id>/`, écrit et lu par
un worker en accès synchrone : `createWritable` recopierait le film entier à chaque morceau. La taille
du fichier dit ce qui est là ; un seul onglet télécharge par compte (`navigator.locks`) ; écran gardé
allumé pendant un téléchargement visible ; `persist()` au premier. Le gestionnaire est un rond à côté de
« Tous les… », au bureau et au téléphone.

**Le lecteur** (`OfflinePlayerHost`, `offlineEngine.ts`, `fmp4.ts`). Un chemin à part, voulu par Louis
pour que la lecture en ligne n'en dépende jamais : il ne partage que `PlayerControls` et le mini-lecteur.
Les fragments vont tels quels à MediaSource (ManagedMediaSource sur iPhone) ; seul l'en-tête est retouché
(`hev1` → `hvc1`, Safari refusant `hev1`, à la condition que le `hvcC` porte les jeux de paramètres).
`mp4Demux.ts` refuse toujours le MP4 fragmenté. Le menu son montre toutes les pistes du film : une autre
que celle du fichier propose la lecture en ligne à la même position, ou dit qu'on est hors ligne. La
position est gardée avec le téléchargement.

**Les épisodes** (19/10/2026, `episodeDownloads.ts`, `OfflineEpisodeDownload.tsx`). Un petit bouton par
ligne d'épisode, à la Netflix, voulu par Louis plutôt qu'un sélecteur global : une icône qui dit l'état
(rien, préparation, anneau d'avancement, téléchargé, échec) et ouvre la suite — la fenêtre de choix d'un
film plus « Télécharger automatiquement l'épisode suivant » (ouvert par défaut), ou, une fois là, « Lire
le fichier téléchargé » et « Supprimer » (confirmé). La ligne reste le bouton de l'épisode et sa lecture
en ligne ne change pas ; le bouton de téléchargement est à côté, jamais dedans, et au bureau les flèches
y vont (→, ←, ↑/↓ dans sa colonne). Les mêmes composants pour la liste du bureau (`CinemaEpisodeBrowser`)
et la fiche du téléphone (`CinemaMobileDetail`). « Télécharger la saison » (en tête de la saison au
bureau, sous les pastilles au téléphone, même seule) annonce la taille estimée et ne pose qu'une
question pour toute la saison : la **langue** — les pistes diffèrent d'un épisode à l'autre —, gardée
dans chaque épisode par `trackForLanguage` (la première dans la langue, sinon la piste par défaut ; la
même règle que la piste préchoisie d'un film), la qualité, l'automatique ; les épisodes absents partent
un à un, dans l'ordre. La place libre (`navigator.storage.estimate`) avertit sans bloquer : Chrome
annonce un quota d'environ « utilisé + 10 Gio », l'avertissement peut être pessimiste. **Le
téléchargement automatique** (carte blanche de Louis) : à la moitié d'un épisode lu depuis l'appareil,
le suivant (`nextEpisodeIn`, les spéciaux à part) se demande aux mêmes langue, qualité et codec s'il
n'est pas déjà là — avec du réseau seulement, sans rien dire sinon ; vu à 95 % (noté en partant, pas
pendant le générique) ou jusqu'à `ended`, l'épisode s'efface dès qu'un épisode plus loin de la même
chaîne est sur l'appareil. Le titre d'un épisode téléchargé s'écrit comme celui du lecteur
(`displayTitle` : « Série — S01E02 · Titre »). Dans le lecteur hors ligne, « Épisode suivant » lance le
fichier de l'appareil s'il est lisible, sinon la lecture en ligne s'il y a du réseau, sinon il n'y a
pas de bouton (`offlineNextTarget`) ; la suite est celle notée à la demande (`episode.next`). Tests :
`offline-episodes`, `offline-episodes-sweep`, `offline-episode-rows`, `offline-player-episodes`.

**La page des téléchargements** (19/10/2026, Louis : une page plein écran plutôt que la fenêtre du premier
jour). Le rond ouvre `#telechargements=1` (`downloads` dans `CinemaRoute`), un écran poussé depuis
l'accueil dans `PlayerPanelFrame` avec sa flèche de retour — pas un onglet : l'onglet allumé reste
l'Accueil, tout onglet le referme (`openPanel`, `normalizeRoute`), et il recouvre la grille
(`coversGrid`, `heroOffscreen`, la bannière du téléphone). Une fiche ouverte depuis lui passe par-dessus
(plan 47 sur 46) et Retour y ramène, comme Ma liste. Le contenu (`OfflineDownloadsView`) est écrit une
fois : la place sur l'appareil (ce que prennent les téléchargements, ce que `storage.estimate()` dit
pouvoir encore accorder), les films, puis les séries par saison (`groupOfflineDownloads`) ; par ligne la
qualité, la piste, la taille ou la barre d'avancement, où l'on s'était arrêté et ce qui reste, Lire
(grisé tant que `offlinePlayable` dit non), la fiche (film par Radarr, série par Sonarr), Supprimer avec
confirmation. Tout y est lu sur l'appareil, affiches comprises.

**Ouvrir l'application sans réseau.** Le cinéma est rendu par le serveur derrière une session, et le
service worker ne garde jamais une page d'un compte : sans réseau, une navigation ne peut aboutir qu'à
`offline.html`. D'où une entrée à part, **`/hors-ligne`** : une page publique (`PUBLIC_PATHS` — une page
rendue qui passe par le proxy comme `/status`, pas un fichier d'`ACTIFS_PUBLICS`), hors du groupe
`(player)`, sous la seule racine — traductions, `PlaybackProvider`, le lecteur : de quoi lister et lire
`cine-offline/<compte>/` sans rien demander au serveur. Choix faits :
- **Quel compte.** Sans session, la page ne peut pas le demander : le rond du cinéma retient sur
  l'appareil le compte et le nombre de ses téléchargements à chaque chargement (`offlineEntry.ts`) ; la
  page l'adopte (`adoptSignedOutAccount`, jamais par-dessus celui d'une session). La déconnexion l'oublie :
  les fichiers restent, la page ne les montre plus.
- **Le worker la garde, par build.** Sur demande du cinéma (`cine:warm-offline-entry`), envoyée
  seulement s'il y a des téléchargements (la racine atteint une cinquantaine de fichiers, 2,7 Mo
  compressés, mesuré sur 8.71.4) : il demande `/hors-ligne` **sans cookie** (rendue pour un
  inconnu, elle ne porte rien d'un compte ; la langue vient du cookie côté navigateur,
  `TranslationProvider`), puis chaque fichier qu'elle nomme et ceux que ces fichiers nomment — Turbopack
  écrit les chemins des morceaux chargés à la demande en clair —, lecteur et dictionnaires compris, et
  range la page en dernier dans `cine-static-<build>`. Page et code sont donc de la même génération.
- **Servie** : `/hors-ligne` prend le réseau s'il répond bien en 2,5 s, sinon la copie gardée.
  `offline.html` montre « Accéder aux téléchargements » quand la copie existe (`caches.match`).
- **Réseau lent.** Sur l'écran de chargement et l'attente du catalogue (les deux accueils), au bout de
  5 s, le même bouton — **seulement si ce compte a des téléchargements** (le nombre retenu) : pour les
  autres, ce serait une page vide au moment où l'on attend autre chose. Sans attendre sur l'écran
  « catalogue indisponible ». Et le worker, sur un appareil qui garde l'entrée seulement, remplace une
  navigation sans réponse après **6 s** par `offline.html` en mode « attente » : la requête continue,
  gardée une minute ; la page guette `/__sw/attente` et se recharge dès qu'elle a répondu, recevant
  cette réponse-là sans la redemander. Six et non trois : une ouverture en 4G en itinérance dépasse
  souvent trois secondes jusqu'au premier octet, et c'est une ouverture normale. Un appareil sans
  téléchargement n'a aucun changement de comportement.
- **Lire hors ligne depuis le cinéma** : `PlaybackProvider.play` ne refuse plus un fichier téléchargé
  pendant une panne de Jellyfin (§92) ni sur un titre retiré (§96) ; la boucle de téléchargement ne
  compte plus un `fetch` sans réseau comme un échec du stockage — compté, il relançait le worker OPFS
  toutes les cinq secondes et faisait échouer les lectures du lecteur hors ligne.

**Limites.** Une PWA iPhone/iPad ouverte sans réseau ne montre `/hors-ligne` que si le worker a pu la
garder auparavant (l'app ouverte avec du réseau après le premier téléchargement, pour ce build) ; iOS
peut évincer le stockage d'une PWA restée longtemps fermée (`persist()` aide sans garantir). La page
d'attente suppose que le worker reste en vie jusqu'à la réponse : arrêté entre-temps, la page recharge
et la navigation repart de zéro.

**Ajouts du 19/10/2026 (retours de Louis, 8.71.x).**
- *Lire avant la fin* : « Lire le fichier en cours de téléchargement », grisé tant que rien n'est lisible
  (`offlinePlayable`) ; ce qui manque sur l'appareil est lu dans la copie du serveur, mêmes octets.
  L'index des fragments d'un téléchargement en cours vient du serveur d'un coup
  (`/api/offline/jobs/<id>/index`) : lu fragment par fragment par le réseau, l'ouverture restait
  « bloquée à l'étape index des fragments » (iPhone et Chrome de Louis). Un saut au-delà de ce que le
  serveur a préparé le dit et revient à la position d'avant.
- *Reprise* : le lecteur hors ligne rapporte sa lecture à Jellyfin comme le lecteur en ligne
  (`usePlaybackSession`, nom « engine ») — Jellyfin applique ses seuils (2 % / 95 % ici, durée
  minimale) et la position est la même des deux côtés à la seconde. Sans réseau, les mêmes seuils sur
  l'appareil (`resumeRules.ts`, lus chez Jellyfin) et l'envoi au retour du réseau (`unsentPosition.ts`).
  Les deux boutons prennent Jellyfin pour référence, l'appareil tant qu'une position attend.
- *Fiche* : « Lire » (ou « Reprendre ») / « Fichier téléchargé · 1h10 restantes » en tête, en blanc ;
  « Lire en ligne » à la place de « Lire ». Une série fait de même pour l'épisode que Lire lancerait
  (`useOfflinePlayable(facts.targetId)`, `CinemaSeriesDetail` / `CinemaMobileDetail`), avec l'épisode
  nommé sur les deux boutons et, tant qu'il n'est pas fini, où en est son téléchargement.
- *Lecteur* : l'ouverture du lecteur en ligne (`PlaybackIntro`) plus « Lecture du fichier téléchargé » ;
  pas de menu son (une seule piste) ; sous-titres texte gardés avec le film (`subtitles.ts`,
  `/api/offline/subtitles/<id>`) ; panneau technique (appareil / serveur) ; partie téléchargée de la
  barre plus sombre que la partie lue, et rien d'autre : la partie en tampon n'y est pas dessinée
  (trois teintes, pas quatre) ; aperçus de la barre gardés avec le film (`trickplay.ts`, prop
  `offlineTrickplay` de `PlayerControls`, rattrapés au chargement pour les téléchargements d'avant) ;
  chapitres en ligne.
- *Page* (partagée par le panneau du cinéma et `/hors-ligne`) : la place, puis « En cours » — des lignes
  avec leurs commandes, tant que quelque chose arrive —, puis films et séries en grille d'affiches. Une
  affiche ouvre la fiche hors ligne (`OfflineTitleSheet`) : visuel, logo, année et genres, Lire en tête
  (pour une série, l'épisode commencé sinon le premier pas vu, `offlineSeriesNext`), résumé,
  distribution en texte seul (ni liens ni photos : rien ne s'ouvre sans réseau, et le poids reste
  quelques centaines de Ko), puis les épisodes avec vignette et résumé. « Lire » et « Pause » écrits
  en toutes lettres (une icône seule se confondait avec la reprise du téléchargement).
  Depuis la relecture du 19/10/2026 au soir, **la forme du cinéma, pièce pour pièce** : la fiche
  (`OfflineTitleSheet.tsx`) prend le cadre et le mouvement des fiches de la bibliothèque
  (`useSheetTransition` — l'affiche touchée devient la fiche —, `useSwipeToDismiss`, `useSheetExit`,
  `PhoneSheetTitle`/`CinemaDetailTitle`, `CinemaDetailPages`, `MENU_ROW`), hors de l'adresse (elle vit
  aussi sur `/hors-ligne`) — la barre du bas du téléphone la lit par `offlineSheetOpen.ts` ; la grille,
  la carte de Ma liste (`PlayerResultCard`, `overlay`) ; l'état d'un épisode et ses gestes, une seule
  pièce pour les deux fiches (`DownloadStateButton`) ; les images en adresses `blob:` partagées
  (`useOfflineImage`), pour que le retour de la fiche retrouve sa carte ; le cadre du lecteur hors ligne,
  celui du lecteur en ligne (`PLAYER_FRAME_TRANSITION`, fondu et échelle d'arrivée) ; l'interrupteur de
  l'app (`Toggle`) et son écran vide (`PlayerEmptyState`).
- *Relecture des défauts (19/10/2026 au soir)* : sauts du lecteur en file, jamais d'ajout ni de vidage
  pendant une opération du tampon (`offline-engine.test.ts`) ; le stockage n'est relancé que sur ses
  propres erreurs ; un seul chargement à la fois ; un échec redemandé repart ; une version effacée
  (Activité) ou expirée n'est plus redemandée en silence — « Réessayer » le fait ; verrou d'écran unique
  et repris au retour ; retraits non reçus renvoyés ; reprise identique partout (`adoptOnlinePosition`) ;
  « vu » au seuil de Jellyfin ; sans réseau, seul ce qui est sur l'appareil rend « Lire » possible ; le
  fichier de l'appareil reste proposé quand la bibliothèque a perdu le sien ; annuler se confirme comme
  supprimer. Côté serveur : fichier fermé à l'annulation, place comptée avec la file, octets comptés une
  fois écrits, index sans doublons.
- *Fiche gardée* : demandée avec le fichier (`/api/offline/details/<id>`, `artwork.ts`) — résumé, année,
  genres, six premiers rôles, logo (`kind=logo`), visuel, affiche de la série pour un épisode ; rattrapée
  au chargement pour les téléchargements d'avant. L'ouverture de la lecture hors ligne en prend le logo
  et le visuel (elle fige ce qu'elle montre à son montage : les adresses `blob:` sont lues d'avance,
  400 ms d'attente au plus).
- *Boucle* : jusqu'à trois téléchargements à la fois, les versions prêtes d'abord, un verrou par
  téléchargement entre onglets ; « En file d'attente sur le serveur » ; pause (rien n'arrive sur
  l'appareil, la préparation continue) ; un retrait de demande part avant toute nouvelle demande du
  même titre (sinon il l'effaçait : « Préparation » sans fin puis « Échec »).
- *H.264* : `h264_qsv` ne marque pas ses images clés forcées ; les fragments trop longs sont découpés
  à la lecture et ces images servent d'entrées de saut (`fmp4.ts`, `Fmp4Reader`).
- *Place sur le serveur* (20/10/2026) : `OFFLINE_SERVER_QUOTA_GB` (50 par défaut, Paramètres › Lecture).
  Au-delà, les versions finies que **tous** leurs demandeurs ont entièrement récupérées
  (`offline_requests.fetched_at`, noté à la dernière plage servie) s'effacent, la moins récemment
  servie d'abord (`enforceOfflineQuota`, ligne `evicted`). Jamais une version en préparation, en file
  ou encore téléchargée : plusieurs gros téléchargements à la fois dépassent la limite, rattrapée dès
  qu'ils finissent. Les trois jours de garde s'appliquent en plus.
- *Déconnexion* (20/10/2026) : avec des téléchargements de ce compte sur l'appareil, les trois boutons
  « Se déconnecter » (`useSignOut`) demandent d'abord : les garder (retrouvés à la reconnexion) ou les
  effacer (`removeAccountDownloads` : demandes retirées au serveur, dossier du compte effacé).
- *Accès* : ouvert à tous les comptes depuis le 20/10/2026 (`OFFLINE_DOWNLOADS_FOR_EVERYONE`, vrai par
  défaut ; administrateurs seulement pendant les premiers essais), refermable aux administrateurs d'un
  geste comme le Chromecast. Le label « Bêta » reste. Page Nouveautés « 9.0 » publiée pour toutes les
  installations (`publishNewsDraft`).
- *Activité* : chaque étape au journal (`scope: "offline"`), les copies du serveur dans le panneau. Depuis le 03/11/2026, la ligne `requested` dit d'où vient la demande (`origin` : `manual`, `season`, `auto` — l'épisode suivant à mi-épisode —, `retry`, `passage` ; `OFFLINE_ORIGINS`, `quality.ts`) : savoir si la première vraie utilisatrice se servait de l'automatique se déduisait des heures. Un appareil d'avant ce champ se lit `manual`.

Tests : `offline-fmp4`, `offline-trickplay`, `offline-engine`, `offline-jobs`, `offline-routes`, `lab-offline-samples-routes`,
`offline-downloads-page`, `offline-entry`, `serviceWorker-offline-entry`, `offline-page`,
`proxy-offline-entry`, `cinemaRoute`, `cinemaRoute-normalize`, `playerNav`.


**Limites et libération (20/10/2026, revue de sécurité, décision de Louis).** Un compte a au plus
50 demandes en cours sur le serveur (en file, en préparation, ou prêtes et pas encore récupérées
par lui) — de quoi prendre une saison ou une saga sans se sentir limité ; la 51ᵉ répond
`offline-limit`. Une copie que tous ses demandeurs ont récupérée est effacée cinq minutes après la
dernière lecture (`releaseFetchedCopies`) — le délai couvre le dernier contrôle de l'appareil et un
dernier morceau redemandé —, et l'appareil qui a déjà tous ses octets ne prend pas ce 404 pour un
échec. Le droit « Autoriser les téléchargements » de Jellyfin ne s'applique pas ici :
le téléchargement dans l'application est ouvert à tous (Louis) ; ce droit ne règle que le fichier
d'origine, « Télécharger le fichier » dans le lecteur.

**Le passage d'adresse (23/10/2026, §119.2).** Les fichiers ne changent pas d'adresse (l'OPFS est par
origine) : le passage emporte la **liste** des téléchargements terminés ou en cours de ce compte sur
l'appareil ; la nouvelle adresse propose une fois de les retélécharger aux mêmes choix, par
`startOfflineDownload` ; l'ancienne efface les siens titre par titre quand le serveur atteste que la
nouvelle les a récupérés (`/api/passage/fetched`) — sur l'appareil seul quand la version est la même
(`removeOfflineDownload(id, { server: false })` : la demande du serveur est celle du compte, commune
aux deux adresses). La page des téléchargements porte l'invitation laissée pour « Plus tard »
(`PassageDownloadsCard`).
## 110. La langue du son retenue par série

**La règle (Louis, 20/10/2026).** Dans une série, changer la langue du son à la main dans deux épisodes
différents, vers la même langue, en fait la langue d'ouverture de cette série pour ce compte, à la place
de la préférence du compte. Réversible de la même façon : deux épisodes passés vers une autre langue la
remplacent ; un retour à la langue retenue efface le changement en cours. Les films gardent la
préférence du compte.

**Pourquoi pas une préférence du compte à corriger.** Augustine passait de l'anglais au français
35 fois en onze jours, mais seulement sur le Mac (The Handmaid's Tale, Obi-Wan, Shōgun) ; sur l'iPhone,
Lucifer et The Rookie restaient en anglais 41 fois sur 41. Une fenêtre « passer en français par défaut »
avait été envisagée et écartée : elle aurait déplacé le problème sur l'autre série.

**Une fonction, une réponse.** La règle est `nextSeriesLanguage` (`seriesLanguage.ts`), l'état dans
`series_audio_language` (compte, série). Le serveur répond seul : `playback-state` donne la langue de la
série comme `audioLanguage` (et `playDefaultAudioTrack: false`), et l'ouverture du lecteur natif choisit
sa piste avec, comme avant. Les deux lecteurs signalent un choix à la main par
`POST /api/player/series-language` (`noteSeriesLanguage`) : le natif quand la reconstruction arrive sur
la piste voulue, le lecteur serveur dans `changeAudio`. Ni le banc ni un extrait de test. La série vient
de Jellyfin (`SeriesId`), le compte de la session.

**Différence voulue.** Un épisode ouvert directement par le lecteur serveur (titre déjà passé au
serveur dans cette séance de l'app) suit encore le choix de Jellyfin : son ouverture ne lit pas
`playback-state`. Un relais du natif garde la piste du natif.

Tests : `series-language.test.ts` (règle, rangement par compte, route, ouverture), `jellyfin-playback-state-route`.

## 111. Les chiffres de l'Activité sur 7 jours, 30 jours et depuis le début

**La règle.** Le bloc des chiffres de la vue d'ensemble (séances, temps regardé, attentes, sauts
lents, reconstructions, replis, erreurs, barres, causes) se choisit sur trois périodes : la semaine,
inchangée et relue avec la vue d'ensemble toutes les vingt secondes ; trente jours ; et depuis le
début. Les deux dernières ne se demandent qu'une fois choisies (`GET /api/admin/activity/period`,
relues chaque minute). La semaine suit « Effacer les alertes » (§59) ; les deux autres sont de
l'historique et comptent tout.

**Une façon de compter.** `tallySignals` (`accounts.ts`) compte des séances et des lignes du serveur
sous une forme qui s'additionne (spectateurs en noms, causes en tables), `addTally` somme,
`signalsOf` met en forme. La semaine, les trente jours et l'historique passent tous par là.

**Depuis le début : un compte par jour, gardé en base.** `allTimeSignals` (`activityHistory.ts`)
garde le compte de chaque jour clos dans `activity_day_tallies`, et ne relit dans les journaux que
les trois derniers jours et aujourd'hui. Relire tout à chaque appel aurait grandi avec les archives
(jusqu'à 120 de 5 Mo pour le lecteur) ; le compte d'un jour fait quelques centaines d'octets, et il
survit à la rotation des journaux. Mesuré le 20/10/2026 sur les journaux réels (depuis le 03/09,
1 598 séances) : 376 ms une fois, pour remplir la table, puis 17 ms. Trente jours : 17 ms.

**Ce que ça accepte.** Un jour est figé trois jours après sa fin : un arrêt perdu qu'iOS renvoie au
lancement suivant (`why: "lost"`) arrive presque toujours avant. Ce qui arrive plus tard n'est pas
recompté. Un changement de ce que compte `tallySignals` fait monter `TALLY_VERSION` : les jours gardés
sont oubliés et recomptés depuis ce que les journaux ont encore. Le temps regardé n'existe que depuis
le 21/09/2026 (les lignes `stop`) : l'historique d'avant compte des séances, pas des heures.

**Différence voulue.** Les barres de l'historique sont des semaines (du lundi), des mois au-delà de
vingt-six semaines.

Tests : `activity-history.test.ts` (somme gardé + direct, jour sorti des archives, jours suivants,
changement de version, trente jours), et ceux de la semaine (`activity-alerts-cleared`,
`activity-perday-dst`, `activity-core`), inchangés.

## 112. Les liens de partage : un titre, un mot de passe, une fin

**La règle.** L'administrateur crée, depuis la fiche d'un film ou d'une série, un lien
`/partage/<code>` et un mot de passe à part, valables un nombre de jours choisi (1 à 90), pour
trois lectures en même temps. Qui a les deux voit la fiche de ce titre — une série entière,
épisodes à venir compris — et le lit avec les mêmes lecteurs, les mêmes règles et la même reprise
qu'un compte du foyer. Rien d'autre : ni catalogue, ni recherche, ni listes, ni demandes, ni
personnes, ni téléchargement d'aucune sorte, ni génération de sous-titres, ni aucune fonction d'IA (§139,
10.28.1), ni compte. Réservé à
l'administrateur à la création, révocable et prolongeable depuis l'Activité.

**Un troisième rôle, fermé par défaut.** Une session de lien a le rôle `share` et porte son lien
(`sh`). Pas « guest » : ce nom est celui de l'ancien rôle non-administrateur, que
`verifySessionToken` ramène encore à `user`. Les comptes du foyer sont « toute lecture ouverte sauf
une liste » ; une session `share` est l'inverse — `proxy.ts` l'envoie à `shareGate`
(`share/gate.ts`) avant les règles des comptes, et elle n'en sort jamais : une liste fermée de
routes (`SHARE_RULES`), chacune avec la façon d'y lire l'élément demandé, vérifié contre le titre du
lien (`itemInShare`, `share/scope.ts` : un film lui seul ; une série, elle et tout élément dont
Jellyfin dit `SeriesId` = elle). Toute autre page ramène à la fiche du lien. Quand l'élément est dans
le corps (positions, journal, langue par série, négociation du lecteur serveur), la route vérifie
elle-même (`shareRefusal`, `share/guard.ts`), et `assertVisible` le refait pour le flux, les
sous-titres, les images et les aperçus. Les signalements, hors du proxy, refusent le rôle dans
`reportCaller`. Une session de lien ne glisse pas : sa fin est celle du lien, réémise seulement s'il a
été prolongé ; révoqué ou passé, `verifySessionFull` la refuse à la requête suivante, film en cours
compris.

**Un compte Jellyfin technique par lien.** Tout ce qui joue parle à Jellyfin au nom d'un compte (la
négociation, les positions, les « vu », la langue) ; un compte par lien garde ces routes telles
quelles, et c'est Jellyfin qui garde la reprise du lien. Créé par `createShareAccount`
(`share/jellyfinAccount.ts`), nommé `partage-<8 hex>`, verrouillé au plus serré : caché, la seule
bibliothèque du genre du titre, sans téléchargement ni gestion des sous-titres, ni télévision en
direct, ni contrôle des autres ; transcodage permis comme pour le foyer. Les langues de
l'administrateur qui partage y sont recopiées. Son mot de passe, aléatoire, est gardé chiffré (même clé
que les secrets du cookie) pour ouvrir une session Jellyfin par appareil ; celui du lien n'est gardé que
haché (scrypt). Ces comptes ne sont pas des personnes du foyer : `jellyfin.getUsers` les écarte (une
fois, pour l'Activité, les nouveautés, l'accueil et les notifications), le blocage des tags des nouveaux
comptes ne les touche pas, Jellyseerr ne les importe jamais. Fin du lien : compte désactivé et sessions
fermées au passage suivant (`sweepShares`, chaque minute depuis le 20/10/2026) ; effacé un mois après —
d'ici là, le lien se prolonge, reprise comprise. Un compte déjà absent de Jellyfin (effacé à la main) est
noté effacé (`ShareAccountGone`, 04/11/2026) : sinon son 404 s'écrivait au journal chaque minute.

**Trois lectures.** Comptées à l'ouverture (`direct` pour le lecteur natif, `playback/start` pour le
lecteur serveur) : les autres sessions du lien dont le battement de lecture a moins de deux minutes et
demie (`playingSessionsOf`). L'appareil qui demande ne se compte pas — un épisode suivant passe toujours.

**L'entrée.** `POST /api/share/redeem` (publique) : code et mot de passe contre la session. Freinée par
adresse (10 / 15 min) et par lien (20 / h) ; un refus ne dit jamais lequel des deux était faux.

**Porteurs.** `share/store.ts`, `share/service.ts`, `share/gate.ts`, `share/scope.ts`, `share/guard.ts`,
`share/jellyfinAccount.ts`, `share/accounts.ts`, `share/overview.ts`.

Tests : `share-gate.test.ts` (parcourt toutes les routes de l'API, toutes méthodes : refus hors liste et
hors titre ; chaque route « corps » appelle `shareRefusal`), `share-core.test.ts` (jeton, secrets, vie
d'un lien, compte verrouillé, comptes écartés, trois lectures).

**Un titre que Jellyfin a seul (§89).** La fiche de l'invité demande sa description comme celle du foyer
(distribution, repli d'accroche et de bande-annonce), sous son identifiant réservé : la porte l'accepte
déjà — la règle `radarr` / `sonarr` compare le nombre de l'adresse à celui que le lien a gardé à sa
création, réservé compris (la pastille Partager envoie `item.radarrId` / `item.sonarrId`), et refuse tout
autre nombre. Rien n'a été élargi pour cela. Elle sautait ces titres (« rien à demander »), prémisse
démentie par §89 (audit des fiches, 23/10/2026, V9). Un lien créé sans identifiant reçoit un refus, et la
fiche reste sur le catalogue, comme pour un titre de Radarr. Tests : `share-guest-jellyfin-seul.test.tsx`.

## 113. La revue de sécurité du 20/10/2026

**Ce qu'elle a changé, et où.** Une fuite critique d'abord (9.3.2) : le relais du flux renvoyait la
clé d'administration de Jellyfin dans une liste de sous-titres demandée en majuscules — ses décisions
se prennent sans la casse, et tout texte venu de Jellyfin est nettoyé avant de repartir ; la clé a été
changée. Puis, approuvées par Louis :
- le relais ne transmet à Jellyfin qu'une liste large de paramètres (`streamQuery.ts`, les inconnus
  écartés et notés une fois, `stream.param-dropped`), et un compte a au plus cinq transcodages en
  même temps (`transcodeBudget.ts`, `transcode-limit`) ; les lectures du fichier brut ne comptent pas ;
- le proxy lit l'adresse décodée (`/%61pi/…` est servi comme `/api/…`), `crossSiteWrite` aussi ;
- sur une route d'API, la validité du jeton Jellyfin est demandée en arrière-plan : un jeton mort ne
  prolonge plus la session, et un administrateur perd ses droits aussitôt ;
- les connexions sont freinées par préfixe IPv6 /64 et par compte (20 échecs par heure) ;
- changer l'adresse d'un service dans les réglages exige de ressaisir sa clé (`secretsToResubmit`) ;
- une installation neuve demande un code d'installation, affiché dans les journaux du conteneur
  (`setupCode.ts`, §48) ; sans proxy de confiance, `X-Forwarded-For` n'est cru que d'un voisin privé ;
- les liens de partage : trois lectures comptées aussi sur le fichier lui-même, et les sessions d'un
  lien fini fermées dans la minute (les adresses de diffusion meurent avec elles) ;
- la recherche Radarr/Sonarr et la bibliothèque Jellyfin réservées à la gestion ;
- la relance d'une génération de sous-titres réservée à son auteur et à l'administrateur ;
- une session finie autrement que par « Se déconnecter » oublie aussi le compte sur l'appareil
  (`forgetAccountOnDevice`, partagée avec `signOut`) — téléchargements hors ligne exceptés ;
- les jetons retirés des journaux du lecteur et des erreurs du navigateur (`redactLogText`) ;
- les captures des signalements et les sous-titres générés revalidés au lieu d'être gardés ;
- les sauvegardes en 0640, le dossier `data/` en 770, le conteneur de développement durci comme la
  production (et `.git` en lecture seule), les actions GitHub figées par empreinte.

**Laissé, exprès.** Les titres masqués (cosmétiques, voulu par Louis). Les paramètres de débit et de
taille restent permis : la limite porte sur le nombre de transcodages, pas sur leur poids.

## 114. Fermer le lecteur, passer à l'épisode suivant : une seule suite pour les quatre hôtes

**Règle.** Fermer : la garde de l'hôte (§36), sortie du plein écran, ligne `stop "close"`, arrêt chez
Jellyfin tout de suite (la position de la croix, pas celle où le fondu aura laissé `currentTime`),
téléviseur arrêté, fondu, `playback.close(openId)` au bout de `PLAYER_CLOSE_MS` (200 ms) — cette
lecture-là seulement —, et la relecture des vues (`refreshAfterPlayback`) lancée sans attendre.
Épisode suivant (ou choisi dans le menu « Épisodes ») : rien sur une séance close, sinon ligne
`stop "next"`, arrêt chez Jellyfin sans l'attendre, `playback.advance` — le lecteur reste ouvert.

**Porteurs.** `closePlayerSession`, `advanceTo` et `PLAYER_CLOSE_MS` (`src/components/player/playerClose.ts`).

**Appelants.** `handleClose`, `handleAdvance`, `handlePlayEpisode` de `ExperimentalPlayerHost` (natif)
et de `PlayerHost` (`ActivePlayer`, serveur) ; `handleClose` de `OfflinePlayerHost` ; `close` et la fin
du film (`finishRef`) de `ChromecastPlayer`.

**Tests.** `player-close.test.ts` (ordre des étapes, garde refusée, `openId` lu à l'appel, étapes
omises) ; `decisions-partagees.test.ts` (« une seule suite pour fermer le lecteur… » : `close(openId)`,
`refreshAfterPlayback(` et `playback.advance(` n'apparaissent dans l'ensemble du lecteur que dans ce
module) ; et, inchangés, `native-close-once.test.tsx`, `ChromecastPlayer.test.tsx`,
`playerHistory.test.tsx`, les empreintes du natif et du serveur (fermeture, épisode suivant, menu
« Épisodes »).

**Voulu — ce qui reste à chaque hôte.**
- La garde (`claim`) : `lifecycle.noteClosing()` pour le natif, `closedRef` pour le serveur, l'état
  `closing` pour le hors ligne, `closedRef` ou la main rendue (`handedBackRef`) pour Chromecast, qui
  y avance aussi sa génération. Pour l'épisode suivant : `lifecycle.isOver()` / `closedRef`, plus
  l'épisode déjà à l'écran pour le menu « Épisodes » ; Chromecast teste sa garde avant de poser la
  position de fin.
- La ligne `stop` : celle de l'hôte (`reportStop`, ou `stopFields` pour Chromecast, `ended` compris) ;
  pour le hors ligne, celle de `useOfflineSessionLog`, au démontage (depuis le 02/11/2026 ; il
  n'écrivait rien au journal du lecteur avant).
- Le téléviseur (`release`) : l'élément HLS relâché en AirPlay (serveur, §94), la séance Chromecast
  terminée.
- Pas de fondu ni de sortie du plein écran pour Chromecast : la page n'y est qu'une télécommande.
- Pas de relecture des vues après une scène (§91), natif et serveur.
- L'épisode suivant hors ligne n'est pas un `advance` : `offlineNextTarget` ouvre une nouvelle séance
  par `playback.play` (fichier de l'appareil ou lecture en ligne, §109) — `advance` garderait la
  séance hors ligne de l'épisode quitté.

**Trouvé le 22/10/2026** par l'audit du lecteur (D1, D2) : quatre copies de la fermeture, chacune avec
son `200` ou son `CLOSE_MS`, et trois de l'épisode suivant. Fusionnées le 23/10/2026 sans changement
de comportement (empreintes identiques). Le hors ligne arrêtait le rapport à Jellyfin après avoir
demandé le fondu, les autres avant : l'ordre commun (arrêt puis fondu) ne change rien d'observable,
les deux partant dans le même appel synchrone.

## 115. Les doublons du lecteur : chaque règle écrite une seule fois

L'audit du lecteur du 23/10/2026 (fusions) a relevé des règles écrites deux à quatre fois — entre le
lecteur natif et le lecteur serveur, ou dans la boucle de reconstruction du natif. Celles qui ne
demandaient qu'un déplacement ont été fusionnées une par une, **sans aucun changement de
comportement** : les 49 empreintes du lecteur sont restées identiques à l'octet à chaque commit.
Les écarts que l'audit a trouvés entre les copies (une garde présente d'un côté, une remise à zéro
oubliée…) ne sont **pas** corrigés ici : chacun est une décision à part, notée sous la règle qu'il
touche. Tests communs : `player-regles-communes.test.ts` (ce que rend chaque module) et
`decisions-partagees.test.ts` (« les doublons du lecteur fusionnés… » : la copie ne revient pas).

### La ligne `rebuild`

**Règle.** La description du fichier, `path: "remux"`, `reason`, `at`, puis ce que chaque émetteur
ajoute, à sa place d'avant. **Porteur.** `rebuildLine` (`src/components/player/nativeHostHelpers.ts`).
**Appelants.** `dropDialogue` et `pceRebuild` (avant la première image), la source perdue de `onError`
(`attempt`, `skipped`, `backgroundFacts`, `lossReport`), la source fermée en arrière-plan
(`useNativeRecovery`, `hiddenMs`). **Tests.** Les empreintes `arriere-plan-…-source-perdue` et
`reseau-source-perdue-a-repetition…` ; `decisions-partagees` (aucun `reportPlayback("rebuild", {`).
**Laissé.** `pceRebuild` écrit sa ligne avant de demander `mayRebuild()` (audit F2-3) — décision à part — faite, §116.

### Entrer en coupure (lecteur natif)

**Règle.** Rien si la séance est close ou la main passée (`isOver`) ; sinon la trace, `noteNetworkLost`,
l'écran « connexion perdue » à la position et sur la piste voulue du moment, la lecture arrêtée.
**Porteur.** `enterNetworkLost(message, traced, line?)`, `useCallback` de `ExperimentalPlayerHost`.
**Appelants.** La description du fichier impossible à obtenir (`onError` de SWR), l'erreur réseau du
moteur (`onError`, `kind === "network"`), l'ouverture impossible (`.catch` du sondage). **Tests.**
Les empreintes `reseau-…` du natif et « une coupure signalée pendant l'attache… » de
`ExperimentalPlayerHost.test.tsx` ; `decisions-partagees` (un seul `setNetworkLost({`). **Différent
exprès.** La phrase de la trace, propre à chaque chemin (figée par les empreintes), passée en
paramètre. **Laissé.** La ligne `network` et la position gardée (`line`) restent au seul chemin du
moteur, comme le dit « Ce que chaque couche écrit au journal » (docs/cycle-de-vie-lecteur.md) : un
pipeline de reconstruction dont l'ouverture échoue faute de réseau n'écrit ni l'une ni l'autre —
les étendre est une décision à part (audit F2-1). Voir aussi §97.

### La fin du mot d'attente (lecteur natif)

**Règle.** `stallAtRef` remis à nul, `stallAt` et `stallUnstable` effacés ensemble. **Porteur.**
`clearStall`, `useCallback` de `ExperimentalPlayerHost`. **Appelants.** `restart` (sans condition) et
`endStall` du pipeline (image, pause, saut, fin — seulement si une attente était notée). **Tests.**
Les empreintes du natif (mot « Connexion perdue ou instable… » sous la roue) ; `decisions-partagees`
(un seul `setStallAt(null)`). **Laissé.** La remise à neuf d'un essai (`setOpenedAt`,
`setNetworkLost(null)`), écrite dans `restart` et `retryAfterNetwork` : deux lignes, pas une règle.

### L'horloge du temps regardé en marche

**Règle.** `WatchedClock.run` quand l'hôte joue, `halt` quand il cesse ou au démontage. **Porteur.**
`useWatchedClockRun(watched, playing)` (`src/components/player/session/useWatchedClockRun.ts`).
**Appelants.** `useNativeSessionRecord` (natif), `ActivePlayer` (serveur), `ChromecastPlayer` — chacun à
la place exacte de sa copie : au démontage, l'horloge s'arrête avant que le `stop "unmount"` ne la
lise. **Tests.** `player-regles-communes.test.ts`, `PlayerHost-temps-regarde`, `playerSessionTally`,
les empreintes (`watched` des `stop`) ; `decisions-partagees`. **Différent exprès.** Ce que « joue »
veut dire : Chromecast exclut l'attente du récepteur (`remote.waiting`, §97) ; les attentes de
l'élément passent par `watchElementWaits`, déjà commun.

### Démarrer un changement de piste (lecteur natif)

**Règle.** Un changement de piste qui reconstruit note d'où il part (piste et étiquette), vers où et
depuis quand (`pendingSwitchRef`, pour la ligne `audio` du pipeline suivant), et retient la piste
voulue (`wantedAudioRef`). **Porteur.** `beginAudioSwitch(playback, to)`, `useCallback` de
`ExperimentalPlayerHost`. **Appelants.** La piste voulue autre que celle ouverte (`startRemux`) et le
menu (`changeAudioTrack`). **Tests.** Les empreintes `pistes-…` du natif (ligne `audio`) ;
`decisions-partagees`. **Différent exprès.** Le menu affiche la piste tout de suite (`setCurrentAudio`,
§93) et reconstruit sur place, pause et image figée comprises (`rebuildHereForViewer`) ; l'ouverture
demande `mayRebuild()` avant de rien écrire.

### Les intentions de rechargement du lecteur serveur

**Règle.** Une intention écrite dans `sessionStorage` (`PLAYER_RELOAD_INTENT_KEY`) que la page
rechargée relit ; depuis une page qui lit déjà le lecteur serveur, l'intention, la coupure de
l'élément (`releaseHlsElement`, avant le rechargement : mediaserverd libère les sessions HLS de
façon asynchrone) et le rechargement sous une seule garde — si quoi que ce soit lève, l'appelant
garde son chemin d'avant. **Porteurs.** `reloadIntoServerPlayer` (la seule écriture),
`reloadServerPage`, `audioReloadIntent`, `ladderReloadIntent` (`src/components/player/server/serverElement.ts`)
et `directReloadIntent` (`serverReload.ts`). **Appelants.** `handOver` (relais natif → serveur,
`reloadPage()`), `changeAudio` sur WebKit (`audioReloadIntent`), la fin de l'échelle du son sur WebKit
(`useElementErrorLadder`, `ladderReloadIntent`). **Tests.** L'empreinte
`pistes-webkit-…-recharge-la-page.txt` (`storage session set …`, ordre des clés), `PlayerHost-echelle`,
`rechargement-webkit-lecteur-serveur`, `player-regles-communes.test.ts`, `decisions-partagees`.
**Différent exprès.** L'ordre des clés de chaque intention (historique, figé par l'empreinte). Ce qui
suit un échec : le changement de piste en place pour `changeAudio`, l'écran d'erreur pour l'échelle,
le relais dans la page pour `handOver`. `window.location.reload()` aux deux sites du lecteur serveur,
`reloadPage()` au relais — l'empreinte simule le second, pas le premier. Pas de coupure au relais : la
page du natif n'a pas d'élément HLS. **Laissé.** Si la coupure lève après l'écriture, l'intention reste
écrite (rouverte au prochain rechargement) — comme avant, invisible en pratique.

### La séance par titre du lecteur serveur

**Règle.** Le lecteur serveur enchaîne l'épisode suivant sans être démonté : à chaque titre, une séance
du journal neuve (identifiant d'abord), et tout ce qui la décrit repart de zéro — décompte, relances,
changements de sous-titres, image jouée, début, lenteur (`SlowLog`, `StutterWatch`, `LinkRecovery`),
palier effacé. **Porteurs.** `ServerTitleSession`, `newServerTitleSession`, `startServerTitleSession`
(`src/components/player/server/serverTitleSession.ts`) : un champ ajouté au type sans sa remise à zéro
ne compile plus. **Appelant.** L'effet du contexte du journal de `ActivePlayer`, avec `titleRefs`.
**Tests.** `player-regles-communes.test.ts`, les empreintes « épisode suivant » du serveur,
`decisions-partagees`. **Différent exprès.** Le natif n'en a pas : son hôte est remonté à chaque
titre. **Laissé.** `handedOverRef`, remis à zéro à côté : il appartient à la garde « un seul `stop` »
(audit F1-4, `StopGate`, non tranché). `switchGapRef` et `reloadGapRef` ne sont toujours pas remis à
zéro — le `stop` d'un épisode enchaîné en place porte `switchGapMs` / `reloadGapMs` de l'épisode
d'avant : une correction à part (audit F1-8) — faite, §116.

### Les saccades : le minuteur de 5 s et la bascule (§78)

**Règle.** Un blocage en pleine lecture qui dure 5 s bascule s'il tient au réseau ; à sa fin, le 2e de
plus d'une seconde en trois minutes préchauffe, le 3e bascule (`StutterWatch`) ; un blocage de plus
d'une seconde est montré au simulateur de la page de test. Le minuteur s'arrête sans rien décider sur
un saut et au départ du pipeline (natif) ou de l'effet (serveur). **Porteur.** `StallSignals`
(`src/components/player/session/stallSignals.ts`) : `started`, `ended`, `cancel`. **Appelants.** Les
écouteurs de `startRemux` (natif) et `useServerSessionWaits` (serveur). **Tests.**
`player-regles-communes.test.ts`, `slowLinkPolicy`, les empreintes `connexion-lente-…` des deux lecteurs ;
`decisions-partagees`. **Différent exprès.** Ce qui dit « réseau » : le verdict du diagnostic au natif ;
au serveur, hls.js seulement et moins d'une seconde devant au début du blocage. La bascule nommée
(`"long"` / `"repeated"`) au natif, sans nom au serveur. Le texte du simulateur (verdict ou « serveur »).
Le mot sous la roue (`stallAt`, natif) et la pastille (`useRebufferBadge`, serveur), §97. Chaque hôte
garde son décompte (`SessionTally`) et sa mesure des sauts. **Laissé, décisions à part (audit F1-3).**
Le temps caché pendant un saut, retiré au natif et compté au serveur ; la fin d'un saut (`seeked` au
natif, `playing` au serveur) ; la portée de « a déjà joué » (`playedOnce` par pipeline au natif, par
effet au serveur — une renégociation hls.js en place le garde) — alignés, §116.

### Les habitudes de lecture (§28) et « ni banc ni scène »

**Règle.** La lecture notée (`noteWatching`) toutes les quinze secondes en lecture et à chaque pause
qui compte ; à la reprise après une longue pause, le recul de `pauseRewindTarget` — ni sur un film fini,
ni pendant un saut, ni pendant un banc. Rien de noté pendant un banc ni une scène (§91) : « ni banc ni
scène » est `recordsResume(bench, isScene)`, la scène demandée seulement hors banc. **Porteurs.**
`habitWatch`, `recordsResume` (`src/components/player/session/habitWatch.ts`). **Appelants.**
`startRemux` (natif, un par pipeline) et `useServerPositionWatch` (serveur, un par `videoKey`) ;
`recordsResume` aussi pour la position gardée d'une coupure, les octets de reprise oubliés à la fin,
`keepOnStop`, la préparation de reprise du natif, l'annonce à Jellyfin et le recul d'ouverture du serveur.
**Tests.** `player-regles-communes.test.ts`, `resumeRewind`, les empreintes (`storage local set
cine:watching…`, `media … currentTime=` du recul) ; `decisions-partagees`. **Différent exprès.** Une
pause sans image ne compte pas au serveur (`pauseCounts`, a3733215) ; « fini » est `lifecycle.isEnded()`
au natif, `element.ended` au serveur ; le natif trace le recul (`onRewind`). **Laissé.** Le natif
n'appelle toujours pas `tally.retries.notePosition` (§67 : « trois secondes jouées effacent les
échecs », pour les deux lecteurs) — décision à part (audit F1-6) — faite, §116.

### La chronologie de deux minutes

**Règle.** Une chronologie (§77) par séance, un échantillon toutes les 5 s, inscrite sous l'identifiant
de séance du journal, arrêtée et désinscrite au démontage ou à l'ouverture d'une autre ; la position
d'un échantillon est `currentTime` s'il est fini et au-delà de zéro, sinon celle que l'hôte suit.
**Porteurs.** `useSessionTimeline(key, sessionOf, sample)` et `timelinePosition`
(`src/components/player/session/useSessionTimeline.ts`). **Appelants.** `useNativeSessionRecord`
(natif) et `useServerTimeline` (serveur), chacun à la place de sa copie — après l'arrêt écrit au
démontage, qui part donc encore avec elle. **Tests.** Le champ `timeline` de toutes les lignes des
empreintes (`stop`, `network`, `stall`…) ; `player-regles-communes.test.ts` ; `decisions-partagees`.
**Différent exprès.** La clé : l'identifiant de séance pour le natif (son hôte est remonté à chaque
titre), `itemId` pour le serveur, qui enchaîne l'épisode suivant en place et lit l'identifiant dans
l'effet. L'échantillon : débit `diag` et réserve pour le natif, débit d'hls.js et pas de réserve pour
le serveur ; l'attente du diagnostic dans l'état du natif seulement.

### Deux sous-titres : survie et permis du second

**Règle.** Le second ne survit ni à un principal éteint, ni à devenir le principal ; il n'est jamais
le principal, jamais sans principal. **Porteurs.** `secondSurvives`, `secondAllowed`
(`src/components/player/session/dualSubtitleRules.ts`). **Appelants.** `chooseSubtitle` et
`chooseSecond` (`useNativeSubtitleLanes`) ; `changeSubtitle` et `changeSecondSubtitle` (`ActivePlayer`).
**Tests.** `player-regles-communes.test.ts`, `PlayerHost-deuxSousTitres.test.tsx`,
`ExperimentalPlayerHost.test.tsx` (« deux sous-titres à la fois »), `decisions-partagees`.
**Différent exprès.** La clause « deux générations » (`bothGenerating`, et le refus d'une seconde
génération dans `chooseSecond`) : le natif seul (§70, §87). `subtitleSwitches` et `reportPositionNow`
sur le second : le serveur seul (§87). **Laissé.** Un second refusé : le natif rappelle quand même
`rememberDual` (la même mémoire réécrite), le serveur non — invisible, non tranché.

## 116. Les écarts entre les copies du lecteur, corrigés

L'audit des fusions du 23/10/2026 (§115) a laissé de côté, sans les corriger, les écarts trouvés
entre les copies d'une règle. Ceux que le propriétaire a validés sont corrigés ici, un commit chacun,
chacun prouvé par un test qui échouait avant. Tests : `PlayerHost-correctifs-23-10.test.tsx`
(serveur), `ExperimentalPlayerHost-correctifs-23-10.test.tsx` (natif), et la règle qui empêche
chaque écart de revenir dans `decisions-partagees.test.ts` (« les écarts entre les copies du
lecteur, corrigés »).

### Fermer pendant qu'un saut charge : la cible du saut (audit F1-4)

**Règle.** La position de la ligne `stop` et du rapport à Jellyfin (battements, arrêt) est la cible
d'un saut en cours — celle que les commandes ont demandée et pas encore atteinte, sinon celle vers
laquelle l'élément cherche (`seeking`) —, la position suivie sinon. **Porteur.** `intendedPosition`
(`src/components/player/session/intendedPosition.ts`). **Appelants.** `HostSeek.intendedPosition`
(natif, avec la cible demandée), `positionNow` de `ActivePlayer` (serveur, sans cible demandée :
`usePlaybackSession`, `useServerSessionRecord`, la position de la bascule allégée). **Avant.** Le
serveur rapportait `lastKnownTime`, que `timeupdate` ne bouge plus tant que l'élément n'a pas d'image :
fermé pendant un saut qui charge, la position d'avant le saut partait au journal et à Jellyfin, et
« Reprendre » y revenait. Le natif l'avait corrigé le 22/09/2026. **Différent exprès.** Le serveur
n'a pas de cible demandée : ses commandes posent `currentTime` sur l'élément, qui la dit aussitôt.
**Laissé.** Les autres lectures de `lastKnownTime` du serveur (changement de piste, relais, diffusion,
minuterie) — hors de ce correctif.

### L'épisode enchaîné en place : `switchGapMs` et `reloadGapMs` repartent de zéro (audit F1-8)

**Règle.** L'interruption mesurée d'une bascule allégée (`switchGapMs`) et d'un rechargement direct
(`reloadGapMs`) appartient à la séance par titre du lecteur serveur, remise à zéro avec le reste à
chaque titre (§115). **Porteur.** `ServerTitleSession.switchGap` / `reloadGap`,
`startServerTitleSession` (`src/components/player/server/serverTitleSession.ts`). **Appelant.**
`ActivePlayer` (`titleRefs`). **Avant.** Les deux références n'étaient jamais remises à zéro : le `stop`
d'un épisode enchaîné en place portait celles de l'épisode d'avant. **Laissé.** Les instants de départ
(`switchedAtRef`, `reloadDecidedAtRef`) : remis à nul à la première image, ils ne survivent à un
titre que si celui-ci n'en a jamais eu — non tranché.

### Le natif nourrit le registre des tentatives (audit F1-6, §67)

**Règle.** « Trois secondes jouées effacent les échecs » (§67) vaut pour les deux lecteurs : la position
de chaque `timeupdate` va au registre de la séance (`tally.retries.notePosition`). **Porteur.**
`habitWatch` (option `notePosition`, `src/components/player/session/habitWatch.ts`). **Appelants.**
`startRemux` (natif, `tally.retries`) et `useServerPositionWatch` (serveur, le décompte de la séance en
cours relu à chaque fois). **Avant.** Depuis `9a51259a` (11/10/2026), seul le serveur l'appelait : au
natif, une reconstruction automatique qui suivait des minutes de lecture au même passage (même motif,
même piste, même case de dix secondes) se comptait « tentative identique » — `identicalRetries` et
`retryMotif` des `stop` natifs surcomptés, et la trace « tentative identique n°… » à tort. Le registre
reste en observation : rien n'en décide. **Différent exprès.** Le serveur ne rapporte que sur une image
(`readyState ≥ HAVE_CURRENT_DATA`, la garde de son écouteur) ; le natif à chaque `timeupdate` — un
recul ou un saut n'y prouve rien de toute façon (`notePosition` ne compte qu'une avance continue).

### « A renoncé » : une séance qui n'a jamais joué (audit F1-4)

**Règle.** `gaveUpAfterMs` (le temps entre l'ouverture et la fermeture) n'est au bilan que si aucune
image n'a été jouée dans la séance. **Porteur.** `gaveUpFields(played, now, since)`
(`src/components/player/session/gaveUp.ts`). **Appelants.** `useNativeSessionRecord` (natif :
`everReadyRef`, depuis le montage) et `useServerSessionRecord` (serveur : `sessionPlayedRef`, depuis le
début de la séance par titre). **Avant.** Le natif le lisait sur le `ready` du pipeline courant, que
`restart` remet à faux : une séance fermée pendant une reconstruction « avait renoncé » depuis le
montage, après avoir joué. **Laissé.** La signature de la copie gardée (`unsentStop`) lit toujours le
`ready` du pipeline : elle ne décide que du moment de la réécrire.

### La mesure des sauts et des attentes du lecteur serveur, alignée sur le natif (audit F1-3)

**Règle.** Un saut se mesure du geste à son arrivée (`seeked`), en lecture comme en pause, sans le
temps passé en arrière-plan entre les deux ; une attente ne compte qu'en pleine lecture, c'est-à-dire
depuis la première image de la négociation (serveur) ou du pipeline (natif) en cours. **Porteurs.**
`seekStart`, `seekElapsed` (`src/components/player/session/seekElapsed.ts`, sur `seekDuration` de
`hostSeek.ts`) ; `hasPlayedOnce` de `ActivePlayer`, remis à faux par `startPlayback` (déjà celui de la
pastille « Connexion instable », `useRebufferBadge`). **Appelants.** `useServerSessionWaits` (serveur) ;
`onSeeked` et `reportUnarrivedSeek` du natif (`seekElapsed`, réexporté par `nativeHostHelpers`).
**Avant.** Le serveur arrêtait la mesure à la reprise de l'image (`playing`, ou `seeked` en pause),
comptait l'absence d'une page cachée pendant le saut (`seekWaitMs`, tuile « attente des sauts » de
l'Activité), et sur hls.js son « a déjà joué » vivait avec l'effet : une renégociation en place (piste,
« Réessayer », marche de l'échelle, bascule allégée) le gardait, ses attentes d'avant la première
image comptaient comme `waits` et nourrissaient les saccades (§78). **Différent exprès.** Le début d'un
saut : au geste pour le natif (`noteSeekRequest`, `HostSeek`), à l'événement `seeking` après une
première image pour le serveur ; le serveur n'a pas de ligne `seek` ni de `resumes` (une attente
avant la première image d'une renégociation n'y est comptée nulle part). **Empreinte.**
`serveur/sauts-et-pause-sauts-clavier-bouton-10-en-pause.txt` : `seekWaitMs` des `stop` — voir le commit
des empreintes qui suit.

### La reconstruction PCE demande `mayRebuild()` avant d'écrire (audit F2-3)

**Règle.** Qui prépare une reconstruction avant la première image demande `lifecycle.mayRebuild()`
avant d'écrire quoi que ce soit (la règle de `c1a8160c`, 27/09/2026). **Porteur.** `pceRebuild`
(`ExperimentalPlayerHost`, local à l'effet du pipeline), comme `dropDialogue` et `revertFailedSwitch`.
**Avant.** `pceRebuild`, venu après la règle, écrivait sa ligne `rebuild` puis laissait `restart`
refuser (« reprise refusée ») : une ligne au journal pour une reconstruction qui n'a jamais eu lieu,
après la main passée ou pendant le fondu de fermeture. **Voulu.** Le refus du PCE reste retenu
(`takePceCopyRefusal`, avant la garde) : c'est un fait sur ce navigateur, que la prochaine ouverture
doit connaître. Le message est rendu comme traité (`true`) : la main est déjà passée, rien d'autre à
faire. **Laissé.** `failOver` (audit F2-4), non tranché.

### Le lecteur hors ligne ne se ferme qu'une fois (§36, §114)

**Règle.** La garde de fermeture d'un hôte est une référence, notée fermée dans l'appel même : un
second appel dans le même tour (double appui, Retour puis croix) la trouve prise. **Porteur.**
`claimOnce(ref)` (`src/components/player/playerClose.ts`). **Appelants.** `handleClose` de
`OfflinePlayerHost` et de `ActivePlayer` (serveur, déplacement pur de sa garde écrite en ligne). Le
natif garde `lifecycle.noteClosing()`, Chromecast sa garde qui avance aussi sa génération.
**Avant.** Le hors ligne lisait l'état React `closing` : les deux appels voyaient la valeur du rendu
d'avant et passaient — deux arrêts chez Jellyfin, deux relectures des vues, deux `playback.close`.
**Voulu.** `closing` reste l'état du fondu (et la garde de la fermeture sur un téléchargement supprimé).
**Tests.** `offline-player-close-once.test.tsx`.

### Chromecast relit les vues après une scène — laissé, exprès (§91)

**Constat.** Natif et serveur ne relisent pas les vues à la fermeture d'une scène (`refresh:
!isSceneRef.current()`) ; `ChromecastPlayer` passe `refresh: true`. **Pourquoi ce n'est pas aligné.**
Ce n'est pas un oubli : §91 exclut la diffusion exprès (« le téléviseur écrit sa propre position »), et
`ChromecastPlayer` annonce et rapporte la séance à Jellyfin même pendant une scène (sa séance passée à
`usePlaybackSession` n'est nulle que pour un banc ; il ne tient pas d'horloge de scène). Après une scène
diffusée, la reprise chez Jellyfin a donc bougé : sans relecture, la fiche et « Reprendre » montreraient
l'ancienne position — une régression visible. La relecture ne peut suivre la règle des deux autres
hôtes que si la diffusion d'une scène cesse elle aussi de rapporter sa position : une décision sur §91,
hors de ce correctif (23/10/2026).

## 117. Les fiches de titre : une règle par geste (audit du 23/10/2026)

L'audit des fiches (film et série du bureau, fiche du téléphone, écran des épisodes, fiche TMDB, fiche
d'un lien de partage, fiche hors ligne) a trouvé chaque geste décidé jusqu'à quatre fois. Chaque
sous-section dit la règle, sa fonction, ses appelants, ses tests et ce qui diffère exprès.

### 117.1 Les touches d'une fiche

**Règle.** Échap et Retour arrière referment une fiche ; les flèches parcourent son menu. Une fiche se
tait quand elle est recouverte (une autre fiche, le lecteur — §7.3 —, une fenêtre à elle), et pour
toute touche quand une feuille (`ActionSheet` : Télécharger, la gestion d'un téléchargement, Partager)
est posée par-dessus. Retour arrière dans un champ de saisie efface une lettre et ne referme rien.
Une feuille ouverte garde ses touches : Échap ne referme qu'elle, les flèches, Entrée et Retour arrière
n'atteignent pas l'écran dessous.

**Porteurs.** `useSheetKeys` et `sheetKeyBelongsElsewhere` (`src/lib/useSheetKeys.ts`) ; `ActionSheet`
écoute en capture sur `window` (comme `CinemaDetailModal`) et arrête ces touches sans les annuler.
`useSheetExit` (§7.1) appelle `sheetKeyBelongsElsewhere` avant de refermer.

**Appelants.** `CinemaMovieDetail`, `CinemaSeriesDetail`, `CinemaEpisodeBrowser`, `CinemaMobileDetail` ;
par `useSheetExit` : `PlayerDiscoverSheet`, `PlayerPersonSheet`, `OfflineTitleSheet`.

**Corrigé le 23/10/2026.** Les fiches du bureau écoutaient sur `window` sans regarder ni la cible ni la
feuille : Retour arrière dans le champ « Pour qui » de Partager refermait la fiche ; Échap fermait la
feuille *et* la fiche ; une flèche dans Télécharger envoyait le focus sur « Lire », derrière la
fenêtre, et Entrée lançait le film. Le téléphone et l'écran des épisodes avaient la garde
`[data-action-sheet]`, recopiée ; elle vit ici. La fiche du téléphone ne fermait que sur Échap : sur un
iPad à clavier en interface tactile, Retour arrière refermait la fiche TMDB posée dessus, puis plus rien ;
elle ferme aux deux touches depuis le même jour.

**Tests.** `fiche-touches-feuilles.test.tsx`, `fiche-telephone-retour-arriere.test.tsx`,
`decisions-partagees.test.ts` (« les touches des fiches »).

**Voulu.** La fiche série du bureau, dont l'adresse nomme l'écran des épisodes sans qu'il soit dessiné,
referme ce cran-là (`cinemaClose({ episodes: false })`) et non la fiche (13/10/2026). La fiche d'un lien
de partage n'a pas de fermeture : elle est la page.

### 117.2 La reprise d'un téléchargement depuis la fiche

**Règle.** « Lire le fichier téléchargé » part de la même position partout sur la fiche — la ligne de
tête comme la feuille de gestion d'un téléchargement en cours : celle de Jellyfin s'il a répondu (et
que rien n'attend d'être envoyé), sinon celle de l'appareil.

**Porteur.** `sharedResumeSeconds(download, ticks, known)` (`OfflineDownloadControl.tsx`, §109).
`OfflineDownloadControl` exige `onlineKnown` à côté de `onlineResumeTicks` : `null` dit aussi bien
« jamais commencé » que « pas de réponse ».

**Appelants.** `CinemaMovieDetail`, `CinemaMobileDetail` (les deux lignes, `OfflinePlayButton` et
`OfflineDownloadControl`, reçoivent `facts.resumeKnown`).

**Corrigé le 23/10/2026.** La feuille de gestion ne recevait que la position : Jellyfin injoignable, un
film commencé, téléchargement en pause, repartait du début depuis la feuille alors que la ligne de tête
disait « Reprendre ».

**Tests.** `offline-gestion-reprise.test.tsx`, `decisions-partagees.test.ts`.

### 117.3 La pastille « Partager » d'une fiche

**Règle.** Administrateur seul (§112). Un film se partage s'il a un fichier ; une série, toujours — on
partage la série entière, quel que soit l'état de l'épisode « À suivre ».

**Porteur.** `shareableFrom(kind, { jellyfinItemId, fileMissing })` (`src/components/share/ShareControl.tsx`).

**Appelants.** `CinemaMovieDetail`, `CinemaSeriesDetail`, `CinemaMobileDetail` (film et série).

**Corrigé le 23/10/2026.** Le téléphone cachait la pastille d'une série dont l'épisode à suivre avait
perdu son fichier (la condition du film recopiée) ; le bureau la gardait.

**Tests.** `fiche-partager-pastille.test.tsx`, `decisions-partagees.test.ts`.

### 117.4 « À voir » et « Vu » : une forme, un crochet

**Règle.** Sur toute fiche de titre — bibliothèque ou TMDB, bureau ou téléphone —, « À voir » dit
« À voir » éteint et « Dans ma liste » allumé, avec un plus qui devient un marque-page coché ; « Vu »
dit « Marquer comme vu » éteint et « Vu » allumé, avec une coche qui devient un cercle coché, et
annonce son état (`aria-pressed`). L'ordre est celui de la mise en page : au bureau « Vu » puis
« À voir », au téléphone « À voir » puis « Vu ». Un ajout dit « Ajouté à ma liste », un retrait
« Retiré de ma liste », d'où qu'ils viennent ; « À voir » est optimiste et ne se grise pas.

**Porteurs.** `WATCHLIST_FACE`, `WATCHED_FACE` et leurs trois dessins `TitleToggleRow` (menu du
bureau), `TitleToggleIcon` (icône du téléphone), `TitleToggleWide` (bouton de la fiche TMDB au
téléphone) — `src/components/cinema/TitleToggles.tsx` ; `useWatchlistToggle`
(`src/lib/useWatchlistToggle.ts`, sur `useAddToWatchlist` et `canJoinWatchlist`) pour l'écriture de
« À voir ».

**Appelants.** `CinemaMovieDetail`, `CinemaSeriesDetail`, `CinemaMobileDetail`, `PlayerDiscoverSheet` —
les quatre pour les dessins comme pour `useWatchlistToggle` (les trois fiches de bibliothèque recopiaient
`useWatchlistStatusMap` + `useAddToWatchlist` + la garde + la charge utile ; fusionnées le même jour,
DOM témoin identique).

**Corrigé le 23/10/2026.** Dans une rangée de saga ou une filmographie, un titre possédé ouvre la fiche
de bibliothèque et un titre absent la fiche TMDB : le même geste changeait de mots (« Ajouter à ma
liste »), d'icônes (marque-page, œil barré), de place (la liste avant « Vu » au bureau) et de message
(« Ajouté à « Ma liste » », par `usePlayerTitleActions.setStatus`, grisé pendant l'écriture). Et le
bouton « Vu » éteint des fiches de bibliothèque disait « Vu », comme allumé : `cinema.markWatched`
dit désormais « Marquer comme vu » dans les quatre langues.

**Tests.** `fiche-a-voir-vu-forme.test.tsx` (le vrai dictionnaire français), `fiche-boutons-deux-etats.test.tsx`,
`decisions-partagees.test.ts`.

**Les fiches de bibliothèque du bureau : une rangée de boutons ronds** (10.27, 09/11/2026, décision du
propriétaire). Avec la ligne « Poser une question » (§139), la liste verticale des actions avait grandi, et
sur un écran de 13 pouces le logo remontait sous le bouton Retour. **Règle : la première page d'une fiche
ne défile jamais — une seule page par titre, comme une télévision — et ne commence jamais sous la barre du
Retour.** Donc :
- « Marquer comme vu », « Dans ma liste » et « Poser une question » quittent la liste et deviennent **une
  rangée de trois boutons ronds** sous les actions principales (`DetailIconActions`, la même pièce pour le
  film et la série) : le verre des autres boutons ronds de la fiche (`ROUND_ACTION`, `bg-black/55`,
  `float-edge`), l'or quand c'est allumé (`TitleToggleRound`, quatrième dessin de `TitleToggles`, mêmes
  mots et mêmes icônes, l'état dans `aria-pressed`), un `aria-label` et une bulle au survol (`title`) ;
  chacun porte `data-detail-menu` (les flèches y descendent). « Poser une question » est
  `AskTitleControl variant="round"`. La fiche du téléphone et la fiche découverte ne changent pas ;
- le logo de la fiche est borné aussi par la hauteur de la fenêtre (`CinemaLogo`, surface `sheet` :
  `min(<px>, 14vh)`) ;
- le haut de la page est réservé à la barre du Retour (`SECTION_CLASS`, `pt-[calc(4.5rem+safe-area)]`) ;
- sous 720 px de haut, en dernier recours : l'accroche se tait (`SHORT_HIDE`), les écarts de la colonne
  (`COLUMN_GAP`) et les lignes du menu (`MENU_ROW`) se resserrent ; le synopsis garde ce que
  `CinemaOverview` mesure (deux lignes au moins). **Jamais de défilement.**
Compté sur le papier (colonne d'un film avec toutes ses lignes, synopsis à deux lignes) : 1280×800 → 586 px
pour 672 disponibles ; 1366×768 → 586 pour 640 ; 1440×900 → 656 pour 732 ; une fenêtre de navigateur de
~650 px de haut (13 pouces) → 461 pour 546. Une série avec « Plus d'épisodes » ajoute une ligne (40 à 48 px)
et tient aussi. Tests : `decisions-partagees.test.ts` (les deux fiches posent `DetailIconActions`, qui pose
`TitleToggleRound` et `AskTitleControl`), `fiche-a-voir-vu-forme.test.tsx` et
`fiche-boutons-deux-etats.test.tsx` (lisent le libellé d'un bouton rond), `CinemaLogo.test.tsx` (le plafond
en `vh`).

**10.27.1 : l'or rendu aux deux boutons allumés.** En 10.27.0, « Vu » et « Dans ma liste » allumés
s'affichaient comme éteints : la classe de l'allumé (`bg-ink text-brand ring-brand/60`) s'ajoutait à celle du
verre (`bg-black/55 text-white`) sur le même bouton, et entre deux couleurs de texte d'une même classe c'est
l'ordre de la feuille de Tailwind qui tranche — le blanc gagnait. `roundAction.ts` sépare la forme
(`ROUND_ACTION_SHAPE`) des deux teintes (`ROUND_ACTION_IDLE`, `ROUND_ACTION_ON`) ; un bouton n'en porte qu'une.
L'allumé est l'or de la pastille allumée du menu (`MENU_BADGE_ACTIVE`, §83 option B — le même jeton `brand`
que l'icône or du téléphone), au clavier un anneau blanc qui n'éteint pas l'or ; `data-on` le dit. Test :
`fiche-ronds-or.test.tsx` (chacun des deux, allumé : l'or et pas le blanc ; éteint : le verre et pas l'or).

**Voulu.** La source de « Vu » reste double (§51) : Jellyfin pour un titre de la bibliothèque
(`useJellyfinItemState`, qui attend d'avoir lu — d'où l'estompé), la copie locale pour un titre TMDB
(`useTitleWatched`). L'estompé d'un « Vu » non lu vaut 50 % au bureau, 40 % au téléphone. La fiche
TMDB du téléphone garde ses boutons pleine largeur sous « Demander » : la mise en page diffère, pas
la forme des deux gestes. `usePlayerTitleActions.setStatus` reste l'écriture de « Ma liste » hors des
fiches (le panneau du lecteur, l'ajout à une liste).

### 117.5 Le hors ligne d'une fiche ne dépend que de sa décision

**Règle.** « Télécharger » et « Lire le fichier téléchargé » paraissent sur la fiche d'un film quand le
hors ligne est ouvert (`useOfflineDownloadsEnabled`, §109) — au bureau comme au téléphone, sans garde à
elles.

**Corrigé le 23/10/2026.** La fiche du téléphone ajoutait la lecture intégrée (`playerEnabled &&`) aux
deux lignes, celle du bureau non : deux endroits pour une décision. Invisible aujourd'hui —
`useOfflineDownloadsEnabled` lit la même configuration et exige déjà `playerEnabled` —, mais la
première à changer aurait dérivé de l'autre. La place de « Lire » encore tenue au téléphone
(`playPending`) reste la condition de la ligne de tête : c'est la mise en page qui l'attend.

**Tests.** `fiche-hors-ligne-sans-garde-lecteur.test.tsx`, `decisions-partagees.test.ts`.

### 117.6 La ligne d'un épisode

**Règle.** Une ligne d'épisode dit le temps qui reste d'un épisode commencé et pas fini, sinon sa durée
quand on la connaît ; elle porte « À suivre » sur l'épisode que Lire lancerait. Un appui lance
l'épisode là où il en est (`episodeResumeAt`, zéro dit explicitement), avec la suite de la série.

**Porteurs.** `episodeRowFacts(ep, nextEpisodeId)` et `playEpisodeFrom(playback, ep, getNextEpisode)`
(`src/lib/episodeRow.ts`).

**Appelants.** `CinemaEpisodeBrowser` (bureau, et l'invité au bureau), `CinemaMobileDetail`,
`ShareTitleSheet` (`PhoneEpisodes`, et le lancement au bureau) ; `CinemaSeriesDetail` pour le
lancement depuis l'écran des épisodes.

**Fusionné le 23/10/2026.** La règle du temps était écrite trois fois, le lancement quatre ; identiques
ce jour-là. DOM témoin identique avant et après.

**Tests.** `episodeRow.test.ts`, `decisions-partagees.test.ts`.

**Voulu.** Chaque liste garde son dessin (colonne de saisons au bureau, pastilles au téléphone) et sa
garde de lecture intégrée ; l'invité ajoute « lien plein ». Le menu « Épisodes » du lecteur a sa propre
ligne (§107), hors de ce registre.

### 117.7 Le bouton Lire d'une fiche : un crochet

**Règle.** Celles de §1 (d'où part une lecture), §2 (l'épisode suivant), §12 (ce que Lire trouve prêt)
et §29 (ce qu'une fiche montre avant le réseau), demandées une fois pour toutes les fiches : la réponse
de Jellyfin traduite en faits (« connu » = Jellyfin a répondu), la place tenue d'une série jamais
commencée, l'attente d'un S1·É1 supposé (sauf liste en panne), le fichier introuvable, la copie hors
ligne en tête, le code « S1:É5 », le libellé (« Lire en ligne » derrière un téléchargement, sinon celui
de « Continuer à regarder »), le préchargement du seul titre du bouton, et l'épisode suivant relu dans la
liste à la fin d'un épisode.

**Porteur.** `useSheetPlay(title, { prefetch, offline })` (`src/lib/useSheetPlay.ts`), sur
`useSheetPlayFacts`, `useFileMissing`, `useOfflinePlayable`, `usePlaybackPrefetch`,
`useNextEpisodeFromCache`. La position d'un film vient de la réponse de `useJellyfinItemState`, que la
fiche tient déjà pour « Vu » (même clé) ; la fiche du téléphone la lisait une seconde fois.

**Appelants.** `CinemaMovieDetail`, `CinemaSeriesDetail`, `CinemaMobileDetail`, `ShareTitleSheet`.

**Fusionné le 23/10/2026.** Quatre copies d'une vingtaine de lignes, identiques ce jour-là. DOM témoin
identique avant et après (68 rendus, reprises de l'appareil comprises).

**Tests.** `useSheetPlay.test.tsx` (les six cas), `fiche-lire-avant-reseau.test.tsx` (rendu, fiche par
fiche), `decisions-partagees.test.ts`.

**Voulu.** Le téléphone tient aussi la place de Lire tant que la configuration n'est pas lue
(`playerEnabled === undefined`) : c'est sa mise en page qui l'attend, pas une règle de lecture. L'invité
ne prépare rien quand son lien est plein (`prefetch: false`) et ne compte aucune copie hors ligne
(`offline: false`).

**Le gros bouton du téléphone n'est pas `PlayButton`, mais suit la même règle.** La fiche du téléphone
garde son propre bouton Lire (§29) — le même calcul (`resumeAtFor`, `useQueuedPlay`, faits de
`useSheetPlay`) : son geste liquide ne se vérifie qu'à l'œil sur iPhone, et le fusionner n'est pas un
simple déplacement. La seule règle qui différait est alignée (tranché le 23/10/2026) : un appui retenu sur
un S1·É1 supposé ne part pas si, la réponse arrivée, l'épisode qu'elle désigne a perdu son fichier — le
téléphone revérifiait `fileMissing` au départ (`launch`), `PlayButton` relit désormais `unavailable` au
départ de la même façon (fiches du bureau, invité), au lieu de lancer un épisode qui échouait dans le
lecteur. `fiche-telephone-lire.test.tsx` et `PlayButton-fichier-perdu.test.tsx` tiennent les deux.

### 117.8 L'habillage des fiches du bureau

**Règle.** Les deux fiches du bureau — film et série — ont le même cycle de vie : arrivée par un retour
sans animation (`arrivedByBack`, lu une fois au montage), fermeture différée par `requestClose` (Échap,
Retour arrière, le bouton Retour, la poignée), trajet ou continuité à l'ouverture et à la fermeture
(§61), poignée au doigt seulement et jamais dessous, focus rendu à la première action au retour du
lecteur (§7.3), drapeau « le spectateur a bougé lui-même » remis à zéro à chaque titre (§74). Et le même
écran : la couche plein écran, le fond (photo, flou localisé, deux voiles), la poignée, le bouton Retour.

**Porteurs.** `src/components/cinema/DesktopSheetShell.tsx` : `useDesktopSheetShell`, `DesktopSheetFrame`
(la racine), `DesktopSheetBackdrop` (le fond), `SheetBackButton` (le bouton Retour), `DetailTrailerRow`
(la ligne Bande-annonce et sa place tenue).

**Appelants.** `CinemaMovieDetail`, `CinemaSeriesDetail` (tout) ; `PlayerDiscoverSheet` (le fond, le
bouton Retour), `ShareTitleSheet` (le fond, la ligne Bande-annonce), `CinemaEpisodeBrowser` (le bouton
Retour).

**Fusionné le 23/10/2026.** ~170 lignes identiques entre le film et la série, cinq copies du fond, quatre
du bouton Retour, trois de la ligne Bande-annonce. DOM témoin identique avant et après.

**Tests.** `fiche-bureau-poignee.test.tsx`, `sheetMorph-desktop-sheets.test.tsx`,
`sheetMorph-continuity.test.tsx`, `series-detail-episodes-*.test.tsx`, `decisions-partagees.test.ts`.

**Voulu.** Le fond de la fiche TMDB ne floute qu'à partir de `md` (`blur="md:backdrop-blur-md"`) et son
bouton Retour est `absolute` (sa racine s'anime au téléphone) ; celui d'un lien de partage n'a pas la
marque `data-sheet-settle` (rien ne s'y relaie). Chaque fiche garde son effet de focus d'arrivée, dont
les déclencheurs diffèrent (la série attend aussi sa liste d'épisodes et se tait sous leur écran). La
fiche hors ligne (`OfflineTitleSheet`) garde son fond, hors du témoin de cette fusion.

## 118. Le nom : Laterna, son moteur Lumen — et les anciens noms reconnus pour toujours

**Règle.** L'application s'appelle **Laterna** ; son moteur de lecture dans le navigateur, **Lumen**
(« Moteur de lecture », `signature.engineRole`). Le nom affiché s'écrit une fois, `APP_NAME`, et le
moteur `ENGINE_NAME` (`src/lib/appBuild.ts`) ; le manifeste, `offline.html` et `sw.js`, qui ne peuvent
rien importer, l'écrivent en toutes lettres. Jellyfin voit deux clients, « Laterna » (lecteur serveur,
connexion, partage, téléchargements) et « Lumen by Laterna » (lecteur natif). Les noms d'avant
— « CineApp », « CineEngine By CineApp » — restent reconnus **pour toujours** : un corps de rapport qui
en porte un est rapporté sous son successeur (un onglet resté sur l'ancienne version ouvrirait sinon
une seconde séance chez Jellyfin, qui clé ses séances par client), et le ménage des appareils traite
`AppName` « CineApp » comme « Laterna ». Ce qui est enregistré garde l'ancien nom : clés `cine:*` /
`cine-*` du navigateur, IndexedDB, dossiers OPFS, caches du service worker (`CACHE_NAME` non relevé),
cookie de session, `cine.db`, `DATA_DIR`, identifiants d'appareil `cine-app-…`.

**Porteurs.** `src/lib/playbackClients.ts` — `PLAYBACK_CLIENTS`, `LEGACY_PLAYBACK_CLIENTS`,
`OWN_APP_NAMES`, `isPlaybackClient`, `currentPlaybackClient`, `isOwnAppName` : la seule liste des noms
annoncés à Jellyfin, anciens compris. `src/lib/appBuild.ts` — `APP_NAME`, `ENGINE_NAME`.
`src/lib/engineBricks.ts` — les briques de Lumen (PlaybackCore, MuxCore, AudioCore, BufferCore,
StreamCore, CodecBridge, PlaybackBridge), **libellés d'affichage seulement** : `brickOfDiagnostic` dit
sous quelle brique s'affiche chaque ligne de diagnostic existante ; aucun champ de journal, clé, fichier
ni variable ne porte ces noms.

**Appelants.** Routes `/api/jellyfin/playback/{playing,progress,stop}` (`currentPlaybackClient`),
`jellyfinDevicePrune.ts` (`isOwnAppName`), `/api/auth/jellyfin`, `share/jellyfinAccount.ts`,
`offline/jobs.ts` (`PLAYBACK_CLIENTS.stable`) ; `AppSignature` (§41), `layout.tsx`, connexion, assistant,
partage, état, hors ligne, rail, barre du téléphone, `useMediaSession`, notification d'essai ;
`describeRemuxPlayback` / `describeJellyfinPlayback` et `PlaybackInfoPanel` (les briques) ;
`ActivitySeance` (« Lumen · lecteur natif », « Lecteur serveur · PlaybackBridge »).

**Tests.** `playback-clients-noms.test.ts` (les quatre noms, le successeur d'un ancien, les appareils
des deux noms au ménage, et aucun de ces noms écrit en dur ailleurs dans `src/`), `engine-bricks.test.tsx`,
`AppSignature.test.tsx`, les tests des routes de rapport (un corps « CineEngine By CineApp » rapporté
« Lumen by Laterna »).

**Voulu.** Dans le panneau technique, le lecteur serveur n'étiquette que ce qui relève de Lumen — sa
tête (PlaybackBridge), « Diffusé » (PlaybackBridge), « Le flux » (StreamCore), « Ce que l'appareil
accepte » (CodecBridge) — : le fichier et le son y sont décrits par Jellyfin. Les pages de Nouveautés
déjà publiées ne sont pas réécrites (« CineApp » y reste). Le dépôt, l'image, le conteneur et le `name`
de `package.json` gardent `cine-app` jusqu'à un renommage décidé à part.

**Deux adresses.** Une installation peut être servie sous plusieurs adresses publiques à la fois
(l'ancienne gardée à côté de la nouvelle). Rien n'en dépend côté serveur : lien de partage
(`window.location.origin`), adresse donnée au téléviseur (`publicOrigin`, lue à chaque requête), liens
des notifications (relatifs), manifeste (`id`, `start_url`, `scope` relatifs — l'`id` ne change pas),
cookies sans `Domain`, `crossSiteWrite` comparé à l'hôte de la requête, CSP en `'self'`, récepteur
Chromecast par défaut de Google. Côté navigateur, chaque adresse est un site à part : session,
application installée, abonnement aux notifications et téléchargements hors ligne sont à refaire sur la
nouvelle ; un appareil abonné aux notifications sur les deux adresses les reçoit deux fois.

**La page Nouveautés du renommage** (`src/lib/news/pageLaterna.ts`) ne va qu'à l'installation dont le
déploiement donne la nouvelle adresse : `NEWS_LATERNA_ADDRESS` (`.env`, déploiement seulement, hors du
schéma des réglages et de `.env.example` — `config.news.laternaAddress`, lue par `envOnly`). Sans elle,
`laternaNewsPage` rend `null` et rien n'est semé ; l'adresse affichée est celle du réglage (nom d'hôte
seul, `laternaAddress`), jamais une valeur du code. Préparée le 23/10/2026, **pas encore branchée** :
elle se publiera par deux lignes dans `migrate()` (`db.ts`), à côté des autres pages. Tests :
`news-page-laterna.test.ts`.

**Le logo** (« le L-faisceau », 23/10/2026) remplace le clap partout où le clap *était le logo* : les
images de `public/` (icônes, favicon, icône Apple, icône maskable à part, badge des notifications,
les 42 écrans de lancement) sont toutes produites par `tools/brand/generate.mjs` depuis les SVG de
`tools/brand/` — jamais retouchées à la main —, et le glyphe sans fond posé dans l'interface (rail,
barre du téléphone, barre latérale de la gestion, état des services, assistant) est `BrandMark`
(`src/components/BrandMark.tsx`) ; `offline.html`, qui ne peut rien importer, en recopie le dessin.
Les `Clapperboard` restants (menu « Lecture », séances, signalements, capacité « trailers ») ne sont
pas le logo.

**Ses couleurs (23/10/2026, « aplat et faisceau or »)** : le logo : L blanc, faisceau or — la lumière de
la lanterne est la couleur de ce qui est à moi (§83, « L'or »). Fond `#0a0a0c` (le noir de l'app, le
carré arrondi ; plein carré pour `icon-flat` et la maskable), L blanc cassé plein `#f5f5f4`, faisceau or
`#fbbf24` en dégradé de gauche à droite (opacité 0,85 → 0,18), triangle de lecture `#0a0a0c` dans le
faisceau. Les variantes 48/32/16 gardent leurs formes (pas de triangle à 32 et 16) ; le badge reste une
silhouette blanche sur transparent. Raison : sortir du registre violet/cyan des produits d'IA. Le
dégradé violet → bleu du 23/10 au matin n'existe plus nulle part. `BrandMark` reprend le L et le
faisceau, sans fond : il ne se pose que sur le noir (sur un fond clair, le L blanc cassé disparaîtrait ;
aucun emploi de ce genre). Sur les écrans de lancement, le carré du logo est du noir même de l'écran et
ne se voit plus : le dessin reste à sa place dans le carré (28 % du petit côté, centré), donc
légèrement à droite et en bas du centre optique — même proportion qu'avant. Le seuil de
`splashScreens.test.ts` (poids par mégapixel, sonde contre l'aplat) passe de 5 à 4 Ko : un carré qui ne
coûte plus rien fait tomber les grands écrans à 4,9 ; un aplat en coûte 2,9. Mêmes adresses qu'avant, plus `icon-maskable-512.png` et `badge-96.png` (dans
`ACTIFS_PUBLICS`) ; `CACHE_NAME` non relevé (voir l'en-tête de `sw.js`). Tests : `brand-assets.test.ts`
(chaque image référencée existe à ses dimensions), `splashScreens.test.ts`.

**Décidé le 23/10/2026.**

## 119. Le passage d'une adresse à l'autre, en un appui

**Règle.** Sur l'ancienne adresse d'une installation qui en annonce une nouvelle (§118,
`NEWS_LATERNA_ADDRESS`), un compte du foyer passe à la nouvelle sans mot de passe, connecté, avec les
réglages de son appareil, et sans recevoir ses notifications deux fois. L'appui (l'écran du passage, `PassageScreen`,
ou l'adresse dans la carte « Une nouvelle adresse » des Nouveautés) demande au serveur **deux secrets à
usage unique**, rangés hachés (SHA-256) dans `passages` : un **jeton** de 32 octets
(`crypto.randomBytes`, deux minutes), placé dans le **fragment** de l'adresse ouverte
(`/passage#t=…` — ni le proxy ni aucun journal ne voient un fragment), et un **code** de 8 caractères
Crockford (`XXXX-XXXX`, quinze minutes), copié au même appui. L'un ou l'autre, présenté à
`/api/passage/redeem` (POST de même origine), ouvre une session **jumelle** de celle d'origine — même
compte, même rôle, même jeton Jellyfin et même appareil Jellyfin, nouveau `jti` —, posée comme une
connexion (`setSignedInCookies`). Le code existe pour l'iPhone : une application installée y a son
propre stockage, ni les cookies ni le `localStorage` de Safari (WebKit ne documente la copie des cookies
qu'à l'ajout au Dock de macOS, pas sur l'écran d'accueil d'iOS) ; elle y entre par la page de connexion
(« Vous venez de l'ancienne adresse ? Code de passage », montrée seulement sur la nouvelle adresse).

**Sécurité.** Demande : session vivante du foyer seulement (`admin`, `user` — jamais `share`, dont la
porte la refuse et la route aussi), même origine, dix par heure et par compte, ligne `passage-requested`
dans `auth.log` ; une demande remplace les secrets non servis de la même session. Échange : consommé par
**une seule écriture conditionnelle** (`UPDATE … WHERE used_at IS NULL AND expires_at > now RETURNING`),
puis la session d'origine doit exister encore (une session fermée entre-temps invalide ses secrets) ;
refus identiques (corps et code 401) pour inconnu, mal formé, expiré, déjà servi, session fermée, et
d'au moins 400 ms (`passageTiming`) ; cinq échecs par adresse cliente (une IPv6
par son /48) en quinze minutes, 2 000 échecs de code pour toute l'installation — cent laissaient un
anonyme fermer l'entrée par code au foyer ; à 2 000, chercher un code de 40 bits reste sans espoir
(calcul dans `attempts.ts`) —, puis 429 (`attempts.ts`, sur `globalThis`) ; `passage-received`,
`passage-refused`, `passage-blocked` dans `auth.log`. Un navigateur déjà connecté sur la nouvelle
adresse (session vivante, lien de partage compris) n'échange rien sans accord : `/passage` demande
« Changer de compte » / « Rester sur mon compte » sans nommer le compte du lien, et la route répond 409
(`passage-confirm`) sans `replace: true`, avant de lire le secret — ni consommé ni compté comme échec
(un lien piégé connectait la victime au compte de l'attaquant, relecture du 23/10/2026). La session d'origine est gardée chiffrée
(`encryptSecret`) dans la ligne le temps du passage ; la table est hors des sauvegardes
(`DISPOSABLE_TABLES`). La destination est **toujours** celle du réglage (`passageTarget`, nom d'hôte
validé par `laternaAddress`, `https` sauf `http://` écrit dans le réglage) : le serveur construit
l'adresse, le client n'en fournit jamais — pas de redirection ouverte.

**La connexion Jellyfin.** Le passage ne peut pas obtenir de nouveau jeton sans mot de passe (Quick
Connect dépend d'un réglage du serveur Jellyfin). Les deux sessions partagent donc l'appareil, et
**l'appareil ne tombe qu'avec la dernière session qui s'en sert** : `sessionDb.delete`, `deleteForUser`
et le ménage de `create` ne rendent un appareil à révoquer que si plus aucune ligne de `sessions` ne le
porte (`orphanDevices`). La déconnexion ne se rabat sur la révocation par jeton que pour une session dont la
ligne existe encore sans appareil connu — une ligne absente est une session déjà fermée (« Déconnecter
les autres appareils », l'administrateur), et son jeton peut servir encore à une jumelle : rien n'est
révoqué (relecture du 23/10/2026) ; une session dans ce cas (ouverte avant le 24/09/2026) ne peut pas demander de passage
(`passage-relogin` : se reconnecter une fois). Fermer une session depuis l'Activité ferme aussi ses
jumelles (même compte, même `jf_device` : `sessionDb.deleteWithTwins`), puis révoque l'appareil ; la
liste des sessions d'un compte dit « Jumelle de … » (`appSessionsOf`, `twinsForUser`). Le ménage des appareils (`jellyfinDevicePrune`) épargne
déjà tout appareil d'une session vivante (`liveJfDevices`).

**Réglages.** Liste blanche, `PASSAGE_SETTINGS` (`src/lib/passage/settings.ts`), par noms logiques :
volume, style des sous-titres, deux sous-titres, interface (Tactile/Ordinateur), agrandissement des
bandes noires, « Améliorer les dialogues », plafond HDR, qualité « Originale » (rangée sous le compte
d'arrivée). Chaque valeur validée à la demande et à l'arrivée ; 2 Ko au plus. Ce qui suit déjà le compte
côté serveur (langue, disposition de l'accueil, défilement guidé) n'y est pas. Gardés avec la session
d'arrivée (`passage_arrivals`, 30 jours au plus) et posés **au lancement du cinéma** (`PassageArrival`)
sur tout stockage qui ne les a pas encore (`cine:passage-applied`) — application installée comprise —,
puis la page se recharge une fois (jamais pendant un film) ; effacés quand l'application installée les
a posés.

**Notifications.** L'abonnement de l'appareil sur l'ancienne adresse voyage avec le passage s'il est
rangé sous ce compte ; quand la nouvelle adresse s'abonne (`POST /api/push/subscribe`), il est retiré
**pour ce compte seulement** (`replaceArrivedPushEndpoint`, `removeForUser`), dans sa propre garde.

Le ménage des secrets expirés (`prunePassages`) passe à chaque demande **et** à chaque échange, réussi
ou non. Sur l'ancienne adresse (`passageHost` annoncé et différent de l'adresse de la page,
`useOldAddress`), aucune aide à l'installation : ni `InstallPrompt`, ni `PassageInstallHelp`, et la phrase
des notifications sur iPhone (`useInstallHintText`, `PushToggle` et l'accueil du compte) renvoie à la
nouvelle adresse au lieu de faire installer celle-ci ; sur la nouvelle adresse et sans réglage, rien ne
change.

**Porteurs.** `src/lib/passage/service.ts` (secrets, échange, arrivée, notifications, ménage),
`settings.ts` (liste blanche), `target.ts` (destination), `attempts.ts` (frein), `client.ts` (navigateur) ;
`sessionDb.get` / `orphanDevices` (`db.ts`) ; `setSignedInCookies` (`src/lib/sessionCookies.ts`), seule
écriture des cookies d'une connexion.

**Appelants.** Routes `/api/passage` (GET destination, POST demande), `/api/passage/redeem` (publique),
`/api/passage/arrival` ; `/api/push/subscribe` ; `/api/auth/logout` ; `/api/auth/jellyfin` et
`adminSessionResponse` (cookies) ; `/api/config/public` (`passageHost`) ; `PassageBanner`,
`PassageDialog`, `PassageArrival` (dans `PlayerShell`), page `/passage` (`PassageEntry`,
`PassageInstallHelp`), lien de la page de connexion, `InstallPrompt` (l'aide d'installation aussitôt
après l'arrivée, iPhone/iPad et Android), `NewsContentView` (le lien de la destination ouvre le passage).
Chemins publics : `/passage`, `/api/passage/redeem` ; écritures d'un compte ordinaire : `POST
/api/passage`, `POST /api/passage/arrival`.

**Tests.** `passage-service.test.ts` (secrets hachés, durées, usage unique, concurrence, session fermée,
jumelle, appareil partagé, liste blanche, notifications d'un seul compte, ménage, table), `passage-routes.test.ts`
(demande : foyer, `share`, sans session, autre site, limite, journal ; échange : cookies identiques à une
connexion, refus identiques, expiré, autre site, blocage au sixième essai, délai plancher, session
précédente fermée ; arrivée ; abonnement remplacé), `passage-proxy.test.ts` (chemins publics, même origine,
compte ordinaire, lien de partage), `passage-banner.test.tsx` (affiché, refermé, nouvelle adresse, sans
réglage, pendant un film, lien des Nouveautés), `auth-routes.test.ts` (déconnexion sans révoquer un appareil
partagé).

**Voulu.** Pas de nouvel appareil Jellyfin ni de Quick Connect. Le bandeau ne se montre que sur
l'ancienne adresse, sous la barre du haut, jamais pendant un film ni tant que l'écran d'accueil du compte
reste « à faire » (comme l'invitation aux notifications : « Passer » ne l'éteint pas), et rien sans
réponse de `/api/passage` — hors connexion, les téléchargements de l'ancienne restent lisibles.
**Depuis le 25/10/2026 (10.1.0) c'est un écran plein, sans croix** (`PassageScreen`, rendu par
`PassageBanner`) : le passage est obligatoire sur l'ancienne adresse (souhait du propriétaire). Un
bandeau refermable l'avait précédé — pour de bon (10.0.0), pour la journée (10.0.1 à 10.0.3), pour le
lancement (10.0.4) — et deux jours après, des comptes passés rouvraient encore l'ancienne icône,
d'autres n'avaient jamais essayé. Deux formes, selon `isInstalledApp` :
- **un onglet** : un seul gros bouton ; l'appui demande le passage et ouvre la nouvelle adresse dans
  le même onglet (`location.assign`), connecté — rien n'est demandé au serveur avant l'appui ;
- **l'application installée** : elle est liée à son adresse pour toujours, il faut en installer une
  autre. Des étapes numérotées, une phrase courte chacune, pour l'appareil qu'on tient (iPhone/iPad :
  boussole, Partager, « Sur l'écran d'accueil », le code montré en gros, supprimer CineApp ; Android et
  ordinateur : « Installer », sans code — le navigateur partage la connexion avec l'application qu'il
  installe), puis **le bouton après la dernière étape** (« J'ai lu, ouvrir Laterna ») : en tête, on
  touchait l'étape 1 et on quittait l'écran sans avoir lu la suite. Le passage est demandé dès
  l'affichage, parce que la copie du code et l'ouverture doivent avoir lieu *dans* l'appui.
L'écran, lui, ne cède **pas** à l'écran d'accueil du compte encore « à faire » (10.1.3) : il est
dessiné par-dessus (couche 75 contre 70), et l'accueil, dû au compte côté serveur, s'ouvre sur la
nouvelle adresse. L'attendre laissait un compte qui passe l'accueil sans le finir regarder sur
l'ancienne adresse indéfiniment — c'est arrivé le soir même de la 10.1.0.
Le lien des Nouveautés est pris en charge tant que l'écran est là. Les clés de fermeture du bandeau
(`PASSAGE_BANNER_CLOSED_KEYS`) ne sont plus relues et s'effacent au montage. Une installation sans
nouvelle adresse annoncée n'a rien de tout cela. Tests : `passage-banner.test.tsx` (onglet sans
demande avant l'appui, échec dit sur place, étapes iPhone et code, bouton après les étapes, ailleurs
sans code, film, même sur un accueil dû, nouvelle adresse, hors connexion, anciennes clés, lien des Nouveautés).
**« Installée », dans la vue « Changement d'adresse »** (§119.1) se lit dans `installedApp`, envoyé
avec chaque ouverture depuis le 25/10/2026 (`isInstalledApp`) : `standalone` est vrai aussi dans la vue
intégrée qu'ouvre le passage sur iPhone, et un compte qui n'avait fait qu'y passer se lisait installé.
Les lignes d'avant ne comptent que loin (5 min) d'un passage reçu par ce compte (`installedOpening`).
Depuis l'application installée, la nouvelle adresse s'ouvre dans le navigateur (`window.open`) ; sur
iPhone, ce navigateur intégré n'est ni Safari ni l'application à venir, d'où le code et la phrase qui le
dit.
**Les téléchargements inachevés de l'ancienne adresse** (10.1.7) : une session passée — un de ses
passages a ouvert une session sur la nouvelle adresse, `arrived` de `GET /api/passage/fetched`
(`passageArrivedFrom`) — les efface de l'appareil au lancement suivant (`freeOldAddressDownloads`),
jamais pendant une lecture, sans toucher la demande du serveur (la nouvelle adresse l'a peut-être
reprise) et sans les compter dans le mot « ils sont dans Laterna ». Un iPhone gardait 660 Mo d'un
épisode à moitié reçu sous l'écran du passage. Et une session refusée (401) arrête la boucle des
téléchargements jusqu'au prochain chargement (`sessionLost`, `downloads.ts`) : elle réessayait toutes
les 60 s sans fin. Tests : `passage-downloads.test.ts`, `passage-downloads-client.test.tsx`,
`offline-session-perdue.test.ts`.

**L'arrivée hors application installée (23/10/2026).** Sur l'iPhone du propriétaire en 10.0.0, la vue
intégrée s'est dite « standalone » : la page s'est crue l'application Laterna installée, n'a pas montré
l'aide d'installation et a proposé les notifications (§17). Désormais l'arrivée par le lien marque
l'onglet (`noteOpenedByPassageLink`), et sur iPhone/iPad `isInstalledApp` le lit comme un onglet ; l'aide
d'installation (`InstallPrompt`, mode « passage ») paraît **dès le montage** — plus de délai de 0,8 s —,
plus grande que la bannière ordinaire, refermable, avec trois gestes numérotés écrits une fois
(`PassageInstallSteps`, partagé avec `PassageInstallHelp` de la page `/passage`) : 1) ajouter Laterna à
l'écran d'accueil — sur iPhone/iPad, « si cette page s'est ouverte dans l'app, touchez d'abord la
boussole « Ouvrir dans Safari » », puis Partager → « Sur l'écran d'accueil » ; sur Android, le menu du
navigateur ; 2) ouvrir la nouvelle icône et coller le code de passage si elle demande de se connecter ;
3) supprimer l'ancienne icône CineApp. Sur iPhone/iPad, une ligne dit que les notifications viendront
dans l'app Laterna : c'est là, une fois installée, que l'invitation « application installée sans
abonnement » les propose (§17), et rien d'autre ne la masque (l'aide d'installation ne s'y montre pas).
Tests : `InstallPrompt.test.tsx` (aussitôt, trois gestes, vue intégrée, application installée,
Android, ordinateur, fermeture), `passage-entry.test.tsx` (le lien marque l'onglet). Un passage n'emporte ni reprise sur l'appareil, ni catalogue gardé,
ni bilans ou lignes en attente ; des téléchargements hors ligne, **la liste seulement** (§119.2).

**Décidé le 23/10/2026.**

### 119.1 Qui est passé : le suivi dans l'Activité

**Règle.** L'administrateur sait, compte par compte, qui ouvre déjà la nouvelle adresse et qui passe
encore par l'ancienne — de quoi savoir quand l'ancienne peut s'éteindre. Chaque ligne `ouverture` de
`startup.log` porte `host`, le nom d'hôte de la requête **lu par le serveur** (`requestHost`,
`src/lib/publicOrigin.ts`) : `X-Forwarded-Host` seulement d'un relais de confiance
(`forwardedFromTrustedPeer`, `src/lib/trustedProxy.ts` — la règle de `clientAddressOf`, §57), sinon
`Host` ; réduit au nom (ni port ni schéma), en minuscules, validé comme un nom DNS, sinon absent. Un
`host` envoyé dans le corps est ignoré. La vue « Changement d'adresse » de la vue d'ensemble de
l'Activité (`AddressChangePanel`, route `GET /api/admin/activity/address`, `adminOnly`) ne s'affiche que
si `NEWS_LATERNA_ADDRESS` est réglée — sans elle la route rend `newHost: null` sans lire aucun journal.
Une ligne par compte actif du foyer (`getUsers` écarte les liens de partage, §112 ; un compte désactivé
n'y est pas) : dernière ouverture sur l'ancienne adresse, sur la nouvelle, la nouvelle ouverte en
application installée (`standalone`) ou non, dernier passage demandé / reçu (`auth.log`, depuis le
changement). Statut, dans cet ordre de tri : « Encore sur l'ancienne adresse », « Jamais ouvert depuis
le changement », « Ouvert depuis, adresse inconnue », « Passé, pas encore installé », « Passé, app
installée » ; à statut égal, le plus récemment vu d'abord. Lu par `readRecords` (archives comprises),
sans aucun stockage de plus.

**Les lignes d'avant `host`.** `ADDRESS_CHANGE_START` = le 23/10/2026 à minuit, heure du foyer (le
déploiement de la 10.0, premier jour où deux adresses ont existé). Une ouverture sans `host` d'avant
cette date vaut l'ancienne adresse (il n'y en avait qu'une) ; d'après, « adresse inconnue » — entre la
10.0 et la version qui écrit `host`, elle peut être l'une ou l'autre, et ne fait donc ni un « encore sur
l'ancienne » ni un « jamais ouvert ». « Depuis le changement » se compte depuis cette date ; une
ouverture de l'ancienne adresse d'avant ne fait pas « encore sur l'ancienne ».

**Porteurs.** `src/lib/activity/addressChange.ts` (`addressOf`, `addressChangeRows`, `addressChange`,
`newHostOf`) ; `requestHost` ; `forwardedFromTrustedPeer`.

**Appelants.** `/api/startup-timing` (écrit `host`), `/api/admin/activity/address`,
`ActivityOverview` (`AddressChangePanel`, `src/components/activity/AddressChange.tsx`).

**Tests.** `startup-timing-route.test.ts` (nom d'hôte sans port, corps ignoré, relais de confiance contre
client direct, hôte invalide omis), `activity-address-change.test.ts` (statuts depuis des lignes
factices, lignes sans `host` avant et après, passages d'avant ignorés, comptes de partage et autres
genres de ligne écartés, tri ; route refusée sans session, à un compte ordinaire et à un lien de
partage, muette sans réglage), `activity-address-change-view.test.tsx` (statuts lisibles dans l'ordre,
passage demandé / reçu, rien sans nouvelle adresse).

**Voulu.** `publicOrigin` (l'adresse donnée au téléviseur) garde sa lecture d'avant : elle n'est pas
un journal et n'a pas changé ici. Un compte passé qui rouvre ensuite l'ancienne reste « passé » ; les
deux dates sont côte à côte.

**Décidé le 23/10/2026.**

### 119.2 Les téléchargements hors ligne suivent le passage

**Règle.** Les fichiers ne traversent pas : chaque adresse a son propre stockage (OPFS), et sur iPhone
l'application installée a le sien. Le passage emporte donc **la liste** des téléchargements de ce
compte sur cet appareil — terminés ou en cours (en préparation, en téléchargement, en pause ; jamais un
échec) —, la nouvelle adresse propose de les **retélécharger** aux mêmes choix, et l'ancienne libère sa
place **seulement quand le serveur atteste** que ce même compte les a récupérés de l'autre côté.

**Au départ.** La fenêtre du passage (`collectPassageInput` → `collectPassageDownloads`) joint la liste
à la demande (`POST /api/passage`, `downloads`) : par titre, l'identifiant Jellyfin, la qualité, le
codec, la piste son, le titre, la taille attendue, l'année, la durée, les pistes nommées, et pour un
épisode sa place dans la série (de quoi grouper la page des téléchargements avant toute réponse).
Revalidée champ par champ des deux côtés (`cleanPassageDownloads`, `src/lib/passage/downloads.ts` :
identifiant au format Jellyfin, qualité et codec dans leur énumération, piste entière ; une entrée hors
format est ignorée, les autres passent), une par titre, **50 au plus** (`PASSAGE_DOWNLOADS_MAX`), 64 Ko
au plus pour le paquet. Gardée avec les secrets (`passages.downloads`), puis avec la session jumelle
(`passage_arrivals.downloads`, 30 jours au plus, comme les réglages). La fenêtre et l'aide
d'installation (`PassageInstallSteps`, `downloads`) disent en une phrase, **seulement s'il y en a** :
« Vos téléchargements vous seront proposés à nouveau dans Laterna. » (l'échange répond `downloads:
true`, retenu dans l'onglet : `passageFlags.carriedDownloads`).

**À l'arrivée.** `GET /api/passage/arrival` rend la liste **filtrée par le serveur** : une seule question
à Jellyfin sous l'identité du compte (`availablePassageItems`, `/Users/{jfId}/Items?Ids=`), où Jellyfin
applique ses droits et les tags bloqués du compte (§54) ; un titre supprimé ou masqué disparaît sans
bruit, jamais nommé. Jellyfin muet : la liste n'est pas rendue, l'arrivée la reposera. `PassageArrival`
la garde sur ce stockage (`cine:passage-downloads`, `keepPassageOffer`) puis le serveur l'oublie (`POST
… { downloads: true }`) : **proposée une seule fois**. Sur iPhone/iPad, seulement dans l'application
installée — un onglet de Safari la rangerait dans le stockage qu'on va quitter, et l'application
installée la reçoit par sa propre arrivée (le code ouvre sa propre session jumelle). L'invitation
(`PassageDownloadsPrompt`) : « Retélécharger vos N téléchargements (X Go) ? », un appui relance chacun
par le chemin normal (`relaunchPassageDownloads` → `startOfflineDownload` : droits, limite de 50, copie
du serveur reprise si elle existe encore ; un refus passe sans bruit ; un titre déjà sur l'appareil
n'est pas redemandé). « Plus tard » la laisse en tête de la page des téléchargements
(`PassageDownloadsCard`) jusqu'à ce qu'on la ferme. Jamais pendant un film, ni pendant l'écran
d'accueil d'un premier lancement, ni par-dessus l'aide d'installation, les Nouveautés ou l'invitation
aux notifications : **une invitation flottante à la fois** (`useFloatingPromptTurn`,
`src/lib/floatingPromptTurn.ts` — rang 0 pour les étapes qui ne cèdent jamais, l'aide d'installation et
les Nouveautés ; 1 les notifications ; 2 le passage).

**La preuve pour effacer l'ancienne adresse.** Chaque échange écrit désormais une ligne d'arrivée,
même sans réglages, avec la session d'origine (`passage_arrivals.origin_jti`). Quand une session
**venue d'un passage** reçoit la dernière plage d'une version finie (`/api/offline/jobs/<id>/file`, là
où `markOfflineFetched` est noté), le titre et la version sont notés sur **sa** ligne d'arrivée
(`notePassageFetched`, `passage_arrivals.fetched`, `{ itemId: jobId }`, 200 au plus). Au lancement de
l'ancienne adresse (`PassageDownloadsCleanup`, `freeOldAddressDownloads`), l'appareil demande `GET
/api/passage/fetched?items=…` : le serveur ne répond que pour les arrivées dont l'origine est **la
session qui demande** et le compte **lui-même** (`passageFetchedFor`). Sûre parce que : le serveur l'a
servie (pas une déclaration de l'appareil) ; à ce compte ; à une session dont le cookie n'existe que sur
la nouvelle adresse ; issue du passage de cet appareil-là (une autre session du même compte — un autre
appareil — n'atteste rien) ; après le passage par construction. `offline_requests.fetched_at` n'aurait pas
suffi : commune à toutes les adresses et à tous les appareils du compte, et effacée avec la copie du
serveur cinq minutes après la dernière plage (`releaseFetchedCopies`). Effacement **titre par titre**,
la lecture relue avant chacun (jamais pendant une lecture, hors ligne comprise) ; même version des deux
côtés : retrait sur l'appareil seul (`removeOfflineDownload(id, { server: false })` — la demande du
serveur est celle du compte, commune aux deux adresses) ; une autre version : retrait ordinaire. Puis
une ligne au journal (`POST /api/passage/fetched`, `server.log`, `scope: "offline"`, `event:
"passage-freed"`, les seuls titres attestés) et un mot : « N téléchargements effacés de l'ancienne
adresse : ils sont dans Laterna ». Sans attestation (30 jours passés, reconnecté depuis, jamais
retéléchargé), rien ne s'efface. Sur iPhone, supprimer l'ancienne icône efface déjà tout ; ceci sert
surtout Android et l'ordinateur.

**Porteurs.** `src/lib/passage/downloads.ts` (liste, validation), `src/lib/passage/offer.ts` (navigateur :
départ, invitation gardée, relance, effacement), `service.ts` (`availablePassageItems`,
`notePassageFetched`, `passageFetchedFor`, `passageArrival`, `ackPassageArrival`),
`src/components/passage/PassageDownloads.tsx`, `src/lib/floatingPromptTurn.ts`.

**Appelants.** `PassageDialog`, `PassageArrival`, `PassageEntry` (`noteCarriedDownloads`), `InstallPrompt`,
`PlayerShell`, `OfflineDownloadsView`, `PushResumePrompt` et `NewsGate` (le tour des invitations) ;
routes `/api/passage`, `/api/passage/redeem`, `/api/passage/arrival`, `/api/passage/fetched` (GET lecture
du compte ; POST au journal, écriture d'un compte ordinaire), `/api/offline/jobs/<id>/file`.

**Tests.** `passage-downloads.test.ts` (liste validée, entrées hors format ignorées, rendue à la seule
jumelle, titre masqué ignoré, Jellyfin muet, proposée une fois ; attestation après la dernière plage
servie à la jumelle seulement, pas à l'ancienne adresse, rien pour un autre compte ni un autre appareil
du même compte, ni pour un lien de partage ; ligne au journal), `passage-downloads-client.test.tsx`
(liste du compte, sans échec ; relance aux mêmes choix, refus silencieux, déjà là ; invitation une fois,
« Plus tard » vers la page, pas pendant un film ni l'accueil, pas par-dessus l'aide d'installation ;
effacement attesté seulement, jamais pendant une lecture, même version gardée au serveur ; phrase de
l'aide et de la fenêtre seulement avec des téléchargements), `passage-banner.test.tsx` (génération).

**Voulu.** Pas de suivi de plus que la colonne `fetched` d'une ligne d'arrivée déjà là ; pas de transfert
de fichiers ; la relance est un geste, jamais automatique (une saison en 4G n'est pas une surprise
qu'on fait à quelqu'un).

**Décidé le 23/10/2026.**

## 120. Le Stream Deck : un jeton à lui, qui ne lit que les lectures en cours

**La règle.** Un plugin Stream Deck (`streamdeck-plugin/`, paquet à part, jamais dans l'image) suit les
lectures en cours : une touche compte, une page montre une lecture par touche, et chaque lecture se
détaille sur les huit touches d'un Stream Deck Neo (et son Infobar). Il ne présente pas de session mais
un **jeton** créé dans Configuration → Administration (`StreamDeckCard`), un par appareil, montré une
fois, gardé en empreinte SHA-256 (`streamdeck/tokens.ts`, table `streamdeck_tokens`), révocable.

**Ce qu'il ouvre, et rien d'autre.** `/api/streamdeck` est dans `PUBLIC_PATHS` : le proxy laisse passer,
et **chaque route du dossier vérifie le jeton avant tout** (`verifyStreamDeckToken`) — un test parcourt
le dossier et échoue si une route l'oublie. Deux routes, en lecture : `plays` (les lectures en cours,
`streamdeck/plays.ts`) et `image` (l'affiche d'un titre **en cours de lecture** seulement : le jeton ne
parcourt pas le catalogue). La gestion des jetons (`/api/admin/streamdeck/tokens`) est à
l'administrateur (`adminOnly`, et le proxy refuse ses écritures à un compte ordinaire).

**Ce que montre une lecture.** Jellyfin dit qui regarde quoi et où il en est — la télévision du salon
comprise ; les séances de `player.log` complètent celles de Laterna (chemin, image, incidents). **Le
lecteur serveur n'est pas un échec** (souhait du propriétaire) : « Serveur » est un chemin, affiché
comme « Appareil » ou « Télé ». Seuls une attente, une erreur ou une reconstruction des deux dernières
minutes passent une lecture en orange — ni un relais, ni une connexion lente.

**Voulu.** Lecture seule : aucune action (pause, relance de service) — chacune serait une porte
d'écriture ouverte par un fichier de réglages sur un ordinateur. Le profil « Laterna » (la page des
lectures) a été créé dans l'appli Stream Deck et exporté, puis livré avec le plugin
(`profiles/Laterna.streamDeckProfile`, plugin 1.1) : son format n'est pas documenté, il n'est pas
fabriqué à la main — pour le changer, le refaire dans l'appli et l'exporter de nouveau. Le paquet
installable est rangé dans `streamdeck-plugin/release/`, reconstruit à chaque version du plugin.

**Décidé le 27/10/2026.**

## 121. Safari et son cache : le worker relaie, et la bannière passe en WebP

**Le constat (27/10/2026).** Sur un lien lent, l'accueil d'un iPhone affichait le catalogue (gardé sur
l'appareil) mais ni l'affiche ni le logo de la bannière, même pour des titres déjà vus. Le journal du
relais l'a expliqué : sur iPhone et sur le Safari du Mac, **le cache HTTP n'était jamais relu d'un
lancement à l'autre**. Le catalogue repartait en entier à chaque ouverture (90 réponses complètes pour
7 « pas changé » en deux jours sur iPhone, contre 13 pour 18 sous Windows), et les images servies
`immutable` pour un an étaient retéléchargées à chaque lancement — trois lancements en quarante
secondes compris : ~1,5 Mo déjà reçus, devant la bannière. Les en-têtes n'y étaient pour rien
(capturés sur le serveur, rejoués à l'identique).

**La cause, reproduite sous Playwright.** WebKit relit son cache sans service worker, ou avec un
worker qui répond `respondWith(fetch(request))`. Avec un worker qui a un gestionnaire `fetch` mais
**laisse passer** la requête sans répondre — ce que le nôtre faisait pour les images et `/api/` —,
WebKit redemande tout au lancement suivant, sans même une requête conditionnelle. Chromium relit son
cache dans les trois cas.

**La règle.** Sur WebKit seulement (`RELAY_THROUGH_WORKER`, `public/sw.js`), le worker relaie
lui-même les images (toutes origines, sauf le code `/_next/static/` qui a son cache) et trois réponses
que l'ouverture redemande et que le serveur confirme d'un 304 : les deux catalogues et les Nouveautés
(`RELAYED_API`). Rien n'est rangé dans un cache du worker : c'est le cache HTTP qui garde, comme
partout ailleurs. Le flux vidéo, les envois et le reste de `/api/` passent toujours à côté du worker.
Ailleurs que sur WebKit, rien ne change. Une même image demandée plusieurs fois à la fois n'est
téléchargée qu'une fois (`relay`, une copie de la réponse pour chacune) : sans worker la page les
réunissait d'elle-même, relayées chacune partait — chaque logo de la bannière cinq à sept fois au
premier lancement (10.5.1). Tests : `serviceWorker-webkit-relay.test.ts`.

**Avec lui.** Les Nouveautés ont une étiquette (`cachedJson`, une entrée par compte) au lieu de
`no-store` : 81 Ko à chaque lancement pour savoir s'il y avait du nouveau. Et les logos et l'affiche
de la bannière du téléphone passent par l'optimiseur en WebP (`bannerImage`, `optimizedImage.ts`) :
80 à 280 Ko de PNG par logo chez TMDB, quatre à six fois moins converti. Les logos le sont **à la
source** (`logoForScreen`, toutes les routes qui en rendent un) pour qu'un titre ait partout la même
adresse — bannière, fiche, ouverture de la lecture ; l'affiche de la bannière dans `heroPoster`. Le
préchauffage (`posterPrewarm`) les prépare à `BANNER_WIDTH`.

**Voulu.** Les affiches des rangées restent servies par TMDB en direct : les convertir à la demande
pendant le défilement a été la première cause des saccades sur téléphone (02/09/2026). Le fond de la
bannière en grand écran reste l'adresse de la fiche (`keepSheetBanners` la garde décodée) : le
convertir le ferait télécharger deux fois. Pas de cache d'images tenu par le worker : le relais rend au
cache HTTP son travail, sans seconde copie à borner et à vider.

**Décidé le 27/10/2026.**

## 122. Un Chromecast qui accepte sans lire : une relance en AAC, puis une erreur dite

**Le constat (27/10/2026).** Un Freebox Player POP (Android TV, Chromecast intégré) a accepté un
épisode — H.264 1080p transcodé, E-AC3 5.1 copié (§64) —, lu la liste, l'en-tête et le premier
segment, puis plus rien : ni erreur ni lecture, le logo de diffusion sur le téléviseur et une page qui
tournait sans fin. Le kit de Google ne dit pas quels sons un récepteur décode, et le récepteur n'a
rien signalé.

**La règle** (`ChromecastPlayer`, `CAST_NO_PICTURE_MS`). Un chargement accepté qui n'a pas d'image —
ni `PLAYING` ni `PAUSED` — au bout de 25 s est relancé une fois avec le son ré-encodé en AAC stéréo
(`forceAudioTranscode`), journalisé `why: "ladder"`, `rung: 1`, avec son déclencheur ; le choix reste
acquis pour ce téléviseur le temps de la diffusion (piste, sous-titre, épisode suivant). Sans image
encore, l'erreur est dite et écrite (« le téléviseur n'a pas démarré la lecture »). Un fichier servi
tel quel n'est pas relancé : il n'a pas de son à ré-encoder.

**Voulu.** Le profil du Chromecast garde AC-3 et E-AC3 copiés : la plupart des récepteurs les
décodent ou les passent au téléviseur, et un ré-encodage pour tous coûterait le 5.1 à tous. La
relance n'est qu'une réponse à un récepteur muet, pas une détection.

**Décidé le 27/10/2026.**

## 123. L'image dans l'image du système, à côté du mini-lecteur

**Règle.** Le lecteur propose l'image dans l'image du système (bouton à l'icône PiP, en haut à
droite) seulement là où le système l'accepte vraiment : `document.pictureInPictureEnabled`, un
élément qui ne l'interdit pas, et sur WebKit `webkitSupportsPresentationMode("picture-in-picture")`.
C'est cette dernière qui décide sur WebKit : dans l'app installée depuis Safari sur iPhone et iPad,
`pictureInPictureEnabled` répond vrai mais `requestPictureInPicture()` échoue ou ne fait rien —
défaut d'Apple ouvert (WebKit 303885, 280627), toujours là en iOS 27.2 ; la question préfixée y
répond faux. Le jour où Apple corrige, le bouton apparaît seul. Firefox n'expose pas l'API : pas de
bouton. « Réduire » (le mini-lecteur de l'app) a pris un chevron : deux icônes PiP pour deux
gestes se seraient lues comme un seul. Pendant l'image dans l'image du système, « Réduire » est
masqué — déplacer la vidéo dans le mini-lecteur l'en ferait sortir.

**Porteurs.** `useSystemPip` et `systemPipAvailable` (`src/components/playerControls/useSystemPip.ts`) ;
`PlayerTopBar` (le bouton, le chevron) ; branché dans `PlayerControls`, donc les trois lecteurs
(natif, serveur, hors ligne).

**Tests.** `useSystemPip.test.tsx`.

**Voulu.** Pas de bouton dans le mini-lecteur : il n'a pas l'élément sous la main, et un appui le
rouvre en grand. La lecture en arrière-plan reste hors de portée de l'app installée sur iPhone : iOS
y met en pause toute vidéo cachée, sans API pour l'en empêcher.

**Décidé le 28/10/2026.**

## 124. Un saut à une image du chargé est posé sur le chargé

**Règle.** Dans le lecteur natif, un saut qui tombe à moins d'une image (1/24 s, `ONE_FRAME_S`)
*avant* le début d'une zone chargée pose la tête sur ce début (`startJustAfter`, `MseSource.onSeeking`)
au lieu de tout relire. Après un saut, la zone chargée commence à l'image clé de son arrivée, et un
« −10 s » qui retombait dessus la manquait de quelques millisecondes — l'audio y commence 30 ms avant
l'image : 1,2 à 1,5 s d'attente en 4K pour une image d'écart (*Braveheart* sur Firefox, au banc).

**Voulu.** Ce n'est pas un saut calé sur une image clé (refusé le 20/10/2026) : la cible ne bouge que
d'une image au plus, seulement vers l'avant et seulement vers du média déjà là. Au-delà d'une image,
c'est un vrai saut, à sa cible exacte.

**Tests.** `webcodecs-mseSource.test.ts` (« pose la tête sur le début du chargé… », « au-delà d'une
image… »).

**Décidé le 28/10/2026.**

## 125. Les notifications, aussi sous la forme que le système affiche lui-même

**Règle.** Un abonnement dont on connaît le site (`origin`, lu dans l'en-tête `Origin` à chaque envoi
de l'abonnement, `pushOrigin`) reçoit le message sous la forme déclarative de WebKit
(`declarativePush`, `src/lib/push.ts`) : `web_push: 8030`, une `notification` toute rédigée dont
`navigate` est l'adresse complète de son site, et `mutable: true`. Les champs d'avant restent au
premier niveau. Un abonnement dont le site est inconnu reçoit exactement l'ancien message.

**Pourquoi.** Sur iPhone (Safari 18.4 et plus), le système affiche la `notification` lui-même si
notre service worker ne le fait pas à temps : une notification n'est plus perdue parce que le
worker n'a pas pu se réveiller, et iOS n'a plus de raison de retirer l'abonnement d'un site dont
les messages n'aboutissent pas. `mutable` : le worker reçoit toujours l'événement et affiche la
sienne — icône, badge, vibration, clic, comme avant ; la version du système n'est qu'un filet.
Chrome, Firefox, un iPhone plus ancien et un worker resté sur l'ancien code lisent les champs
d'avant. Personne n'est invité à se réabonner : le site s'apprend au renvoi que le panneau Compte
fait déjà à chaque ouverture.

**Voulu.** Le site de l'abonnement plutôt que celui de la configuration : une même instance répond
sous deux adresses (§119), et l'app installée d'un appareil est celle de l'adresse où il s'est
abonné. Une adresse de notification qui sortirait du site ramène à son accueil, comme le clic du
worker (revue du 20/10/2026).

**Tests.** `push-declarative.test.ts`, `push-subscribe-route.test.ts`.

**Décidé le 28/10/2026.**

## 126. Deux mesures à l'ouverture, qui ne décident de rien

**Ce qui est mesuré.** Sur la ligne `opening` : `swMs`, ce que le service worker a coûté à la
première requête du flux (`fetchStart − workerStart`, `streamRequestTiming.ts`), ou `sw: "hors"` si
elle n'en a touché aucun. `mcSmooth` / `mcEfficient` (et `mcSupported: false` s'il y a lieu), aussi
tracés « capacités : lisible/illisible, fluide/pas fluide, économe/pas économe » : la réponse de `mediaCapabilities.decodingInfo` pour la
taille, le débit et le HDR du fichier (`decodingInfo.ts`, posée à l'attachement de MediaSource).

**Pourquoi.** Deux pistes à juger sur pièces avant d'y toucher : déclarer au worker les adresses
qu'il ne doit jamais voir (« static routing », Safari 27) ne vaut que si son réveil coûte vraiment
à l'ouverture ; proposer la version allégée d'emblée ne vaut que si « pas fluide » prédit les
attentes réellement mesurées.

**Décidé le 28/10/2026.**

## 127. Les livres : une option, coupée par défaut, sans rien toucher du cinéma

**Règle.** `BOOKS_ENABLED` (Configuration → Livres depuis le 10/11/2026 — Lecture avant, §142 —, ou `.env` ; coupée par défaut, relue à chaque
accès comme tout réglage, §48) ajoute une troisième catégorie à la bascule de l'accueil — Films,
Séries, Livres — et une page `/livres` : les EPUB que Jellyfin range comme livres
(`IncludeItemTypes=Book`), une fiche par livre, et un lecteur dans l'application. Coupée, rien
n'existe : toutes les routes `/api/books/*` répondent 404 sans lire de session ni appeler Jellyfin,
la page répond 404, la bascule rend ses deux boutons d'avant et l'accueil ne charge aucun code des
livres. Ni catalogue, ni cache gardé sur l'appareil, ni lecteur vidéo, ni recherche ne sont touchés :
tout vit dans `src/lib/books/`, `src/components/books/`, `src/app/api/books/` et `src/app/livres/`.

**Une catégorie, pas un onglet.** `tab` reste `movies | series` : une vingtaine d'endroits le lisent
(adresse, onglets gardés, bannière, disposition, top 10, grille complète…). Les livres sont un mode
posé par-dessus, un champ facultatif de l'adresse du cinéma (`books`, `#livres=1`, absent sinon) :
Retour et rechargement le gardent, et une installation sans livres ne voit jamais la clé. Les deux
écrans n'importent que `BooksMode` (le mode, le rond « Tous les livres ») et ne chargent l'accueil des
livres (`BooksHome`, morceau à part) que dans la catégorie : la grille des films et séries reste
montée dessous, inerte, sa bannière à l'arrêt (`gridOnTop` au bureau, `heroCovered` au téléphone).
Option coupée, `useBooksMode` ignore le champ et le retire de l'adresse. « Tous les livres » mène à
la grille complète (`/livres`). **La fiche d'un livre est une fiche du cinéma** : nommée par l'adresse
(`#livre=<id>`, `&lire=1` pour le lecteur — deux autres champs facultatifs de `cinemaRoute`), ouverte par
une entrée d'historique, refermée par `cinemaClose` (un seul retour en vol), avec les pièces du cycle de
vie des fiches (CLAUDE.md) : `useSheetTransition` (la couverture touchée devient la fiche au téléphone et
à l'iPad, continuité au bureau), `useSheetExit`, `useSwipeToDismiss`, `useExitDelay`, `arrivedByBack`
lu au montage, une `key` par livre, la barre du bas effacée dessous (`setOfflineSheetOpen`). « Lire » fait
grandir la couverture en première page (`readerOpening.ts`, rien si le système demande moins de
mouvement). Depuis l'accueil, le lecteur s'ouvre dans un cadre posé sur le cinéma — la page
`/livres?cadre=1#livre=…&lire=1`, sous sa propre politique de sécurité (plus bas) —, et le refermer retire
le cadre : la fiche est là, dessous, sans que rien n'ait été rechargé (§128). Tests : `books-sheet.test.tsx`,
`books-reader-frame.test.tsx`. Les livres ne s'appuient sur aucun champ propre à un greffon de Jellyfin : titre,
auteur (`People` de type `Author`), série et tome (`SeriesName`, `IndexNumber`), année, résumé et
couverture sont ce que Jellyfin lit lui-même dans l'EPUB ; un tome, un auteur ou une couverture
absents sont prévus.

**Qui voit quoi.** Tout compte du foyer, `user` compris. La bibliothèque est lue **une fois pour tous**
avec la clé du serveur (`fetchLibrary`, bibliothèque par bibliothèque), et chaque compte n'en voit que
ce que ses droits permettent (`rights.ts`) : ses bibliothèques Jellyfin (`EnableAllFolders` /
`EnabledFolders` de sa politique, relue toutes les deux minutes), ses tags bloqués (§54, la même
fonction `carriesBlockedTag`), et le contrôle parental par classification au plus prudent (`BlockUnratedItems`
qui nomme les livres cache ceux sans classification ; un âge maximal cache tout livre classé). Une
politique illisible sans copie connue : 502, rien n'est montré. Un livre seul (fiche, fichier, position,
signets) est toujours demandé sous l'identité du compte (`/Users/{jfId}/Items/{id}`), Jellyfin
appliquant ses propres droits, puis les tags bloqués. « Lu » vient de Jellyfin par compte, une requête
qui ne rend que les livres lus, gardée deux minutes (`playedBooksOf`). Le fichier est relayé
depuis `/Items/{id}/Download` avec la clé du serveur, seulement après avoir vérifié que l'élément est
un `Book` visible de ce compte ; rien de la réponse de Jellyfin n'est recopié hormis la taille, et la
réponse est `private`. Une session de lien de partage (§112) n'atteint rien : aucune règle de
`shareGate` ne nomme les livres, la page la renvoie à la fiche de son lien, et les routes la refusent
une seconde fois. Seule écriture ouverte aux comptes : `POST /api/books/{id}/progress`, sa propre
position.

**« Afficher les livres », par compte.** Compte → Interface, à côté de la disposition de l'accueil
(§52), montré seulement l'option allumée (`booksAvailable`) : gardé par le serveur
(`user_preferences.show_books`, `NULL` = oui), donc le même sur tous les appareils du compte. Coupé, la
configuration publique répond `booksEnabled: false` (et `bookRequests: false`) pour ce compte : c'est la
clé que lisent la bascule, la recherche et les demandes, et tout se passe comme l'option coupée — deux
boutons, pas de section dans la recherche, aucun code des livres chargé, aucune requête. Les routes,
elles, restent ouvertes à ce compte : c'est un affichage, pas un droit (`showBooks.ts`).

**À l'échelle de plusieurs milliers d'EPUB, sans jamais ralentir le reste.** Rien des livres ne part
au lancement : ni dans `earlyFetch`, ni dans le catalogue, ni dans le cache gardé sur l'appareil, ni dans
les préchauffages du serveur (`catalogueWarm`, `selfWarm`) — un test le vérifie. Le serveur garde **un
seul index** en mémoire (`bookIndex.ts`) : la liste demandée à Jellyfin par pages de mille (`LIST_PAGE`,
trois en parallèle) sans résumés, triée, le texte de recherche de chaque livre déjà replié. Par compte,
il était lu par chaque compte après chaque redémarrage — sept pages, ~5 s chacun en production (6 403
EPUB). Il naît à la première ouverture de la catégorie, se construit par tranches de quatre cents livres
en rendant la main à la boucle entre deux, sert cinq minutes puis se refait derrière la réponse (une
préparation à la fois), et se refait depuis les éléments déjà reçus quand des métadonnées d'EPUB arrivent
(au plus toutes les vingt secondes). Une copie des éléments reçus est gardée sur le disque
(`DATA_DIR/book-index.json`, un jour au plus) : après un redémarrage, la première ouverture part d'elle
pendant que Jellyfin est relu. Chaque ensemble de droits a sa **vue** (livres permis, accueil, choix des
menus), calculée une fois et partagée par les comptes qui ont les mêmes droits ; vingt-quatre vues au plus ;
une vue servie pendant que la suivante se calcule derrière, quand l'index commun vient d'être refait.

**Préparé d'avance** (`prewarm.ts`) : option allumée, l'index commun est construit en arrière-plan après
les préchauffages du catalogue (`catalogueWarm`, `selfWarm` — jamais en même temps qu'eux ; trente secondes
après le démarrage, puis toutes les cinq secondes tant qu'ils tournent, deux minutes au plus), et aussitôt
quand l'administrateur allume l'option (`/api/settings`), sans redémarrage. Puis redemandé toutes les
quatre minutes, ce qui le refait derrière s'il a vieilli : une ouverture trouve toujours le dernier index
construit. Seule la toute première construction d'une installation neuve peut être attendue. Option
coupée, rien n'est importé ni lancé (`books-warm.test.ts`). Mesuré sur 6 400 livres synthétiques : ~115 ms
de construction, la boucle jamais tenue plus de ~16 ms, et l'accueil servi de l'index chaud en 0,3 ms.

**Une copie par livre.** La bibliothèque de production a des doublons, surtout dans un même lot
(« Les cavernes d acier » et « Les cavernes d'acier », « Le Roi de fer » et « Roi de fer », « Prelude a
Fondation » et « Prélude à Fondation ») et parfois entre deux racines. Les fichiers restent sur le disque —
le lot est partagé, les effacer le ferait retélécharger — et l'index n'en montre qu'un partout : rangées,
pages, nombres, menus, recherche. La clé (`duplicateKey`) : le titre sans accents, casse, ponctuation ni
« _ », sans article en tête (le, la, les, l', un, une, the…), et le premier auteur quel que soit l'ordre de
ses noms (« Asimov,Isaac » = « Isaac Asimov »). Depuis le 29/10/2026 (des paires Stephen King de la
production), elle ôte aussi un sous-titre de fin qui ne dit que le genre ou la forme (« : roman », « : a
novel », « (poche) », « - nouvelles »…) et le « s » final de chaque mot de plus de trois lettres, « œ »
écrit « oe » (« Coeur perdu en Atlantide » = « Coeurs perdus en Atlantide »). Jamais une édition
« illustrée » ni un tome (« Rêves et cauchemars (Tome 1) » peut être la moitié d'une édition coupée), et
« Brume » ≠ « Brume ; La Faucheuse: nouvelles » (`books-mise-en-page.test.ts`). La copie montrée (`preferredCopy`) : celle que ce compte a
commencée ou marquée d'un signet (`accountCopies`, au moment de répondre), puis celle qui a une
couverture, puis le titre le plus soigné (accents, apostrophes, pas de « _ », le plus complet). La taille
du fichier n'entre pas en compte : la liste ne la demande pas à Jellyfin. Dédoublonné après les droits, et
les copies cachées restent lisibles (une position, un lien direct, leur couverture). Le
téléphone n'en reçoit que des morceaux : l'accueil (`/api/books/home`, une douzaine de rangées de vingt),
une page de la grille (`/api/books?offset=…&limit=…`, 200 au plus, filtrée et triée par le serveur, avec
le vrai nombre de tomes des séries de la page), les choix des menus (`/api/books/facets`), douze
résultats de recherche (`/api/books/search`). La grille demande sa page suivante à l'approche du bas ; ses
cartes hors du champ ne sont ni mises en page ni peintes (`content-visibility: auto`) ; les couvertures
se chargent à l'approche. Mesuré (`books-scale.test.tsx`, suite en parallèle) : l'index de 6 400 livres en
~160 ms, la plus longue tranche ~25–30 ms ; une page triée et une recherche ~4 ms ; 5 000 OPF par la
file en 200 transactions, boucle au plus ~30 ms. Le « Tout voir » est la grille complète, réglée comme
« Voir tout » des films (`CinemaBrowseSheet`, recopié et non modifié) : « Filtrer… » (un filtre de la
grille, pas une seconde recherche), tri, genre, auteur, série — des listes, pas de puces.

**La série, l'auteur, le genre : jamais le dossier.** Jellyfin donne à un livre le nom du dossier qui le
contient pour série : l'auteur dans une bibliothèque rangée par auteur (`/livres/<Auteur>/…`, ce que fait
le greffon des livres), « 6000 Romans Ebook en Epub Pack » pour un lot déposé d'un bloc. La série et le
tome viennent donc de l'EPUB seul — `calibre:series` / `calibre:series_index`, ou en EPUB 3
`belongs-to-collection` / `group-position`, préfixés ou non (`opf:meta`) — et pas de série dans l'EPUB veut
dire pas de série (`decideSeries`). L'OPF est lu par plages à travers le relais de Jellyfin (la fin du
zip, `container.xml`, l'OPF : quelques dizaines de kilo-octets), une fois par fichier (`book_meta`, clé
`Etag`), en arrière-plan, deux à la fois ; la grille ne l'attend jamais — un livre pas encore lu s'affiche
sans série, et la prend au chargement suivant (`epubMeta.ts`). Cette file ne démarre qu'à la demande de
l'index (jamais au lancement), lit deux livres à la fois, **ralentit à un livre par seconde tant qu'un
film joue** (`anyPlaybackBeat`) et écrit par lots de vingt-cinq dans une transaction courte. Elle
s'arrêtait tout à fait pendant un film : seize livres sur 6 403 en une heure en production, trois films
jouant presque sans cesse ; un livre lu coûte trois petites requêtes de plages, rien qu'un film remarque. Les auteurs sont les `People`
de Jellyfin, sinon les `dc:creator` de l'OPF (Jellyfin n'en a que pour une partie des livres que l'EPUB
décrit pourtant ; « Nom, Prénom » remis dans l'ordre, `bookAuthors`) — jamais un nom de dossier —,
rapprochés quel que soit l'ordre des mots (« Muchamore Robert », `nameKey`). Les genres réunissent ceux
de Jellyfin et les sujets de l'EPUB, coupés (« Policier/Thriller »), synonymes ramenés à un libellé
(« SF », « Science-Fiction » → « Science-fiction » ; « Polar » → « Policier » ; « Fantasy » et
« Fantastique », « Policier » et « Thriller » restent distincts), débarrassés des mots de format ou de
langue (« Fiction », « Roman », « Lang:fr ») et des valeurs qui ont l'air d'étiquettes ou d'ISBN
(`bookGenres`) ; un genre porté par un seul livre n'est ni une rangée ni un choix de menu. **La
couverture** : celle de Jellyfin ; sinon celle que l'OPF déclare (`meta name="cover"`,
`properties="cover-image"`), faite à la première demande de la carte — jamais en masse — lue par plages,
réduite par `sharp` (360 px, WebP), gardée sous `DATA_DIR/book-covers` (bornée en nombre et en octets,
un EPUB sans couverture marqué pour ne pas être relu ; `covers.ts`, `/api/books/<id>/cover`, vérifié contre
l'index du compte) ; sinon une couverture dessinée — titre et auteur sur une couleur tirée du titre
(`BookCover`), jamais une tuile grise. Rien ne suppose une seule
racine : une bibliothèque peut en avoir plusieurs, et un même livre (même titre, même auteur) présent dans
deux n'apparaît qu'une fois dans les rangées — celui où l'on a lu, sinon le mieux décrit (`dedupeBooks`) —,
les deux restant dans la grille. L'accueil montre, dans l'ordre et chaque rangée cachée quand elle est
vide : « Continuer la lecture », « Récemment ajoutés », une rangée par série (deux livres et plus, par
tome), par auteur (deux livres et plus, par année ; pas quand tous ses livres sont dans une série déjà
montrée), par genre (trois livres et plus) — dix au plus, les plus fournies, chacune avec son « Tout
voir » (`/livres?serie=`, `auteur=`, `genre=`, `tri=`). Les titres sont ceux de Jellyfin (les métadonnées
de l'EPUB), jamais les noms de fichiers. Tests : `books-metadata.test.ts`.

**La recherche.** Une seule : celle de l'application (la loupe) gagne une section « Livres » sous les
films et les séries, quand les livres sont affichés pour ce compte (`BooksSearchEntry`, rien sinon — ni
rendu, ni code, ni requête). Sa propre requête, partie 300 ms après la dernière frappe
(`/api/books/search`, l'index en mémoire, même limite par compte que la recherche des films) : les films
et séries ne l'attendent jamais. Un livre touché y ouvre sa fiche dans la catégorie Livres. Depuis le
04/11/2026, une puce « Livres » à côté de Films / Séries / Personnes, avec leur nombre (remonté par
`onCount`), les montre seuls, et « Tout » les compte : sans elle, il fallait descendre sous trente films
pour les voir. La section reste montée pendant toute la recherche (`shown` la cache sous une autre puce),
pour que la puce reste juste ; sous Films ou Séries, elle ne s'affiche plus. Test :
`player-search-panel.test.tsx`.

**Demander un livre.** Une seconde option, `BOOKS_REQUESTS_ENABLED` (même carte, coupée par défaut,
sans effet tant que les livres sont coupés — `config.books.requests`). Un ticket, traité à la main :
titre (requis), auteur, note, bornés, vingt par jour et par compte (`requests.ts`, table
`book_requests`) ; aucune base de livres consultée, Jellyseerr jamais touché. Le bouton est dans la
catégorie Livres, dans la grille complète et sous une recherche vide (« Vous ne le trouvez pas ?
Demandez-le », titre déjà rempli) ; « Mes demandes » montre l'état de chacune. L'administrateur voit
toutes les demandes au même endroit (onglet « Toutes les demandes », celles en attente d'abord), les
marque « ajouté » ou « refusé » avec un mot ; un livre de la bibliothèque au titre voisin est signalé
(« Peut-être déjà là »). Les notifications reprennent le chemin des signalements — `report-new` aux
administrateurs, `report-reply` à qui a demandé, dans la langue de chacun de ses appareils — plutôt
qu'une catégorie nouvelle, qui aurait ajouté une case dans Compte sur toute installation, livres
coupés compris. Seule écriture ouverte aux comptes : `POST /api/books/requests` ; répondre
(`PATCH /api/books/requests/<id>`) reste à l'administrateur, au proxy et dans la route. Tests :
`books-requests.test.ts`.

**La position.** Table `book_progress` (compte de l'application, livre, CFI EPUB, fraction, date,
fin) : Jellyfin ne sait garder que des durées. Envoyée au fil de la lecture (regroupée, 1,5 s), à la
fermeture et à `pagehide` (`sendBeacon`). Le livre fini la première fois, il est noté « lu » chez
Jellyfin pour ce compte (`markPlayed`) ; un échec de cet appel ne perd pas la position.
*Pas commencé (28/10/2026)* : sous 1 % (`MIN_STARTED_FRACTION`, `types.ts`), un livre n'est pas commencé.
La route n'écrit rien pour un livre qu'on vient d'ouvrir ; revenu à sa première page et refermé, il redevient
« pas commencé » (`forgetUnstarted` efface sa position, sauf s'il est terminé ; les signets restent, dans
leur table). `resumeFrom`, `continueReading` et la barre des cartes appliquent le même seuil, aussi aux
positions écrites avant la règle. Ouvert pour voir puis refermé, un livre entrait dans « Continuer la
lecture ».

**Les transitions (28/10/2026, mesurées avant d'être changées).** Sur 6 400 livres, iPhone émulé
(WebKit) et ordinateur (Chromium), cache chaud :
- *« Tous les livres » s'ouvre par-dessus l'accueil* (`#tous=…`, `booksAll` dans l'adresse du cinéma),
  sans changer de page : la grille n'a pas besoin de la politique de sécurité du lecteur. Elle chargeait
  le document `/livres` (~0,55 s), et son retour rechargeait tout le cinéma (~0,65 s) ; le retour est
  maintenant de 70 ms. Le lecteur, lui, reste la page `/livres` — dans un cadre posé sur le cinéma depuis
  le même jour (§128).
- *Aucun morceau des livres ne passe par Suspense* (`lazyNow`) : React retient l'apparition de ce qui
  était suspendu 300 ms au moins. La catégorie Livres, « Tous les livres » et le lecteur l'attendaient,
  alors que leur code et leurs données arrivaient en 10 à 40 ms.
- *« Lire » → première page* : ~1,4 s → ~0,42 s (iPhone), ~1,1 s → ~0,25 s (ordinateur). Le fichier du livre
  est demandé dès qu'on reste 0,6 s sur sa fiche (`readerPreload.ts`, gardé aussi une heure par le
  navigateur ; rien en économie de données), et la page des livres ouverte pour lire ne demande que le
  lecteur : son code, foliate-js et le fichier partent au premier rendu, en même temps ; la grille n'est pas
  chargée derrière. Depuis le cadre (§128), cette page se prépare elle-même au même moment, invisible, le
  livre fermé jusqu'à « Lire ».
- *La catégorie Livres se prépare à l'intention* (survol, doigt posé, focus du bouton) ; la fiche paraît
  sans attendre sa propre réponse quand la carte suffit.
- *Refermer le lecteur rechargeait le cinéma* (~0,5 s à l'ordinateur, ~0,75 s sur iPhone, l'accueil
  reconstruit sous les yeux). Le cache d'aller-retour des navigateurs ne le gardait pas : son document est
  servi `Cache-Control: no-store` (Chromium le dit : `response-cache-control-no-store`), ce qui empêche
  aussi de revenir, après une déconnexion, sur la page d'un autre compte — gardé. Ni ce `no-store` retiré,
  ni la politique du cinéma ouverte aux cadres `blob:` : le lecteur est posé sur le cinéma dans un cadre de
  la même origine, la page `/livres` telle quelle (§128). Refermer : ~50 ms sur iPhone, ~20 ms à
  l'ordinateur, sans rechargement.
- *Les « mini blocages » (28/10/2026, mesurés : un minuteur de 16 ms en retard, et la trace de Chromium).*
  La couverture floue derrière l'en-tête d'une fiche (`blur-3xl` sur l'image entière) coûtait 250 à 400 ms
  de fil principal à chaque ouverture et fermeture de fiche (Chromium ; le voile retiré, plus rien) : elle
  est faite une fois en une image de 16 × 24 points étirée (`coverWash.ts`), que le calque du trajet garde.
  Les menus de « Tous les livres » ne créent leurs milliers d'options qu'à l'approche du doigt ou du focus.
  Les rangées de l'accueil sautent leur mise en page hors de l'écran (`content-visibility`, comme celles des
  films) et ne se redessinent plus à chaque changement d'adresse (`memo`). Après la première visite,
  l'accueil des livres reste monté, caché, quand on revient aux films : y retourner ne refait ni requête ni
  rendu. Le cadre du lecteur qui se prépare sous une fiche est `visibility: hidden` en plus d'être
  transparent et sans pointeur : sur iPhone, la fiche du livre ne défilait plus au doigt pendant ce temps.

**Google Books, en option (`googleBooks.ts`).** `BOOKS_GOOGLE_ENRICH` (coupée par défaut) et
`GOOGLE_BOOKS_API_KEY` (un secret, comme la clé TMDB : jamais renvoyé au navigateur), dans la même carte
que les livres, ou dans `.env`. Rien ne part sans les livres allumés, l'option allumée et une clé ;
l'allumer depuis la Configuration lance la file sans redémarrage. Elle ne comble que **ce qui manque** —
le résumé, la couverture (ni Jellyfin ni l'EPUB n'en ont), les genres (par `bookGenres`), l'année —, posé
au moment de répondre sur les champs vides : Jellyfin et l'EPUB l'emportent toujours, et rien ne touche
un titre, un auteur ni une couverture existante (les corrections faites à la main dans Jellyfin restent).
- *La recherche* : l'ISBN quand Jellyfin le connaît (`isbn:…`), sinon `intitle:<titre> inauthor:<nom>`,
  encodé une fois par `URLSearchParams` — en français d'abord, puis sans restriction ; deux requêtes par
  livre au plus.
- *Mieux vaut rien qu'un mauvais résumé* : un candidat n'est retenu que si son titre est le même (égal,
  ou l'un contient l'autre à 80 % des mots, article ignoré) et qu'un auteur est le nôtre (le nom de
  famille au moins) ; jamais une analyse, un résumé, une fiche de lecture, un guide, un titre qui porte le
  nom de l'auteur (« L'inconnu de la forêt de Harlan Coben »), ni un éditeur d'études (lePetitLitteraire,
  Encyclopaedia Universalis…). Le français d'abord, un résumé ensuite. Sinon : « sans correspondance »,
  rien n'est rempli.
- *Règles v4 (28/10/2026) — la langue du livre, jamais supposée.* Chaque livre a une langue, choisie dans
  cet ordre : celle que son EPUB déclare (`dc:language`, colonne `book_meta.language`, ramenée à deux
  lettres : `fre`, `fra`, `fr-FR` → `fr`), sinon celle des métadonnées de sa bibliothèque Jellyfin
  (`LibraryOptions.PreferredMetadataLanguage`, lue dans la réponse `/Library/VirtualFolders` déjà demandée),
  sinon celle de l'installation (`APP_LANGUAGE`) — `targetLanguage`. Cette langue sert à tout : la
  recherche est restreinte à elle (`langRestrict`), le classement préfère ses volumes, et un résumé n'est
  pris que d'un volume dans cette langue. Un volume d'une autre langue donne encore l'année, l'image ou les
  genres. Rien n'est écrit en dur : une installation allemande cherche en allemand, un livre anglais dans
  une installation française garde son résumé anglais. Le cas qui l'a fait naître : « Lunatic Café »
  (Hamilton, édition française) avait reçu le résumé anglais d'un volume anglais, faute de candidat
  français décrit. Les lignes des règles v3 sont réévaluées (et vidées faute de mieux).
- *Règles v3 (28/10/2026)* : Google ne répond plus à ses opérateurs (`intitle:`, `inauthor:`, `isbn:` → 0 résultat, mesuré en production) ; la recherche est en texte libre, `<titre> <auteur>`, 20 réponses, dans la langue du livre (v4 ; le français jusque-là) puis la variante suivante ou sans restriction. Le bon volume est choisi parmi toutes (même ISBN, puis la langue du livre, puis résumé le plus long, puis le moins d’auteurs en plus) ; une adaptation à plus d’auteurs que le livre et un tome dans le titre est refusée. Un 503 (une requête sur deux, mesuré) est retenté trois fois à 1,5–3 s, chaque tentative comptant dans le quota.
- *Règles v2 (28/10/2026)*, après la première passe en production : « La Tour des anges » (Pullman, tome 2)
  avait reçu le résumé du tome 1 et le genre « Arctic regions ». Désormais : titre égal, ou le nôtre suivi
  d'un sous-titre après « : » / « - » qui n'est pas un autre titre de l'auteur (fini « l'un contient
  l'autre ») ; jamais une intégrale, un coffret, une trilogie, « tomes 1 à 3 », un recueil qui cite d'autres
  titres de l'auteur ; jamais un autre tome que celui de l'EPUB (`tomeOf`) ; jamais un résumé qui nomme un
  autre titre de l'auteur sans nommer le nôtre. Les genres passent par une table explicite vers le
  vocabulaire de l'application (`googleGenres`) — le reste est laissé. Les titres préfixés par un nom de
  fichier sont nettoyés avant la recherche (`titleVariants` : « APE18 5 L'or maudit du pharaon », « Alex
  Cross 03 Jack et Jill », « L'accro du shopping 3 dit oui »), toujours deux requêtes au plus. Chaque
  ligne porte la version des règles (`rules`) : celles d'une version plus ancienne sont réévaluées, les
  remplies d'abord, dans le même quota — un mauvais résumé est remplacé ou effacé.
- *Le quota* : un livre à la fois, 2 s au moins entre deux requêtes, 900 requêtes par jour au plus
  (compteur en base, `book_enrich_quota`, remis à zéro à **minuit heure du Pacifique**, comme le compte Google
  — `quotaDay`). Il l'était à minuit heure du serveur jusqu'au 29/10/2026 : la marge sous les 1 000 ne suffisait
  pas, une journée Google à cheval sur deux des nôtres a reçu ~1 000 requêtes (463 + 510, refus à 1 h du
  matin), et le refus bloquait la file jusqu'à notre minuit, quinze heures après que Google avait rendu son
  quota. Le réveil du lendemain vise 00:05 heure du Pacifique ; un changement d'heure qui le fait sonner
  trop tôt trouve le jour encore bloqué et se rendort jusqu'au vrai minuit. Chaque livre n'est essayé qu'une fois,
  « sans correspondance » compris (`book_enrich`), sauf si son titre, son auteur ou son ISBN changent.
  429 ou 403 : arrêt jusqu'au lendemain ; 503 ou réseau : reprise cinq minutes plus tard, le livre non
  compté comme essayé. L'ordre : les livres sans résumé chez Jellyfin d'abord, puis sans couverture, puis
  sans genres ni année.
- *La clé* part dans l'en-tête `X-Goog-Api-Key`, jamais dans l'adresse ; toute erreur est passée par
  `redact` avant un journal. Une ligne `[livres] Google Books` par passe dans `docker logs`, jamais une par
  requête. L'image de couverture est l'image publique du volume, sans la clé, réduite et gardée avec les
  autres (`googleCover`).

**Un livre qui ne s'ouvre pas le dit (28/10/2026).** Un échantillon de 300 EPUB tirés au hasard du lot
de production (dont « Skidamarink », écrit par Word avec ses espaces de noms Office et un `preview.wmf`
absent) s'ouvre en entier dans le vrai lecteur — Chromium 301/301, WebKit 76/76 — : foliate-js relit
déjà en HTML un chapitre XHTML mal formé, comme le nettoyage, et ignore une ressource absente. L'échec
vu en production n'a donc pas été reproduit sur le fichier ; deux choses le diront la prochaine fois :
la cause de chaque échec du lecteur part dans `server.log` (`reportClientError`, `component:BookReader`),
et un refus de Jellyfin au téléchargement y est écrit par la route du fichier. Un livre qu'on ne lira
jamais le dit avant foliate-js (`epubCheck.ts`) : « protégé (DRM) » — `rights.xml`, `sinf.xml`, ou un
`encryption.xml` qui chiffre des chapitres (l'obfuscation de polices seule n'en est pas un) — ou « pas un
EPUB lisible ».

**Signets, recherche, lecture hors ligne.**
- *Signets* : le signet de la barre du haut marque la page lue (plein quand elle l'est) ; la liste est un
  onglet du panneau de la table des matières — chapitre, quelques mots, pourcentage. Gardés par compte
  côté serveur (`book_bookmarks`, cinq cents par livre au plus, `POST /api/books/<id>/bookmarks`, aussi
  pour retirer — même règle de proxy que la position).
- *Retirer de « Continuer la lecture »* : un lien de la fiche du livre (pas d'appui long, que les cartes
  de films n'ont pas de façon évidente). La position reste, le livre quitte la rangée
  (`book_progress.dismissed_at`, `DELETE /api/books/<id>/progress`, même règle de proxy) et y revient à la
  prochaine page lue ; une position renvoyée hors ligne, lue avant le retrait, ne l'y remet pas.
- *Recherche dans le livre* : `search` de foliate-js, chapitre par chapitre (un `await` entre deux),
  résultats avec leur contexte sous le titre du chapitre, trouvailles soulignées sur la page ; chaque
  frappe arrête la recherche précédente, et elle s'arrête d'elle-même à trois cents trouvailles.
- *Toucher les bords* : « Tourner les pages en touchant les bords », réglage de l'appareil, allumé par
  défaut. Les zones restent 30 % / 40 % / 30 % (`tapAction`) ; coupé, un toucher ne fait que montrer
  ou cacher les barres (glisser, le clavier et la molette tournent toujours).
- *Hors ligne* : « Télécharger » sur la fiche garde l'EPUB dans l'OPFS du site
  (`laterna-books/<compte>/<livre>/`, `offlineBooks.ts`), à part des téléchargements de films, qui n'en
  savent rien ; la place est demandée au navigateur avant. Le lecteur ouvre la copie de l'appareil quand
  il y en a une. Sans réseau, la position et les signets attendent dans une file de l'appareil
  (`bookSync.ts`, `laterna:books:outbox`) et repartent au retour ; une position renvoyée tard n'écrase
  pas une plus récente (`at`). Les livres gardés ont leur section dans la page des téléchargements
  (rien de chargé quand l'appareil n'en garde pas, `useOfflineBooksPresent`), et s'ouvrent dans
  `/livres/hors-ligne` : une page publique que le service worker garde et sert sans réseau, comme
  `/hors-ligne`, **avec sa politique de sécurité** (celle des livres) — une page gardée sans elle n'est
  pas servie. L'entrée des films n'est pas touchée.
  **Un livre est un téléchargement** (29/10/2026) : un iPhone qui ne gardait qu'un livre, lancé sans
  réseau, ne proposait rien — chaque décision « a des téléchargements » ne lisait que les films. Le
  bouton de `offline.html` ne paraît que si `/hors-ligne` est gardée, et elle ne l'était que pour un
  appareil qui gardait un film ; `SlowLaunchDownloads` ne lisait que leur nombre ; `/hors-ligne` sans
  compte des films retenu disait « aucun compte » ; et sa section des livres suivait sans réseau un
  « affichés pour ce compte » (`laterna:books:shown`) que seule la page des téléchargements écrivait.
  Une règle, `deviceKeepsDownloads` (`offlineEntry.ts`) : des films **ou** des livres
  (`laterna:books:offline-count`). Garder un livre fait garder les deux entrées
  (`warmBooksOfflineEntries`) ; le cinéma les refait garder au lancement si l'appareil garde des livres,
  et retient `laterna:books:shown` (`useBooksMode`) ; `/hors-ligne` montre sa page quand l'appareil
  garde un livre. Sans livre, tout est comme avant : `offline-entry.test.tsx`, et le banc Chromium
  (un livre seul, hors ligne, lancement à froid : bouton, section Livres, lecture).

**Le lecteur.** foliate-js, copié à un commit précis (`src/lib/books/foliate/`, README et
`UPSTREAM`) : pas de paquet npm, et seuls les fichiers de l'EPUB. Pages en colonnes (deux côte à côte
sur un écran large et couché, si l'on veut) ou défilement continu ; toucher à gauche ou à droite,
glisser, molette, flèches ; Échap ou Retour referment (`&lire=1` dans l'adresse du cinéma). Réglages
gardés par appareil (`localStorage`, chaque accès gardé ; par compte et par type d'appareil depuis le
29/10/2026, la copie de l'appareil restant, §129) : changement de page (glisser, fondu, page
3D, aucun, défilement — fondu par défaut si le système demande moins de mouvement), taille, police
(celle du livre, Literata, Georgia, Outfit, système ; Literata et Outfit servies depuis
`public/books/fonts`), interligne, marges, justification, thème (auto, clair, sépia, sombre, noir),
lumière et chaleur (deux voiles sur la page). Changer un réglage garde la position : foliate-js
repagine autour de l'endroit lu.

**La sécurité : trois barrières, chacune suffisante pour l'essentiel.** Un EPUB est du XHTML venu
d'ailleurs.
1. *Le nettoyage* (`sanitize.ts`), branché sur le chargeur de foliate-js avant que le moindre chapitre
   devienne un document : plus de script, plus d'attribut `on…`, plus de cadre, d'objet ni de
   rafraîchissement, plus aucune adresse qui sorte du livre (seuls restent les `blob:` de cette
   origine, les ancres, les chemins relatifs et les images `data:`), dans le XHTML, le SVG et le CSS.
   Les ressources de type script ne sont même pas extraites.
2. *Le cadre sans `allow-scripts`*. foliate-js ajoute `allow-scripts` à cause d'un défaut de WebKit
   (218086 : sans lui, les écouteurs posés depuis la page sur le document du cadre ne se déclenchent
   pas) ; ce correctif local le retire, et le lecteur prend tous les gestes sur une couche de sa
   propre page — un lien touché est retrouvé par `elementFromPoint` sur le document du chapitre, que
   `allow-same-origin` permet de lire. `allow-same-origin` sans `allow-scripts` ne donne rien au
   livre : c'est la page qui lit le cadre, jamais l'inverse, puisque rien ne s'exécute dedans. Un lien
   externe ne s'ouvre jamais.
3. *La politique de la page* : `/livres` a sa propre règle dans `next.config.js`, qui remplace la
   générale pour cette adresse seulement (la générale garde `frame-src` YouTube et, depuis §128, notre
   propre origine) : `frame-src
   blob:`, et images, polices, feuilles de style et connexions limitées à l'application et à `blob:`.
   Un document `blob:` hérite de la politique de la page qui l'a créé : c'est aussi celle des
   chapitres. On n'arrive sur `/livres` que par un vrai chargement (lien ordinaire, ou le cadre que le
   cinéma pose pour lire, §128 — pas de navigation de Next) : sinon le document — et la politique — de
   l'accueil resteraient en place.

**Tests.** `books-routes.test.ts` (option coupée, droits, tags bloqués, relais, position, « lu »),
`books-isolation.test.ts` (défaut coupé, page absente, configuration publique, liens de partage,
rien des livres dans l'accueil, politique générale intacte), `books-sanitize.test.ts` (chapitre
piégé, `fixtures/books/piege.xhtml`), `books-reader.test.ts` (réglages, grille, adresse, correctifs
de foliate-js, titre affiché), `books-toggle.test.tsx` (deux boutons option coupée, troisième et mode
Livres allumée, adresse ; la section de la recherche coupée), `books-sheet.test.tsx` (cycle de vie de
la fiche), `books-scale.test.tsx` (index, pages, file des OPF, mesures de la boucle),
`books-metadata.test.ts` (OPF, auteurs, genres, couverture, file ralentie pendant un film),
`books-requests.test.ts`, `books-reading.test.tsx` (bords, signets, file hors ligne, section des
téléchargements), `serviceWorker-offline-entry.test.ts` (page hors ligne des livres et sa politique),
et dans `books-routes.test.ts` un livre d'une bibliothèque interdite ou porteur d'un tag bloqué, absent
de toutes les routes pour ce compte. En vrais navigateurs : `tools/livres-securite/` (Chromium, Firefox, WebKit ; un EPUB
piégé et un espion qui compte ce qui l'atteint ; sur la page seule et dans le cadre posé sur le cinéma).

**Voulu.** Ni page Nouveautés, ni entrée au registre des corrections : une option qu'une
installation allume elle-même. Pas de sélection de texte ni de surlignage (la couche de gestes les
empêche ; une version future pourrait les faire depuis la page). Les livres à mise en page fixe
passent par le même lecteur sans réglages de texte utiles. Seul l'EPUB : les autres formats de
foliate-js ne sont pas copiés.

**Décidé le 28/10/2026.**

## 128. Le lecteur de livres dans un cadre posé sur le cinéma, et `frame-src 'self'`

**Règle.** Depuis le cinéma, « Lire » ouvre la page `/livres?cadre=1#livre=<id>&lire=1` dans un `<iframe>`
de la même origine posé sur tout l'écran (`ReaderFrame.tsx`), au lieu d'y mener toute la fenêtre. C'est
toujours le document `/livres`, avec sa propre politique de sécurité et ses trois barrières (§127) ; le
refermer retire le cadre, et le cinéma dessous n'a pas bougé. La politique générale ne gagne qu'une
source : `frame-src 'self' https://www.youtube-nocookie.com` — ni `blob:`, ni `data:`, ni autre hôte.
`'self'` ne vaut que pour les cadres que le cinéma crée : ce qu'ils chargent eux-mêmes relève de leur
propre politique (les cadres `blob:` des chapitres, permis par celle de `/livres` seule). La page des
livres garde `frame-ancestors 'self'` (seule notre origine peut la poser) et le `X-Frame-Options: DENY`
de la règle générale, que Chromium, Firefox et WebKit ignorent quand `frame-ancestors` est là (vérifié
le 28/10/2026 dans les trois) ; le cinéma reste `frame-ancestors 'none'`.

**Le contrat entre les deux documents** (`src/lib/books/readerFrame.ts`, une fonction par sens) :
- *l'adresse* : le cinéma pousse **une** entrée (`#livre=…&lire=1`, `cinemaNavigate`) après l'animation
  de la couverture ; le cadre ne touche jamais à l'historique de la fenêtre — une entrée poussée dans un
  cadre s'empile dans l'historique commun, et Retour reculerait dans le cadre. Le cadre naît avec son
  adresse (la première navigation d'un cadre neuf remplace son `about:blank`).
- *refermer* : la croix et Échap du lecteur demandent `close` ; Retour (navigateur, bouton d'Android)
  ramène l'entrée d'en dessous ; Échap resté au cinéma (avant la première page) fait de même. Tout passe
  par `cinemaClose({ reading: false })` — un seul retour en vol — et le cadre est retiré quand l'adresse ne
  nomme plus le lecteur. Le focus revient à « Lire » de la fiche (`data-book-read`).
- *les messages* : des objets aux clés exactes (`app`, `v`, `kind`, et le livre ou les marges), acceptés
  seulement de notre origine **et** de la fenêtre attendue — le cadre pour le cinéma (`acceptFromFrame`),
  le cinéma pour le cadre (`acceptFromParent`) ; envoyés à notre seule origine. Du cadre : `hello` (il
  écoute), `ready` (première page ou erreur affichée — le calque de l'ouverture part), `saved` (une
  position est enregistrée — la fiche, l'accueil des livres et la grille ouverte par-dessus relisent la
  leur), `close`. Du cinéma : les marges de l'écran (`insets`) et `open`.
- *les marges* : un cadre ne reçoit pas celles de l'encoche ni de la barre d'accueil (`env()` y vaut 0) ;
  le cinéma les mesure et les envoie, et le lecteur lit `var(--reader-inset-*, env(safe-area-inset-*))`
  (`insetVar`), la plus grande des deux.
- *la position relue* : la dernière part du cadre en `keepalive` au moment où il est retiré ; le cinéma
  relit la fiche et l'accueil tout de suite, puis 1,5 s plus tard.

**Préparé depuis la fiche.** Les deux documents partagent le même fil : chargé à « Lire », le code de la
page des livres tombait pendant que la couverture grandit (mesuré : ~0,75–0,95 s jusqu'à la première page
sur iPhone émulé, contre ~0,5 s avant le cadre). Restée 0,6 s sur la fiche (la même intention que le
fichier demandé d'avance, rien en économie de données), la page prépare son cadre (`standbyReaderFrame`,
`onReadIntent` de `BookSheetHost`) : `/livres?cadre=1#livre=<id>`, invisible et inerte, qui charge son
code, foliate-js et le fichier **sans ouvrir le livre** — ouvrir, c'est aussi enregistrer une position, et
un livre seulement regardé entrerait dans « Continuer la lecture ». Il l'ouvre à `open`. La fiche refermée
sans lire, le cadre est retiré ; une fiche refermée pendant que la couverture grandit l'emporte (rien n'est
poussé).

**Mesuré (28/10/2026, 6 400 livres, cache chaud, médiane de six ouvertures du même livre, Playwright).**

| | iPhone émulé (WebKit) avant → après | Ordinateur (Chromium) avant → après |
|---|---|---|
| « Lire » → première page | 482 → 503 ms | 354 → 432 ms |
| Lecteur refermé → fiche | 736 → 48 ms | 428 → 21 ms |
| … animations terminées | 1 021 → 314 ms | 994 → 23 ms |
| Document du cinéma rechargé | oui → non | oui → non |

« Avant » s'arrêtait à la première peinture de la page des livres, l'animation de la couverture coupée par
le changement de document ; « après », elle va à son terme (380 ms) et la page paraît quand le calque
commence à s'effacer — d'où les ~80 ms de plus à l'ordinateur.

**Fonctions.** `readerFrame.ts` (adresse, messages, vérifications, `isFramedReader`, `insetVar`),
`ReaderFrame.tsx` (`standbyReaderFrame`, `openReaderFrame`, `ReaderFrame`), `BooksScreen` (la page en
cadre : `tellCinema`, marges, `open`), `BookReader` (`onReady`). Appelants : `BooksHome` (sa fiche et la
grille ouverte par-dessus). La page `/livres` ouverte seule — lien direct, rechargement, `?retour=1`
d'une adresse gardée, `/livres/hors-ligne` — se comporte comme avant : le paramètre ne suffit pas, il faut
aussi un parent de notre origine.

**Tests.** `books-reader-frame.test.tsx` (messages refusés d'une autre origine, d'une autre fenêtre, mal
formés ; une entrée d'historique ; `close` par l'adresse, un seul retour en vol ; cadre préparé, `open`
après `hello` ; marges ; position relue), `books-isolation.test.ts` et `youtube-fenetre-seule.test.ts` (la
politique générale : exactement `frame-src 'self' https://www.youtube-nocookie.com`, sans `blob:`). En vrais
navigateurs, `tools/livres-securite/` ouvre l'EPUB piégé aussi dans le cadre posé sur le cinéma : aucun
script, aucune requête hors de l'application, rien d'écrit dans la fenêtre du cinéma ni de changé à son
adresse — et, sans le correctif de foliate-js (`allow-scripts`), le script d'un chapitre atteindrait bien la
fenêtre du cinéma, ce qui dit pourquoi les cadres des chapitres ne l'ont jamais.

**Voulu.** Le cadre est retiré, pas gardé caché : un lecteur vivant sous le cinéma tiendrait de la mémoire
et des écouteurs pour un livre qu'on ne lit plus. Pas d'animation de sortie : refermer découvre la fiche,
qui est déjà là. La page des livres seule n'a pas changé de comportement.

**Pas sûr, à regarder sur un vrai iPhone en application installée** : le défilement continu, le pincement
et les marges dans un cadre (Playwright n'émule ni l'encoche ni le zoom de la page).

**La page 3D couchait le chapitre en colonnes d'un mot** (iPhone, 29/10/2026, et reproduit dans WebKit,
dans le cadre comme sur `/livres`). Le retournement fait pivoter `<foliate-view>` (`rotateY`), et foliate-js
mesurait sa boîte par `getBoundingClientRect()` — la boîte *dessinée*. Au milieu du geste, la page de
profil mesure presque 0 px de large : un chapitre posé à ce moment recevait une colonne d'une trentaine de
pixels (`column-width: 36px` mesuré), et la page, le nombre de pages et la position étaient calculés sur
cette largeur. Ni le cadre ni un `ResizeObserver` n'y étaient pour rien : une transformation ne change pas
la mise en page, seulement ce que ce rectangle en dit. Correctif à la source, dans foliate-js
(`layoutRect`, `paginator.js` ; même chose dans `fixed-layout.js`) : la largeur du conteneur, la taille d'une
page et celle de la vue viennent de `offsetWidth` / `offsetHeight`, qui ignorent les transformations — le
rectangle dessiné reste pris quand les deux s'accordent, pour ses fractions de pixel. L'animation peut
donc tourner l'élément mesuré sans rien lui faire mesurer de faux, quel que soit le moment où un chapitre
se pose (le geste, un toucher en attente, une rotation pendant le geste — qui donne, elle, une vraie
taille). Le pincement (une `scale` sur la même vue) en profite aussi.

**« Deux pages » n'en montrait qu'une** sur un iPhone couché (Auto en montrait deux). Le lecteur passait
`max-inline-size="min(680px, 520px)"`, que foliate-js relit par `parseFloat` (une propriété personnalisée
n'est pas calculée) : `NaN`, une largeur de colonne invalide, aucune colonne. Désormais un nombre en
pixels (`paginatorColumns`, `readerPrefs.ts`). La règle : Une page, toujours une ; Auto, deux dès que deux
largeurs de lecture tiennent (680 px avec la marge moyenne : un iPhone 15 couché oui, un iPhone SE couché
non) ; Deux pages, deux sur tout écran couché (colonne bornée à 520 px). Debout, une seule page quel que
soit le choix — c'est foliate-js (`--_max-column-count-portrait`) : deux colonnes sur la largeur d'un
téléphone debout ne font plus des lignes.

Banc en vrai navigateur (WebKit, iPhone émulé, dans le cadre et sur `/livres`) : huit tours en page 3D,
glisser, fondu et aucun, puis couché, trois tours, redressé — à chaque fois la colonne visible fait la
largeur de la page moins les marges, et une ligne porte plus de cinq mots ; les trois dispositions
couché et debout.

**Décidé le 28/10/2026.**

### Chasse aux bugs du 29/10/2026 (10.10.6)

Une relecture du code et une passe en vrai navigateur (Chromium, Firefox, iPhone et iPad émulés) ; ce
qu'elles ont fixé comme règles :

- **« Terminé » suit la position** (`saveProgress`) : il tombe dès qu'une page d'avant est enregistrée. Il
  ne tombait jamais — un coup d'œil à la dernière page sortait le livre de « Continuer la lecture » pour
  toujours. « Lu » chez Jellyfin reste ; il est redit à la fin suivante (sans effet de plus).
- **Une heure de lecture est dans l'horloge du serveur** (`readAt`) : le client envoie l'âge de la mesure
  (`ageMs`), le serveur en déduit l'heure, s'en sert pour `updated_at` et pour comparer au retrait. `GET`
  rend `now`, que le lecteur utilise pour comparer sa copie de l'appareil. Un ancien client (seulement
  `at`) reste accepté.
- **La file de l'appareil garde une écriture refusée par 401 ou 429** (`bookSync.ts`) : une session
  expirée pendant une lecture hors ligne n'est pas un refus.
- **La page où le livre s'ouvre n'est pas enregistrée** : seule une page tournée part.
- **Un livre gardé n'attend pas le réseau** : 4 s au plus pour la position, la file envoyée sans attendre.
- **Le compteur des livres gardés est relu au lancement** s'il vaut zéro (`recountOfflineBooks`), et la
  place qu'ils prennent compte dans celle des téléchargements (`keptBooksBytes`).
- **Le cadre du lecteur** : un second « Lire » pendant l'ouverture est ignoré ; un cadre rechargé reçoit
  `open` à son `hello` ; la présence, la maintenance, `BuildRefresh` et l'invitation à installer ne sont pas
  montées dans un document servi à un cadre (`Sec-Fetch-Dest: iframe`, `layout.tsx`).
- **Les tags autorisés de Jellyfin** (`AllowedTags`) filtrent l'index comme les tags bloqués.
- **foliate-js** : un seul décodage des adresses (`decodeHref`, `epub.js`) — `decodeURI` laissait `%2C`,
  et une table des matières qui échappe « , » ne menait nulle part ; un chapitre sans `body` n'est plus
  mis en page (`setStylesImportant`). Vérifié avant : aucun des 6 505 EPUB de la bibliothèque n'a de `%`
  dans un nom d'entrée, donc rien qui se trouvait ne se perd.
- **Le lavis de la fiche est un `blob:`**, pas un `data:` : la politique d'images du cinéma refuse `data:`.

Laissé en l'état, exprès : au défilement continu sur WebKit, un toucher ne ramène pas les barres (les
écouteurs posés dans un chapitre sans scripts ne s'y déclenchent pas ; remonter les ramène) — à juger sur
un vrai iPhone ; Retour pendant les 200–600 ms d'ouverture du lecteur referme aussi la fiche ; l'option
coupée n'est vue par un cinéma déjà ouvert qu'au rechargement ; la liste des demandes de l'administrateur
cherche chaque demande (limite de 120 recherches par minute).

## 129. Les livres par compte : réglages par type d'appareil, journal des lectures, liste de lecture

Trois ajouts à l'option des livres (§127), voulus ensemble le 29/10/2026. Coupée, rien de tout cela
n'existe : les routes répondent 404 (`booksCaller`, et la route de l'activité vérifie l'option elle-même),
Ma liste n'a pas d'onglet de plus, l'activité ni carte ni vue, et aucun code des livres n'est chargé
(`books-isolation.test.ts`).

### Les réglages du lecteur, par compte et par type d'appareil

**Règle.** Les réglages du lecteur (page qui tourne, police, taille, interligne, marges, justification,
thème, lumière, chaleur, disposition, bords) sont gardés **par compte et par type d'appareil** — `telephone`,
`tablette`, `ordinateur` — dans `book_reader_prefs` (une ligne par compte et par type, l'objet entier en
JSON). Un type qui n'a encore rien prend **les derniers réglages écrits par le compte, quel que soit leur
type** : la première fois qu'on règle le lecteur, le réglage vaut partout. Dès qu'on en change un sur un
autre type d'appareil, ce type a les siens et les garde. Deux appareils du même type partagent la même
ligne. Ils étaient gardés par appareil seulement (`localStorage`, §127) : un nouveau téléphone, une
navigation privée, un navigateur effacé repartaient des réglages par défaut.

**Le type d'un appareil** (`deviceType.ts`, `deviceTypeOf` / `currentReaderDeviceType`) : tactile
(`hover: none` et `pointer: coarse`) et petit côté de **l'écran** sous 600 points → téléphone, au-dessus →
tablette ; tout le reste, une Fire TV comprise, → ordinateur. L'écran et non la fenêtre, exprès : `useIsMobile`
et `useIsTablet` suivent la fenêtre, pour la mise en page — une fenêtre d'ordinateur réduite y devient un
téléphone, un téléphone couché change de côté. Un profil qui sauterait quand on tourne l'écran
repaginerait le livre sous les yeux.

**Fonctions.** `readerPrefsFor` / `saveReaderPrefs` (`readerPrefsStore.ts`, la règle du repli, et un
changement renvoyé tard qui n'écrase pas un plus récent du même type), `strictReaderPrefs`
(`readerPrefs.ts` : tous les champs, aucun autre, chaque choix dans sa liste, chaque nombre dans ses
bornes — plus strict que `normalizeReaderPrefs`, qui rattrape un ancien stockage de l'appareil),
`GET/PUT /api/books/reader-prefs` (corps de 2 000 octets au plus ; `PUT` dans la liste blanche du proxy).
Côté lecteur, `useReaderPrefsSync` (`readerPrefsSync.ts`) : le livre s'ouvre **aussitôt** sur la copie de
l'appareil (`laterna:books:reader`, gardée à la déconnexion comme avant) ; la réponse du serveur n'est prise
que si elle diffère et qu'aucun réglage n'a été touché depuis l'ouverture ; un changement part une seconde
après le dernier (un curseur en produit des dizaines), tout de suite si le lecteur se referme. Un envoi
qui échoue (hors ligne, panne, session expirée) laisse une marque (`laterna:books:reader-pending`, avec
l'heure) : à la prochaine ouverture en ligne, la copie de l'appareil part d'abord au lieu d'être remplacée.
Même chemin dans le cadre posé sur le cinéma, sur `/livres` seule et sur `/livres/hors-ligne` (l'appareil
seul, la marque pour plus tard).

**Les réglages d'avant le 29/10/2026 sont repris** (`SYNCED_KEY`, `laterna:books:reader-synced`) : au
premier échange réussi d'un appareil avec le serveur, si ses réglages ne sont pas ceux d'origine et que le
serveur n'a rien de propre à son type, ils partent comme ceux de ce type au lieu d'être remplacés. Sans
cette règle (la première version), le premier appareil à envoyer les siens les imposait à tous les autres,
qui perdaient ce qu'on y avait réglé quand ils n'étaient gardés que sur l'appareil. Un appareil aux
réglages d'origine prend ceux du compte. La marque est sous `laterna:books:` : après une déconnexion, le
premier échange se refait pour le compte suivant.

**Voulu.** Pas de profil nommé à choisir : trois types d'appareil, rien à gérer.

### Le journal des lectures, et « Lectures » dans l'activité

**Règle.** `data/logs/lectures.log` (`READINGS_LOG`, `logReadingEvent`, `eventLogs.ts` : une ligne JSON,
cinq mégaoctets, vingt archives, `logGenerations`), trois sortes de lignes :
- `séance` — une par séance de lecture, envoyée par le lecteur (`useReadingSession`, `readingSessions.ts`)
  à sa fermeture et au passage de la page en arrière-plan, par `sendBeacon` : temps **page visible**
  (`durationMs` ; le temps caché n'y est jamais, et un retour au premier plan ouvre une nouvelle séance),
  avancement au début et à la fin, pages tournées (une repagination ne compte pas), type d'appareil,
  `offline`, `build`/`version`. Sans réseau, la séance attend dans `laterna:books:sessions` (cinquante au
  plus) et repart à l'ouverture suivante ou au retour du réseau, avec son âge : le serveur la place à
  l'heure où elle a eu lieu (`startedAt`/`endedAt` dans son horloge, `resent` et `lateByMs` au-delà d'une
  minute). Le compte vient de la session ; le titre et le premier auteur, de l'index du serveur (`bookFields`)
  — rien du corps ne nomme le livre, et un livre hors de la vue du compte est refusé (404). Sous dix
  secondes sans page tournée, rien n'est écrit ; soixante séances par heure et par compte au plus
  (`readingSession`, `writeLimits.ts`) ; une séance renvoyée deux fois (même `id`) n'est écrite qu'une fois.
- `terminé` — le livre fini la première fois (`firstFinish` de la route de la position) ;
- `retiré` — « Retirer de Continuer la lecture ».
`book_progress.last_device` garde l'appareil (`requestDeviceLabel`) de la dernière page enregistrée.

**L'activité.** « Lectures » (`#activite=lectures`, `ActivityReadings`, carte dans la vue d'ensemble
seulement les livres allumés et quand quelqu'un a lu) : par compte, les livres en cours (titre, auteur,
pourcentage, date, appareil), les terminés et leur date, le temps de lecture et les séances sur sept et
trente jours, puis le fil des dernières lectures. `readingsOverview` (`src/lib/activity/readings.ts`) réunit
`book_progress` (`allProgress`) et le journal (`readRecords("readings")`) ; les titres viennent de l'index
commun vu avec tous les droits, sinon de la dernière ligne du journal qui nomme le livre. Route
`/api/admin/activity/books` : `adminOnly`, au proxy dans `ADMIN_ONLY_READS`, 404 l'option coupée. Le journal
est aussi une source des Journaux de l'activité (`readings`, proposée seulement les livres allumés).

### « Ma liste de lecture »

**Règle.** Table `book_list` (compte, livre, date d'ajout), à part de la liste des films et séries
(`watchlist`, qui ne connaît qu'eux). `GET /api/books/list` (la liste vue à travers la vue du compte :
un livre retiré ou caché depuis par un tag bloqué n'y paraît pas, sa ligne reste), `POST { id }` (ajouter :
seulement un livre que `bookFor` rend pour ce compte, sinon 404 ; deux mille au plus), `DELETE ?id=`
(retirer). Seul son compte la vide : un livre terminé ou marqué lu y reste, comme un film vu reste dans
« À voir » (29/10/2026 — avant, il en sortait de lui-même à la première fin).

**Où elle se voit.** Sur la fiche d'un livre, « Ajouter à ma liste de lecture » / « Retirer de ma liste
de lecture », du style des autres gestes secondaires, appliqué avant la réponse et rattrapé si le serveur
refuse (`setListed`, `ReadingList.tsx`) — proposé aussi pour un livre lu. Sur l'accueil
des livres, une rangée « Ma liste de lecture » juste après « Continuer la lecture », quand elle a des
livres (`list` de `/api/books/home`, vingt au plus, sans « Tout voir »). Dans Ma liste, un onglet « À
lire » juste après « À voir », seulement quand les livres sont affichés pour ce compte
(`useReadingListEntry` de `BooksMode`, la clé `booksEnabled` de la configuration publique) : sa recherche et
son tri sont ceux de Ma liste, un livre touché ouvre sa fiche dans la catégorie Livres par-dessus Ma liste
(`{ books: true, book }`, comme depuis la recherche). Le segment est chargé à part (`ReadingListEntry`,
`lazyNow`) : `PlayerListPanel` n'importe des livres que `BooksMode`.

**Voulu, différent exprès.** « À lire » n'est jamais l'onglet choisi d'office à l'ouverture de Ma liste : son
compte arrive après celui des films, et l'écran sauterait d'un onglet à l'autre ; Ma liste s'ouvre comme
avant les livres. Le compteur et le filtre de l'onglet lisent le nom entier du livre (pas le titre
raccourci de `displayTitle`) : les deux disent le même nombre.

**Tests.** `books-lectures.test.ts` (type d'appareil ; réglages refusés champ par champ, repli sur les
derniers du compte puis les siens, ordre des écritures tardives, isolement entre comptes, option coupée et
lien de partage ; séance validée et bornée, compte et titre du serveur, appareil, séance courte ignorée,
renvoi tardif et doublon, livre hors des droits ; lignes `terminé`/`retiré` et `last_device` ; « Lectures »
à l'administrateur seul, absente option coupée, chiffres par compte ; liste : ajout, retrait, isolement,
droits, tag bloqué après coup, sortie à la fin, rangée de l'accueil, option coupée),
`books-lectures-ui.test.tsx` (onglet « À lire » absent sans les livres, jamais choisi d'office, ouverture de
la fiche ; vue « Lectures » ; réglages : copie de l'appareil puis ceux du compte sans renvoi, geste avant la
réponse qui l'emporte et part une seconde après, hors ligne puis envoi à l'ouverture suivante),
`books-isolation.test.ts` (proxy : écritures permises à un compte et refusées à un lien de partage,
« Lectures » à l'administrateur seul).

**Décidé le 29/10/2026.**

### Commencé dès la deuxième page (29/10/2026, 10.11.1)

Le seuil de 1 % (`MIN_STARTED_FRACTION`, 28/10/2026) demandait quatre pages d'un roman de 400 avant
« Continuer la lecture ». La règle devient : la page où un livre jamais commencé s'ouvre n'est pas envoyée
(`BookReader`, déjà le cas), toute page tournée ensuite le commence ; revenu à cette page d'ouverture (ou au
tout début du fichier), le lecteur envoie `atStart: true` et la route l'efface (`forgetUnstarted`). Une position
gardée est donc un livre commencé : les filtres de `resumeFrom`, `grouping.ts` et de la vue « Lectures »
n'appliquent plus de seuil, et le pourcentage montré n'est jamais « 0 % » (`readPercent`). Un client d'avant,
qui n'envoie pas `atStart`, garde le seuil de 1 % côté route.

### « Marquer comme lu / non lu » (29/10/2026, 10.12.0)

Sur la fiche d'un livre (`MarkReadButton`, `ReadingList.tsx`), la forme de « Ma liste » et la coche dorée de
« Marquer vu » des films ; il remplace la ligne « Terminé ». Route `POST|DELETE /api/books/<id>/read` (le compte
de la session, un livre qu'il voit — `bookFor`). Lu : `markRead` (terminé comme au bout du lecteur, la position
gardée ou une ligne vide), « lu » chez Jellyfin ; il reste dans « Ma liste de lecture », comme un film vu. Non lu : `markUnread` (la
position effacée, les signets restent), « non lu » chez Jellyfin. Les deux vont au journal des lectures
(`marqué lu`, `marqué non lu`). Un refus de Jellyfin ne bloque pas l'état local et va dans `server.log`.

### Pas de 404 pour une couverture absente (29/10/2026, 10.12.4)

Un livre sans couverture (ni Jellyfin, ni l'EPUB, ni Google Books) faisait répondre `404` à
`/api/books/<id>/cover`. Une grille de livres en demandait une rafale, et CrowdSec, devant le proxy, l'a lue
comme un robot qui fouille le site (`crowdsecurity/http-probing`, douze 404 en onze secondes) : un compte a
été coupé de toute l'application pendant quatre heures. « Pas de couverture » répond désormais `204`, gardé une
heure ; `BookCover` retient pour la page les couvertures absentes et ne les redemande plus ; le téléchargement
hors ligne n'enregistre qu'une réponse `200` non vide. Un livre hors des droits du compte répond toujours 404.
Laissé exprès : le relais `/api/jellyfin/image` garde son 404 (des `fetch` des téléchargements de films le
lisent comme un échec ; ses 404 sont rares et espacés).

### Le relais d'images et les menus de « Voir tout » (29/10/2026, 10.12.5)

Le relais `/api/jellyfin/image` suit la règle des couvertures : une image absente chez Jellyfin répond `204`
(gardé une heure), tout autre refus `502` — jamais 404 (27 en quatre jours, des images de fond absentes : une
rangée de titres sans fond suffisait à faire bannir une adresse). Les `fetch` qui gardent une image hors ligne
(`artwork.ts`, l'affiche dans `downloads.ts`) n'acceptent qu'un `200` non vide. Ce qui reste en 404 dans
l'usage, rare et isolé : `trickplay/info` (un titre sans aperçus, une fois par lecture), un titre masqué.

Les menus des grilles « Voir tout » (films, séries, livres) n'ont plus de marge verticale (`FILTER_SELECT`,
`BooksScreen` `Picker`) : 8 px en haut et en bas dans 36 px coupaient leur texte sur iPhone.

La lecture des attributs de l'OPF (`attr`, `epubMeta.ts`) prend la valeur entre ses propres guillemets :
`["']([^"']*)` s'arrêtait à la première apostrophe (« Ailes d » pour « Les ailes d'Alexanne », 141 séries).
Toute ligne de `book_meta` qui porte une série est relue une fois (empreinte vidée, marqueur
`book-meta-apostrophe`) ; l'index garde l'ancienne valeur jusqu'à la relecture.

### Le défilement continu mené par nos gestes, et Google Books plus économe (29/10/2026, 10.12.7)

**Défilement continu.** La couche des gestes du lecteur reste posée sur le livre dans ce mode aussi (elle
s'effaçait pour laisser le doigt au texte). Sur WebKit, un chapitre — cadre sans scripts — ne transmet aucun
toucher à la page : un toucher ne ramenait pas les barres ; et foliate-js ne passait jamais au chapitre suivant
au doigt — une couverture qui tient dans l'écran ne se quittait pas. Désormais : un toucher montre ou cache les
barres (les bords ne tournent rien dans ce mode) ; un glissement vertical fait défiler par `scrollFlow` (patch
Laterna de `paginator.js`, qui rend la distance réellement parcourue), avec un élan qui ralentit ; au bord d'un
chapitre, ce qui dépasse s'accumule et au-delà de `FLOW_EDGE_PX` (70 px, 220 px à la molette) le chapitre
voisin s'ouvre — le suivant en haut, le précédent en bas. Un doigt posé arrête l'élan. Revers assumé : on ne
sélectionne plus de texte au doigt dans ce mode, comme dans les autres.

**Google Books.** La pause après trois refus d'affilée passe de cinq minutes à une : les 503 de Google sont un
hasard (environ un sur sept, indépendants, mesuré sur 50 requêtes le 29/10). Ils restent comptés dans les 900
du jour : la console de Google les compte aussi — elle a d'abord affiché 907 (son retard d'affichage), puis 949,
soit exactement les 899 de l'application et les 50 de l'essai.

## 130. Revue de sécurité ciblée de `src/proxy.ts` (29/10/2026)

Trois relectures isolées (formes d'adresses, sessions et partage, accès sans session et en-têtes), chaque
trouvaille contre-vérifiée par une relecture neuve ou un essai. Rien de grave. Les contournements par une
adresse encodée (`/_next%2F..%2Fapi%2Fsettings` et voisines) ont été essayés contre le conteneur : Next
répond 404, ou ramène le chemin à la route réelle qui répond 401.

**Une écriture en GET échappait à `crossSiteWrite`.** `/api/player/watched/finished` (« Vous avez terminé
ce film », écran de fin du lecteur) écrivait « vu » sur un GET ; le refus des écritures d'un autre site ne
regarde que les méthodes qui écrivent, et le cookie `SameSite=Lax` suit une navigation. C'est un POST,
inscrit dans la liste des écritures permises à un compte ordinaire ; l'appelant (`FinishedAsk`) le pose
par `apiAction`. Une route qui écrit n'est jamais un GET.

**Les verdicts sur les jetons Jellyfin existaient en deux exemplaires.** `middleware.js` embarque sa propre
copie de `jellyfinToken.ts` (vu dans le build) : un rapport de lecture refusé, noté côté route, n'était connu
du proxy qu'à sa propre question, une heure plus tard au pire. La table vit sur `globalThis`
(`cine-app.jellyfinTokenVerdicts`) ; `jellyfin-token.test.ts` l'éprouve entre deux imports du module.

**Laissé tel quel, par choix.** Un compte ordinaire dont le jeton Jellyfin est mort garde sa session sur
les appels d'API jusqu'à l'expiration du cookie (sept jours au plus) : seul un chargement de page la ferme,
pour ne jamais couper un film en cours. « Déconnecter mes autres appareils » la ferme.


## 131. Le cadrage des réponses posé par le serveur de démarrage, pas par la route (06/11/2026)

**La panne.** Next 16.4.5 (correctif GHSA-pc58-hwjq-p385) retire `content-length`, `content-encoding` et
`transfer-encoding` de toute réponse de route (`next/dist/server/send-response.js`, `FORBIDDEN_HEADERS`) : un
corps relu par `fetch` a pu être décompressé en gardant ses en-têtes, et sa longueur d'origine décrivait alors
autre chose que ce qui partait. Le 05/11/2026, le catalogue, les Nouveautés et les listes HLS — précompressés
par leurs routes — sont arrivés sans leur étiquette ; le navigateur a lu du brotli comme du JSON. Retour en
16.4.3 le jour même. Le gate était vert : aucun test ne passait par le code de Next qui envoie la réponse.

**La règle.** Une route n'écrit jamais `Content-Encoding` ni `Content-Length`. Elle pose un marqueur
(`x-cine-encoding: br|gzip`, `x-cine-length: <n>`) par `src/lib/responseFraming.ts` — `encodedBodyHeaders`
(corps précompressé en mémoire), `lengthHeader` (corps en mémoire, plage de fichier bornée),
`upstreamLengthHeader` (longueur de Jellyfin, seulement si l'amont n'a pas codé son corps : `fetch` ne l'a donc
pas décodé). `server-boot/responseFraming.mjs`, branché par `boot.mjs` sur chaque réponse avant Next, en fait le
vrai en-tête **au moment où Next le pose** (`setHeader` / `appendHeader`) — avant le `writeHead` où le module
`compression` de Next décide : il y voit `Content-Encoding` et ne recompresse pas. Un marqueur ne sort jamais ;
une valeur illisible est jetée. Les octets envoyés sont comptés contre la longueur traduite : trop ou trop peu,
la connexion est coupée plutôt que de laisser une réponse mal cadrée (le fond de la faille). HEAD, 204, 304 ne
sont pas comptés ; quand `compression` compresse lui-même (il retire la longueur), le compte s'efface.

**Sans le serveur de démarrage** (`next dev`, les tests, un autre point d'entrée), `boot.mjs` n'a pas posé
`CINE_FRAMING_HEADERS=1` : `framingAvailable()` est faux et les routes répondent en clair, sans longueur. Jamais
un corps compressé sans son étiquette.

**Appelants.** `respondPrepared` / `cachedJson` (catalogues, Nouveautés, copie de secours §92), `encodePlaylist`
(listes HLS), le relais du flux (`/api/jellyfin/stream` : fichier en lecture directe 206/HEAD, textes nettoyés,
sous-titres), `/api/player/download` (sans longueur, le téléchargement du navigateur n'a ni taille ni barre),
`/api/books/[id]/file` (la place libre est vérifiée sur cette longueur), `/api/books/[id]/cover`,
`/api/offline/jobs/[jobId]/file`, `/api/lab/offline-samples/[file]`. Sans la longueur relayée, le HEAD de
`HttpByteSource.open` ne lisait plus la taille (un aller-retour de plus), et le `<video>` du lecteur serveur en
lecture directe — Safari, un téléviseur AirPlay — recevait des 206 en morceaux.

**Relevé en chemin.** La compression de Next ne touche aucune réponse de route, en 16.4.3 comme en 16.4.5 :
`sendResponse` pose les en-têtes en tableaux et le filtre `compressible` n'accepte qu'une chaîne. Les pages et
les fichiers statiques restent compressés. Une route JSON qui ne passe pas par `cachedJson` part donc en clair,
avant comme après — non changé ici.

**Tests.** `response-framing.test.ts` : les règles du marqueur ; le vrai `sendResponse` et le vrai
`compression` de Next, branchés dans l'ordre de `router-server.js` (la panne reproduite sans le cadrage, brotli,
gzip, HEAD, 304, 206 relayé, corps trop long/trop court) ; les routes en clair sans `boot.mjs` ; aucune écriture
de `Content-Encoding`/`Content-Length` dans `src/app` et `src/lib`. `compression-reelle.spec.ts`, sauté sans
build, par `tools/compression-reelle/run.sh` : `next build`, `boot.mjs` sur la sortie standalone, DATA_DIR
jetable, faux Jellyfin, session créée par le code de l'application ; il échoue sur l'arbre du 05/11 construit
avec 16.4.5 (JSON illisible, liste HLS sans codage, 206 sans longueur) et passe avec ce changement. À lancer
avant toute montée de Next.

## 132. Le TrueHD décodé dans un worker, par le même code que le fil principal (06/11/2026)

**Règle.** Le décodage d'un lot de TrueHD n'existe qu'une fois : `decodeBlocks` (et `closeDecoder`),
dans `src/lib/webcodecs/truehd/truehdWorker.mjs`. Le worker exécute ce fichier tel quel ; le fil
principal l'importe. Un worker par page, partagé par les décodeurs ouverts, terminé 10 s après la
fermeture du dernier ; s'il ne peut pas naître, le décodeur s'ouvre sur le fil principal comme avant, et
la page s'en souvient.

**Porteur.** `truehdWorker.mjs` (`decodeBlocks`, `closeDecoder`, `serveTrueHd`) ;
`truehdDecoder.ts` (`openTrueHdDecoder` : le worker, ses transferts, son repli ; `absoluteHref`).

**Appelants.** `TrueHdCore` (fil principal, Node) et `serveTrueHd` (worker) pour le décodage ;
`truehdAudio.ts` pour `openTrueHdDecoder` ; `softwareAudio.ts` → `takeTrueHdThread` →
`trueHdThreadFacts` (`nativeHostHelpers.ts`) pour la ligne `start` (`truehdThread`, `truehdWorkerError`).

**Tests.** `webcodecs-truehd-worker.test.ts` (au bit près contre le fil principal, saut et blocs refusés
compris ; ordre des réponses en vol ; blocs du cache jamais détachés ; un seul worker, terminé ; replis :
constructeur refusé, worker qui ne démarre pas, muet 20 s, perdu en cours de film ; adresses complètes ;
forme du lancement). Bancs : `ffmpeg-wasm-regress-bench.spec.ts` et `truehd-bench.spec.ts` avec
`FFW_WORKER=1` / `THD_WORKER=1` (`src/__tests__/helpers/nodeWebWorker.ts` exécute le fichier du navigateur
dans un fil `worker_threads`, le module en ligne `blob:` compris).

**Ce qui diffère exprès.** Sur le fil principal, chaque lot est suivi d'un retour au navigateur
(`yieldToBrowser`) ; dans le worker, la réponse est elle-même une tâche, rien à céder. Les lots gardent
leur quart de seconde des deux côtés : les morceaux livrés (`contiguousAudio`) restent les mêmes.

**Pourquoi un module en ligne et pas `new Worker(new URL(...))`.** Turbopack (Next 16.4.3) reconnaît
cette forme, même au travers d'une variable, et en fait un worker à lui : le fichier recompilé dans ses
morceaux, `importScripts` dans un worker classique (`type: "module"` retiré), modules évalués après une
attente. Lu dans `.next/static` le 06/11/2026. Le module en ligne importe la copie conforme que le build
pose dans `static/media` (SHA-256 identique à la source, vérifié). Et `new URL(..., import.meta.url)`
devient chez Turbopack un objet au `href` relatif : sans `absoluteHref`, un module `blob:` ne trouve
rien — premier essai Firefox sur l'instance du banc : repli sur le fil principal, noté
`truehdWorkerError: "le worker n'a pas démarré"`, ce qui a aussi prouvé le repli.

**Mesuré.** Identité : ffmpeg-wasm-regress-bench sur les 59 fichiers TrueHD de la bibliothèque (68 pistes, 272 fenêtres), chaque
fenêtre de 60 s (0 s, 40 %, 75 %, décodeur neuf à 40 %) au même SHA-256 sur les deux chemins ;
truehd-bench contre `ffmpeg astats` (FFmpeg de Jellyfin) identique à 0,01 dB, worker ou non (Top Gun
Maverick 7.1, Braveheart 7.1, Gattaca 5.1, à 600 s) ; dans Chromium 153, Firefox 155 et WebKit 26.6,
sous la CSP de production, le worker tel que la page le lance rend sur la fixture stéréo l'empreinte de
Node. Coût retiré du fil principal : le décodage seul prend dans Node 1,07–1,10 s par minute de 7.1
Atmos (4,5 ms par lot, 9 au pire) et 0,67 s par minute de 5.1, sur le serveur — plusieurs fois plus
sur un téléphone. Dans Chromium (The Duchess, TrueHD 5.1 → Opus, 3 × 60 s par build) : `TaskDuration`
du fil principal 3,92 s → 3,37 s par minute (−14 %), sonde de retard 58,7 → 49,2 ms/s. Dans Firefox
headless (Braveheart 4K, The Duchess), aucune différence lisible : ~180–200 ms/s et ~50–60 tâches de
plus de 50 ms par minute des deux côtés, le fil principal de Firefox sans GPU étant occupé par autre
chose. Sur iPhone, non mesuré ici.

## 133. L'interface décidée avant le premier dessin, et l'écran de lancement en forme d'accueil (06/11/2026)

**Règle.** Tactile ou ordinateur se décide par une seule règle, `decideInterface`, sur les faits que lit
`readInterfaceFacts` (`src/lib/interfaceDecision.ts`) — un écran étroit, le choix Compte → Interface là
où il est proposé, l'appareil touché, la Fire TV, le simulateur d'iPad. Le crochet `useIsMobile` les
appelle ; le layout du cinéma les envoie dans le HTML, sérialisées par `toString()`, dans un script qui
pose `<html data-ui="touch|desktop">` avant le premier dessin. Ce que le serveur rend pour les deux
interfaces porte `data-ui-only`, et `globals.css` (« La marque de l'interface ») cache l'autre et pose
`--player-rail` / `--player-bar-space` jusqu'à ce que `PlayerShell` le fasse. Les deux fonctions ne
lisent rien hors de leurs paramètres : sérialisées, elles n'emportent pas leur module.

**Porteur.** `interfaceDecision.ts` (`readInterfaceFacts`, `decideInterface`, `interfaceMarkScript`) ;
`useHydrated.ts` ; `HomeSkeleton.tsx` (`DesktopHomeSkeleton`, `MobileHomeSkeleton`,
`MobileHomeSkeletonBody`, `HomeSkeletons`, et les mesures partagées avec les accueils : part de la
bannière, largeurs des cartes, fondu des bords).

**Appelants.** `useIsMobile` / `canChooseInterface` ; `(player)/layout.tsx` (le script, après celui du
simulateur) ; `PlayerShell` (les deux navigations pendant l'hydratation, puis la seule utile dans la
même enveloppe ; la marque tenue à jour) ; `(player)/page.tsx` (`LoadingScreen`) ; `CinemaClient` et
`CinemaMobileClient` (leur propre attente de catalogue, et les mesures).

**Tests.** `interface-mark.test.tsx` (le script exécuté seul contre le crochet : téléphone, iPad
automatique / Tactile / Ordinateur, ordinateur, PC tactile, Fire TV, simulateur ; HTML serveur sous la
marque : ni rail ni squelette du bureau sur un téléphone, réserves justes ; hydratation sans désaccord ;
valeurs du CSS égales à `RAIL_WIDTH` / `BAR_SPACE`) ; `interface-choice.test.tsx` ;
`decisions-partagees.test.ts` (une seule part de bannière).

**Ce qui diffère exprès.** Sous le simulateur d'iPad, l'écran n'est jamais « étroit » : la méta
`viewport` vient d'être réécrite à 1 180 px et `matchMedia` peut ne pas l'avoir vue au moment du script
— le crochet, plus tard, y trouve la même réponse. Sans marque (script en échec, ou une navigation
client depuis la gestion, où un script inséré ne s'exécute pas), le CSS montre l'interface ordinateur
comme avant, et `PlayerShell` pose la marque dans son effet de mise en page, avant la peinture. Les
accueils n'ont plus de fondu d'entrée sur leur cadre : le squelette de lancement est déjà là, et un
fondu depuis le noir l'effaçait d'abord ; la bannière et les rangées gardent le leur. L'écran de
lancement passe au rang de l'accueil (45, sous la navigation), et non plus au-dessus de tout (200).

## 134. Au retour au premier plan, la version d'abord (06/11/2026)

**Règle.** Au passage d'une page à « visible », la question de version (`BuildRefresh`, `/api/version`)
part seule ; ce que le retour déclenche sur le réseau attend sa réponse. Même build, réponse en échec
ou absente au bout de 1,5 s : tout part, comme avant. Nouveau build et `reloadIfSafe` recharge : rien ne
part (sauf si la page est encore là 15 s plus tard — rechargement raté). Nouveau build sans rechargement
permis : tout part. La porte n'est armée que si un rechargement était possible au retour (`mayReloadNow`
au moment de l'armer) : un film ouvert, même réduit, un banc, un texte en cours — rien n'attend, et le
lecteur n'attend jamais. Relevé du 06/11/2026 à 07:20 : un iPhone revenu après un déploiement relisait
les deux catalogues, « Reprendre », « À suivre », Ma liste… sur l'ancienne page, puis se rechargeait et
redemandait tout — 141 requêtes en 8 s, le catalogue téléchargé deux fois.

**Ordre.** La porte s'arme dans un écouteur `visibilitychange` en capture sur `window` : l'événement
vise le `document`, la phase de capture passe par `window` avant lui, donc avant tout écouteur du
`document` (SWR, les crochets, `BuildRefresh`), quel que soit leur ordre d'inscription.

**Porteur.** `src/lib/foregroundGate.ts` (`enableForegroundGate`, `foregroundHeld`,
`currentForegroundReturn` / `settleForegroundReturn`, `afterForegroundCheck`, `onForegroundRelease`).

**Appelants.** `BuildRefresh` (branche la porte, la règle par sa réponse — `reloadIfSafe` dit s'il
recharge) ; `SWRProvider` — SWR n'a pas de crochet pour différer sa relecture au focus (`initFocus`
n'est lu que pour un `provider` neuf, qui serait un second cache) : son `isVisible` répond faux tant
que la porte est fermée, ce qui saute la relecture au focus, la reconnexion et les tours de sondage
(dont `useMaintenance`), et `ForegroundReplay` rejoue la relecture au focus de chaque clé montée (et la
reconnexion si `online` est arrivé entre-temps) à l'ouverture ; par `afterForegroundCheck` :
`useCatalogueRefresh` (retour et focus), `useFreshPersonalLists`, `PresencePinger` (le retour ; le
départ reste immédiat), `SSENotifier` (titres des demandes), `useResumeCache`, `imageRetry`,
`OfflineDownloadsButton`, `OfflineEntryScreen`.

**Tests.** `foregroundGate.test.ts` (armée avant un écouteur inscrit plus tôt ; même build ; recharge ;
délai ; rechargement impossible ; sans porte ; retour à l'arrière-plan et réponse périmée) ;
`foreground-version-first.test.tsx` (vrais `SWRProvider`, `BuildRefresh` et `useCatalogueRefresh` :
témoin sans porte, même build → « Reprendre » et catalogue après la réponse, nouveau build → rien avant
le rechargement).

**Ce qui diffère exprès.** Hors de la porte : le lecteur et tout ce qui vit pendant un film (battement,
journaux, réserve, réveil), `clearDeliveredNotifications` (pas de réseau), la mesure de hauteur
(`viewportWatch`), les séances de lecture des livres (le cadre ne monte pas `BuildRefresh`, la porte n'y
est jamais armée). Le focus seul, sans changement de visibilité (un ordinateur qui revient d'une autre
application), n'arme rien : `BuildRefresh` ne pose la question qu'au retour de visibilité. `pageshow`
non plus : `BuildRefresh` ne l'écoute pas. Un tour de sondage sauté pendant la porte n'est pas rejoué.

## 135. La recherche par description : le modèle reconnaît, TMDB décide (07/11/2026)

*Amendé le 09/11/2026 (§140) : aussi chez OpenAI et Google (même prompt, même schéma, leur modèle rapide),
comptée dans le plafond mensuel commun ; atteint, elle n'est plus proposée.*

**Règle.** Une frappe qui décrit un titre (`looksLikeDescription` : quatre mots dont un mot repère des
quatre langues, ou sept mots) part, après 600 ms d'arrêt, à `/api/search/describe`. Claude Haiku y rend
des titres (anglais, original, année, film ou série) dans un schéma JSON imposé ; chacun n'est gardé que
si TMDB a ce titre à un an près (`pickTmdbMatch` — sinon le premier résultat s'il est exactement de
l'année), et devient une carte de recherche ordinaire (`makeEntry`, même règle bibliothèque / à demander
que `/api/search`). Rien de ce que le modèle écrit n'est montré. Les tags bloqués du compte sont retirés
après le cache (§54). Option coupée par défaut (`DESCRIBE_SEARCH_ENABLED`), Anthropic seulement, avec la
clé des sous-titres générés (§69) ; Haiku toujours, quel que soit le modèle réglé pour les sous-titres.

**Pourquoi ce prompt.** Banc du 07/11/2026 : 48 descriptions en quatre langues (intrigue, acteur,
souvenirs flous, détails faux, fautes, demandes larges), trois prompts. Tous trouvent les descriptions
nettes ; celui retenu ne rend que le bon titre quand la description en désigne un. 46/48 sur les cas
durs, ~0,9 s médian, ~1,3 s au 90e centile, moins d'un dixième de centime par phrase.

**Écran.** Une section à part au-dessus de la grille, dans la même grille qu'elle (`DescribedResults`) :
une ligne de squelettes à la taille des cartes pendant l'attente, « Encore un instant… » passé 3 s, puis
les cartes. Une rangée qui défilait de côté a été retirée le jour même : affiches de tailles inégales sur
iPhone, et « Tout 7 » au-dessus de trois cartes visibles. Ce que la grille montre déjà dans ses six
premières cartes n'y est pas répété ; vide, la section s'en va. Les titres trouvés comptent dans les
puces. Un échec ne se dit pas : la recherche ordinaire est là. Pas de « Rien trouvé » tant que la
description est en route.

**Porteurs.** `src/lib/describeSearch.ts` (appel, lecture défiante `parseDescribed`, `pickTmdbMatch`,
`findOnTmdb`, cache disque une semaine par phrase normalisée, TMDB un jour par langue) ;
`src/lib/describeQuery.ts` (`looksLikeDescription`, `describeKey` — partagés par l'écran et la route) ;
`src/lib/useDescribeSearch.ts` ; `src/lib/searchLibraryIndex.ts` (déplacé de `/api/search` pour n'avoir
qu'une règle). Borne : 30 phrases par minute et par compte.
Journal : une ligne par phrase dans `recherche.log` (`logDescribeSearch`, `eventLogs.ts`) — compte,
appareil, nombre de mots, délai, cache ou modèle, résultats ; jamais la phrase elle-même.

**Tests.** `describe-search.test.ts` (déclenchement, lecture du modèle, correspondance TMDB, route :
coupée, titre tapé, bibliothèque / à demander, titre inventé écarté, tag bloqué, échec) ;
`player-search-describe.test.tsx` (squelettes puis cartes, pas de doublon, abandon à la frappe, rangée
vide retirée, option coupée).

**Ce qui diffère exprès.** Seule la recherche du cinéma l'a ; celle de la gestion non. Pas sous les puces
Personnes, Livres, Répliques.

## 136. L'Activité en tableau de bord : n'alerter que sur ce qui a vraiment gêné (07/11/2026)

**La règle.** Un incident que le lecteur a traité comme prévu n'est pas un problème : il est compté
(« gérés seuls »), jamais mis dans « À gérer », ni dans le diagnostic « fichier ou appareil », ni dans les
problèmes d'un compte ou d'un jour. Sont gérés : une ou deux reconstructions dans une séance sans repli ni
erreur (`recovered`, `RECOVERED_MAX`), un passage au lecteur serveur annoncé par le refus d'emblée du chemin
natif (`planned`, `isPlannedHandoff` — « Aucun chemin de lecture disponible… », hors zone illisible), une
bascule sur la version allégée (`slowLinks`, §77–§78) et un retour d'arrière-plan (`backgroundRebuilds`).
Restent des problèmes : erreurs, replis non prévus, blocages, trois reconstructions ou plus, relances
d'échelle du lecteur serveur, défauts du fichier.

**Porteurs.** `buildSeances` / `finish` (`seances.ts`) classent ; `failuresOf` (`diagnosis.ts`) est la seule
définition d'un vrai incident, `problemsOf` la reprend, `handledOf` compte le reste (`accounts.ts`).
`dashboard.ts` (`periodStats`, `dashboard`, `describeStats`) donne les chiffres de 24 h, 7 et 30 jours, la
courbe des heures regardées, l'heure de la journée et la recherche par description. Les séances des 31
derniers jours ne se construisent qu'une fois tant que le journal du lecteur ne bouge pas
(`seancesSince`, sur `globalThis` avec le cache des journaux, préparées 20 s après le démarrage).

**L'écran.** `ActivityOverview` reste monté sous les autres vues (`PlayerActivityPanel`) : revenir d'une
fiche ne reconstruit rien, la hauteur de chaque vue est gardée. `ActivityLink` précharge la fiche d'un
compte ou d'une séance au survol et à l'appui. Les sections secondaires sont repliées (`Fold`), le
changement d'adresse (§119) est derrière un bouton en bas de page.

**Tests.** `activity-dashboard.test.ts` ; `activity-core`, `activity-alerts-cleared`,
`activity-connexion-lente` suivent la règle.

Un blocage que le diagnostic du lecteur impute au réseau du spectateur (`netStalls` : verdict
`réseau`, lien `trop lente`, hors ligne) est géré lui aussi. Côté serveur, seules les lignes `error`
alertent (`isAlarmingServerLine`) : ni un avertissement (une relance, un 503 de Google Books), ni un EPUB
illisible (`EpubDefectError`).

**Effacer.** « Effacer les alertes » est définitif et vaut pour toutes les périodes — 24 h, 7 et 30
jours, « Tout » (`allTimeSignals(now, clearedAt)`, `withoutIncidents`) : les incidents d'avant sortent
des tableaux et des chiffres, les séances et le temps regardé restent, les journaux ne sont jamais
touchés. « Réafficher » est retiré. Chaque ligne de « À gérer » s'efface aussi à part
(`dismissIssue`, une date par clé) et revient avec un nouvel événement.

**L'historique.** « Tout » garde le temps par compte jour par jour (`byUser`, `TALLY_VERSION` 2) ; la
fiche d'un compte lit tous les journaux (`ACCOUNT_HISTORY_DAYS = null`, c'était 90 jours). Le journal
du lecteur garde 120 archives de 5 Mo (deux mois en remplissaient quatre à l'automne 2026).

**Ajouts du 07/11/2026 (10.17.0).** Chaque chiffre clé dit son écart avec la période d'avant
(`previous`, fenêtre de séances portée à 61 jours) ; la courbe des heures porte un trait par version
apparue (`releasesSince`, d'après le `version` des lignes du lecteur). L'ouverture se lit par origine
(`openDeviceMs` / `openNetworkMs`, d'après `openedFrom`), et « Qui regarde » donne le débit habituel de
chacun (`linkMbps` / `needMbps` du bilan), en ambre seulement sous celui de ses fichiers. Toucher une
barre, une heure, un appareil, un titre, un chemin ou un compte filtre le fil des séances
(`/api/admin/activity/feed`, `feedOf`). « En direct » dit le client — Laterna et son chemin
(`pathOfPlay`), ou l'autre client que Jellyfin voit — au lieu du « DirectPlay » de Jellyfin. Les comptes
sans activité de la semaine sont repliés.

**Ajouts du 07/11/2026 (10.18.0).** La courbe des heures remonte tout l'historique, trente jours par
trente jours (`historySeries`, `/api/admin/activity/series`, jours gardés en base). Toucher une barre ou
une ligne la choisit sans faire bouger la page : une barre de filtre flottante (`FilterBar`) dit le choix
et le nombre de séances, et y mène ; elle se cache quand le fil est à l'écran. La fiche d'un compte a le
même sélecteur 24 h / 7 jours / 30 jours / Tout et les mêmes chiffres (`accountPeriods`, `KpiRow`
partagé). En direct, Laterna n'ajoute son chemin que s'il n'est pas le lecteur de l'application.

**Habitudes (07/11/2026, 10.19.0).** Un encadré à quatre onglets suit la période choisie : menées au
bout (`completion` — `ended` ou `why: next`, titres quittés avant dix minutes plus d'une fois), séries
en cours par spectateur (dernier épisode, épisodes et rythme), d'où viennent les octets (`reads`,
`diag.read*MB` du bilan : réserve en mémoire, appareil, réseau) et les demandes (`requestStats` :
Jellyseerr, trente jours, gardé cinq minutes) — arrivées, regardées par leur auteur et le délai médian,
une demande et une séance se rejoignant par TMDB (fiche Jellyfin du film, série de l'épisode), jamais
par le titre. Les pistes audio et sous-titres ne sont pas comptées : le journal ne note que le rang de
la piste, pas sa langue.

**Ordre et compléments (07/11/2026, 10.20.0).** De haut en bas : en direct, « À gérer » (avec
« Effacer les alertes » dans son en-tête), la période et ses habitudes, les courbes, le fil des
séances, puis les répartitions, les comptes et le détail replié. « Menées au bout » remplace « gérés
seuls » parmi les six chiffres ; « Sans accroc » dit le taux depuis la plus récente version qui a dix
séances (`sinceVersionOf`, `version` de la séance). La fiche d'un compte a ses habitudes, ses demandes
(`requestsOfUser`, sur le bilan des demandes gardé cinq minutes) et ses deux courbes (`accountCharts`).

**Revue du 08/11/2026 (10.21.0).** Parcourue dans un vrai navigateur (téléphone et ordinateur) sur une
instance jetable, chiffres recomptés à part dans les journaux (338 séances, 12 spectateurs, 260 bilans :
justes). Corrigé : « lu d'avance » au lieu de « hors du réseau » (la réserve vient aussi du réseau,
d'avance) ; les demandes suivent la période, liste dépliable ; « menées au bout » compte aussi un arrêt
après 90 % de la durée (`isFinished`, durées lues chez Jellyfin, `ensureRuntimes`) ; les attentes ne
sont plus effacées avec les alertes (une mesure, pas une erreur) ; `books/meta` hors des alertes par sa
portée (le lecteur des journaux retire `stack`) ; plus de traits de version sur la courbe (une version
presque chaque jour) ; l'écart sous le chiffre ; « 0 min » au lieu de « 0 » ; une seule étiquette pour
le lecteur serveur prévu ; légendes et pluriels.

## 137. « Précédemment » : les derniers faits vus, préparés en fond (08/11/2026)

*Amendé le 09/11/2026 (§140) : aussi chez OpenAI et Google (réflexion « moyenne » transposée), compté dans le
plafond mensuel commun ; atteint, rien de nouveau n'est préparé, les textes prêts restent lus.*

**Règle** (le propriétaire, 08/11/2026, après trois versions le même jour). Sur la fiche d'une série en cours,
« Précédemment : … » remplace le synopsis, avec un lien discret « Voir le synopsis de la série » (et, de
là, « Voir le résumé des épisodes précédents ») ; chaque ouverture de la fiche repart sur « Précédemment ».
Option de l'installation coupée par défaut (`RECAP_ENABLED`), Anthropic seulement, clé des sous-titres
générés (§69), Haiku toujours ; chaque compte peut la couper dans Compte → Interface
(`user_preferences.show_recap`) — coupée, rien n'est ni affiché ni préparé pour lui.

**Quel endroit.** Les douze séries les plus récentes de « À suivre » du compte (`/Shows/NextUp`, avec
`NextUpDateCutoff` à trente jours) : l'épisode que Jellyfin propose ensuite, et la tranche de dix minutes
où le compte s'est arrêté (`recapStep` ; avant deux minutes, l'épisode n'est pas commencé).

**Ce qui s'affiche, selon l'endroit.**
- Aucun épisode fini : rien, le synopsis (`aucun`) — sans résumé officiel où s'appuyer, des dialogues
  seuls sont trop risqués.
- Un épisode fini, et pas de dialogues (le suivant pas commencé, ou sans sous-titres texte) : son résumé
  Jellyfin tel quel, sans modèle (`officiel`), avec « Résumé de l'épisode S01E01 » au lieu de la mention IA.
- Sinon, un texte du modèle, avec « Généré par IA à partir de ce que vous avez déjà vu » : au milieu d'un
  épisode, le résumé officiel du dernier épisode fini et les dialogues des dix minutes avant l'arrêt
  (piste texte non forcée de la langue du compte, sinon pour malentendants, sinon l'anglais —
  `pickSubtitleStream`) ; au début d'un épisode, les résumés des deux derniers épisodes finis, dans
  l'ordre de l'histoire. **Jamais le résumé de l'épisode en cours** : il raconte la suite.

**Quand.** Une tâche de fond (`startRecapCron`, toutes les 5 min, une minute après le démarrage) prend
les comptes du foyer qui se servent de Laterna (`jellyfin.getUsers`, sans les liens de partage, avec une
session vivante — `sessionDb.activeUsers`, vue depuis moins de sept jours : le compte de la télé, qui ne
passe que par d'autres applications, recevait des textes que personne ne lirait), dans la langue de chacun
(`user_preferences.lang`, sinon celle de l'installation) — sans attendre qu'ils ouvrent l'application : la
première version l'attendait, pour apprendre la langue, et ne préparait rien avant leur retour.
Une série n'est préparée que trois heures après son dernier visionnage (`RECAP_IDLE_MS`, `LastPlayedDate`
— dix minutes pendant quelques heures le 08/11/2026, revenu à trois heures le soir même : le texte sert
après une vraie pause, pas entre deux épisodes enchaînés) **et** si personne ne la regarde sur ce compte (`/Sessions`, pause comprise, télé comprise) : sa position
avance en continu, et Jellyfin ne date parfois une lecture qu'à son début. La tâche tourne pendant les
films des autres (la première version attendait que plus rien ne joue nulle part, et n'a jamais tourné).
Douze textes au plus par passage, un à la fois ; arrêt au premier refus de débit ou à la première panne.

**Réactif.** Avancer d'une tranche de dix minutes, ou d'un épisode, demande un nouveau texte ; le modèle
reçoit celui que **ce compte** avait plus tôt dans l'histoire (`recap_progress`) et le garde tel quel
(`inchange`) si rien d'important n'est arrivé. Jamais le texte d'un autre compte, qui peut être plus loin ;
jamais celui d'avant un retour en arrière. Un texte par épisode, tranche et langue (`recapKey`, table
`series_recaps`), partagé par les comptes arrêtés au même endroit ; rejets, réponses vides et « rien à
dire » gardés aussi, pour ne pas redemander ; effacés après trente jours.

**Pourquoi ces garde-fous.** Bancs du 08/11/2026 (Haiku, une requête à la fois) : quatre séries à une
position fixée, dix puis onze séries réellement en cours. Les dialogues ne disent pas qui parle : avec tout
le début de l'épisode, le modèle prêtait des répliques au mauvais personnage ; avec dix minutes et « faits
nets seulement », beaucoup moins. **Réflexion adaptative, effort moyen** : sans réflexion, des actes prêtés
au mauvais personnage dans 4 séries sur 11 (« Nate a passé la nuit avec Canaille ») et la fausse publicité
de *The Boys* saison 5 recopiée ; en effort moyen, une erreur de lieu sur 22 textes et *The Boys* laissé
vide ; l'effort haut ne fait pas mieux (~8 s et ~0,001 $ le texte, en fond). Le modèle sort des noms de sa
mémoire (« Baelish », « Torfes ») : tout nom absent des sources rejette la réponse (`unknownNames` — mots
à majuscule hors début de phrase, plus les noms qu'il déclare dans `noms`, faute de quoi « Sansa » en tête
de phrase échappait) ; un rejet laisse le synopsis. La longueur demandée n'est pas tenue : coupée à trois
phrases et 80 mots (`judgeRecap`), qui retire aussi « Dans S02E04, … ». La structure du prompt suit
l'ordre de l'histoire : la première disait « le dernier épisode, puis l'avant-dernier », et au début d'un
épisode les deux faits sortaient à l'envers. Les pistes pour malentendants n'ont pas fait mieux en moyenne.

**Affiché après la même pause.** `readyRecapsFor` ne rend pas le texte d'une série regardée il y a moins
de trois heures (`lastPlayedBySeries`, une requête pour toutes) : la fiche montre son synopsis — sans
quoi un texte prêt restait affiché après une reprise de cinq minutes, tant que la tranche ne changeait pas.

**Usage mesuré.** Au journal des ouvertures (`startup.log`, `kind: "précédemment"`, `logRecapView`) :
`affiché` à chaque ouverture d'une fiche qui le montre (série, épisode, `ia` ou `officiel`, `idleMin` —
depuis quand la série n'a pas été regardée), `synopsis` quand on lui préfère le synopsis. Route
`/api/cinema/recaps/event`, 30 lignes par minute et par compte ; jamais le texte.

**Écran.** `useSeriesRecap` lit `/api/cinema/recaps` (tous les textes prêts du compte, une requête,
relue au plus toutes les dix minutes, à l'ouverture d'une fiche ou au retour au premier plan, et tout de
suite quand le réglage change) ; `SeriesRecap` l'affiche avec le synopsis de la fiche en enfant. Les deux
fiches de série — `CinemaSeriesDetail` et `CinemaMobileDetail` — passent par ces deux-là et nulle part
ailleurs. Le réglage du compte : `useShowRecap.ts`, montré seulement si `recapAvailable` (configuration
publique).

**Porteurs.** `src/lib/recap/core.ts` (tranche, clé, SRT, piste, sources, prompt, schéma, jugement) ;
`src/lib/recap/service.ts` (Jellyfin, modèle, `prepareRecap`, `runRecapPass`, `readyRecapsFor`) ;
`recapDb`, `userPrefsDb.getShowRecap` (`db.ts`) ; `src/app/api/cinema/recaps/route.ts` (hors de la liste
fermée des liens de partage, §112). Journal : une ligne par texte dans `recherche.log` (`logRecap`,
`kind: "précédemment"` — compte, série, épisode, minute, `dialogues` ou `résumés`, verdict `ok` / `gardé`
/ `officiel` / `rejeté` / `vide` / `erreur` / `limite`, jetons, noms rejetés ; jamais le texte), une ligne
`[tâche] précédemment` par passage qui a fait quelque chose.

**Tests.** `recap-core.test.ts` (tranches, fenêtre de dialogues, rien après l'arrêt, résumés au début,
SRT, choix de piste, noms inconnus en tête et en milieu de phrase, « inchangé », texte précédent parmi les
sources, coupe, réponse vide) ; `recap-service.test.ts` (dix minutes, aucun épisode fini, résumé officiel
tel quel, préparé une fois, jamais le résumé de l'épisode en cours, langue du compte, réglage coupé, rejet
gardé, texte précédent gardé et jamais celui d'un autre compte, refus de débit).

**Limites connues.** Le fait retenu n'est pas toujours le plus marquant de la scène. Un compte dans une
autre langue que celle des résumés de Jellyfin voit plus de rejets : un nom traduit n'est pas dans les
sources. La diarisation des voix et des sources plus riches (Wikipédia, Fandom) ont été écartées pour
l'instant : la première donne des voix anonymes sur un son difficile, les secondes ne servent qu'aux
épisodes finis, en anglais surtout.

## 138. Les acteurs à l'écran : un service à part, commandé par la séance qui commence (09/11/2026)

*Amendé le 09/11/2026 (§140) : les questions sur une personne (`ASK_PERSON_ENABLED`) et « Jusqu'ici »
(`SOFAR_ENABLED`) ont chacune leur réglage et demandent les acteurs à l'écran ; sans elles, le panneau d'une
personne ne montre que ses faits TMDB. La carte des réglages renvoie au guide de déploiement du service.*

**État en 10.30.1** (résumé ; la règle, puis l'historique version par version, suivent — un paragraphe daté
peut décrire une forme remplacée depuis, il le dit).
- **Le service** `laterna-xray` dit qui est à l'image **et, depuis 10.30, qui parle**, scène par scène
  (contrat v1 et ses ajouts compatibles : `xray/README.md`). Gratuit, local, coupé par défaut ; public
  `off` / `admins` / `tous` (`XRAY_ENABLED`).
- **Commandé** par la ligne `start` du journal du lecteur (l'élément en `high`, l'épisode suivant en
  `normal`) **et** par le planificateur de la bibliothèque : palier 0 (liste de priorité de
  l'administrateur), 1 (ce qui se regarde), 2 (arrivées des quatorze derniers jours), 3 (le reste) ; **le
  scan continue pendant une lecture** depuis le 10/11/2026 (`scanWaitsForPlayback` : il ne gêne qu'un
  transcodage, et la priorité suffit — l'iGPU rendu à Jellyfin, ordres en `low`, `cpu_shares` du conteneur
  sous ceux de Jellyfin) ; `XRAY_SCAN_DURING_PLAYBACK=false` rétablit l'attente (rien de neuf pendant une
  lecture sauf palier forcé ou palier 0) ; dossiers permis seulement
  (`XRAY_LIBRARY_ROOTS`) ; animation écartée ; un fichier remplacé à durée égale rattaché sans
  réanalyse ; les épisodes dans l'ordre de la série, et une série finie renommée une fois.
- **La rangée « À l'écran »** du lecteur : **avec les commandes, en lecture comme en pause** (10.27),
  au-dessus du titre, aussi loin que possible à droite (10.27.1), pilules compactes, au début à chaque scène,
  jamais déplacée sous un doigt, commandes tenues pendant le geste (10.27.2) ; un voile au bord droit, plus
  de masque (10.29.1, WebKit) ; les pilules gonflent à l'appui comme les autres pilules du lecteur ; le bouton
  rond « Poser une question » au bout, seul quand personne n'est reconnu. Ni sur Fire TV, ni au lecteur hors
  ligne, ni pendant une diffusion, ni au mini-lecteur.
- **Le panneau d'une personne** : photo, acteur, personnage, faits TMDB (âge, lieu), courte biographie (sans
  Markdown, 10.29.2), « Dans votre bibliothèque » (affiches inertes ; jamais pour un lien de partage) ; avec
  leurs réglages, « Jusqu'ici » et au plus deux liens entre personnages de la scène — **aucun champ libre**
  (10.29.2, §139).
- **La qualité des noms** (Configuration → Acteurs à l'écran) et « Réinitialiser la mémoire » d'une série
  (10.30) ; le relevé `kind: "xray-ui"` dans `startup.log` (10.29.1).

**Règle.** L'analyse des acteurs présents à l'image, scène par scène, est faite par un service à part,
`laterna-xray` (son code et son installation : `xray/README.md`), que Laterna commande et lit par un
contrat fixé des deux côtés (v1 : `GET /health`, `POST /jobs`, `GET /items/{id}`, `GET /items/{id}/scenes`,
`DELETE /items/{id}`, une clé en `Authorization: Bearer`). Une option de l'installation, **coupée par
défaut** (`XRAY_ENABLED`), avec son adresse (`XRAY_URL`, `http://laterna-xray:8000`) et sa clé
(`XRAY_API_KEY`) : Configuration → Connexions, carte « Acteurs à l'écran », comme les autres services
(réglage → `.env` → défaut, relus à chaque appel, §48) — depuis le 10/11/2026 (§142), Connexions ne
garde que l'adresse et la clé, et le public se règle dans Fonctions intelligentes → Acteurs à l'écran. « Tester la connexion » lit `/health` et dit le
modèle, s'il est prêt (il se télécharge au premier lancement du service) et si le décodage matériel est
disponible (`testService`, `XrayFacts`). Sans les trois — allumée, une adresse, une clé —
(`xrayConfigured`), rien ne part vers le service et rien n'est lu. L'écran qui les montre : la rangée
« À l'écran » du lecteur (10.26, plus bas).

**Pour qui : `off` / `admins` / `tous`** (09/11/2026, consigne du propriétaire : expérimental, d'abord pour
les administrateurs seuls). `XRAY_ENABLED` est désormais un public, `off` par défaut ; `true` et `false`
d'avant valent `tous` et `off` (`parseAudience`), sans rien réécrire. `config.xray.enabled` veut dire « pas
`off` » (le service est branché pour quelqu'un : `xrayConfigured`, le Tester). Réglé sur `admins`
(`xrayOpenTo(session)`, la règle partagée `audienceAllows` de `src/lib/featureAudience.ts`, la même que
« Poser une question », §139) : `/api/player/xray/[itemId]` répond `status: "off"` à tout autre compte, avant
toute lecture ; et seule une ligne `start` d'une séance d'administrateur commande une analyse
(`/api/player/log`). Tests : `feature-audience.test.ts`, `xray-player-route.test.ts`, `xray-trigger.test.ts`.

**Le déclencheur : la ligne `start` du journal du lecteur.** `/api/player/log` reçoit un `start` des trois
lecteurs — le natif, celui du serveur (AirPlay compris) et le Chromecast —, avec l'élément (`itemId`) et la
position (`at`, la reprise pour le lecteur du serveur). Le rapport de lecture à Jellyfin
(`/api/jellyfin/playback/playing`) n'est envoyé que par le lecteur natif (le lecteur du serveur s'annonce
par sa négociation) : il aurait laissé de côté chaque séance confiée au serveur. Exclus : une ligne de banc
(`bench`, gardé pour l'administrateur seul), le lecteur hors ligne (le fichier est sur l'appareil), et pour
un lien de partage tout autre titre que le sien (`shareRefusal`). L'élément regardé part en priorité `high`
à partir de la position (`startAt`), puis l'épisode suivant de la série en `normal` (`nextEpisodeAfter` :
la règle de `nextEpisodeIn`, saison suivante, spéciaux entre eux, sur la liste du serveur). **Sans
attente** : la réponse du journal part avant, et rien ne remonte — `noteSessionStart` n'attend rien, un
échec va dans `server.log` (`logError`, `xray/order`, `xray/next`) et la configuration illisible vaut
« coupée ».

**Une commande par élément.** Un film reconstruit réécrit son `start`, chaque relance du lecteur du
serveur aussi : `orderAnalysis` garde chaque commande six heures (en mémoire, sur `globalThis` — la route
du journal et celle du banc ont chacune leur copie du module) et ne repasse que pour une priorité plus
haute ; un échec est retenté au bout de dix minutes, pas à la ligne suivante. Trente commandes neuves par
compte et par heure au plus (un client qui boucle ne fait pas tout analyser). Une ligne `[tâche]` par
vraie commande (`taskLog("acteurs", …)`) — pas pour « déjà fait au même fichier », ni pour un tour sans
rien.

**La commande.** `analysisTarget` (Jellyfin, clé du serveur, `getItemForAnalysis`, dix minutes en
mémoire) : le chemin du fichier tel que Jellyfin le voit (le service monte la médiathèque au même chemin,
en lecture seule), l'`ETag` de la source (sinon `size:<octets>`), la série, et le titre chez TMDB (le film,
ou la série — par TVDB si Jellyfin n'a que lui — avec saison et épisode). `castOf` : la distribution de
**cet** épisode (`/tv/{id}/season/{s}/episode/{e}/credits` : rôles crédités puis invités — et, si TMDB ne connaît
pas l'épisode (404 : une saison que TVDB rattache à la série et que TMDB range ailleurs), la distribution de toute la
série, `/tv/{id}/aggregate_credits`, sans les invités, 10/11/2026 ; toute autre erreur reste une erreur) ou du film
(`/movie/{id}/credits`), dans l'ordre du générique, une personne une fois (deux rôles joints), quarante au
plus. `castWithPhotos` : la photo principale puis les mieux notées de `/person/{id}/images`, huit au plus,
en adresses `https://image.tmdb.org/t/p/w185…` — les seules que le service accepte ; un album qui ne répond
pas laisse la photo principale. Projections seulement, sous des clés de consultation (`credits:xray:v1:…`,
`person:xray-photos:v1:…`, une semaine) que le ménage efface après quatorze jours et que la sauvegarde
laisse de côté. Sans distribution, rien n'est commandé.

**La lecture du lecteur : `GET /api/player/xray/[itemId]`** (`scenesForPlayer`). Les scènes du service,
chaque personne jointe à la distribution (nom, personnage, photo TMDB `w185` — l'adresse que le cinéma
affiche déjà pour la distribution) ; un visage nommé ailleurs dans la série et absent de la distribution de
cet épisode garde `name: null`. **Une absence attendue répond 200**, `scenes: []` et un `status` : `off`
(option coupée), `none` (rien), `queued` / `running` / `failed`, `stale` (le résultat d'un autre `ETag` :
le fichier a changé), `unavailable` (service injoignable, au journal). Jamais 404 : la route est appelée
par élément (CLAUDE.md, « An expected absence is never a 404 »). Le droit de voir l'élément est demandé à
Jellyfin sous l'identité du compte (`assertVisible` — tags bloqués §54, bibliothèques, contrôle parental) ;
caché, la route répond **exactement** `none`, comme un élément jamais analysé. Un lien de partage n'y lit
que son titre (`SHARE_RULES`, portée `path`, §112). Réponse `private, no-store`.

**Le banc : `/api/admin/xray`** — `GET` (l'état du service, et d'un élément avec `?itemId=`), `POST`
(`{ itemId, priority?, startAt? }`, commande en passant outre la mémoire). Administrateur seul : `adminOnly`
dans la route, `ADMIN_ONLY_READS` dans le proxy, et l'écriture hors de la liste blanche des comptes.

**Porteurs.** `src/lib/clients/xray.ts` (contrat, `xrayConfigured`, `xrayAuthHeaders`) ;
`src/lib/xray/cast.ts` (`analysisTarget`, `castOf`, `castWithPhotos`, `nextEpisodeAfter`) ;
`src/lib/xray/orders.ts` (`orderAnalysis`, `noteSessionStart`) ; `src/lib/xray/scenes.ts`
(`scenesForPlayer`) ; `tmdb.getEpisodeCredits` / `getMovieCredits`, `jellyfin.getItemForAnalysis`.
**Appelants.** `/api/player/log` (déclencheur), `/api/player/xray/[itemId]`, `/api/admin/xray`,
`testService` (Tester). **Tests.** `xray-client.test.ts` (contrat, Bearer, adresse relue, 404 = rien,
Tester, réglages), `xray-cast-fallback.test.ts` (repli sur la série), `xray-orders.test.ts` (commande, distribution invités compris, photos, mémoire, borne
par compte, panne, épisode suivant), `xray-player-route.test.ts` (200 partout, caché = `none`, `stale`,
jointure), `xray-proxy-admin.test.ts` (portes), `xray-trigger.test.ts` (la ligne `start`) ;
`share-gate.test.ts` parcourt la nouvelle route avec les autres.

**La rangée « À l'écran »** (10.26, 09/11/2026, maquette validée par le propriétaire ; **forme d'origine** — depuis
10.27 avec les commandes en lecture comme en pause, la question en bouton rond, pilules plus compactes, voile au
lieu du masque en 10.29.1 : plus bas). Film en pause, au-dessus
du titre, à gauche (la place de la pilule « Une question ? », `PROMPT_BOTTOM`) : une étiquette « À l'écran »
(11 px, capitales, espacement .16em, blanc 60 %) puis une rangée de pilules de verre (`player-pill`) qui
défile de côté — photo ronde TMDB (36 px, 32 sur un téléphone), nom de l'acteur (14/12 px, demi-gras),
personnage (12/11 px, blanc 60 %). **Toutes** les personnes nommées de la scène, par temps à l'écran
décroissant ; un visage sans nom (`name: null`) n'est pas montré. Aimantée sur chaque pilule, un fondu au
bord droit quand d'autres attendent (un masque, posé seulement alors — un voile à part depuis 10.29.1, plus bas) ; au
doigt on glisse, à la souris la molette verticale fait défiler de côté et deux petites flèches paraissent
(pointeur fin seulement). « Une question ? » reste au bout, hors de ce qui défile. Le fondu des commandes
(`player-fade`) est porté par chaque pilule, jamais par la rangée. Elle paraît et part avec les commandes,
en pause seulement ; jamais pendant une diffusion (`castActive`), au lecteur hors ligne (`xrayable={false}`),
au banc (`lab`), au mini-lecteur (les commandes n'y sont pas), ni pendant l'ouverture du film. Rien du
tout quand la scène n'a personne de nommé ou que l'option est coupée pour ce compte. Une photo absente ou
qui ne charge pas montre les initiales (`PersonAvatar`) ; l'adresse est celle que la route donne
(`image.tmdb.org` w185, permise par la CSP) — aucune route par personne, donc aucun 404 à craindre.

**Les données : une lecture par élément, rien à la pause.** `useXrayScenes` lit `/api/player/xray/{id}` à
l'ouverture de l'élément (et de l'épisode suivant), relit toutes les minutes tant que `status` vaut `queued`,
`running` ou `unavailable` — vingt minutes au plus depuis l'ouverture, jamais page cachée (la relecture
attend `visibilitychange`) —, s'arrête sur `done`, `off`, `none`, `failed`, `stale` (`xrayNextPoll`). La
scène de l'instant se cherche en mémoire (`sceneAt` : début compris, fin exclue) à chaque rendu en pause,
un saut en pause compris. **Seulement l'option allumée pour ce compte** : `xrayAvailable` de la configuration
publique (`xrayOpenTo(session) && xrayConfigured()`), **suivie, jamais demandée** (`followOnlyOptions`,
comme `askAvailable`) — absente des doubles des empreintes du lecteur, donc aucune requête de plus dans
aucun scénario : les empreintes ne changent pas. Une requête `fetch` directe, pas SWR (en pause pendant un
film, §SWR de CLAUDE.md).

**Une personne touchée ouvre « Poser une question »** (10.26 ; remplacé en 10.27, plus bas) avec l'en-tête du panneau rempli
(`AskPersonHeader` : photo, nom, personnage) et une seule question proposée, « Qui est <prénom du
personnage> ? » (`characterFirstName` : premier mot qui n'est pas un titre abrégé, sans ce qui suit une
barre ou une parenthèse ; sans personnage, les propositions d'office). La place sous l'en-tête
(`data-ask-person-more`) est gardée pour la biographie résumée de TMDB et « Jusqu'ici » — pas encore
faits. Sans l'option des questions, toucher une personne ne fait rien (la rangée reste une information).

**10.27 (09/11/2026, essai du propriétaire sur iPhone en application installée).**
- **Placement.** Couché, la rangée passait sous −10 / lecture / +10. Elle **mesure** maintenant le groupe du
  centre (`getBoundingClientRect`) et s'arrête 16 px avant son bord gauche quand elle partage sa hauteur
  (`onScreenRowWidth`), et se pose juste au-dessus du bloc du titre (`onScreenRowBottom`), relue à chaque
  changement de taille, de vue visuelle et de rotation (`useOnScreenPlacement`). Debout, toute la largeur.
  Pilules plus compactes : photo 32 px, nom 13 px (12 au téléphone), personnage 11 px, deux lignes.
- **Avec les commandes, en lecture comme en pause** — plus seulement en pause ; elle part avec elles. Elle
  suit les changements de scène (les nouveaux visages en fondu, `player-onscreen-in`, ceux qui partent
  s'effacent, `player-onscreen-out`) mais **jamais sous un doigt** : appuyée, défilée ou à la molette, elle
  garde ce qu'elle montre, et rattrape la scène 600 ms après le dernier signe (`ONSCREEN_SETTLE_MS`).
  Toujours aucune requête : la scène se cherche en mémoire.
- **La question : un bouton rond, icône seule** (`aria-label` « Poser une question »), au bout de la rangée,
  hors de ce qui défile ; seul quand personne n'est reconnu ; avec les commandes, en lecture et en pause,
  seulement si l'option des questions est ouverte à ce compte.
- **Le panneau d'une personne, indépendant du modèle.** Sans l'option des questions (ou sans clé), toucher
  une personne ouvre quand même son panneau : photo, acteur, personnage, une ligne de faits (« 50 ans ·
  London, Royaume-Uni » : `personFactsLine`, le pays traduit par `Intl.DisplayNames`, la ville telle que TMDB
  l'écrit), une courte biographie coupée à trois lignes, et « Dans votre bibliothèque » : deux ou trois
  affiches de ses autres titres **ouvrables** (pas celui qu'on regarde), tags bloqués appliqués, qui **ne
  réagissent à rien** (ni bouton, ni lien, `pointer-events: none`, pas de menu au long appui). Lu par
  `GET /api/player/xray/[itemId]?person=<id>` (`personFactsForPlayer`) : la personne est cherchée dans la
  distribution de cet élément, la biographie et la filmographie passent par **le chemin des fiches personne
  du cinéma**, sorti des routes `/api/tmdb/person/[id]` et `/enriched` dans `src/lib/tmdbPerson.ts` (mêmes
  appels, mêmes clés de cache, `selectBio`) — rien n'est recopié. Même porte que les scènes (`xrayOpenTo`,
  `assertVisible`, lien de partage par la règle de la route), 200 et `status: "none"` quand il n'y a rien.
  Avec l'option : le même panneau, plus « Jusqu'ici » et les questions (§139). Ordre : en-tête →
  « Jusqu'ici » → faits et biographie → bibliothèque → questions proposées (plus de champ depuis 10.29.2, §139).
- Les questions proposées pour une personne (`personQuestions`) : depuis 10.29.2 (§139), seulement « Quel est le lien
  entre <prénom> et <prénom> ? » avec les autres personnages de la même scène, par temps à l'écran, deux au plus ;
  « Qu'est-il arrivé à … récemment ? », « Que cherche … ? » et « Qui est … ? » sont retirées.
Porteurs ajoutés : `useOnScreenPlacement`, `onScreenRowWidth`/`onScreenRowBottom`, `personQuestions`,
`compactPlace`/`personFactsLine`, `usePersonFacts` (`src/lib/xray/client.ts`), `AskPersonBlock`
(`AskPersonHeader.tsx`), `src/lib/xray/person.ts`, `src/lib/tmdbPerson.ts`. Tests : `xray-row-1027.test.tsx`,
`xray-person-panel.test.tsx`, `xray-person-facts.test.ts`, `xray-onscreen.test.tsx`. **Empreintes du
lecteur inchangées** : `xrayAvailable`/`askAvailable` restent absents de leurs doubles — ni rangée, ni
bouton, ni préparation, ni requête de plus.

**10.27.1 (09/11/2026, deuxième essai du propriétaire, iPhone couché, *Ted Lasso* S01E08).** La rangée
s'arrêtait au tiers de l'écran, un seul nom coupé (« Hannah Waddingh… »), alors que −10 / lecture / +10
étaient **au-dessus** d'elle : la règle de 10.27 comptait comme « même hauteur » tout ce qui passait à 16 px,
et mesurait la rangée entière, étiquette comprise. Règle du propriétaire désormais (`onScreenRowWidth`) : la
rangée va **aussi loin que possible à droite** — 16 px avant le groupe du centre **seulement s'il chevauche**
la hauteur de la ligne des pilules (`data-onscreen-line`, pas l'étiquette, courte et collée à gauche) ; sinon
16 px avant la pilule des outils (audio, sous-titres, épisodes… — `settingsPillRef`, mesurée et suivie par
`useOnScreenPlacement`) si elle la chevauche ; sinon jusqu'au bord sûr de droite. Se toucher par un bord n'est
pas se chevaucher. Les pilules n'ont plus de largeur à elles (`max-w-[10rem]` retiré) : `max-w-full`, un nom
n'est coupé que si la rangée entière manque de place. Le bouton rond de la question reste au bout de la ligne.
Tests : `xray-row-1027.test.tsx` (centre chevauchant, rangée sous le centre sans chevauchement, pilule des
outils chevauchante, debout ; pilule sans largeur propre, bouton au bout).

**10.27.2 (09/11/2026, iPhone couché du propriétaire, *Ted Lasso* S01E08).**
- **La rangée commence au début.** Elle s'ouvrait souvent au bout quand la scène comptait plus de visages
  qu'il n'en tient. Cause : l'aimantation (`snap-mandatory`) garde, après un changement de mise en page, la
  pilule sur laquelle elle était posée (règle de « re-snap » des navigateurs) — une pilule passée à la fin
  d'une nouvelle scène emmenait la rangée avec elle. `toStart` (`PlayerOnScreen`) la remet à `scrollLeft = 0`
  à l'ouverture, à chaque scène, quand la largeur permise change et quand la rangée change de taille, avant
  l'image puis une image plus tard — **jamais sous un doigt** ni après que le spectateur l'a fait défiler dans
  cette scène (`userMoved` : doigt, molette, flèche). Aucun `scrollIntoView` n'était en cause.
- **Les commandes ne partent plus sous le doigt.** Toucher ou faire défiler la rangée (doigt, molette, pavé,
  flèches) appelle `holdControls` (`onHold`), comme la barre de progression ; la fin du geste
  (`ONSCREEN_SETTLE_MS` après le dernier signe) relance le décompte ordinaire de dix secondes (`onRelease` →
  `showControls(10000)`).
Tests : `xray-row-1027.test.tsx` (au début à l'ouverture, à chaque scène, à une largeur nouvelle ; rien ne
saute sous un doigt ni après un défilement ; `onHold`/`onRelease` ; au lecteur, rangée tenue cinq secondes en
lecture : les commandes restent, relâchée : elles partent).

**Fire TV : pas proposée** (`useXrayAvailable` → `isFireTv`, §71). Une rangée qui défile de côté, au
curseur de Silk ou à la télécommande, demanderait un parcours au focus propre (y entrer, défiler, en
sortir vers la barre) que rien ne porte ici, et la pilule qu'elle ouvre n'y existe pas non plus.

**Porteurs.** `src/lib/xray/client.ts` (`useXrayAvailable`, `useXrayScenes`, `xrayNextPoll`, `sceneAt`,
`onScreenPeople`, `characterFirstName`, `initialsOf`) ; `src/components/playerControls/PlayerOnScreen.tsx` ;
`src/components/ask/AskPersonHeader.tsx` (`PersonAvatar`, `AskPersonHeader`) ; `PlayerControls` (commun aux
deux lecteurs). **Tests.** `xray-onscreen.test.tsx` (scène par instant, ordre par temps à l'écran, visages
sans nom écartés, prénom, relecture qui s'arrête et attend une page cachée, « off » = une seule lecture,
option coupée = aucune, rangée absente sans personne / sans option / hors ligne, la pilule de la question
hors de ce qui défile, saut en pause sans requête, personne touchée = panneau avec en-tête et « Qui est … ? »,
→ du clavier du lecteur intact) ; `misc-simple-routes.test.ts` (`xrayAvailable` dans la configuration
publique).

**Le planificateur de la bibliothèque** (09/11/2026, consigne du propriétaire). Jusque-là, seule une séance
commandait une analyse : la première lecture d'un titre n'avait rien à montrer. Toute la bibliothèque est
désormais analysée **en fond**, par paliers, et seulement quand personne ne regarde.
- **Trois paliers, dans l'ordre** (`scanPlan.ts`, `buildPlan`, `watchingRanks`) : (1) ce qui se regarde —
  pour chaque compte (`getUsers`, liens de partage exclus), les films de « Reprendre » et, pour chaque
  série de « Reprendre » + « À suivre », l'épisode en cours ou suivant et les quatre d'après
  (`episodesFrom`, la chaîne de `nextEpisodeAfter`) ; le premier titre de chaque compte avant le deuxième
  de quiconque, le cinquième épisode après tous les premiers ; relu toutes les dix minutes. (2) Les
  arrivées des quatorze derniers jours (`NEW_WINDOW_MS`), une file continue. (3) Le reste, films et
  épisodes, du plus récent au plus ancien ; plan complet relu toutes les six heures.
- **La date d'entrée vient de Radarr et Sonarr** (`movieFile.dateAdded`, `episodeFile.dateAdded`, rapprochés
  par TMDB pour les films, TVDB puis TMDB et numéros pour les épisodes — `scanSources.ts`), jamais de
  `DateCreated` de Jellyfin : mesuré le 09/11/2026, 2 015 éléments datés du 19/08 (la migration de
  stockage), 712 du 05/10, 585 du 25/10. Le repli sur Jellyfin ne sert qu'à ce que ni Radarr ni Sonarr ne
  revendique (67 épisodes ce jour-là). FileFlows ne change pas la date d'import : un réencodage ne remonte
  pas au palier 2, c'est la relecture de l'`ETag` qui le voit.
- **Écartés** : l'animation (genre « Animation » / « Anime » chez Jellyfin, Radarr ou Sonarr,
  `isAnimationGenre`) — 1 310 éléments, 552 h ici —, et à la commande, ce qui n'a pas de distribution TMDB
  ou pas de fichier. Comptés à part, jamais commandés.
- **Seulement les dossiers des films et des séries** (consigne du propriétaire, 09/11/2026) : le chemin
  réel du fichier (`analysisTarget`) doit être sous `/media/movies/` ou `/media/tv/` (`isLibraryPath`,
  `DEFAULT_LIBRARY_ROOTS`, réglables par `XRAY_LIBRARY_ROOTS` pour une autre installation) — jamais les
  téléchargements, les seeds, les livres (`/media/books`, `/media/books-packs`) ni un autre dossier, même si
  Jellyfin en listait un élément. Un segment `..`, un chemin relatif ou un voisin au même début
  (`/media/movies-seeds`) ne passent pas. Écarté avec la raison `outside-library`, vérifié avant toute
  commande du planificateur. Relevé ce jour-là : 920 films sous `/media/movies`, 9 398 épisodes sous
  `/media/tv`, rien ailleurs.
- **Seulement sans lecture** : le signal de la recherche de répliques (§88, `mustWaitForPlayback` — séance
  Jellyfin, relais de flux, battement, puis cinq minutes). Un tour par minute (`scanTick`, un seul à la fois,
  état sur `globalThis`, démarré par `instrumentation.ts` trois minutes après le démarrage). Les commandes
  partent en `low`, **deux à nous en file au plus** (`MAX_PENDING`) et rien si la file du service en compte
  déjà trois (`MAX_SERVICE_PENDING`) : une commande `high` d'un spectateur ne trouve jamais une longue file
  devant elle. Pendant une lecture, rien de neuf ne part ; ce qui est déjà en file y reste (le service cède
  lui-même aux transcodages de Jellyfin).
- **Déjà fait, rien ne part.** Avant chaque commande, `/items/{id}` : fini au même `ETag` → compté fait ;
  en file au même `ETag` (la commande d'un spectateur) → compté dans l'avance. Les éléments finis sont
  relus lentement (dix par tour sans autre travail, chacun au plus une fois par semaine) : un `ETag` changé
  les remet à vérifier ; un échec est retenté une fois par semaine.
- **Un fichier remplacé à durée égale garde son analyse** (consigne du propriétaire, 09/11/2026 : les 65
  épisodes de *MacGyver* réencodés d'AV1 en HEVC ce jour-là). La durée de la version analysée : `durationS`
  de `/items` (ffprobe, côté service), sinon celle que Laterna a retenue en commandant (`xray_file_versions`,
  écrite par **toute** commande, celle d'une séance comprise), sinon `analyzedUntil` d'un résultat complet ;
  comparée à celle de Jellyfin (`durationS` d'`analysisTarget` : `RunTimeTicks` de la source) à une seconde
  près (`sameDuration`). Égale : la commande part avec `rebindIfSameDuration: true` et `durationS`
  (`rebindAnalysis`) — 200 `done`, rattachée ; 400, rien n'est commandé et l'ancien résultat reste.
  Le planificateur (`prepare`) et la commande d'une séance (`orderAnalysis`) font ce même détour, et
  `/api/player/xray/[itemId]` ne répond plus `stale` dans ce cas : il sert les scènes de l'ancien `ETag`
  (`scenesForPlayer`, `keepsAnalysis`).
- **Les gestes** (`/api/admin/xray/scan`, administrateur seul : `adminOnly` et `ADMIN_ONLY_READS` du proxy,
  déjà couvert par `/api/admin/xray`) : « Lancer maintenant » reprend un palier et le **force** — nourri même
  pendant une lecture, jusqu'à ce qu'il soit vide (le forçage tombe alors de lui-même : la file continue du
  palier 2 forcée pour toujours passerait outre chaque lecture) ou retiré (« Ne plus forcer ») ; « Mettre en
  pause » / « Reprendre » par palier, ou tous. Retenus dans `xray_scan_meta`, à travers un redémarrage.
- **Le suivi** : Configuration → Acteurs à l'écran (`/parametres/acteurs`, `XrayScanCard`, sur le modèle de
  `DialogueSearchCard` §88). Par palier : éléments faits / total, en file, échecs, écartés, heures de vidéo
  faites / totales, temps restant ; en tête : l'état (en cours, en attente d'une lecture, en pause, à jour,
  injoignable), l'élément en cours et sa progression, la vitesse (× temps réel : durée analysée sur temps
  de calcul — `stats.seconds` de `/items` — des trente derniers éléments finis, `analysisSpeed`), le temps
  restant de toute la bibliothèque (temps de calcul, attentes des lectures non comptées), les derniers
  échecs. L'option coupée (`xrayConfigured` faux) : rien ne tourne, la page le dit. Le public de l'option
  (`admins`/`tous`) ne compte pas : `admins` analyse aussi toute la bibliothèque.
- **La base** : `cine.db`, trois tables créées par `scanStore.ts` à la première utilisation
  (`CREATE TABLE IF NOT EXISTS`, idempotent) : `xray_scan_items` (un élément par ligne : palier, rang, durée,
  date, état, `ETag`, temps de calcul), `xray_scan_meta`, `xray_file_versions`. Le plan s'écrit par
  tranches de 500 lignes, la boucle rendue entre deux ; un plan lu vide n'efface rien.
- **Le journal** : une ligne `[xray]` par lot commandé (palier, nombre, titres ; « passage au palier N »
  quand il change), par relecture du plan, par geste et par palier forcé terminé — jamais par tour. Les
  erreurs dans `server.log` (`xray/scan`, `xray/scan-watching`, `xray/version`).
- **Mesuré le 09/11/2026** (lecture seule, 32 comptes) : palier 1, 402 éléments (351 h) ; palier 2, 586
  (479 h) ; palier 3, 8 020 (6 746 h) ; animation écartée, 1 310 (552 h). Dates d'import : 920 films par
  Radarr, 9 331 épisodes par Sonarr, 67 par Jellyfin.
- **La liste de priorité de l'administrateur : le palier 0** (09/11/2026, demande du propriétaire). Un film,
  ou une série entière, choisi à la main passe avant tout le reste : `prioritizeTitle` (`readPriorityTitle` :
  le film, ou tous les épisodes réels de la série saison par saison, spéciaux à la fin — `seriesOrder`),
  liste retenue dans `xray_scan_meta` (`priority`), éléments au palier 0 (`priority_of`, `setPriorityRows`)
  — une relecture du plan ne les en fait pas descendre (`upsertPlanSlice`, `setWatching`) et y fait entrer
  les épisodes arrivés depuis (`applyPriority`). Commandés en **`normal`** : devant les `low` du fond, jamais
  devant le `high` d'un spectateur ; une commande `low` déjà en file est renvoyée en `normal` (le contrat
  remonte la priorité d'un double). **Nourris même pendant une lecture** (une demande explicite vaut
  forçage), tant qu'ils ont du travail ; les deux d'avance restent la borne. Déjà fait, durée égale,
  dossiers permis, distribution : les mêmes vérifications. **L'animation reste écartée** : le titre est
  refusé (`animation`, 409 — jamais 404) et la page comme la fiche le disent. Retiré (`unprioritizeTitle`),
  un élément retrouve le palier de sa date, le palier 1 relu au tour suivant ; ce qui est fait reste fait.
  Où : la carte « Analyse prioritaire » de Configuration → Acteurs à l'écran (un champ qui cherche dans les
  deux catalogues du cinéma par `searchCinemaLibrary`, chaque titre avec ses éléments faits / total, son
  temps restant, et un bouton pour le retirer ; pause et reprise du palier 0) ; et sur la fiche du cinéma,
  pour l'administrateur seul et l'option branchée (`XrayPriorityControl` : présentation — la route est la
  porte), « Analyser en priorité » : un **bouton rond de plus** dans la rangée du bureau (`DetailIconActions`,
  la rangée ne gagne pas de hauteur : la fiche tient toujours en une page, §117.4), une icône sous libellé
  au téléphone (la rangée passe à la ligne plutôt que de serrer les autres). Un message bref confirme. Le
  rôle n'est demandé qu'une fois l'option connue ouverte : une fiche sans l'option ne fait aucune requête de
  plus. Route : `POST /api/admin/xray/scan` `{ action: "prioritize" | "unprioritize", itemId }`.
Porteurs : `src/lib/xray/scanPlan.ts`, `scanSources.ts`, `scanStore.ts`, `scheduler.ts` (`scanTick`,
`scanAction`, `xrayScanStatus`, `startXrayScheduler`), `rebind.ts` (`keepsAnalysis`, `rebindAnalysis`,
`jobFor`) ; `src/app/api/admin/xray/scan/route.ts` ; `src/components/settings/XrayScanCard.tsx`,
`src/app/(dashboard)/parametres/acteurs/page.tsx`. Tests : `xray-scan-plan.test.ts` (paliers, chaîne, dossiers permis,
animation, durée égale, vitesse, estimation), `xray-scheduler.test.ts` (sans lecture seulement, avance
bornée, file du service pleine, déjà fait, écartés, hors des dossiers permis, forçage, pauses, un tour à la fois, redémarrage,
progression et estimation, rattachement et repli sur 400, journal), `xray-same-duration.test.ts` (lecteur
et commande d'une séance), `xray-scan-route.test.ts` (portes, liste de priorité, refus de l'animation), `xray-priority-control.test.tsx` (le bouton de la fiche : administrateur seul, confirmation, refus de l'animation) ; la liste de priorité dans `xray-scheduler.test.ts` (avant le palier 1, en `normal`, saison par saison, pendant une lecture, redémarrage et relecture du plan, retrait).

**Revue du planificateur** (09/11/2026, relecture indépendante des deux commits du jour). Ce qui a changé :
- **Un élément en erreur ne bloque plus la file.** Toute erreur levée par `prepare` (TMDB dans `jobFor` /
  `castOf`, Jellyfin dans `analysisTarget`) arrêtait le tour : l'élément restait en tête des `pending`, l'état
  affichait « injoignable » et `server.log` recevait la même ligne chaque minute — la file entière était
  arrêtée par un seul titre. Désormais l'erreur est attrapée par élément dans `runTick` : une réponse d'erreur
  (`HttpError`) le met en échec (`xray/scan-item`), revu une semaine plus tard ; une erreur de réseau aussi,
  mais revue dans l'heure (`TRANSIENT_RETRY_MS`), et le tour s'arrête là pour qu'une panne de Jellyfin ne
  mette pas vingt éléments en échec par minute. Seul le service d'analyse lui-même (`/health`, `/items`,
  `/jobs` autre que 400 — `XrayServiceError`, `service()`) arrête le tour.
- **Les échecs et les écartés qui peuvent changer sont revus** (`reopenStale`, `REOPEN_AFTER_MS` = 7 jours,
  50 par tour, une écriture en base) : sans fichier, sans distribution, hors des dossiers permis — jusque-là
  écartés pour toujours — et les échecs, qui n'étaient retentés qu'une fois toute la bibliothèque finie (la
  relecture lente ne tournait qu'à file vide). Un échec revu est **relancé** même si le service le dit encore
  en échec au même `ETag` (« un ordre en échec est relancé », contrat) : avant, la relance relisait l'échec et
  ne commandait rien. L'animation suit le genre que relit le plan. `XRAY_LIBRARY_ROOTS` changé : les « hors
  des dossiers » sont revus au tour suivant (`followLibraryRoots`, `reopenOutsideLibrary`).
- **Une relecture du plan qui échoue attend** (`PLAN_TRIED_KEY`, `planBackoffMs` : 15 min, 1 h, puis 6 h) :
  `plannedAt` n'étant écrit qu'au succès, elle était retentée chaque minute — une vingtaine de pages de
  Jellyfin, deux appels par compte, deux par série chez Sonarr, à chaque tour. La liste des comptes et la
  bibliothèque sont lues en `allSettled` : la première est appliquée même si la seconde échoue, et sans
  elle le plan garde le palier 1 retenu (`storedWatching`). Le plan en place continue de servir ; l'incident
  reste affiché jusqu'au succès. La relecture du palier 1 (dix minutes) date sa tentative, plus son succès.
- **Aucune lecture inutile** : la relecture du plan et du palier 1 se fait après la pause et après
  `mustWaitForPlayback`. Tous les paliers en pause : rien n'est lu (ni Jellyfin, ni les comptes, ni le service).
  Pendant une lecture : le scan continue (10/11/2026) ; avec `XRAY_SCAN_DURING_PLAYBACK=false`, rien, sauf palier
  forcé ou liste de priorité avec du travail.
- **Le palier 0 ne passe jamais devant un spectateur.** Il part en `normal`, comme l'épisode suivant qu'une
  séance commande (`orders.ts`), et le service sert à priorité égale dans l'ordre d'arrivée
  (`ORDER BY priority, seq`) : une commande à nous arrivée avant aurait été servie avant la sienne. Il n'est
  donc nourri que si la file `pending` du service (`/health`) ne contient que nos propres commandes en attente
  (`followInflight` les compte, `waiting`) ; sinon rien ne part ce tour-ci — pas même le fond en `low`, qui
  prendrait les deux places que le palier 0 attend. Un état illisible ne compte pas comme le nôtre. `/health`
  ne donne pas les priorités : une commande d'autrui est supposée d'un spectateur (le fond est seul à
  commander en `low`). Ce qui est déjà en file avant l'arrivée d'une commande de spectateur y reste (deux au
  plus) ; le `high` passe devant de toute façon, le service cédant entre deux tronçons.
- **`rebindAnalysis` garde la priorité de la commande** (paramètre, par défaut celle du `job`) : il forçait
  `low`, et un élément du palier 0 — ou la commande `high` d'une séance (`orders.ts`) — que le service ne
  rattachait pas (202 : il oublie l'ancien résultat et réanalyse, contrat) retombait derrière tout le fond.
  Le commentaire qui donnait un 400 pour ce cas est corrigé : 400 = commande refusée, rien ne change.
- **Les gestes de l'administrateur ne sont plus écrasés** : les réglages sont relus juste avant d'écrire la
  fin d'un forçage, et seuls les paliers forcés au début, encore forcés et vidés, le perdent (une pause
  posée pendant le tour était effacée).
- **Un élément fait reste fait à la relecture du plan** quand seule sa date bouge (`DateCreated` de
  Jellyfin, réécrit par une réanalyse de la bibliothèque) ; il ne repasse à vérifier que si sa durée change
  aussi (plus d'une seconde) — un remplacement à durée égale, c'est la relecture de l'`ETag` qui le voit.
  Une date inconnue (`0`, élément ajouté par la liste de priorité avant le plan) n'est pas une date changée.
- **L'affichage** : « Tout mettre en pause / Tout reprendre » compte le palier 0 (`everyTierPaused`) ; l'état
  dit « En pause » et non « À jour » tant qu'un palier en pause a du travail ; la barre d'un palier ou d'un
  titre compte les échecs comme traités, dans leur propre segment (`scanBar`) — elle restait sous 100 %.
- **`next dev` ne planifie rien** (`devServer`, `NODE_ENV === "development"`, lu à l'appel — même règle que
  `dev-player.log`) : la pile de développement partage `data/cine.db`, et deux planificateurs commanderaient
  en double sur le même plan. Les gestes de la page de développement s'écrivent quand même dans la base
  partagée — c'est l'administrateur qui les fait. La recherche de répliques (§88) n'a pas cette garde.
Tests : `xray-scheduler.test.ts` (« La revue du 09/11/2026 » : chaque point ci-dessus, chacun en échec sur le
code d'avant), `xray-scan-card.test.tsx` (pause de tout, barre avec échecs).

**10.29.1 — la rangée sans masque, le geste des pilules, et un relevé pour voir ce que l'écran montre.**

- **Le symptôme** (prod 10.29.0, 09/11/2026, iPhone du propriétaire, application installée, iOS 26) : *Ted Lasso*
  S01E08, la scène de 599 s — cinq personnes, la rangée déborde. Des touchers sur les acteurs ont fait disparaître la
  rangée quelques secondes, puis elle est revenue **vide** ; le panneau de Roy n'a pas paru — le serveur l'a vu monté
  puis refermé 2,4 s plus tard, sans doute un panneau **invisible** refermé par un toucher sur son fond invisible.
  Cassé jusqu'à la réouverture du lecteur. Rejoué sous jsdom avec les vraies données, l'état est juste à chaque pas.
- **L'hypothèse retenue : un défaut de rendu de WebKit**, pas de logique. Deux combinaisons connues pour mal finir
  avec `backdrop-filter` (WebKit 284227, 279115, 298709) étaient réunies : le fondu du bord droit de la rangée était un
  `mask-image` posé sur l'élément qui défile, **parent de pilules floutées** — et seulement quand elle déborde, ce qui
  était le cas ; et l'attente de « Jusqu'ici » animait sans fin un `background-clip: text` dans l'espace qui défile
  (`contain: paint`) d'un panneau flouté (§139). Rien ne le prouve encore : d'où le relevé ci-dessous.
- **Le fondu du bord est un voile, plus un masque** (`PlayerOnScreen`, `.player-onscreen-fade`) : un élément à lui,
  `pointer-events: none`, posé au-dessus des pilules et sous les flèches, monté seulement quand la rangée déborde, qui
  va vers le sombre du voile bas du lecteur ; il part avec les commandes (`player-fade`). **Aucun masque sur un élément
  qui porte des enfants à `backdrop-filter`.** Le voile assombrit un peu l'image au bord au lieu de la laisser voir :
  c'est le prix, accepté, d'une rangée qui se dessine.
- **Les pilules et le bouton rond répondent au doigt comme les autres pilules du lecteur** (§45) : les pilules portent
  `data-liquid-pan="press"`, que la délégation de `PlayerControls` branche sur le réglage du même nom de
  `useLiquidDelegation` (force 0,4, `yieldAfter` 8 px) — elles gonflent à l'appui, rebondissent au relâchement sur le
  ressort commun, et rendent la main dès que le doigt part de côté. Leur `touch-action` est `pan-x` dans la rangée
  (`pan-y`, celui des boutons d'une page qui défile, aurait interdit de la faire glisser en partant d'une pilule). Un
  appui pendant l'élan d'iOS (`data-onscreen-scrolling`, posé sur le nœud 120 ms après chaque `scroll`, sans rendu)
  ne fait qu'arrêter la rangée : rien ne gonfle. Le bouton rond de la question devient une cible du geste comme le
  rond seul des commandes (`.player-ask-btn` dans `targets`) : même marge, et il s'allume (`data-lit`).
- **Le relevé `kind: "xray-ui"`** (`src/lib/xrayUiDiag.ts`, dans `startup.log` par `/api/viewport-diag`, comme
  `hauteur`, `retour` et `clavier`) : sur un écran tactile seulement, douze lignes au plus par séance du lecteur (un
  élément), dont cinq pour la rangée ; un `session` court relie les lignes. `row` (montée ou scène, commandes
  affichées, une image plus tard) : début de la scène, pilules, débordement, `scrollLeft`, la boîte et l'opacité /
  visibilité **calculées** de la rangée et de sa première pilule ; `tap` : la personne, la boîte de la pilule ; `open`
  300 ms après le montage du panneau (ou tout de suite s'il se referme avant, `early`) : sa boîte, son opacité et sa
  visibilité calculées, celle de la couche, et **ce qui est dessus en son centre** (`elementFromPoint` : `panneau`,
  `fond`, ou l'élément trouvé) ; `close` : `fond`, `croix`, `glissé`, `échap` ou `démonté` (par le lecteur), et la
  durée. Activité les montre avec les autres lignes de `startup.log`. La limite de `/api/viewport-diag` passe de 8 à
  20 par minute. Tests : `xray-ui-10291.test.tsx` (voile, plus de masque ni de texte détouré dans la feuille de style,
  geste, élan, relevé borné, `hitAt`, parcours complet dans le lecteur, rien à la souris), `xray-person-panel.test.tsx`
  (`open` et `close` du panneau), `viewport-diag-route.test.ts` (champs bornés).

**10.30 — « Qui parle » : les voix, nommées par les visages ; renommer sans relire ; la mémoire des séries gardée**
(10/11/2026, consigne du propriétaire après la R&D du 09/11, branche `voice-exp`, `tools/voice-exp/`).

- **Le service écoute** (résultats v5 ; tout le détail, les modèles, les licences et les mesures : `xray/README.md`,
  « Qui parle »). Le son sort du **même ffmpeg** que l'image (une seconde sortie dans un second tuyau, le canal central
  quand la piste en a un, 16 kHz mono), part dans un fil à lui (Silero VAD, une empreinte de voix par fenêtre de 1,5 s,
  `XRAY_VOICE_THREADS`) et s'écrit en base tronçon par tronçon. Les voix sont regroupées et nommées à chaque point
  d'étape comme les scènes : morceaux de 2 s coupés aux changements de voix, **consensus de trois seuils** (un nom
  seulement si deux sur trois le donnent, aucun autre), **contraste local avec les visages** d'« À l'écran », seconde
  chance, **une personne, une voix** (une seconde grosse voix nettement différente reste sans nom : le téléphone),
  **mémoire de la série** (voix nommées par les visages des épisodes précédents) — et **un désaccord entre la mémoire
  et les visages de l'épisode laisse la voix sans nom**, marquée `conflict` et comptée au journal. Modèle d'empreinte
  au choix : **WeSpeaker ResNet34-LM** (CC BY 4.0, défaut) ou CAM++ (Apache-2.0) ; poids téléchargés au démarrage,
  SHA-256 figés, comme ceux des visages. La piste : la **version originale** (Laterna envoie `originalLanguage`
  — `originalLanguageOf`, la langue que le catalogue tient de TMDB), sinon une piste dite VO, sinon celle par défaut ;
  jamais un commentaire ni une audiodescription.
- **Mesuré** sur les trois vérités de terrain de la R&D (*Ted Lasso* S01E08, *MacGyver* S01E06, *Bullet Train*), par le
  service lui-même, avec la règle de Laterna (ci-dessous) : **66,6 % des répliques nommées, 97,5 % justes** (WeSpeaker,
  VO), 77,6 % sur *Ted Lasso* avec la mémoire de l'épisode précédent ; une voix au téléphone sur quatorze nommée. CAM++ :
  66,4 % / 95,4 %. La stabilité, le risque de la R&D : seuil déplacé de ± 0,05, le seuil unique allait de 52 à 66 % à
  94 % de précision (dix voix au téléphone nommées), le consensus reste entre 63 et 67 % à 97,3–97,5 % (une ou deux).
  Le doublage se nomme mieux que la VO sur *Ted Lasso* (88,5 %), moins bien sur *Bullet Train* (50 %) :
  `XRAY_VOICE_TRACK=default` existe, la VO reste le défaut. Coût : ~0,065 s de calcul par seconde d'épisode.
- **Un ordre fini avant 10.30 n'est pas réanalysé** : quand rien de plus pressé qu'un ordre `low` n'attend, le service lit
  le son seul de ses tronçons et prend les visages en base (`voicejob.run_voice_only`).
- **Contrat, ajouts compatibles** : `GET /items/{id}/voices` (`{ itemId, etag, model, version, complete, analyzedUntil,
  track, stats, segments: [{start, end, voiceId, personId|null, confidence, conflict?}] }`), `voices` et `faces` dans
  `/items/{id}`, `voice` dans `/health`, `originalLanguage` dans `POST /jobs`, et les gestes ci-dessous.
- **Renommer sans relire** (`relabel.py`) : plans, empreintes de visages, zones de parole et empreintes de voix sont
  gardés ; `POST /items/{id}/relabel`, `/series/{id}/relabel` (dans l'ordre des épisodes) et `/relabel` (toute la
  bibliothèque) refont seulement regroupement et noms, visages puis voix, avec les seuils et la mémoire du moment, par
  lots de 20 s entre deux tronçons, jamais devant un ordre `normal` ou `high`. Résultat identique à une analyse neuve
  sur les mêmes données (`test_relabel.py`).
- **La mémoire des séries, gardée** (`memory.py`, visages et voix) : une **contribution par épisode et par personne**,
  avec sa provenance (épisode, date, poids, note), remplacée — jamais ajoutée — quand l'épisode est refait ; un épisode
  pèse au plus 300 s de visage et 60 morceaux de voix par personne, 15 personnes ; seulement un visage nommé par les
  **photos** avec une marge de 0,10 (0,08 avant) et 5 s de présence, une voix nommée par les **visages**. Auditable
  (`GET /series/{id}/memory`), réinitialisable (`POST /series/{id}/memory/reset`, puis la série est renommée).
- **Le planificateur** (`scanPlan.ts`, `inEpisodeOrder`) : dans un palier, les épisodes d'une série passent **dans
  l'ordre de la série** (saison, épisode), aux places que la série tenait — `nextPending` ordonne désormais tous les
  paliers par rang (les paliers 2 et 3 l'étaient par date, que le rang portait déjà). Une série dont tout le plan est
  traité est **renommée une fois** (`relabelFinishedSeries`, trois par tour, refait si de nouveaux épisodes sont finis ;
  `[tâche] série renommée`) : ses premiers épisodes profitent de la mémoire de toute la série.
- **La qualité des noms** (Configuration → Acteurs à l'écran, `XrayQualityCard`, `GET /api/admin/xray/quality`) : pour
  toute la bibliothèque, les films, puis chaque série (les moins bien nommées d'abord) — parole nommée, visages nommés,
  voix indécises, désaccords ; et « Réinitialiser la mémoire » par série (confirmé d'abord ; `POST { action: "reset",
  seriesId }`, administrateur seul, dans `ADMIN_ONLY_READS` par `/api/admin/xray`).
Porteurs : `xray/app/audio.py`, `voice.py`, `voices.py`, `voicejob.py`, `relabel.py`, `memory.py` ; côté Laterna
`src/lib/clients/xray.ts` (`voices`, `relabelSeries`, `resetSeriesMemory`, `quality`), `src/lib/xray/voices.ts`
(`speakerSegments`), `cast.ts` (`originalLanguageOf`), `scanStore.ts` (`finishedSeries`, `seriesRows`), `scheduler.ts`,
`src/app/api/admin/xray/quality/route.ts`, `XrayQualityCard.tsx`. Tests : `xray/tests/test_voices.py`,
`test_relabel.py` ; `ask-voices-1030.test.ts`, `xray-quality-1030.test.tsx`, `xray-scheduler.test.ts` (ordre des
épisodes, série renommée une fois), `xray-same-duration.test.ts` (langue d'origine dans la commande).


## 139. « Poser une question » : la réponse ne sait que ce que le compte a vu (09/11/2026)

*Amendé le 09/11/2026 (§140) : trois réglages au lieu d'un — `ASK_ENABLED` (questions sur un titre),
`ASK_PERSON_ENABLED` et `SOFAR_ENABLED` (vides, ils suivent `ASK_ENABLED`) —, chacun vérifié par la route ;
OpenAI et Google répondent aussi (d'un bloc, par le même `AnswerGate`) ; le plafond mensuel atteint donne
une ligne `budget` à une question et tait « Jusqu'ici ».*

**État en 10.30.1** (résumé ; la règle et l'historique version par version suivent — plusieurs formes
décrites plus bas ont été remplacées le jour même, chacune le dit).
- **Trois fonctions, trois publics** `off` / `admins` / `tous` (§140) : les questions sur un titre
  (`ASK_ENABLED`), les questions sur une personne (`ASK_PERSON_ENABLED`) et « Jusqu'ici »
  (`SOFAR_ENABLED`) ; les deux dernières demandent aussi les acteurs à l'écran (§138). La route est la
  porte. **Un lien de partage n'a aucune fonction d'IA** (10.28.1). Pas sur Fire TV. Anthropic, OpenAI ou
  Google, un seul plafond mensuel (§140).
- **Où.** Au lecteur : un bouton rond, icône seule, au bout de la rangée « À l'écran », avec les commandes,
  en lecture comme en pause (10.27 — la pilule « Une question ? » en pause seulement est l'ancienne forme).
  Sur les fiches : `AskTitleControl` (un bouton rond de la rangée du bureau, §117.4 ; une icône au
  téléphone). Le panneau d'un titre : trois propositions et le champ libre. **Le panneau d'une personne n'a
  pas de champ** (10.29.2) : « Jusqu'ici », les faits, puis au plus deux « Quel est le lien entre X et Y ? »
  avec les autres personnages de la scène.
- **Les filets** : seulement ce que le compte a vu ; noms absents des sources (réponse retirée) ; mots de
  coulisse, horaires du lecteur, « attribué », parole du lecteur (`metaTalk`) ; Markdown retiré mot à mot
  (10.30.1). Réponses diffusées **mot par mot** (10.28.0). Bornes : 60 questions par heure et 300 par jour,
  200 générations de « Jusqu'ici » par heure, par compte.
- **« Jusqu'ici »** : une ou deux phrases sur le personnage, **qui commencent par son nom** (consigne de la
  famille S7c, `SOFAR_VERSION` 10) ; générées **à la demande** — la demande part au toucher de la pilule —,
  préparées seulement sur une **intention au bureau** (pointeur fin posé 300 ms) ; **coupe** au début de la
  scène d'« À l'écran » en cours, plus les pas de deux minutes déjà passés dans une longue scène (`sofarCut`,
  le même calcul au client et au serveur ; sans scènes, la marque des cinq minutes) — et, pour une personne qui
  paraît pour la première fois dans la scène en cours, la position arrondie à la demi-minute (10.30.2) ; trois résumés au plus
  avant l'épisode en cours, répliques groupées par scène ; un second passage quand le filet a tout retiré ;
  **gardées trente jours sous l'empreinte de ce qui part au modèle** (partagées entre comptes au même
  endroit), un rejet une heure, une panne jamais, et une panne passagère ouvre une attente de 2 puis 10 min ;
  rien sur le seul synopsis quand les répliques d'un élément sous-titré ne sont pas prêtes, rien avant dix
  minutes de film. Pendant l'attente, une ligne à la fois (« Relecture des N scènes de X… », « Épisodes a à
  b… », « Rédaction… »), remplacée par le premier mot ; faute de texte, « Encore trop peu vu pour en dire
  plus. ».
- **Qui parle** (10.30) : une réplique porte le nom de qui la dit seulement quand l'analyse des voix est
  **complète** et la voix sûre (60 % de la réplique, confiance 0,6, pas de désaccord, pas une réplique courte
  avalée par la voix voisine — 10.30.1).
- **Journal** : `recherche.log`, `kind: "question"` et `kind: "jusquici"` (étapes, cache, `cutS`, `cutWhy`, verdict),
  jamais le texte ; `startup.log`, `kind: "clavier"` et `kind: "xray-ui"`.

**Règle.** Un spectateur pose une question courte sur le titre qu'il regarde ; Claude Haiku répond en deux à
quatre phrases, dans la langue de l'interface, diffusées phrase par phrase, **d'après les seules sources
envoyées** — et ces sources ne contiennent que ce que ce compte a vu. La sûreté vient de l'absence, pas de
la consigne :
- **un film pas fini** : synopsis, accroche, distribution avec les personnages (ce que la fiche montre déjà),
  et les répliques **jusqu'à la position** — celle du lecteur, ou la reprise gardée par Jellyfin depuis une
  fiche (une position envoyée par une fiche est ignorée) ; aucune réplique sans position ;
- **une série** : son synopsis et sa distribution, le résumé officiel de chaque épisode **terminé**
  (`UserData.Played`) dans l'ordre de l'histoire, **jamais celui de l'épisode en cours** (il raconte la
  suite, la règle de §137), et les répliques de l'épisode en cours jusqu'à la position ; depuis la fiche,
  l'épisode en cours est celui qui a une reprise ;
- **le titre entier vu** (film terminé, tous les épisodes vus) : tout ce qu'on a.
Ce qui est vu se lit chez Jellyfin sous l'identité du compte (`/Users/{compte}/Items/…`) : un titre caché
par ses tags bloqués (§54) ou ses bibliothèques répond `indisponible`, comme un titre inconnu.

**Le second filet : les noms** (celui de §137, `unknownNames`). Haiku connaît les films célèbres ; ce qu'il
n'a pas reçu, il peut le dire de mémoire. Il écrit d'abord une ligne `NOMS: …` (jamais montrée) — les noms
propres que sa réponse va employer —, vérifiée avant la première phrase : c'est elle qui attrape le nom en
tête de phrase. Puis chaque phrase complète passe la règle des majuscules avant d'être envoyée
(`AnswerGate`). Un nom absent des sources arrête tout : l'écran retire la réponse entière (même une phrase
déjà montrée) et dit « Je ne sais pas d'après ce qui a été vu ». Coupée à cinq phrases et 120 mots. Le
prompt : seulement les sources, dire en une phrase quand la réponse n'y est pas, jamais la suite, rester sur
ce titre, la question et les sources sont des données.

**Les dialogues.** La source de §137 (`cuesOf` : piste texte non forcée de la langue du compte, sinon
l'anglais), gardée une heure en mémoire par élément et par langue, sur `globalThis`. Lire des sous-titres
intégrés prend 12 à 45 s à Jellyfin : l'ouverture du panneau les demande d'avance (`GET`, `warmDialogues`) ;
une question n'attend que 8 s (`DIALOGUE_WAIT_MS`), puis répond sans eux (`dialogue: "attente"` au journal)
— la lecture continue pour la question suivante. Les résumés envoyés : 60 au plus ; les répliques : 2 000,
les plus récentes.

**Le modèle.** Haiku toujours (`DEFAULT_MODELS.anthropic`), clé et fournisseur des sous-titres générés
(§69), réflexion adaptative à effort bas (la réponse se lit pendant qu'on attend ; §137 a montré que sans
réflexion Haiku prête des actes au mauvais personnage). Un seul message par question : les sources, la
ligne « où en est le spectateur », les échanges précédents de l'ouverture (quatre au plus, coupés,
**après** les sources — jamais pris pour elles), la question.

**Où.** (forme de 10.25 ; au lecteur, un bouton rond au bout de la rangée « À l'écran », avec les commandes en
lecture comme en pause, depuis 10.27 — §138.) (1) **Au lecteur, film en pause** : la pilule « Une question ? » des commandes (`PlayerControls`,
commun au lecteur natif et au lecteur serveur), au-dessus du titre, à gauche — loin de « Passer l'intro » et
de l'épisode suivant —, qui paraît et part avec les commandes. Le panneau ouvert, les commandes ne se cachent
plus (`held`, comme un menu ouvert) et n'écoutent plus le clavier (`suspended`). Pas au lecteur hors ligne
(`askable={false}`), ni au banc (`lab`), ni au mini-lecteur (les commandes n'y sont pas), ni pendant une
diffusion vers un téléviseur (`castActive`), ni pendant l'ouverture du film. (2) **Sur les
fiches** : `AskTitleControl`, une ligne du menu des deux fiches du bureau, une icône à côté de « À voir » et
« Vu » sur la fiche du téléphone (film et série) ; la pièce décide seule d'exister.

**Le panneau** (`AskPanel`, un pour tout). Verre à droite (380 px, 330 sur un téléphone couché), feuille en
bas sur un téléphone debout ; trois questions proposées, puis le champ et le bouton d'envoi ; la question en
petite bulle à droite, la réponse dessous. Toucher le film (ou la fiche) referme — pendant la frappe, ce
toucher referme seulement le clavier ; Échap referme (en capture, arrêté là). Il porte `data-action-sheet`
(les fiches se taisent, §117.1), arrête ses touches (le clavier du lecteur — espace, flèches, K, F, M — ne
les reçoit pas) et ses appuis (ni pause de la surface, ni geste de la fiche). Cinq échanges par ouverture,
en mémoire de la page seulement ; refermé, ils sont partis, et la réponse en cours s'arrête (le modèle
avec elle). `header` : la place d'un en-tête au-dessus des échanges, remplie depuis 10.26 par une personne
d'« À l'écran » (§138 : photo, nom, personnage ; la biographie et « Jusqu'ici » viendront dessous), avec
`suggestions` (« Qui est … ? ») à la place des trois propositions d'office. *Depuis 10.29.2 : les seuls liens
entre personnages de la scène, et pas de champ (plus bas).*

**Il arrive et repart** (10.26 — la fiche n'avait aucun mouvement) : la colonne glisse de la droite
(`animate-fade-in-side`), la feuille du téléphone monte (`animate-slide-up`) ; la sortie, en 0,2 s
(`ASK_EXIT_MS`, `ask-panel-out-side` / `animate-fade-out-down`), passe par `useDelayedClose` — Échap, la croix,
toucher le film ou la fiche. `transform` et `opacity` seulement, rien sous `prefers-reduced-motion`. Le
même mouvement au lecteur et sur les fiches (un seul panneau).

**Le clavier de l'écran** (priorité du propriétaire, iPhone couché : ~390 px de haut, un clavier de plus de
la moitié). D'abord les propositions, sans clavier. Pendant la frappe, le panneau se réduit à la ligne du
champ, posée juste au-dessus du clavier ; à l'envoi le champ rend le focus, le clavier se referme, la réponse
arrive dans le panneau entier. Tout se place d'après la **vue visuelle** (`visualViewport` : hauteur et
`offsetTop`, écoutés en `resize` et `scroll`), jamais `100vh` ni la hauteur de la fenêtre : iOS 26 laisse
parfois la fenêtre à la hauteur d'un clavier (`viewportWatch.ts`) et iOS décale la vue vers le champ. Le
clavier se reconnaît à la vue qui perd plus de 120 px champ actif, comparée à la hauteur relevée sans focus
(`askPanelLayout`, pure, testée). Le champ reste le même nœud dans les deux formes (en changer ferait
perdre le focus, et refermer le clavier) ; 16 px de texte (Safari n'agrandit pas la page) ; rien derrière
ne défile au doigt (`touchmove` non passif, sauf l'espace des réponses qui déborde) ; la position de la page
est remise après chaque clavier refermé et au départ du panneau. Le lecteur ne change pas de taille : il est
posé sur la vue de mise en page, que le clavier d'iOS ne redimensionne pas.

**L'iPhone du propriétaire en application installée** (10.26, 09/11/2026). Couché, le clavier couvrait le
champ ; debout, au lecteur, le panneau ne s'était **pas réduit du tout** — le champ entier sous le clavier.
Donc la vue visuelle n'avait rien dit (ni `resize`, ni hauteur plus courte), ou trop tard. Ce qui est en
place, sans supposer laquelle des deux (`askPanelLayout`, `keyboardCover`) :
- le clavier se reconnaît de deux façons : la vue visuelle plus courte que la **référence** relevée sans
  focus (branche `vue`), ou plus courte que la **fenêtre** restée entière, `innerHeight − hauteur − offsetTop`
  (branche `fenetre` : la référence relevée trop tard, ou iOS qui fait glisser la vue au lieu de la réduire) ;
  un pincement (`scale` > 1,05) n'en est pas un ;
- la ligne se pose le bas contre le bas de la vue visuelle (`offsetTop + hauteur`), en coordonnées de la vue
  de mise en page, moins le haut du calque du panneau (`layerTop`, 0 d'ordinaire) ;
- la vue est relue à chaque image pendant la première seconde du focus, puis une fois à 700 ms : un `resize`
  en retard, ou absent, ne laisse plus le panneau entier ;
- **un téléphone** (pointeur grossier, petit côté de l'écran < 600 px) dont le clavier ne se laisse pas
  mesurer passe quand même à la ligne : invisible les 700 premières ms (branche `attente`, elle ne saute pas
  du haut vers le bas sous les yeux), puis **en haut** de ce qu'on voit, sous la zone sûre (`inconnu`) — le
  seul endroit qu'aucun clavier ne couvre. Un iPad garde son panneau entier (un clavier matériel n'ouvre rien).

**Le relevé `kind: "clavier"`** (`startup.log`, même route et même chemin que `kind: "hauteur"`,
`/api/viewport-diag`) : sur un écran tactile, une ligne au focus (écouté sur le document, `focusin` — pas
l'état de React, que la ligne dit à part : `focusedState`, `active`), une 600 ms plus tard, une par rafale de
`resize` de la vue champ actif ; six par ouverture du panneau au plus. Elle porte `innerHeight` /
`outerHeight`, `clientHeight`, la vue visuelle (`vv`, `vvTop`, `vvPageTop`, `vvScale`), la référence,
`scrollY`, l'écran et l'orientation, `standalone`, `touchPhone`, les bords du calque, du panneau et du champ,
la branche et la forme décidées, et les événements comptés depuis le focus (`vvResize`, `vvScroll`,
`winResize`) — ce qui dira, au prochain essai, si iOS prévient, quand, et de quoi.

**« OK »** à côté de l'envoi, seulement champ actif : referme le clavier sans envoyer (iOS n'a pas de touche
pour cela ici), le texte reste, le panneau entier revient. Appuyé, il ne prend pas le focus.

**Rien ne se dessine sur la réponse.** Couché, la fin d'une réponse passait sous la proposition restante :
l'espace des réponses rogne ce qu'il porte (`contain: paint` depuis 10.27.1, qui rogne aussi un calque
composé de WebKit — le `clip-path: inset(0)` de 10.27.0 sur l'élément qui défile est retiré, voir « Jusqu'ici »), descend jusqu'à sa dernière ligne une image plus tard et quand il change de taille
(`ResizeObserver`) ; propositions et champ sont dessous, dans le flux. Peu de hauteur (couché), les
propositions tiennent sur une ligne qui défile de côté.

**Pas de « sources » dites au spectateur.** Une réponse finissait par « Les sources ne vont pas au-delà de
ces neuf premières minutes. » La consigne interdit désormais de parler de sources, documents, contexte,
dialogues fournis, sous-titres ou résumés, et donne une façon naturelle de dire la limite, dans la langue de
l'interface et seulement quand la question l'exige (`SEEN_SO_FAR` : « D'après ce que vous avez vu
jusqu'ici… », « From what you've seen so far… », « Por lo que ha visto hasta ahora… », « Nach dem, was Sie
bisher gesehen haben… »). Le filet des noms et la règle de la suite ne changent pas.

**Fire TV : pas proposé** (`useAskAvailable` → `isFireTv`). Un champ de saisie sous le curseur de Silk et
son clavier d'écran, à refermer à la télécommande, est la chose la plus fragile qu'on puisse y poser (§71) ;
les propositions seules n'en valent pas la peine.

**Liens de partage : aucune fonction d'IA** (10.28.1, consigne du propriétaire — en 10.27 ils y avaient droit,
sur leur seul titre, l'option réglée sur `tous`). Ni question sur le titre, ni question sur une personne, ni
« Jusqu'ici », quels que soient les publics réglés : `tous` désigne les comptes du foyer. La porte est
`aiAudienceAllows` (`featureAudience.ts`), par laquelle passent `askAvailableFor`, `askPersonAvailableFor` et
`sofarAvailableFor` : la route répond `off` (POST) et `available: false` (GET), la configuration publique dit
`false` aux trois drapeaux, l'écran cache donc pilule, champ et section. `SHARE_RULES` garde la route (portée
`path`) : un refus de la porte serait un 403 par élément. Il garde les acteurs à l'écran ordinaires (la rangée,
le panneau d'une personne : photo, acteur, personnage, âge, lieu, courte biographie) quand le titre est analysé,
**jamais « Dans votre bibliothèque »** : `hiddenTmdbKeysFor` ne cache rien à un compte de lien, et ses « autres
titres » étaient ceux de toute la bibliothèque — la route des faits passe `library: false` pour `share` et retire
le champ (`personFactsForPlayer`). Tests : `ai-share-10281.test.ts`, `xray-player-route.test.ts`,
`xray-person-facts.test.ts`.

**Pour qui : `off` / `admins` / `tous`** (consigne du propriétaire, 09/11/2026 : les fonctions expérimentales
s'allument d'abord pour les administrateurs seuls). Le réglage `ASK_ENABLED` est un public, **`off` par
défaut** dans le code (Configuration, avec les deux autres options du modèle ; `true`/`false` y valent
`tous`/`off`). **La route est la porte** : `askAvailableFor(session)` (`audienceAllows`, la règle partagée
avec les acteurs à l'écran, `src/lib/featureAudience.ts`) — réglée sur `admins`, un compte ordinaire ou un lien
reçoit `{"t":"error","code":"off"}`, la même réponse qu'option coupée, et le `GET` `available: false` ;
`askAvailable` de la configuration publique suit la même porte, pour que l'écran cache la pilule et la ligne
des fiches — de la présentation seulement.

**Bornes et journal.** 30 questions par heure et 100 par jour et par compte Jellyfin (60 et 300 depuis
10.27, plus bas). Une ligne
par question dans `recherche.log` (`logAskQuestion`, `kind: "question"`) : compte, appareil, élément, `where`
(`fiche` | `lecteur`), tranche de dix minutes de la position, `ms` et `firstMs` (premier morceau rendu),
jetons, `dialogue` (`true` / `false` / `attente`), `episodes`, `turn`, verdict `ok` / `rejeté` / `limite` /
`erreur` / `indisponible` — **jamais la question ni la réponse**. Les pannes vont à `server.log`
(`ask/model`, `ask/context`, `ask/dialogues`, `ask/warm`). La route répond toujours 200 pour une issue
attendue (option coupée, borne, titre caché, panne : une ligne `{"t":"error","code":…}`), jamais 404
(CrowdSec, CLAUDE.md) ; l'écran dit chacune dans sa langue, et une réponse coupée sans ligne de fin est une
erreur dite, jamais un écran cassé.

**Porteurs.** `src/lib/ask/core.ts` (`askSources`, `seenCues`, `seenEpisodes`, `askSystem`, `askMessage`,
`AnswerGate`, `positionBucket`) ; `src/lib/ask/service.ts` (`askAvailable`, `gatherAskContext`,
`warmDialogues`, le modèle remplaçable) ; `src/lib/ask/client.ts` (`useAskAvailable`, `useAskTitle`,
`readAskStream`) ; `src/lib/ask/viewport.ts` (`askPanelLayout`, `useAskPanelLayout`) ;
`src/components/ask/AskPanel.tsx`, `AskTitleControl.tsx` ; `src/app/api/cinema/ask/[itemId]/route.ts`.
Reprend de §137 `cuesOf`, `episodesOf` et `unknownNames`, sans les recopier.
**Appelants.** `PlayerControls` (les deux lecteurs), `CinemaMovieDetail`, `CinemaSeriesDetail`,
`CinemaMobileDetail`. Proxy : `POST /api/cinema/ask/{id}` dans les écritures permises à tout compte.

**Tests.** `ask-question.test.ts` (aucune réplique après la position ni sans position, jamais le résumé de
l'épisode en cours ni des suivants, fiche = reprise de Jellyfin, film fini = tout, nom déclaré inconnu rejeté
avant la première phrase, nom au milieu d'une phrase, coupe, route : option coupée, 401/400, titre caché,
borne horaire, panne du modèle, journal sans texte, échanges après les sources, liste fermée des liens) ;
`ask-panel.test.tsx` (propositions sans clavier, position à l'instant, cinq échanges, rejet qui retire la
réponse, panne dite, Échap arrêté, touches du champ qui n'atteignent pas le lecteur, toucher le film,
appuis qui ne remontent pas, réduction à la ligne au-dessus du clavier d'après une vue visuelle simulée,
`askPanelLayout` dont la fenêtre restée courte d'iOS 26, la vue qui rétrécit avec la fenêtre, la fenêtre
entière et la vue glissée, un calque décalé, le téléphone sans mesure (attente puis en haut), le pincement,
~150 px visibles ; `resize` en retard, aucun `resize`, les lignes `clavier` et leur borne, « OK », propositions
sous l'espace des réponses, l'entrée et la sortie animées, l'en-tête d'une personne, `AskTitleControl` :
option, Fire TV, aucune requête au montage) ; `viewport-diag-route.test.ts` (la ligne `clavier`, bornée) ;
`ask-question.test.ts` (la consigne sans « sources », dans les quatre langues) ; `decisions-partagees.test.ts` (les trois fiches passent par `AskTitleControl`, le panneau n'est
posé que par elle et `PlayerControls`, la route n'est appelée que par `useAskTitle`) ;
`news-page-1025.test.ts`. Les empreintes du lecteur ne changent pas : l'option se lit dans la configuration
publique **suivie, jamais demandée** (`followOnlyOptions`), absente des doubles, donc ni requête ni pilule.

**« Jusqu'ici »** (10.27, 09/11/2026). Dans le panneau d'une personne d'« À l'écran » (§138), avec l'option :
une ou deux phrases sur **le personnage** d'après ce que ce compte a vu, sous les mêmes règles que les
questions — les sources de `askSources` (`sofarSources` y ajoute la personne, prise dans la distribution de
l'élément, jamais dans la requête) et le même filet des noms (`AnswerGate`, coupée à deux phrases et 60
mots ; « RIEN » quand il n'y a rien à dire, jamais montré). **La coupe est le début de la tranche de cinq
minutes** (forme de 10.27.1 ; posée sur un début de scène en 10.27.2, puis sur la scène en cours et ses pas de
deux minutes en 10.30.1 — plus bas) de la position (`sofarCutoff`, `SOFAR_BUCKET_S` — dix en 10.27.0 : pendant les dix premières minutes
d'un épisode, aucune réplique de cet épisode ne partait, `dialogue: false` au journal ; cinq depuis 10.27.1,
consigne du propriétaire, le budget est large ; la tranche du client, `SOFAR_BUCKET_S` de `ask/client.ts`, est
la même — un test les compare) : rien de ce qui suit ce début n'entre, un retour en arrière dans
la tranche ne montre rien de plus, et deux comptes au même endroit envoient les mêmes sources.
- **Gardé par ce qui part au modèle, partagé entre comptes** (consigne du propriétaire) : la clé est le
  SHA-256 du modèle, de la version de la consigne (`SOFAR_VERSION`), de la consigne (sa langue) et du
  message entier (titre, élément, personne, résumés effectivement envoyés, répliques jusqu'à la coupe).
  Deux comptes qui ont vu la même chose au même endroit lisent le même texte ; la moindre différence dans
  ce qui a été vu donne une autre clé — rien ne passe d'un compte à l'autre au-delà de ce que chacun a vu.
  **Trente jours en base** (`sofar_texts`, `sofarDb`), jamais regénéré tant qu'il vaut, effacé ensuite par le
  ménage horaire (`cleanupDiskCache` → `sofarDb.prune`, par tranches sous budget). Une panne n'est jamais
  gardée ; « rien à dire » l'est ; un rejet du filet des noms l'est **une heure** (`rejeté`,
  `SOFAR_REJECT_KEEP_MS`, 10.28.1 — jamais gardé avant : chaque réouverture du panneau regénérait et repayait
  la même entrée, rejetée à l'identique). Une génération par clé : la première demande lance
  le modèle **détaché de la requête** (un panneau refermé ne la perd pas) ; les suivantes lisent les mêmes
  phrases à mesure (`sofarStart`, `sofarSubscribe`).
- **Préparé en fond** (10.27 à 10.27.1 — retiré en 10.27.2, voir plus bas) : la rangée affichée, pour les
  **trois premières personnes** de la scène. Le panneau s'ouvre tout de suite avec ce qui ne dépend pas du modèle ;
  « Jusqu'ici » montre une ligne d'attente, puis le texte (`useSofar`).
- **L'affichage, règle du propriétaire (10.27.1 ; depuis 10.27.2 la section ne disparaît plus, une ligne
  discrète la remplace ; depuis 10.28.0 le reflet est remplacé par des lignes d'attente, une à la fois en
  10.29.1).** Le panneau s'ouvre tout de suite avec ce qui ne dépend
  pas du modèle (faits, biographie, affiches — `usePersonFacts`, jamais en attente de « Jusqu'ici ») ; avec
  l'option pour cette séance, la section « Jusqu'ici » est **toujours** là, en haut, dès l'ouverture
  (`AskPersonSofar`, un composant à lui) : une ligne d'attente discrète — deux traits sur lesquels passe un
  reflet (`ask-shimmer`, un fond qui glisse, jamais une opacité animée), étiquetée « Un instant… » pour un
  lecteur d'écran — qui ne paraît qu'après 350 ms sans texte (`SOFAR_LOADING_DELAY_MS`), puis le texte en
  fondu (`ask-sofar-in`). Un texte gardé par le serveur (~230 ms) se montre donc sans ligne d'attente ; un
  texte déjà lu par la page pour la même personne et la même tranche se montre à l'instant, sans requête
  (`sofarRead`, en mémoire). La section ne disparaît que sur « rien à dire » (`rejected`), une panne
  (réseau, 5xx, `error`, flux fini sans sa fin) ou **vingt-cinq secondes sans fin** côté client
  (`SOFAR_CLIENT_TIMEOUT_MS`) — sans un mot, la cause dans `server.log` (`ask/jusquici`). Position inconnue :
  demandée quand même (`positionS: null`, coupe au début), jamais une section muette.
- **Ce que 10.27.0 a montré sur l'iPhone** (le propriétaire, 09/11 vers 13 h) : pour Hannah Waddingh, faits et affiches
  mais aucune section ; pour Jason Sudeikis, « Jusqu'ici · Un instant… » figé, ni faits, ni biographie, ni
  affiches. Le serveur avait tout donné : `recherche.log` `cache: "compte"`, `ok`, ~230 ms, et le relais a
  envoyé des réponses complètes (326 et 369 octets — les deux phrases gardées et la fin), les faits aussi
  (558 et 383 octets) — le client ne les a pas montrés. Trois défauts côté client, corrigés :
  1. **le panneau figé** (cause la plus probable, à confirmer sur l'iPhone) : `.ask-scroll` portait depuis 10.27.0 un `clip-path: inset(0)` sur l'élément même
     qui défile, avec dedans une ligne d'attente à opacité animée (`animate-pulse`, un calque composé) ; sur
     l'iPhone le contenu n'a plus été redessiné après sa première image — les faits arrivés 3 s plus tard
     n'apparaissent pas non plus, ce qu'aucun défaut de « Jusqu'ici » seul n'expliquerait. Non reproduit
     dans le WebKit de Linux (Playwright), qui redessine : seul l'iPhone le confirmera. `contain: paint`
     rogne de même, et la ligne d'attente n'anime plus d'opacité ;
  2. **la section absente** : une ouverture du panneau d'Hannah (11:57:46 UTC) a demandé l'option et les
     faits mais pas « Jusqu'ici » — le seul chemin du client qui fait cela est `useSofar` rendant `none`
     sans demande quand la position n'est pas un nombre ; c'est corrigé (demandée avec `null`) ;
  3. **aucun délai côté client** : une réponse qui ne finissait pas laissait « Un instant… » pour toujours.
- **Route** : `POST /api/cinema/ask/{id}` avec `{ mode: "jusquici", personId, positionS, prewarm? }`
  (`answerSofar`, `src/lib/ask/sofarRequest.ts`) — même porte (`askAvailableFor`), mêmes réponses.
- **Journal** : une ligne `kind: "jusquici"` dans `recherche.log` (`logJusquici`) — compte, appareil, élément,
  personne, tranche (`bucket`, en minutes : 0, 5, 10… depuis 10.27.1), `prewarm`, `cache` (`partagé` / `compte` /
  `nouveau`), `ms`, jetons, verdict ; jamais le
  texte. Une seule ligne `nouveau` par génération, à sa fin.
- **Haiku** `claude-haiku-5-5`, réflexion adaptative à effort bas, comme les questions.

**Bornes (10.27, consigne du propriétaire : ~100 €/mois de crédit, ne pas brider).** Questions : 60 par heure
et 300 par jour et par compte (`ASK_PER_HOUR`, `ASK_PER_DAY`). « Jusqu'ici » : 200 générations par heure et
par compte (`SOFAR_PER_HOUR` depuis 10.27.2, préparations sur intention comprises), comptées seulement quand
le modèle est appelé.

**Les pannes, dites proprement (10.27).** Réseau, 5xx, 429, refus (`stop_reason: "refusal"`), **vingt
secondes sans rien du modèle** (`MODEL_IDLE_MS` : le délai du client et un chien de garde réarmé à chaque
événement du flux, `AskModelTimeout`), flux fini sans son message final : une question finit par
`{"t":"error","code":"erreur"}` (`limite` pour un 429), la cause dans `server.log` (`ask/model`), `erreur`
dans `recherche.log` ; l'écran dit « La réponse n'a pas pu être obtenue. » avec **« Réessayer »**, qui
repose la même question à sa place (`retry`, sans compter pour un échange de plus) ; le panneau reste
utilisable, rien ne remonte dans React. Pour « Jusqu'ici », la même panne ne montre **rien** : le bloc
disparaît, le reste du panneau (faits, biographie) reste ; la cause va à `server.log` (`ask/jusquici`).

**Le clavier, la règle du propriétaire (10.27, iPhone en application installée)** — ce qui avait été observé
devient la règle (`askPanelLayout`, `context`) :
- **au lecteur**, pendant la frappe, la ligne du champ va **toujours en haut** de ce qu'on voit, sous la zone
  sûre — debout comme couché, sans attente invisible (aucun clavier ne couvre le haut) ;
- **sur une fiche** : debout, posée juste au-dessus du clavier (inchangé) ; couchée, en haut ;
- **une rotation pendant la frappe** : le champ rend le focus (le clavier se referme), le texte reste, le
  panneau se replace dans la nouvelle forme (`orientationchange` et `screen.orientation`).
« OK », l'envoi et le relevé `clavier` ne changent pas ; le relevé dit aussi où la ligne s'est posée
(`place` : `haut` / `clavier`).

**La feuille du téléphone debout (10.27).** Haute de son contenu (posée par son bas, `max-height` — plus de
grand vide sous deux lignes), propositions côte à côte (`flex-wrap`), et refermée en la tirant vers le bas
par sa poignée — le geste des fiches (`useSwipeToDismiss`, capture par `usePointerCapture`, la croix hors du
geste par `NOT_THE_HANDLE`, la sortie jouée par le geste lui-même par `sheetMotionClass`), sous les règles
de « The sheet lifecycle » : une seule voie de sortie (`useDelayedClose`).

**Pas d'historique** (décidé) : rien n'est gardé au-delà de la vie du panneau — ni question, ni réponse.

Tests ajoutés : `ask-sofar.test.ts` (coupe à la tranche, clé partagée et `partagé`/`compte`/`nouveau`, autre
tranche = autre appel, trente jours puis ménage, rejet jamais gardé, « RIEN », personne hors distribution,
préparation `queued` et sa borne, chaque panne pour la question et pour « Jusqu'ici », refus, flux coupé) ;
`xray-person-panel.test.tsx` (faits sans le modèle, affiches inertes, attente puis texte, silence sur panne,
ordre, « Réessayer », feuille haute de son contenu, glisser pour fermer, la croix hors du geste) ;
`ask-panel.test.tsx` (le haut au lecteur, fiche debout/couchée, rotation pendant la frappe). 10.27.1 :
`xray-person-panel.test.tsx` (texte gardé : à l'instant, sans ligne d'attente ; génération : ligne d'attente
passé le délai puis phrases à mesure, faits jamais en attente ; rouvert dans la même tranche : sans requête ;
position inconnue : section quand même ; rien à dire : retirée ; 25 s sans fin : retirée ; `.ask-scroll` sans
`clip-path`) ; `ask-sofar.test.ts` (tranche de cinq minutes, répliques jusqu'à 5 min à 9 min, `bucket` en
minutes, tranche du client = celle du serveur).

**10.27.2 (09/11/2026, essai du propriétaire, iPhone couché, *Ted Lasso* S01E08).**
- **« Jusqu'ici » ne se tait plus sur les seconds rôles.** `recherche.log` montrait `status: "vide"` pour cinq
  personnes sur huit entre 13:03 et 13:10 UTC (Isaac, Keeley, Bex, Rupert, Mae) : la consigne autorisait
  « RIEN » dès que les sources ne disaient rien « au-delà du nom », et ces « vide » étaient gardés trente
  jours. Nouvelle consigne : un personnage nommé une seule fois reçoit au moins une phrase factuelle (qui il
  est pour les principaux, ce qu'il a fait à l'écran) ; le personnage demandé est **dans la scène** (le message
  le dit : il vient d'être touché dans « À l'écran ») — même nommé nulle part, une phrase : son nom et qu'il
  apparaît dans cette scène, son rôle si la distribution le dit, rien d'inventé ; « RIEN » seulement s'il n'est
  ni dans les sources ni dans la distribution. `SOFAR_VERSION` passe à 2 : la version est dans la clé
  (`sofarKey(…, version)`), aucun « vide » d'avant n'est relu. Vérifié sur la vraie API (5 appels, un à la
  fois) : Bex, « vide » sous la consigne d'avant, rend « Bex apparaît dans la scène que vous regardez. » ;
  Rupert « Rupert Mannion apparaît dans cette scène, où il vient d'entrer à l'écran. ».
- **Centré sur le récent** (consigne du propriétaire). Au plus une incise sur qui est le personnage, puis le
  plus récent : l'épisode en cours jusqu'à la coupe, puis les derniers épisodes vus ; l'ancien seulement s'il
  est indispensable. L'entrée est bornée : **les résumés des cinq derniers épisodes vus avant l'épisode en
  cours** (`SOFAR_MAX_EPISODES`, ceux de la fin de la saison d'avant comptent au début d'une saison — option
  `maxEpisodes` / `beforeCurrent` d'`askSources`), plus les répliques de l'épisode en cours jusqu'à la coupe,
  rien de plus ancien. Une série revue en entier (`sofarInput`) est coupée de même — « Jusqu'ici » parle de là
  où en est le spectateur. Les questions gardent leur fenêtre (soixante résumés).
- **La coupe tombe sur un début de scène** (consigne du propriétaire). Le rythme reste de cinq minutes, mais
  la coupe est le début de la **dernière scène d'« À l'écran » qui commence au plus tard à la marque** des cinq
  minutes : un texte ne s'arrête jamais au milieu d'une conversation, les répliques partent jusqu'à ce début.
  Une seule fonction, `sofarCut` (`src/lib/ask/sofarCut.ts`, sans dépendance), lue par le serveur (sur les
  scènes de `scenesForPlayer`, celles que reçoit le lecteur) et par le client (préparation sur intention, textes
  déjà lus, sur la charge `useXrayScenes` passée à `AskPanel` → `AskPersonBlock` → `useSofar`). Sans scènes,
  ou quand l'analyse ne va pas encore jusqu'à la marque, la marque elle-même. La coupe entre dans le message,
  donc dans la clé ; `cutS` au journal (à côté de `bucket`, la marque en minutes).
- **Rien à dire, rejet, panne ou délai : une ligne discrète**, « Encore trop peu vu pour en dire plus. »
  (`xray.sofarLittle`, quatre langues, `Sie`), état `little` de `useSofar` — la section ne disparaît plus
  (elle se lisait comme une panne). Seule l'option refusée à ce compte (`off`) la retire.
- **Le panneau s'ouvre en haut.** L'espace des réponses descendait à l'ouverture (`scrollTo` vers le bas dès
  le montage, sans échange) : avec des faits déjà gardés, la biographie s'ouvrait coupée en haut. Il ne
  descend plus que quand une question est posée ou que sa réponse arrive ; ce qui arrive ensuite (faits,
  biographie, « Jusqu'ici ») ne le fait pas bouger.
- **Une question posée depuis le panneau d'une personne** emporte `personId` : ses faits réels (TMDB — nom,
  naissance, décès, lieu, `actorFactsForAsk`, cherchée dans la distribution de l'élément ; **jamais la
  biographie** depuis 10.28.1 : celle de Wikipédia raconte souvent l'arc du personnage, la suite de ce qui a été
  vu — le panneau la montre toujours, elle ne part plus au modèle)
  partent dans un bloc `<acteur>` après les sources, et la date de diffusion de l'épisode (ou de sortie du
  film, `PremiereDate` de Jellyfin, tirée de TMDB) est dans les sources. « Quel âge a cette actrice pendant
  cet épisode ? » recevait « Les sources ne donnent pas l'âge… » sous la date de naissance affichée ; vérifié
  sur la vraie API : « Juno Temple, née le 21 juillet 1989, avait 31 ans lors de la diffusion de cet épisode,
  en septembre 2020. ». La consigne dit que ces faits ne disent rien de l'histoire ; leurs noms passent le
  filet (ajoutés à `check`).
- **Le filet des mots de coulisse** (`metaTalk`, `core.ts`) : chaque phrase, avant d'être rendue, est cherchée
  pour « sources, documents, contexte, sous-titres, transcription » et leurs équivalents anglais, espagnols,
  allemands — sauf un mot que l'histoire emploie elle-même (une réplique qui dit « documents »). Une question :
  prise avant toute phrase rendue → **redemandée une fois** avec un rappel (`metaReminder`) ; sinon « D'après
  les sources, … » reformulé (« D'après ce que vous avez vu, … », `rewriteMetaPrefix`) ; sinon la phrase
  remplacée par une limite dite naturellement (`METALESS_LIMIT`, une fois). « Jusqu'ici » : la phrase est
  retirée. `meta` au journal (`regénéré`, `réécrit`).
- **Le cache de prompts d'Anthropic.** Le message part en deux blocs (`askContent`, `prefixEnd`) : la partie
  partagée — sources (résumés, répliques jusqu'à la coupe) et où en est le spectateur — marquée
  `cache_control: { type: "ephemeral" }` (cinq minutes), puis ce qui est propre à la demande (la personne, ses
  faits, les échanges, la question). La consigne (fixe par langue) est devant. L'empreinte de `sofar_texts`
  prend toujours le message entier, jamais le découpage. Mesuré sur la vraie API : la deuxième personne d'une
  même scène relit 6 659 jetons du cache (`cacheRead`) pour 86 en entrée ; le minimum cachable de Haiku 5.5
  est 512 jetons. `cacheWrite` / `cacheRead` au journal.
- **Plus de préparation à l'apparition de la rangée** (décision du propriétaire). Jusqu'en 10.27.1, les trois
  premières personnes de chaque scène étaient préparées dès que la rangée paraissait : ~6 textes par heure de
  film pour zéro ou une lecture. Désormais « Jusqu'ici » est **généré à la demande**, à l'ouverture du panneau
  d'une personne, diffusé (la première phrase dès qu'elle est prête), puis gardé comme avant (clé de ce qui
  part au modèle, trente jours, partagé entre comptes) — un texte gardé se montre à l'instant ; la partie sans
  le modèle reste immédiate. **Seule préparation : une intention au bureau** — un pointeur fin (`hover: hover`
  et `pointer: fine`) posé `SOFAR_HOVER_INTENT_MS` (300 ms) sur une pilule (`onIntent` de `PlayerOnScreen` →
  `prewarmSofar`, une personne, une fois par coupe pour la page, jamais page cachée) ; le clic qui suit lit
  la même génération (le serveur la garde par sa clé), rien n'est annulé si le pointeur s'en va. Jamais au
  doigt. La route répond `{"t":"queued"}` aussitôt ; une seule borne, 200 générations par heure et par compte
  (`SOFAR_PER_HOUR`, préparations comprises — la borne à part des préparations est retirée). Le cache de
  prompts reste utile : plusieurs personnes ouvertes dans la même scène, et les questions.
- **L'attente, réduite sans toucher à la qualité** (la réflexion et l'effort ne changent pas : le
  propriétaire veut d'abord un essai à part).
  1. **La demande part au toucher** : `startSofar`, appelé par le clic sur la pilule (`PlayerControls`),
     lance la requête avant l'animation du panneau et toute autre requête ; `useSofar`, monté ensuite, la
     reprend (`takePendingSofar`) au lieu d'en lancer une seconde — une demande jamais reprise est oubliée
     au bout de 10 s, la génération va au bout et se garde. Une question part déjà du clic (`ask`).
  2. **Le contexte préparé à l'ouverture du lecteur** : avec l'option pour la séance, le lecteur appelle
     `GET /api/cinema/ask/{id}` une fois par élément ; le serveur lit l'élément, sa série et ses épisodes sous
     l'identité du compte et les garde en mémoire (`prepareAskContext`, huit éléments, quinze minutes, sur
     `globalThis`), et demande les répliques d'avance (`cuesKept`, une heure) — une question ou « Jusqu'ici »
     ne fait plus que couper à sa position.
  3. **Les étapes au journal**, lignes `question` et `jusquici` : `contextMs` (assemblage du contexte),
     `ttftMs` (départ vers le modèle → premier morceau), `firstSentenceMs` (→ première phrase rendue, après
     le filet des noms), `totalMs`, et `ctx` (`prêt` : le contexte venait de la préparation ; `construit`).
- **Plafonds de sortie** : `max_tokens` à 2 500 pour « Jusqu'ici » et 2 000 pour une question
  (`SOFAR_MAX_OUTPUT_TOKENS`, `ASK_MAX_OUTPUT_TOKENS`, réflexion comprise ; le plus long relevé : 1 730 et
  1 151). Atteint (`stop_reason: "max_tokens"`) : une panne — la ligne discrète, « Réessayer » —, jamais une
  phrase coupée.
- **Le coût, en euros, dans Activité** (sous « Recherche par description », administrateur seul) :
  aujourd'hui, sept jours, trente jours, le mois en cours contre la référence de 100 € (`aiCost.ts`) — les
  jetons de `recherche.log` (questions, « Jusqu'ici », « Précédemment » ; une recherche par description qui
  en porterait aussi) au tarif de `officialPrice` (Haiku 5.5 : 0,10 $ / 0,50 $ par million, cache ×1,25 /
  ×0,1), au taux fixe et approximatif `USD_TO_EUR` = 0,92 (« ≈ » à l'écran).
Tests : `ask-sofar.test.ts` (consigne, version dans la clé, « vide » d'avant jamais relu, cinq résumés au plus
avant l'épisode en cours, série revue, préfixe partagé et personne en dernier, `cache_control` sur le seul
premier bloc, jetons du cache au journal, plafond atteint jamais gardé, une seule borne) ; `ask-question-1027-2.test.ts` (mots de coulisse dans les quatre langues, reformulation, second
passage, limite naturelle, faits réels et date de sortie, `personId`, plafond) ; `xray-person-panel.test.tsx`
(ligne discrète sur rejet, panne, coupure et délai ; `off` retire la section ; le panneau ne descend pas à
l'arrivée des faits ; il descend à une réponse ; `personId` envoyé) ; `xray-row-1027.test.tsx` (la rangée qui
paraît ne prépare rien ; intention de 300 ms au pointeur fin, pas un passage, jamais au doigt ; une fois par
coupe ; jamais page cachée ; le clic qui suit ouvre) ; `ai-cost.test.ts` ; `ask-sofar-cut.test.ts` et `ask-sofar.test.ts`
(coupe sur un début de scène, jamais au milieu, repli sans scènes, même clé dans la même scène, `cutS` ; les
étapes au journal ; `ctx: "prêt"` après la préparation) ; `xray-row-1027.test.tsx` (« Jusqu'ici » part au
toucher, panneau pas encore monté, une seule demande ; le contexte préparé une fois à l'ouverture).

**10.28.0 (09/11/2026) — consigne S7c, répliques par scène, mot par mot, attente vraie.**

- **La consigne S7c** (`sofarSystem`), retenue par le propriétaire après des appels réels sur six cas (*Ted Lasso*,
  *MacGyver*) : le nom du personnage, une incise, puis **ce qui se passe au dernier moment de l'épisode en cours où il
  est là** — ce qu'il y fait ou ce à quoi il assiste ; les épisodes précédents en appoint. Ses règles visent ce que les
  bancs ont montré : un acte prêté au mauvais personnage (un mot d'adresse dit à qui l'on parle), les termes d'un
  échange (« qui propose quoi ») où les attributions se trompent, une cause ou un lien inventé, la liste « à l'écran »
  ou un horaire recopiés. Seule la langue de la réponse suit le compte ; sans scènes (titre non analysé), la précision
  « groupées par moment avec qui est à l'écran » est retirée. **Un film** (`kind: "movie"`, non couvert par le banc) :
  trois phrases changent et rien d'autre — « synopsis, distribution, et répliques du film », « au dernier moment du
  film », « si le synopsis le dit » ; un test vérifie que les règles sont celles du banc.
- **Le message** (`askSources` avec `strictCut` et `scenes`) : les **trois** derniers résumés avant l'épisode en cours
  (`SOFAR_MAX_EPISODES`, cinq avant) ; les répliques **groupées par scène d'« À l'écran »**, sans horaire — un titre
  « ### Épisode en cours, SxxEyy « titre », jusqu'à N min… » (« ### Film en cours, … » pour un film), puis par scène
  « — à l'écran : » et les personnages reconnus (« personne de reconnu » sinon) ; une réplique au temps t est dans la
  scène où `début − 0,5 ≤ t < fin − 0,5`, celles d'avant la première scène vont avec elle, une scène sans réplique
  n'est pas écrite (`groupCuesByScene`). **Coupe stricte** : seulement `t < coupe`, millisecondes comprises
  (`Cue.atS`, lu par `parseSrt`) — à la seconde entière, la première réplique de la scène coupée passait. La personne
  reste en dernier, après le préfixe partagé (cache de prompts). Les noms de personnages viennent de TMDB, en anglais
  (« Flo 'Sassy' Collins ») : gardés tels quels, le filet des noms les connaît par le texte même des sources.
  **Preuve** : le message du banc (`build.py`, variante S7c) reproduit octet pour octet — les six cas réels vérifiés
  hors du dépôt le 09/11/2026, un cas inventé produit par le banc lui-même figé dans `ask-sofar-s7c.test.ts`.
  `SOFAR_VERSION` 3 : aucun texte d'avant n'est relu.
- **Un film long** : au-delà du plafond des répliques (`ASK_MAX_CUES`), la moitié va aux scènes où la personne
  touchée est reconnue (les plus récentes d'abord) — sa présentation ne doit pas tomber —, le reste aux dernières
  scènes ; « […] » marque ce qui est omis. Sous le plafond, rien ne change (la forme du banc).
- **Mot par mot** (`AnswerGate`, questions et « Jusqu'ici ») : chaque mot part dès qu'il est complet (suivi d'un blanc,
  ou la fin du flux) — un nom en cours d'écriture attend d'être entier. Le contrôle des noms est **le même** :
  `unknownNames` sur la phrase en cours à chaque mot (ses correspondances ne dépendent que du mot et de sa place) ; un
  nom inconnu n'est jamais montré et retire toute la réponse. Le filet des mots de coulisse regarde chaque mot : au
  premier, la phrase commencée quitte l'écran (`reset` — un nouvel événement du flux, le texte montré entier), est
  gardée jusqu'à sa fin et reçoit la règle d'avant (reformulée, redemandée une fois, retirée, remplacée) ; une phrase
  qui commence comme « D'après les… » est retenue six mots, le temps de savoir si sa tête se reformule ; « RIEN » seul
  n'est jamais montré. Le texte final est le même quel que soit le découpage (`ask-stream-1028.test.ts`). Le
  protocole garde `{"t":"text"}` (un mot, joint d'une espace comme l'étaient les phrases) : un onglet resté sur
  l'ancien code lit le même texte. Journal : `firstWordMs` (premier mot), `firstSentenceMs` reste la première phrase.
- **L'attente vraie** (`SofarWaiting`, `AskPersonHeader.tsx`) : des lignes gris clair, l'une après l'autre (900 ms),
  la dernière parcourue d'un reflet dans le texte — « Relecture des N scènes de {personnage}… » (scènes de la personne
  avant la coupe, lues des scènes du lecteur), « Épisodes {a} à {b}… » (la fenêtre des résumés, dite par le serveur
  dans un premier événement `{"t":"plan"}` quand une génération commence), « Rédaction… ». Aucun appel au modèle pour
  elles. **Règle du propriétaire : elle ne retarde jamais rien** — pas de durée minimale, le premier mot la remplace à
  l'instant, même au milieu de ses lignes ; un texte gardé (sur l'appareil, ou au serveur : pas de `plan`) n'en
  montre aucune. Sans `plan`, elle paraît passé `SOFAR_LOADING_DELAY_MS` (le contexte se prépare). Mouvement réduit :
  les lignes connues ensemble, immobiles. Le texte n'a plus de fondu : le premier mot est là à pleine lumière.
- **Appels réels du 09/11/2026** (compte de test, base copiée, Haiku, 4 appels) : *Ted Lasso* S01E08 à 15 min, Rebecca
  — « Rebecca Welton, qu'on appelle « patronne », est avec Ted : elle lui demande de l'accompagner à un rendez-vous
  avec deux actionnaires minoritaires, les sœurs Lait, et il accepte. » ; *Bullet Train* à 1 h 47 (coupe 1 h 45),
  Ladybug, répliques prêtes — « Coccinelle, assassin malchanceux qui veut descendre du train, assiste au récit de la
  Mort Blanche sur la mort de sa femme, pendant qu'il est question de Carver. » (fidèle au dernier moment, rien
  au-delà) ; la même demande à froid, répliques pas prêtes dans les 25 s (`SOFAR_DIALOGUE_WAIT_MS`), n'avait que le
  synopsis : un texte générique — le premier « Jusqu'ici » d'un film jamais ouvert peut l'être. Prince, même
  position : juste mais recopie les présents (« entourée de Ladybug, Lemon, White Death… ») malgré la règle.

**Nouveautés.** La page « 10.25 » (`src/lib/news/page1025.ts`), semée **en brouillon**
(`news-seed-10.25-draft`) : rien ne s'affiche avant qu'elle soit publiée depuis Activité → Nouveautés.

**Limites connues** (écrites en 10.25 ; depuis 10.30 les répliques portent le nom de qui parle quand la voix est
sûre, et les bancs sur la vraie API ont eu lieu à partir de 10.27.2 — plus bas). Les répliques ne disent pas qui
parle : une question « qui a dit… » reste générale. Un
mot à majuscule au milieu d'une phrase qui n'est pas un nom (« Pourquoi » dans une citation) fait rejeter une
réponse juste — un « je ne sais pas » de trop plutôt qu'une révélation. Un compte dans une autre langue que
les résumés de Jellyfin voit plus de rejets (un nom traduit n'est pas dans les sources, §137). Pas encore
passé sur la vraie API (le banc n'a pas été lancé) : l'effort et la tenue du format `NOMS:` sont à vérifier
sur quelques questions avant d'allumer l'option.

**10.28.1 — une seule coupe par toucher, la sortie d'un compte, la préparation.** (1) Le toucher d'une
personne (`startSofar`) coupait sur l'heure affichée, le panneau (`useSofar`) sur la position qu'il relisait un
instant plus tard : à une limite de tranche, deux coupes, deux clés, une seconde demande et parfois une seconde
génération payée. La position est lue **une fois** au toucher (`readPosition` de `PlayerControls`) ;
`startSofar` la rend (`sofarPosition`), le lecteur la passe au panneau (`AskPanel` `sofarPosition`) — même
nombre, même `sofarCut`, même clé. (2) `GET /api/cinema/ask/{élément}` préparait le contexte pour les questions
seulement, alors que le lecteur l'appelle aussi quand « Jusqu'ici » est seul ouvert : les trois portes y entrent.
(3) La sortie d'un compte (`forgetAccountOnDevice`) oublie les textes lus et préparés (`forgetAskClient`) et les
faits des personnes (`forgetPersonFacts`). (4) Une question abandonnée (panneau refermé, page quittée) s'écrit
`status: "abandon"` dans `recherche.log` — elle se lisait `ok`. Tests : `xray-row-1027.test.tsx` (limite de
tranche, oubli), `ai-share-10281.test.ts` (préparation), `ai-spend-abort-10281.test.ts` (`abandon`).

**10.28.2 — les films : les noms des répliques, jamais la liste des présents, rien sur le seul synopsis, rien
avant dix minutes.**

- **Deux règles de plus dans la consigne** (`sofarSystem`, séries et films — une seule consigne), retenues par le
  propriétaire : « Appelle chaque personnage comme les répliques le nomment quand c'est clair (une traduction, un
  surnom), sinon comme la distribution. » — la distribution de TMDB est en anglais (« Ladybug », « White Death »,
  « The Prime Minister ») quand les sous-titres français disent « Coccinelle », « la Mort Blanche », « le Premier
  ministre » ; le filet des noms accepte le nom des répliques, il est dans les sources. Et « Un autre personnage
  seulement s'il prend part à ce que tu racontes, jamais une liste de qui est là. » — un second rôle était présenté
  « entourée de Ladybug, Lemon, White Death, The Elder et Kimura ». `SOFAR_VERSION` 4.
- **Banc du 09/11/2026** (Haiku 5.5, réflexion adaptative, effort bas, une requête à la fois, 29 appels, ~0,06 $) :
  trois films analysés par X-Ray — *Bullet Train* (action, distribution anglaise), *Le Prénom* (huis clos, cinq
  personnages, un secret révélé tard), *Love Actually* (film choral) —, un premier rôle et un second rôle chacun, à
  trois moments ; la consigne d'avant (S7c) sur les mêmes entrées là où il fallait comparer. Avec les deux règles :
  les noms des répliques partout (« Coccinelle », « l'Ancien », « la Mort Blanche », « le Premier ministre » ; S7c
  écrivait encore une fois « The Prime Minister »), plus de liste de cinq présents (au plus deux noms, une fois),
  aucune révélation au-delà de la coupe (le secret du *Prénom* n'est dit qu'une fois passé), aucun rejet du filet.
  *Ted Lasso* S01E08 (Rebecca, 15 min) et *MacGyver* S01E06 (Jack, 20 min) : les mêmes faits que S7c. Ce que les
  deux règles ne règlent pas, vu sur les deux consignes : une scène d'X-Ray qui mêle deux fils montés en alternance
  (un coup de téléphone et un autre wagon) fait prêter à un personnage ce qui se passe dans l'autre fil ; un détail
  du monde ajouté (« britannique ») ; une fois, un moment plus ancien raconté à la place du dernier ; une fois le mot
  « scène », que le filet des mots de coulisse ne retient pas.
- **Rien sur le seul synopsis d'un élément sous-titré** (`dialogueMissing`, `gatherAskContext`) : quand l'élément — le
  film ou l'épisode en cours — a une piste de sous-titres texte que `cuesOf` sait lire (`hasTextSubtitles`,
  `recap/service.ts`, la même condition) et qu'aucune réplique n'est là — lecture pas finie dans
  `SOFAR_DIALOGUE_WAIT_MS` (25 s ; 12 à 45 s chez Jellyfin pour une piste intégrée) ou en échec —, « Jusqu'ici »
  n'appelle pas le modèle et ne garde rien : la route répond `{"t":"rejected"}`, l'écran garde l'attente animée
  pendant ce délai puis montre la ligne discrète ; `recherche.log` dit `status: "attente"`. La lecture continue et
  sert à la demande suivante (`cuesKept`). En 10.28.0, *Bullet Train* ouvert à froid recevait un texte générique tiré
  du synopsis, gardé trente jours sous sa clé. Une coupe à zéro (un épisode avant cinq minutes) n'envoie aucune
  réplique : rien n'y manque, la règle d'avant vaut (résumés). **Un élément sans piste texte garde la règle
  d'avant** : synopsis, distribution, résumés.
- **Un film avant dix minutes** (`SOFAR_MOVIE_MIN_S` = 600, `sofar.ts`) : la ligne discrète tout de suite — ni modèle,
  ni répliques attendues (`movieEarly`), rien de gardé, `status: "tôt"` ; une position inconnue aussi. Le générique et
  la scène d'ouverture ne disent rien d'un personnage que le synopsis ne dise déjà (au banc, un second rôle à 18 min :
  trois répliques, un texte creux). Une série n'est pas concernée — ses épisodes vus ont des résumés.
Tests : `ask-sofar-s7c.test.ts` (les deux règles dans les consignes série et film, la consigne entière octet pour
octet, un nom tiré des répliques accepté par le filet, version 4) ; `ask-sofar.test.ts` (film à 9 min 59 et position
inconnue : `rejected`, ni modèle ni sous-titres lus, rien en base, `tôt` ; à 10 min, appelé ; répliques en retard
au-delà de `SOFAR_DIALOGUE_WAIT_MS` : `rejected`, `attente`, rien en base, puis la demande suivante écrit sur les
répliques ; lecture en échec : `attente` ; film sans piste texte : texte sur le synopsis comme avant ; épisode : la
même règle, et à la coupe zéro le texte s'écrit sur les résumés).

**10.29.1 — le dernier fait qui le concerne, plus le dernier moment où il ne fait qu'assister.**

- **Le symptôme** (prod 10.29.0, 09/11/2026) : *Ted Lasso* S01E08, Rebecca, coupe à 4 min 13 → « Rebecca Welton,
  divorcée, est là pendant une dispute sur une chambre, où l'on revendique la pièce et où l'on réclame qu'on
  sorte. » Juste, et inutile. La cause : la consigne demandait « ce qui se passe au dernier moment de l'épisode en
  cours où il est là — ce qu'il y fait, ou à quoi il assiste », et les règles contre les attributions (« dis
  seulement à quoi il assiste », « ni geste qui ne soit dit tel quel ») ne laissaient de ce moment qu'un échange
  vague.
- **La phrase, une seule, à la place de l'ancienne** (`sofarSystem`, séries et films ; aucune règle ajoutée — la
  longueur de la consigne fait la durée de la réflexion) : « puis le fait le plus récent qui le concerne vraiment —
  ce qu'il fait, ce qui lui arrive, ce qu'on dit de lui —, dans l'épisode en cours d'abord, sinon dans les derniers
  épisodes vus ; un moment où il ne fait qu'assister ne compte pas. » Pour un film : « …, le plus tard possible dans
  le film ; … ». Les règles restent celles de S7c et de 10.28.2. `SOFAR_VERSION` 5.
- **Banc du 09/11/2026** (Haiku 5.5, réflexion adaptative, effort bas, une requête à la fois, 27 appels, consigne et
  messages construits par le code de `main`) : huit cas — Rebecca à 4 min 13 (le creux), Ted à 4 min 13 (tôt),
  Rebecca à 12 min 38 et Rupert à 24 min (doivent rester précis), Jack (*MacGyver* S01E06, 19 min 53) et Patricia
  (34 min 46, le « leurre » d'avant), *Le Prénom* (Claude, 78 min 42) et *Bullet Train* (Prince, 58 min 50). Quatre
  formulations : une phrase de repli après l'ancienne (« s'il ne fait qu'y assister… ») et une règle ajoutée
  restaient creuses (« est à l'écran quand il est question d'une chambre ») ; une variante sans « vraiment » aussi,
  avec le mot « scène ». La phrase retenue, seize textes : Rebecca à 4 min 2 fois sur 2 utile (« divorcée, décide
  de partir en week-end avec l'équipe pour le match face à Liverpool », résumé de S01E07) ; Rebecca à 12 min,
  Patricia, Claude, Prince justes et précis à chaque fois (Prince : « a menacé Kimura de faire tuer son fils Wataru,
  puis lui demande de tuer la Mort Blanche pour elle » — la consigne d'avant écrivait « la jeune femme rencontrée à
  l'hôpital par Kimura », faux) ; aucun spoiler, aucun mot de coulisse, aucun rejet du filet. Ce qu'elle coûte : Jack
  est raconté une scène plus tôt (le camion qu'on lui dit d'arrêter, où il est nommé, plutôt que la salle qu'on
  évacue), Ted une fois par un fait de S01E06 plutôt que son matin avec Sassy ; et un lieu inventé une fois sur trois
  pour Rupert (« dans le bureau du club », c'est un pub) — la règle « ni lieu » ne l'a pas retenu. Réflexion ≈
  1 100 jetons, environ 6,2 s, comme la consigne d'avant sur les mêmes cas.
Tests : `ask-sofar-s7c.test.ts` (la consigne série octet pour octet, la phrase film, version 5) ; `ask-sofar.test.ts`
(la phrase, plus de « à quoi il assiste », version 5 et une clé de la v4 jamais relue).

**10.29.1 — l'attente de « Jusqu'ici » : une ligne à la fois, sans texte détouré** (dessin du propriétaire). Les lignes
restent celles de 10.28.0 (`sofarWaitLines` : « Relecture des N scènes de X… », « Épisodes a à b… », « Rédaction… »),
mais **une seule à la fois, à la même place** (`SofarWaiting`) : la nouvelle entre en fondu en montant de 4 px pendant
que la précédente sort de même (350 ms, `ask-wait-in` / `ask-wait-out`), une ligne toutes les 1,2 s
(`SOFAR_WAIT_STEP_MS`), rien ne s'accumule ; la dernière reste et respire doucement (`ask-wait-pulse`, opacité de 1 à
0,55). Les deux lignes partagent une case de grille — aucune position absolue. **`opacity` et `transform` seulement** :
le reflet dans le texte de 10.28.0 (`.ask-wait-shimmer`, `background-clip: text` animé sans fin) est retiré — il tournait
dans l'espace qui défile (`contain: paint`) d'un panneau flouté, l'une des deux combinaisons soupçonnées du panneau
invisible de l'iPhone (§138, 10.29.1). Inchangé : le premier mot la remplace à l'instant ; un texte gardé s'affiche
sans attente ; mouvement réduit : une seule ligne immobile, la plus avancée de ce qu'on sait (10.28.0 les montrait
toutes). Fermeture du panneau : une raison par geste (`fond`, `croix`, `glissé`, `échap`), pour le relevé `xray-ui`.
Tests : `xray-person-panel.test.tsx` (une ligne à la fois, la sortante en fondu puis retirée, la dernière qui respire,
plus de reflet ; mouvement réduit).

**10.29.2 — rien ne le concerne encore : une phrase simple ; l'horaire et « attribué » au filet.**

- **Le symptôme** (prod 10.29.1, 09/11/2026) : *Ted Lasso* S01E08, Sam Obisanya, coupe à 9 min 59 → « Sam Obisanya est
  présent dans l'épisode en cours, « Solidarité masculine », jusqu'à 9 minutes, sans qu'aucune parole ou action ne lui
  soit attribuée à ce stade. » Le propriétaire veut une phrase quand il n'y a rien à dire, mais celle-ci donne un
  horaire et parle d'attribution.
- **La consigne** (`sofarSystem`) : la ligne « S'il n'est nommé nulle part, écris son nom, son rôle si la distribution
  le donne, et qu'il est là. » devient « Si ni l'épisode en cours ni les épisodes vus ne disent rien de lui, une seule
  phrase, sans l'expliquer : son nom, qui il est si on le sait, et « n'a pas encore eu de moment à lui ». » — pour un
  film, « Si le film, jusqu'ici, ne dit rien de lui, … ». « RIEN » reste réservé à qui n'est pas dans la distribution.
  Même longueur. `SOFAR_VERSION` 7. Une première forme, « Si rien de ce qu'il a vu ne le concerne encore » (version 6,
  jamais déployée), ne disait pas que les épisodes vus comptent : rejouée sur la version livrée, Rebecca à 4 min y
  redécrivait sa présence (« se trouve dans une scène où il est question d'une chambre ») au lieu de Liverpool.
- **Un second passage quand le filet a tout retiré** (`sofarStart`, `sofarRequest`) : si le filet des mots de
  coulisse a retiré toutes les phrases (rien de gardé, ni nom inconnu ni « RIEN »), le modèle est redemandé une fois,
  le même message suivi du rappel (`metaReminder`) — le préfixe du cache de prompts est le même. Chaque passage est
  compté dans le plafond par `askModel` (10.28.1) ; `recherche.log` additionne leurs jetons et dit `meta: "regénéré"`.
  Le second encore vidé : « vide », la ligne discrète, **rien de gardé** (`finish(…, unkept)`) — ce n'est pas « rien à
  dire », la demande suivante redemande. La cause : Ted à 4 min, « … échange avec Flo 'Sassy' Collins dans cette scène
  du matin. », une seule phrase juste, retirée pour un mot — l'écran restait blanc. Une phrase qui reste suffit : pas
  de second passage (une question, elle, redemande dès la première phrase prise, `retry`).
- **Banc du 09/11/2026** (24 appels, une requête à la fois, consigne et messages construits par le code de `main`,
  identiques octet pour octet à ce qui est livré) : cinq formulations sur Sam. Sans « une seule phrase, sans
  l'expliquer », le modèle justifie toujours : « il est présent dans plusieurs scènes, mais les répliques ne lui sont
  pas attribuées », « jusqu'à 9 minutes… qu'on lui attribue » (4 textes sur 6) ; avec, « Sam Obisanya n'a pas encore
  eu de moment à lui. » 2 fois sur 2, en 3 s (réflexion ≈ 450 jetons). La même règle conditionnelle, formulée sans ce
  bout (F2), sur les autres cas : Rebecca à 4 min et Ted inchangés (Liverpool ; le matin avec Sassy), Rupert, Jack,
  Claude justes. Elle a aussi donné une fois un texte sans le nom en tête (Rebecca à 12 min), une fois Prince
  « depuis l'hôpital » (faux, déjà vu en 10.29.1) et une fois « scène » (Patricia) : le hasard d'un seul passage, que
  le banc n'a pas pu départager dans le budget. Rejouée sur la version 7 (le code de `main`, le filet réel, 9 appels) :
  Sam 2 fois sur 2 « Sam Obisanya n'a pas encore eu de moment à lui. » ; Rebecca à 4 min, une fois Liverpool (résumé
  de S01E07), une fois une première phrase retirée pour « attribuée » puis « Dans S01E07, elle décide de partir en
  week-end avec l'équipe… » (juste, mais le code d'épisode et sans son nom en tête) ; Ted à 4 min, une fois le matin
  avec Sassy, une fois un fait de S01E06 ; Rebecca à 12 min et Patricia justes ; Prince faux (« a demandé à Kimura de
  tuer Wataru » — l'ordre est donné à l'homme de l'hôpital — et « sans que le film ait encore révélé… », mots du
  lecteur) : ce cas de *Bullet Train* (une menace au téléphone, deux fils montés ensemble) reste le plus fragile.
  Aucun texte vide ni spoiler.
- **Le filet des mots de coulisse** (`META_WORDS`, `TIME_REF`, `metaTalk`, `core.ts`) prend désormais
  « attribué(e)(s) », « attribue », « attribution » et leurs équivalents (« attributed », « atribuido », « zugeschrieben »),
  et un horaire du lecteur : un nombre écrit en chiffres suivi de minutes (« jusqu'à 9 minutes », « à 12 min »,
  « 9 minutos », « 9 Minuten »). « Une minute de silence », « cinq minutes de retard » passent (sans chiffre) ; un
  horaire que l'histoire dit elle-même (« dans 7 minutes, je descends ») est excusé comme les autres mots ; les
  intitulés des sources (« jusqu'à 9 min ») ne comptent pas comme histoire. La phrase prise est retirée
  (« Jusqu'ici », `drop`) ou remplacée par la limite (questions). Rejoués dans le filet, les textes du banc qui
  justifiaient sortent vides plutôt que faux. Le rappel de la seconde demande (`metaReminder`) nomme « attribué » et la
  minute.
Tests : `ask-question-1027-2.test.ts` (l'horaire et « attribué » dans les quatre langues ; une minute de silence, un
horaire de l'histoire, un prix « attribué » par l'histoire passent ; à travers `AnswerGate`, la phrase à l'horaire
retirée et la phrase simple montrée) ; `ask-sofar-s7c.test.ts` (consigne octet pour octet, version 6) ;
`ask-sofar.test.ts` (la ligne dans les consignes série et film, version 7 et une clé de la v6 jamais relue ; tout
retiré au premier passage : un second avec le rappel, deux appels, jetons additionnés, `regénéré`, le texte gardé ;
encore vidé : la ligne discrète, rien de gardé, pas de troisième appel ; une phrase restée : un seul appel).

- **Le nom en tête, et la parole du lecteur au filet** (même version de l'app, `SOFAR_VERSION` 8). La consigne finit
  par « …puis la réponse, qui commence par le nom du personnage. », et le filet l'exige (`leadVerdict`, `core.ts`,
  option `lead` de `MetaOptions`, posée par `sofarRequest`) : la première phrase gardée commence par un mot du nom
  du personnage (après un article au besoin), ou par un nom que les répliques emploient comme tel — en majuscule au
  milieu d'une phrase, ou interpellé (« Coccinelle, attends ! ») ; les répliques seules, ni la distribution ni les
  résumés, où tous les noms sont écrits. Elle attend son premier nom avant de se montrer ; sans lui, elle est retirée
  comme une phrase de coulisse, et si rien ne reste, le second passage part. Pour « Jusqu'ici » seulement (une
  question peut parler du film ou d'un épisode), le filet prend aussi un code d'épisode (« Dans S01E07, elle… »), les
  titres d'épisodes des intitulés des sources (« dans « Deux as » »), « l'épisode en cours », « le film » / « du
  film » / « ce film » (« sans que le film ait encore révélé… »), « le spectateur », et leurs équivalents — excusés
  quand l'histoire les dit (un film sur un tournage). Limite connue : un nom des répliques n'est pas forcément celui
  du personnage présenté ; « Ted lui rend visite… » passe si « Ted » est interpellé dans les répliques.
- **Banc v8** (le code de `main`, le filet réel, 9 appels dont un second passage) : Sam « n'a pas encore eu de moment
  à lui. » ; Rebecca à 4 min deux fois Liverpool — la seconde après un premier passage vidé (« …dans la scène de la
  chambre. Dans l'épisode précédent, elle… » : « scène », puis pas de nom) et redemandé ; Claude juste deux fois ;
  Prince une fois juste et récent (« face à lui dans le train quand il est question de son pistolet saboté, destiné à
  exploser sur la Mort Blanche »), deux fois faux : « lui a ordonné à l'hôpital de tuer son fils Wataru », « Prince, à
  l'hôpital, présente Kimura comme l'homme qui doit la tuer ». C'est la scène d'X-Ray « Prince, Kimura, Hospital Thug »
  — l'appel du train et la chambre d'hôpital montés en alternance, fondus en une scène — : le modèle place Prince à
  l'hôpital et prête à Kimura l'ordre donné à l'homme de main. Le correctif est dans le découpage des scènes
  (service X-Ray), pas dans la consigne. Tests : `ask-question-1027-2.test.ts` (la parole du lecteur pour « Jusqu'ici »
  seulement, `leadVerdict`, une phrase sans nom retirée et la suivante gardée, « RIEN » intact) ; `ask-sofar.test.ts`
  (une réponse sans le nom en tête : un second passage ; version 8) ; `ask-sofar-s7c.test.ts` (la consigne octet pour
  octet).

**10.29.2 — le banc de bout en bout : cinq retouches au panneau d'une personne et autour.**

- **Le panneau d'une personne du lecteur n'a plus de champ libre** (décision du propriétaire). Ni le champ ni son
  clavier (`freeInput` = questions ouvertes **et** pas de personne ; `useKeyboardDiag` reçoit `enabled`) ; « Qu'est-il
  arrivé à X récemment ? » et « Que cherche X ? » sont retirées (« Jusqu'ici » dit déjà le récent), avec leurs clés
  (`xray.qRecent`, `xray.qWants`, quatre langues). Restent les liens (`personQuestions`, `xray/client.ts`) : « Quel est
  le lien entre <prénom> et <prénom> ? » avec les **autres personnages de la même scène d'« À l'écran »**, par temps à
  l'écran décroissant, deux au plus, un même prénom une fois. Personne d'autre dans la scène : aucune proposition (ni
  les trois d'office) — « Jusqu'ici » et les faits seulement. Une proposition touchée part comme avant (`about:
  "person"`, la même porte côté serveur), la réponse dans le panneau. Le champ libre reste au panneau d'un titre (fiches,
  bouton rond du lecteur). Ceci remplace la liste « Les questions proposées pour une personne » de §138.
- **« Jusqu'ici » attend après une panne passagère** (`sofarTransient`, `sofarNoteFailure`, `sofarWaiting`,
  `sofar.ts`). Le banc avait vu 43 appels refusés en quelques minutes après un 429 : rien n'était gardé d'une panne, et
  chaque toucher relançait le modèle. Une panne passagère (408, 429, 5xx dont 529, délai du chien de garde, réseau)
  ouvre une attente pour la clé **et** pour le compte : 2 min (`SOFAR_FAIL_WAIT_MS`), 10 min (`SOFAR_FAIL_WAIT_MAX_MS`)
  si elle revient dans la demi-heure qui suit, jamais plus ; en mémoire, bornée à 2 000 entrées. Pendant l'attente,
  `answerSofar` répond `{"t":"error","code":"erreur"}` (la ligne discrète) sans appeler le modèle, préparations comprises,
  et écrit `status: "attente-erreur"` avec `waitBy` (`clé` / `compte`) et `waitLeftS` à `recherche.log`. Une réponse
  (texte, « rien à dire », rejet) referme l'attente de la clé et du compte. Un refus du modèle ou une réponse coupée
  au plafond ne sont pas passagers : pannes ordinaires, redemandées. Le texte, « vide » et le rejet gardé une heure
  sont inchangés.
- **Les biographies de TMDB sans Markdown** (`stripSimpleMarkdown`, `format.ts`) : « *Atlanta* », « **Widows** »,
  « _x_ », « [titre](url) » s'affichaient tels quels. Nettoyé dans `selectBio`, que lisent les fiches d'acteur, la page
  de personne et le panneau du lecteur (`personFactsForPlayer`). Une étoile ou un trait bas qui ne marquent rien
  (« 5 * 3 », « mon_fichier ») restent.
- **Le relevé `xray-ui` dit ce que l'écran montre vraiment** (`effectiveLookOf`, `xrayUiDiag.ts`). Les lignes `row` du
  banc disaient `rowOpacity: 1` alors que tout le cadre du lecteur était à 0 (l'accueil à l'écran). `row` porte en plus
  `rowEffOpacity` / `firstEffOpacity` (produit des opacités jusqu'à la racine), `rowHiddenBy` / `firstHiddenBy`
  (`display` / `visibility` d'un ancêtre) et `rowTop` / `firstTop` (`elementFromPoint` au centre : `elle`, ou
  l'élément trouvé) ; `open` porte `panelEffOpacity` / `panelHiddenBy`. La route les borne ; l'activité ne les dit que
  quand ils s'écartent de « visible, elle dessus ».
- **Le lecteur se montre même sans image** (`useRevealAfterFrame`, `REVEAL_FALLBACK_MS` = 400 ms ; lecteur en ligne et
  hors ligne). `revealed` était posé par un seul `requestAnimationFrame` : sous charge, WebKit a laissé le cadre à
  l'opacité 0 de 2,6 à 9,3 s, le film derrière l'accueil. Le minuteur ne force que ce même état ; il est annulé quand
  l'image vient d'abord (le cas ordinaire : même ordre, empreintes inchangées) et au démontage. `revealed` ne règle que
  l'opacité et l'échelle du cadre (`nativeFrameStyle`, fondu de 220 ms) — pas l'ouverture de §60 (visuel, logo, ligne),
  montée et cadencée par l'hôte indépendamment, ni le départ du chargement ni les commandes ; `closing` l'emporte
  toujours (un lecteur qui se referme reste à 0).
Tests : `xray-person-panel.test.tsx`, `xray-onscreen.test.tsx` (liens seulement, par temps à l'écran, deux au plus,
aucun champ ; `panelEffOpacity` sous un ancêtre à 0) ; `ask-sofar.test.ts` (ce qui est passager ; après un 429, ni la
même clé, ni un autre compte, ni une autre clé du compte n'appellent le modèle ; 2 puis 10 min, borné ; une réponse
referme ; un refus n'attend pas) ; `format.test.ts` (Markdown retiré, étoiles isolées gardées) ;
`viewport-diag-route.test.ts` (les champs bornés) ; `xray-ui-reveal-10292.test.tsx` (`effectiveLookOf`, la ligne `row`
sous un cadre invisible, le filet de 400 ms, l'image d'abord sans minuteur restant, le démontage qui annule tout,
`closing` plus fort que `revealed`).

**10.30 — « Qui parle » dans « Jusqu'ici » et les questions** (10/11/2026, consigne du propriétaire). Les répliques de
l'épisode en cours ou du film portent le nom de qui les dit quand la voix est sûre (`src/lib/ask/voices.ts`) :
- **Seulement une analyse complète** (`speakerSegments` rend `null` tant que `/voices` dit `complete: false`, et pour un
  autre fichier, une option coupée, un service d'avant 10.30) : pendant l'analyse, rien ne change, jamais un nom
  provisoire. Aux questions, aussi seulement pour un compte à qui « À l'écran » est ouvert (`xrayOpenTo`). Un lien de
  partage n'a aucune fonction d'IA.
- **« Nom : » seulement si tout tient** (`speakerOf`) : une même voix nommée couvre au moins **60 %** de la réplique
  (élargie de 0,15 s de chaque côté) et c'est la voix qui en couvre le plus ; sa confiance est d'au moins 0,6 ; pas de
  désaccord (`conflict`) ; jamais une réplique à deux voix (un tiret en tête d'une ligne après la première —
  `parseSrt` le note, `twoSpeakers`, avec la fin, `endS`). Le nom est celui qu'« À l'écran » écrit (le personnage,
  sinon l'acteur) ; la consigne fait le reste (le nom des répliques quand il est clair).
- **La consigne change d'une règle, et seulement avec des noms** (`sources.voiced`) : « Une réplique précédée d'un nom
  (« Nom : … ») est dite par lui ; d'une réplique sans nom, ne déduis rien sur qui la dit, même juste après une des
  siennes. » remplace « Les répliques ne disent pas qui parle… » (« Jusqu'ici ») et « Les dialogues ne disent pas qui
  parle… » (questions) ; le titre du bloc dit « certaines précédées du nom de qui parle ». Sans voix, consignes et
  messages identiques à l'octet à ceux de 10.29.2 (vérifié au banc). `SOFAR_VERSION` 9. « … même juste après une des
  siennes » vient du banc : sans elle, Patricia (*MacGyver*, 34 min) recevait deux fois de suite la réplique sans nom
  qui suivait les siennes (« il pourrait être n'importe qui », de Mac).
- **Banc** (Haiku, 19 appels, un à la fois, aucun refus ; les huit cas difficiles des bancs précédents, avant / après) :
  après, Ted (4 min) « avoue au coach Beard avoir passé la nuit avec l'amie de Rebecca » (avant : « il est question de
  café ») ; Sam (10 min) « n'a pas encore eu de moment à lui » sans justification (avant : « sans qu'on lui attribue une
  réplique », retiré par le filet) ; Rupert (24 min) « fiancé à Bex… affronte Ted aux fléchettes » ; Jack (20 min)
  « lui demande s'il est sûr de vouloir voir seul une vidéo » (avant : « fait partie de ceux à qui l'on demande de
  quitter la pièce ») ; Prince (59 min) « reconnaît avoir fait venir Kimura pour qu'il échoue » ; Rebecca (4 et 12 min)
  inchangées et justes. Le seul écart d'attribution (Patricia) a conduit à la précision de la règle ci-dessus.
Tests : `ask-voices-1030.test.ts` (couverture, deux voix d'une même personne, tirets, confiance, désaccord, réplique sans
fin, analyse pas finie = rien, autre fichier = rien, « Nom : » dans les deux formes du bloc, consignes inchangées sans
voix) ; `recap-core.test.ts` (`endS`, `twoSpeakers`) ; `ask-sofar*.test.ts` (version 9).

**10.30.1 — le banc de bout en bout sur *Ted Lasso* S01E09 : répliques courtes, coupe à la scène en cours, Markdown.**

- **Une réplique courte avalée par le segment de l'autre reste sans nom** (`speakerOf` / `withSpeakers`, `voices.ts`,
  `SPEAKER_SHORT_S` = 1,1 s, `SPEAKER_NEIGHBOUR_COVER` = 0,5). Relu ligne à ligne, l'épisode avait 337 répliques
  nommées sur 546, dont 5 fausses — toutes d'environ une seconde : « Zut. » (Ted, au milieu de Keeley), « Quand ? »
  (Keeley, au milieu de Rebecca), « T'exagères. » (Ted, au milieu de Roy), « Quoi ? » et « Comment vous avez su ? »
  (Higgins, nommés Dani). L'analyse des voix découpe la parole en tronçons de plus d'une seconde : une réponse brève
  disparaît dans le segment de celui qui parle avant ou après. Désormais, une réplique de moins de 1,1 s (sans
  l'élargissement de 0,15 s) n'est pas nommée quand un segment de la voix qui la gagne couvre aussi au moins la moitié
  de la réplique d'avant ou d'après. Rejoué par le code livré : 321 nommées, aucune des cinq fausses, précision
  100 % (98,5 % avant), couverture 61,7 → 58,8 % (11 justes perdues). Sur les trois vérités de terrain étiquetées à la
  main, avec les voix v5 du service : *Ted Lasso* S01E08 342 justes / 18 fausses → 330 / 13, *MacGyver* S01E06 254 / 7
  → 252 / 7, *Bullet Train* 67 / 0 inchangé ; ensemble, précision 96,4 → 97,0 %, couverture 72,6 → 70,6 %. Le seuil :
  1,0 s laissait 3 des 5 erreurs de S01E09 ; 1,2 et 1,3 s retiraient plus de justes sans une erreur de moins ; une
  voisine « effleurée » (plus de zéro au lieu de la moitié) retirait 7 justes de plus. **Le contrat avec le service** :
  une petite voix (3 à 5 tronçons) n'est nommée qu'avec une confiance d'au moins 0,75 — appliqué côté `laterna-xray`,
  Laterna garde son seuil de 0,6 sur ce qu'il reçoit.
- **La coupe de « Jusqu'ici » tombe au début de la scène en cours** (`sofarCut`, `sofarCut.ts`, client et serveur ;
  consigne du propriétaire). Le symptôme : Rebecca à 13 min 43, coupe à 7 min 31 (la dernière scène commencée avant la
  marque de 10 min) — sa confession à Ted (10 min 57 à 13 min 10), juste vue, absente du texte. La règle livrée telle
  que demandée (le seul début de la scène en cours) ne suffisait pas sur ce cas : la confession est *dans* la scène
  11 min 02 – 13 min 55, qu'« À l'écran » ne coupe pas, et cette coupe à 11 min 02 la laissait encore dehors. D'où
  **un pas de deux minutes dans une longue scène** (`SOFAR_SCENE_STEP_S` = 120) : la coupe est le début de la scène,
  plus les pas déjà passés — Rebecca à 13 min 43 : 13 min 02. Ce qui reste : entre deux scènes (un trou de l'analyse),
  la fin de la précédente ; sans scènes, analyse qui ne va pas jusqu'à la position, ou avant la première scène, la
  marque des cinq minutes comme avant. **La position est prise en secondes entières dans `sofarCut`** : le serveur la
  reçoit ainsi (`readSofarBody`), le client a la position exacte, et un début de scène à 662,25 s donnait deux coupes
  et deux clés à 662,5 s. Les coupes restent rares (une par scène, une de plus par tranche de deux minutes) : un texte
  gardé sert à tous ceux qui sont au même endroit. `cutS` au journal ; `bucket` reste la marque des cinq minutes.
  `SOFAR_VERSION` 10 : aucun texte gardé sous l'ancienne coupe n'est relu.
- **Les réponses sans Markdown** (`stripEmphasisWord`, `core.ts`, dans `AnswerGate` — « Jusqu'ici » et questions).
  Le modèle écrit parfois « *Ted* » ou « **la confession** », et l'écran montrait les étoiles. Le filet reçoit la
  réponse mot par mot et une emphase en couvre plusieurs : chaque mot passe par `stripSimpleMarkdown` (`format.ts`, la
  règle des biographies), puis une ouverture seule en tête (« **la ») ou une fermeture seule en fin (« confession**. »)
  est retirée — **avant** tout contrôle, si bien que le filet des noms et le nom en tête lisent le mot sans étoiles ;
  la ligne « NOMS: » aussi. Une étoile isolée (« 5 * 3 »), un trait bas dans un mot restent ; « ** » seul ne laisse rien.
- **« X n'a pas encore eu de moment à lui » et qui il est** : rien à ajouter. Vérifié chez TMDB (crédits de l'épisode,
  de la saison, agrégés, en français et en anglais) : Nathan Shelley, Coach Beard, Sam Obisanya n'y ont que leur nom —
  aucun rôle (« intendant », « adjoint ») n'existe dans ces données. Quand le nom de crédit porte une description (*Bullet
  Train* : « Hospital Thug », « White Death's Wife »), elle est déjà dans la distribution envoyée. La consigne (« son nom,
  qui il est si on le sait ») est inchangée : le texte de Rebecca à 13 min 43 dit bien « ex-femme de Rupert Mannion et
  dirigeante du club » quand les éléments le disent.
- **Banc** (Haiku, 5 appels, un à la fois, aucun refus ; le code de la branche, une copie de la base) : Rebecca à
  13 min 43 (coupe 13 min 02) « Rebecca Welton, ex-femme de Rupert Mannion et dirigeante du club, avoue à Ted Lasso
  qu'elle lui a menti : elle l'a embauché pour faire perdre l'équipe et a saboté son travail. Elle lui présente ses
  excuses. » (avant : « …hésite à avouer à Ted une faute ancienne ») ; Nathan à 6 min 31 (coupe 6 min 03) « Nathan
  Shelley s'excuse d'une remarque qu'il juge sexiste sur les chaussures des femmes, puis laisse Rebecca Welton et Keeley
  Jones seules dans la pièce. » (avant : « n'a pas encore eu de moment à lui », coupe 3 min 57) ; Beard à 6 min 38
  « Coach Beard n'a pas encore eu de moment à lui. » (rien avant 6 min 03 ne le concerne) ; Roy à 27 min 18 (coupe
  26 min 36) « Roy Kent, capitaine de Richmond, s'excuse d'avoir traité Ted d'enfoiré. Ted lui conseille de dire qu'il
  est blessé, ce que Roy juge utile pour sa cote s'il veut partir. » ; Sam (S01E08, 9 min 59, coupe 9 min 59 — sa
  scène commence là) « Sam Obisanya n'a pas encore eu de moment à lui. » (inchangé). Tous justes, relus contre les
  répliques.
Tests : `ask-voices-1030.test.ts` (« Zut. » avec les segments réels sans nom, les répliques de Keeley gardent le leur ; seule
dans son segment, nommée ; au-dessus du seuil, nommée ; voisine effleurée ; sans voisines, la règle de 10.30) ;
`ask-sofar-cut.test.ts` (les scènes réelles de S01E09 : Rebecca à 823 s → 782 et la confession avant la coupe, Nathan et
Beard → 363, le pas d'une longue scène, le trou entre deux scènes, client et serveur à la même coupe sur toute la durée,
les replis) ; `ask-sofar.test.ts` (les répliques des scènes vues partent, celles de la scène en cours non ; deux positions
dans les deux premières minutes d'une scène, un appel ; version 10) ; `ask-question-1027-2.test.ts` (`stripEmphasisWord`,
une emphase sur plusieurs mots à travers `AnswerGate` avec le nom en tête, une question).

**10.30.2 — la coupe fine d'une première présence** (`sofarCutDetail`, `sofarCut.ts`, client et serveur ; consigne du
propriétaire).
- **Le symptôme** : *Ted Lasso* S01E09, Trent Crimm touché à 5 min 40, dans la conférence de presse (5 min 20 –
  5 min 48). La coupe au début de la scène (5 min 20) ne laissait rien de lui : « Trent Crimm n'a pas encore eu de
  moment à lui. » — juste, et inutile : il venait de recevoir la parole sous les yeux du spectateur.
- **La règle** : quand la personne paraît dans la scène en cours et dans **aucune scène commencée avant elle**, la
  coupe devient la position arrondie à la demi-minute en dessous (`SOFAR_PRESENT_STEP_S` = 30) — si c'est plus tard
  que la coupe ordinaire (à 5 min 25, la demi-minute tomberait avant le début de la scène : la coupe ordinaire reste).
  Jamais après la position : ce qui part a déjà été vu. Sinon rien ne change (Rebecca à 13 min 43 : 13 min 02 ; Keeley
  à 5 min, vue dès 2 min 11 : 3 min 57 ; une personne absente de la scène en cours : la coupe ordinaire).
- **Écart voulu — les seules présences d'« À l'écran »**. La consigne disait « rien d'elle dans les sources avant la
  coupe (présence ou réplique nommée) ». Les répliques nommées (« qui parle », §139 10.30) et les résumés des épisodes
  d'avant ne sont qu'au serveur ; le client, qui calcule la même coupe pour ses clés (préparation sur intention, textes
  déjà lus), ne les a pas — une coupe qu'il ne saurait pas refaire donnerait deux clés et une seconde génération. La
  décision lit donc les présences des scènes, que les deux côtés ont (`people[].personId` du `XrayPlayerPayload`).
  Conséquences : un personnage récurrent qui paraît pour la première fois **de l'épisode** dans la scène en cours a la
  coupe fine (plus de contexte, jamais de divulgation) ; une présence dans une scène antérieure suffit à garder la coupe
  ordinaire, même sans une réplique. Dans une longue scène, la présence dans la scène en cours ne compte pas comme
  « avant » : la personne y a la demi-minute plutôt que le pas de deux minutes.
- **Le journal dit pourquoi** : `cutWhy` à côté de `cutS` — `scene` (début de la scène en cours, ou fin de la
  précédente entre deux scènes), `step` (un pas de deux minutes), `present` (la demi-minute), `fallback` (la marque
  des cinq minutes). `SOFAR_VERSION` 11 : un « n'a pas encore eu de moment à lui » gardé sous l'ancienne coupe n'est
  plus relu.
- **Banc** (Haiku, 2 appels, un à la fois, aucun refus ; le code du dépôt, une copie de la base effacée après) : Trent
  à 5 min 40 (coupe 5 min 30, `present`) « Trent Crimm, que Ted présente comme journaliste du Daily Planet, se voit
  donner la parole par Ted, qui vient d'évoquer le dernier match de la saison contre Manchester City. » ; Rebecca à
  13 min 43 (coupe 13 min 02, `step`, inchangée) « Rebecca Welton, dirigeante du club, avoue à Ted qu'elle l'a engagé
  pour le faire échouer et qu'elle a saboté son travail. Il lui répond qu'il la pardonne. »
Tests : `ask-sofar-cut.test.ts` (les scènes réelles de S01E09 avec leurs présences : Trent à 340 s → 330, Rebecca à
823 s → 782, Keeley à 300 s → 237, une personne absente de la scène en cours, la demi-minute qui ne recule jamais la
coupe, la seconde entière, les raisons) ; `ask-sofar.test.ts` (`cutWhy` au journal ; version 11).

## 140. Les fonctions d'IA chez les trois fournisseurs, un seul plafond mensuel, et des réglages qui disent ce qu'ils demandent (09/11/2026)

**Règle.** Le fournisseur, la clé et le budget des sous-titres générés (§69) servent à **toutes** les
fonctions payantes, chez Anthropic, OpenAI et Google : sous-titres générés, recherche par description
(§135), « Précédemment » (§137), questions sur un titre, questions sur une personne et « Jusqu'ici »
(§139). Le budget (`SUBTITLE_GEN_BUDGET_USD`, nom et sens gardés : dollars par mois calendaire UTC, 5 $ par
défaut) devient leur **plafond commun**. La page des réglages dit, pour chaque fonction, ce qu'elle fait,
si elle coûte, ce qu'elle demande, à qui elle est ouverte, ce qui la bloque, et ce qui change d'un
fournisseur à l'autre. Décidé par le propriétaire ; le défaut reste Anthropic, et rien ne change pour une
installation qui l'emploie.

**Une seule voie d'appel.** Les fonctions qui ne passaient que par le SDK d'Anthropic appellent, pour OpenAI
et Gemini, la couche des sous-titres (`subtitleGen/providers/`, `TranslationProvider.complete`) : des
consignes, un message, un schéma JSON éventuel, une borne de sortie, l'usage en jetons — rien de plus n'est
demandé à un fournisseur. Le chemin Anthropic de chaque fonction reste tel quel (réflexion adaptative et
effort choisis au banc, flux des questions) ; il gagne seulement le comptage. Ce qui s'adapte :
- **la réflexion** : `effort` (`TranslationCall`) — `medium` pour « Précédemment » (ce qu'Anthropic a gagné
  au banc de §137), bas ailleurs ; OpenAI le lit en `reasoning.effort`, Gemini en `thinkingLevel` ;
- **le flux** : seules les questions d'Anthropic arrivent phrase par phrase ; chez OpenAI et Gemini la
  réponse arrive d'un bloc (30 s au plus, `MODEL_WHOLE_MS`) puis passe par le même `AnswerGate` — un
  refus devient `stop: "refusal"` (la panne dite), une réponse coupée `max_tokens`, une limite de débit
  garde son 429 ;
- **le cache** : Anthropic par points explicites (sous-titres), OpenAI et Gemini automatiquement sur les
  préfixes identiques — d'où l'ordre déjà en place partout : consignes et contexte stable d'abord, le
  variable (position, question) à la fin ;
- **le modèle** : hors sous-titres, toujours le rapide du fournisseur (`DEFAULT_MODELS` : Haiku 5.5,
  gpt-6-luna, gemini-3.8-flash, `featureSettings`) — ces réponses s'attendent devant l'écran. Les prix
  saisis à la main ne valent que pour ce même modèle. « Jusqu'ici » met le modèle dans la clé de ses textes
  gardés (`askModelName`) : un texte d'un fournisseur n'est jamais servi pour un autre ; chez Anthropic la
  clé ne change pas, les textes gardés restent.

Aucune fonction n'est restée « Claude seulement » : aucune ne demandait plus que cet appel générique. Les
garde-fous ne dépendent pas du fournisseur et s'appliquent à l'identique : fenêtre de ce qui a été vu,
contrôle des noms et des mots interdits (`AnswerGate`, `judgeRecap`), titres vérifiés dans TMDB, cache de
30 jours de « Jusqu'ici », limites par compte. **Seul Claude Haiku 5.5 a été mesuré sur banc** : la page le
dit, et dit que la qualité avec un autre fournisseur est l'affaire de l'administrateur.

**Le plafond, avant et après.** Avant : `subtitle_gen_spend` (un rang par mois) ne recevait que les lots de
sous-titres et la traduction des Nouveautés ; atteint, les tâches de sous-titres se mettaient en pause
(`budget`) et la création répondait 402. La recherche décrite, « Précédemment » et les questions n'étaient
comptées nulle part (seulement leurs jetons au journal). Après : chaque appel de chaque fonction y écrit son
coût exact (`recordAiSpend` : entrée, écriture et lecture du cache, sortie, au prix du modèle — refus et
réponses coupées compris, ils se paient), et le plafond atteint (`aiBudgetReached`) coupe chaque fonction
proprement :
- sous-titres : inchangé (pause `budget`, 402) ;
- recherche décrite : `describeSearchAvailable` faux — l'écran n'essaie plus, la recherche ordinaire reste ;
- « Précédemment » : le passage de fond ne prépare plus rien (vérifié aussi entre deux séries) ; les textes
  déjà prêts restent lus, puis le synopsis ;
- questions (titre et personne) : `{"t":"error","code":"budget"}`, dit à l'écran (`ask.budget`) ;
- « Jusqu'ici » : un texte déjà gardé est encore servi ; un texte à écrire répond `budget`, que l'écran tait.
Le premier franchissement du mois écrit une ligne `[tâche] ia · plafond mensuel atteint` dans `docker logs` ;
la carte de la Configuration le dit en clair et marque chaque fonction payante « en pause ». Un plafond
illisible en base ne coupe rien (le contrôle est sur le chemin de chaque fonction).

**Les prix (`pricing.ts`), relevés le 09/11/2026 sur les pages officielles** — Anthropic
(platform.claude.com/docs/en/about-claude/pricing), OpenAI (developers.openai.com/api/docs/pricing), Google
(aistudio.google.com/docs/pricing) — avec la date et les adresses en tête du fichier. Nouveau : les paliers
d'invite longue (`Price.long` : Haiku 5.5 au-delà de 100 000 jetons cache compris, OpenAI au-delà de
272 000), la lecture du cache de Gemini à son prix (elle était comptée au prix plein faute de tarif publié),
les changements de prix annoncés (gemini-3.8-flash au 01/01/2027, gemini-4-argon au 01/12/2026), et une liste
de modèles par fournisseur (`modelChoices`) que le champ propose, « Autre modèle… » restant libre. Un modèle
retiré, en aperçu, réservé ou « deprecated » n'est pas repris ; rien n'est deviné — un modèle hors table
demande les deux prix saisis.

**Les questions détachées (§139) et les prérequis dits.** `ASK_ENABLED` ne règle plus que les questions sur
un titre. Deux réglages de public (`off` / `admins` / `tous`) le rejoignent : `ASK_PERSON_ENABLED` (les questions
proposées du panneau d'une personne d'« À l'écran » — le champ y était encore, retiré en 10.29.2) et
`SOFAR_ENABLED` (« Jusqu'ici » et sa préparation — de fond à l'écriture de ceci, sur intention au bureau
depuis 10.27.2). **Vides, ils suivent `ASK_ENABLED`** (`inherits` dans le schéma, `config.ask.personAudience`
/ `sofarAudience`) : une installation réglée avant garde exactement ce qu'elle avait, sans migration de base.
Les deux demandent en plus les acteurs à l'écran branchés et ouverts à la session (§138) et un fournisseur
prêt (clé, prix connu). Chaque porte est au serveur : la route des questions lit `about: "person"` et répond
`off` selon le réglage de la question posée ; la configuration publique porte `askPersonAvailable` et
`sofarAvailable`, que le lecteur lit pour les propositions du panneau et la préparation sur intention. Sans eux, le panneau
d'une personne ne montre que ses faits TMDB (qui font partie des acteurs à l'écran, sans réglage à part). La
carte « Acteurs à l'écran » (Connexions) renvoie au guide de déploiement du service (`xray/README.md` sur le
dépôt) ; elle dit que l'analyse est gratuite et locale.

**Porteurs.** `src/lib/aiFeatures.ts` (`featureSettings`, `featureComplete`, `recordAiSpend`,
`aiBudgetReached`, `featureStatuses`, `askPersonAvailableFor`, `sofarAvailableFor`), `src/lib/aiFeatureTable.ts`
(la liste des fonctions et de leurs différences, lue par la page et les tests), `subtitleGen/pricing.ts`,
`subtitleGen/providers/{types,openai,google}.ts` (`effort`), `describeSearch.ts`, `recap/service.ts`,
`ask/service.ts`, `ask/sofarRequest.ts`, la route `cinema/ask/[itemId]`, `config/public`,
`components/settings/{AiFeaturesBlock,SubtitleGenCard,SettingsGroupCard}.tsx` (`choices`, `notes`, l'option
« comme les questions sur un titre »), `PlayerControls.tsx` et `AskPanel.tsx` (prop `sofar`).

**Tests.** `ai-providers-140.test.ts` (aiguillage par fournisseur doublé de chaque fonction, garde-fous
inchangés chez OpenAI, plafond commun qui coupe chacune, état vu par l'administrateur, combinaisons des
réglages détachés, textes de la page dans les quatre langues), `subtitleGen-pricing.test.ts` (cache par
fournisseur, paliers longs, dates, listes), `xray-person-panel.test.tsx` (questions sans « Jusqu'ici » et
l'inverse, ligne `budget`), `describe-search.test.ts`.

**Ce qui diffère exprès.** Les sous-titres gardent le modèle réglé ; les autres fonctions, le rapide. Le
plafond n'éteint pas l'affichage de ce qui est déjà payé (textes « Précédemment » et « Jusqu'ici » gardés).
Aucune vraie requête n'a été faite chez OpenAI ou Google (pas de clé) : leurs chemins sont prouvés contre un
double et contre leur documentation, pas contre leur API.

**10.28.0 — le coût dans Activité lu de la source du plafond.** Les tuiles de coût de 10.27.2 recalculaient la
dépense d'après les jetons de `recherche.log` au prix de Haiku : une seconde comptabilité, sans les sous-titres ni
les autres fournisseurs, qui pouvait dire autre chose que le plafond. `spendDb.add` écrit maintenant, dans une même
transaction, la ligne du mois (`subtitle_gen_spend`, que le plafond lit) et celle du jour UTC et de la fonction
(`ai_spend_days` : `subtitles`, `describe`, `recap`, `askTitle`, `askPerson`, `sofar`, `news`) ; `aiCostOf`
(`activity/dashboard.ts`) les lit, et le mois affiché **est** `aiBudget().spent`. La référence est le plafond réglé, en
dollars (« x $ sur y $ de plafond mensuel ») ; les euros, au taux fixe écrit dans le titre (≈ 0,92), sont dits
approximatifs. Les journées d'avant 10.28.0 n'existent pas (le mois en cours est entier). `anthropicUsage` compte
écriture et relecture du cache, chacune à son prix ; OpenAI et Gemini reçoivent le préfixe partagé en `stable` (leur
cache implicite). Tests : `ai-cost.test.ts`.

**10.28.1 — un appel interrompu se paie, et se compte.** La dépense d'Anthropic n'était écrite que dans
`stream.finalMessage().then(...)` ; interrompu, `finalMessage()` rejette (`APIUserAbortError`) et rien n'était
compté, alors qu'Anthropic facture l'entrée et ce qui a été produit. Interrompent un flux : le filet des noms
(question et « Jusqu'ici »), le premier passage d'une question redemandée (`retry`), le panneau refermé, le
chien de garde des 20 s. Chaque appel est maintenant compté **une fois**, fini ou non (`count` dans
`ask/service.ts`) : sur un rejet, `partialAnthropicUsage(stream.currentMessage)` (`src/lib/aiUsage.ts`) —
l'instantané que le SDK 1.6.0 garde après l'interruption : entrée et cache **exacts** (`message_start`), sortie
au moins ce qui a été reçu (le compteur, ou texte et réflexion reçus à quatre caractères par jeton ; le total
n'arrive qu'au `message_delta` de la fin). Le même relevé part avec la panne d'un lot de sous-titres en flux
(`subtitleGen/providers/anthropic.ts`). Un appel sans flux coupé par le délai ou par nous (recherche décrite,
« Précédemment » : `anthropicTimed` ; OpenAI et Gemini : `featureComplete` quand son `signal` est levé) ne rend
aucun compteur : son entrée est estimée sur le texte envoyé, sans sortie. Coupé avant `message_start`, rien n'est
compté (rien de connu). Tests : `ai-spend-abort-10281.test.ts` (le vrai `MessageStream` du SDK, le transport en
double : flux interrompu, flux fini, question rejetée, panneau refermé, « Jusqu'ici » rejeté puis rouvert).

## 141. La synchro des sous-titres : mesurée à la demande, corrigée à l'affichage (10/11/2026)

**Règle.** Un sous-titre texte peut être décalé ou dériver par rapport à la parole du fichier (une version
faite pour un autre montage, une autre cadence d'image). `laterna-xray` le **mesure** — modèle
`t_parole = a + s · t_sous-titre`, verdicts `ok` / `décalé` / `dérive` / `incertain` / `montage` / `image` /
`peu-de-répliques` (méthode : `xray/docs/PIPELINE.md`, « 11. Synchro des sous-titres ») — et Laterna
**applique** la correction à l'affichage. Trois interdits du propriétaire, tenus par construction :
- **rien sans un clic** : une mesure ne part que de « Scanner » (Configuration → Synchro des sous-titres,
  `launchScan`), une correction ne s'applique que par « Recaler » (`decideScope`). Le planificateur des acteurs
  à l'écran n'en sait rien ; les résultats ne sont relus que tant qu'une mesure demandée n'est pas revenue
  (`pullPending`, un minuteur qui s'arrête seul) ;
- **jamais un fichier modifié** : ni la vidéo, ni le sous-titre (liens de seed, médiathèque en lecture seule) —
  la correction vit dans `cine.db` (`subtitle_sync`) ;
- **les sous-titres en images** (PGS, VobSub) sont hors champ : listés avec le verdict `image`, jamais mesurés.

**La version du fichier.** Une mesure garde l'`ETag` Jellyfin du fichier mesuré (`media_etag`, et la taille et
la date d'un fichier à côté, que le service lit). Une correction n'est lue **que pour l'`ETag` que Jellyfin
donne maintenant** (`appliedFor`) : un fichier remplacé rend la ligne périmée, jamais appliquée, et « Recaler »
la refuse (la version est relue chez Jellyfin au moment de décider). Une nouvelle mesure du même fichier qui dit
la même chose garde la décision ; une mesure différente revient à « mesuré » (`recordMeasurement`). Limite
connue : un fichier à côté réécrit au même chemin (Bazarr qui en trouve un meilleur) ne change pas l'`ETag` de
la vidéo — la correction resterait lue jusqu'à la mesure suivante, qui la remet à « mesuré ».

**Une saison, une série, un élément entier** ne recalent que des mesures **fiables** d'un décalage ou d'une
dérive (`APPLICABLE_VERDICTS`, `decide(…, { strict: true })`) ; une piste seule, toute mesure qui a un décalage
(l'administrateur l'a regardée).

**Porteurs.**
- `src/lib/subtitleSync.ts` (pur, client et serveur) : `cueLookupTime(p, fileDelay, offset, scale, onFileClock)`
  — fichier à côté `(p − fileDelay − offset) / scale`, piste du conteneur `fileDelay + (p − fileDelay − offset) /
  scale`, **à l'échelle 1 le calcul d'avant opération pour opération** ; `rewriteVttTimes` (`t → a + s·t`) ;
  `subtitleTrackKey` (`emb:<index>` / `ext:<chemin>`) ; `startingOffset` ; `subSyncLogField`.
- `src/lib/subtitleSync/store.ts` : `recordMeasurement`, `appliedFor`, `subtitleSyncByIndex` (clé → index
  Jellyfin, pour les trois lecteurs), `decide`, la file des mesures demandées.
- `src/lib/subtitleSync/admin.ts` : `launchScan`, `pullPending`, `treeView`, `seriesView`, `decideScope`.

**Appelants.**
- **Lecteur natif** : la description du fichier porte `subtitleSync` (par index Jellyfin) seulement s'il y a une
  correction (`/api/jellyfin/direct`) — aucune requête de plus ; `useNativeSubtitleLanes` (`syncForChoice` au
  choix d'une piste : le décalage du menu part de la correction, le spectateur l'ajuste encore ; `showSubtitleAt`
  et `showSecondAt` par `cueLookupTime`), `useNativeSubtitleGeneration` et `noteSeekRequest` (générations : échelle
  1, jamais corrigées). Ligne `start` : `subSync` seulement avec une correction.
- **Lecteur serveur** : `playback/start` ajoute `&sync=<version de la décision>` à l'adresse d'une piste recalée
  (l'adresse est gardée une heure en cache) et `sync: {offset, scale}` ; la route des sous-titres réécrit alors le
  WebVTT (`syncForSubtitleStream`, version relue chez Jellyfin). Les contrôles du lecteur serveur décalent ensuite
  par rapport au fichier corrigé (ils partent de 0). Ligne `start` : `subSync` (`subSyncFromTracks`).
- **Téléchargements** : `/api/offline/subtitles` ajoute le même `&sync=` ; le fichier gardé sur l'appareil est déjà
  corrigé.

**Ce qui diffère exprès.** Le lecteur natif applique la correction **à chaque recherche de ligne** et ne demande
jamais `&sync=` (sinon elle s'appliquerait deux fois) ; le lecteur serveur et les téléchargements lisent un WebVTT
réécrit. Une diffusion (sous-titres dans le flux, `subtitlesInStream`, ou incrustés, `burnSubtitles`) n'est pas
corrigée : rien ne réécrit ces chemins-là.

**Pas de réglage, pas d'option publique.** La page n'a d'effet qu'avec les acteurs à l'écran branchés
(`xrayConfigured`) ; le lecteur ne lit rien de plus sans correction — les empreintes du lecteur sont inchangées.

**Tests.** `subtitle-sync.test.ts` (`cueLookupTime` à l'échelle 1 bit pour bit sur 20 000 tirages, modèle,
réécriture, clés, portées), `subtitle-sync-store.test.ts` (rien d'office, version, portée stricte, décision qui
survit ou non), `subtitle-sync-routes.test.ts` (proxy et routes administrateur seul, portées refusées, scan d'une
série, relecture seulement en attente, mesure d'un autre fichier écartée, recaler une saison périmée refusé, la
route des sous-titres qui réécrit seulement avec `&sync=`), `subtitle-sync-card.test.tsx` (la page) ; côté service
`xray/tests/test_subsync.py`.

## 142. La Configuration : une place par fonction, et ce qui lui manque dit sur sa carte (10/11/2026)

**Règle.** Chaque réglage réglable dans l'application se montre **sur une page et une seule** de la
Configuration, et la page d'un réglage est écrite une fois, dans `CONFIG_LAYOUT`
(`src/lib/settings/configLayout.ts`) — les pages lisent leurs cartes là, aucune ne tient sa liste. La
disposition, validée par le propriétaire :
- **Connexions** : les services seulement — adresse, clé, test —, le service des acteurs à l'écran compris
  (`XRAY_URL`, `XRAY_API_KEY`), et la carte Application (`POSTER_PREWARM`, `VAPID_SUBJECT`).
- **Lecture** : le lecteur seulement (`PLAYER_ENABLED`, `PLAYER_SERVER_FALLBACK`).
- **Diffusion et hors-ligne** : le Chromecast (`CHROMECAST_FOR_EVERYONE`, `CAST_RECEIVER_APP_ID`), puis les
  téléchargements (`OFFLINE_*`).
- **Livres** : `BOOKS_ENABLED`, puis les demandes et Google Books, qui disent ne rien faire sans lui.
- **Fonctions intelligentes**, un groupe de la navigation : **Intelligence artificielle** (`/parametres/ia` : le
  fournisseur commun — `SUBTITLE_GEN_PROVIDER`, `_API_KEY`, `_MODEL`, `_BUDGET_USD`, `_PRICE_*` —, la dépense
  et le tableau par fournisseur, puis une carte par fonction : sous-titres générés avec leurs tâches,
  recherche par description, « Précédemment », questions sur un titre, sur un acteur, « Jusqu'ici ») ;
  **Acteurs à l'écran** (`XRAY_ENABLED`, l'analyse de la bibliothèque, la qualité des noms — la place des
  réglages propres à la fonction qui viendront, entre l'interrupteur et l'analyse) ; **Synchro des
  sous-titres** ; **Recherche de répliques** ; **Recadrage automatique** (`PLAYER_AUTO_FRAME`).
- **Installation** : Nouveaux comptes, Administrateur, Déploiement — inchangés.

**Une carte de fonction dit toujours la même chose, au même endroit** : son interrupteur ou son public ; ce
dont elle a besoin (`needs` : `aiKey`, `xrayService`, `xrayOn`, `booksOn`, `playerOn`), écrit même quand tout
est là (« Nécessite une clé d'IA : prêt ») ; quand un besoin manque d'après les réglages **enregistrés**, la
carte s'estompe — ses champs restent modifiables, on peut préparer avant de brancher — et un lien mène où
il se règle (`NEED_HREF`) ; et son état en une ligne quand le serveur le donne sans frais (`featureStatuses`,
§140, lu par `/api/subtitle-gen/admin` : public, raison du blocage, payant ou non). `missingNeeds` applique les
règles du serveur (`xrayConfigured`, `featureSettings().hasKey`, `config.player.enabled`, `config.books.enabled`).

**Rien ne change pour une installation existante.** Ni clé renommée, ni groupe du schéma déplacé, ni défaut :
une carte prend un groupe de `schema.ts` et quelques-unes de ses clés, et n'enregistre que celles-là. Les
clés `SUBTITLE_GEN_*` gardent le nom qu'elles avaient quand les sous-titres étaient seuls à s'en servir ;
seuls leurs libellés disent « fournisseur d'IA ». Les adresses gardent leur nom (`/parametres/acteurs`,
`/repliques`, `/synchro-sous-titres`) : la navigation est regroupée sans lien à réécrire. Une seule a changé,
`/parametres/sous-titres` → `/parametres/ia`, parce qu'elle nommait une fonction parmi six ; l'ancienne
répond `308` (`permanentRedirect`, comme les adresses déplacées du proxy) et reste à l'administrateur par son
premier segment (`ADMIN_ONLY_PAGES`).

**Pourquoi.** « Sous-titres » tenait toutes les fonctions d'IA ; « Lecture » mêlait le lecteur, le
hors-ligne, les livres, le Chromecast et le recadrage ; les acteurs à l'écran étaient coupés en deux
(l'interrupteur dans Connexions, l'analyse ailleurs) ; et ce qui empêchait une fonction de marcher se lisait
dans une phrase sous un champ, sans chemin vers la cause.

**Porteurs.** `src/lib/settings/configLayout.ts` (`CONFIG_LAYOUT`, `CUSTOM_CARD_GROUPS`, `missingNeeds`,
`NEED_HREF`), `src/components/settings/ConfigurationSection.tsx` (`FeatureState`), `FeatureNeeds.tsx`
(`FeatureNeeds`, `FeatureNeedsNotice` pour une page à carte propre), `SettingsGroupCard.tsx` (`titleKey`,
`anchor`, `status`, `needs`, `dimmed` ; le test de connexion seulement sur une carte qui montre une adresse),
`SubtitleGenCard.tsx` (`AiProviderCard`, `SubtitleJobs`, `useAiAdmin`), `AiFeaturesBlock.tsx`
(`featureStateLine`), `src/components/navItems.ts` (trois groupes dans la partie Configuration).

**Appelants.** Les pages `src/app/(dashboard)/parametres/**` ; la synchro des sous-titres
(`FeatureNeedsNotice`).

**Ce qui diffère exprès.** La recherche de répliques garde sa carte propre (`DialogueSearchCard`, qui
enregistre ses clés et refuse l'option sans dossier des films monté) : `CUSTOM_CARD_GROUPS`. La feuille de
navigation du téléphone reste à plat par partie (§81) : les intitulés de groupe n'y sont pas.

**Tests.** `config-layout.test.ts` (chaque réglage une fois et une seule, clés dans le groupe de leur carte,
Connexions et Lecture réduites, une carte d'état par fonction de la table §140 avec les mêmes besoins, textes
dans les quatre langues, `missingNeeds`, liens vers des pages qui existent, pages réservées, redirection 308,
pages sans liste à elles), `config-layout-ui.test.tsx` (carte estompée et lien quand la clé d'IA ou le service
manque, état du serveur, Connexions sans interrupteur X-Ray), `navItems.test.ts` (trois groupes, entrée active).

## 143. « Revenir au début de la scène » : un vrai début de scène, ou rien — livré coupé (10/11/2026)

**État : laboratoire (« Lab bêta »), coupé.** Une passe à l'aveugle sur 24 titres jamais vus, avec les règles
resserrées (`cutsVersion` 2), n'a couvert qu'environ 1,5 % des reprises et a trouvé un renvoi trop tôt (un
prologue monté en séquence courte) : le « zéro faux » n'est pas acquis. La carte de Configuration porte
l'étiquette « Lab bêta » (`lab` dans `CONFIG_LAYOUT`), son texte dit de la laisser coupée, et **rien d'autre ne
s'appuie sur ces débuts de scène** — la rangée « À l'écran » et « Jusqu'ici » lisent les scènes, jamais `cut`.
Piste étudiée pour plus tard : une combinaison apprise d'indices image et son (couleurs, visages, voix, silences,
ambiance sonore, lieu), validée sur des titres tenus à part avant tout rallumage.

**Règle.** À la reprise d'un titre laissé **depuis quatre heures au moins**, un bouton propose, huit secondes à
partir de la première image, de revenir au début de la scène en cours — **seulement si ce début en est un vrai**.
Une scène de `laterna-xray` est un regroupement de plans par les couleurs et les visages : une de ses frontières
peut tomber au milieu d'un dialogue, entre deux angles d'une même pièce ou dans un montage sans personne. Le
service dit donc, **frontière par frontière**, si l'on peut y revenir et d'où partir (`xray/app/scenecuts.py`,
`xray/docs/PIPELINE.md` « 12. Débuts de scène ») :
- `entry` : une phrase commencée 3 s au plus avant la coupe y ramène le point d'entrée ;
- `cut: {ok, why}` — sûre : `début`, `après-saut` (après une plage sautée), `chapitre` (un chapitre d'auteur à 2 s
  près ; des chapitres à intervalles égaux sont automatiques, ignorés), `deux-signaux` (**choix du propriétaire** :
  les couleurs changent, `sim` ≤ 0,82, **et** les personnes aussi, Jaccard des groupes de visages ≤ 0,15 avec deux
  groupes au moins de chaque côté) ; refusée : `parole` (une phrase traverse la coupe depuis plus de 3 s),
  `même-lieu`, `montage` (deux scènes de moins de 25 s sans visage ni parole), `îlot` (une scène sûre de moins d'une
  minute entre deux refus). R&D du 10/11/2026 sur 44 frontières jugées à l'œil (*Ted Lasso*, *Le Flambeau*,
  *House of the Dragon*) : un seul signal acceptait 7 fausses frontières sur 22.
- **`cutsVersion` 2** (10/11/2026, service 1.6.0), après les îlots et pour `deux-signaux` seulement (les chapitres
  d'auteur, tous justes à la mesure, n'y passent pas) : refusée `court` (la scène d'avant ou d'après dure moins de
  40 s, `SHORT_SCENE_S`), `muet` (personne ne parle dans les 60 s après le point d'entrée, `FIRST_SPEECH_MAX_S`),
  `enchaîné` (moins de 1,5 s de silence en tout de part et d'autre du point d'entrée, `CUT_QUIET_MIN_S` : la
  conversation continue par-dessus le changement de plan) ;
- `pauses` (version 2) : chaque silence d'au moins 5 s qui suit une prise de parole, `[début, fin]`, dans la scène
  où il **commence** (sa fin peut la dépasser : Laterna le mesure entier).

Les règles s'appliquent **à la lecture** de `/scenes` : `CUTS_VERSION` (servie comme `cutsVersion`) ne touche pas
aux mesures gardées, qui portent leur propre version, `BOUNDS_VERSION` (1) — monter la première vaut aussitôt pour
tous les résultats mesurés, sans rattrapage ; seule la seconde relance `backfill_some`.

Côté Laterna, la décision est **une fonction pure**, `decideSceneRestart` (`src/lib/sceneRestart.ts`), dans l'ordre
de ses refus : analyse complète et mesurée, parole connue et ≥ 20 % du temps, absence ≥ 4 h (Jellyfin,
`UserData.LastPlayedDate`), ni saut ni changement de piste avant la première image, pas dans la première minute,
ni dans l'intro, le récap, le générique de fin ou les dernières scènes sans visage, aucune coupe sûre dans les
20 dernières secondes ; la cible est la dernière coupe sûre ≥ 20 s avant la position, à son `entry`, de 20 à
**90 s** en arrière (`trop-loin`), jamais `début` ni `après-saut` (`cible-début`, `cible-après-saut` : des bords de
l'analyse, pas des débuts reconnus) ; **aucune frontière refusée** entre la cible et la position, `même-lieu`
compris (`coupe-<raison>`), ni sans verdict (`coupe-inconnue`) ; chaque scène de la cible à la position porte ses
silences (sinon `pauses-inconnues` : un service en `cutsVersion` 1 ne fait rien proposer) et **aucun silence de 5 s**
ou plus ne commence après le point d'entrée et avant la position, mesuré jusqu'à elle (`pause`).

**Le resserrement (10/11/2026).** Seconde R&D : 17 titres (films et séries, dialogues et action), une position de
reprise toutes les 10 s (6 850 positions), chaque cible jugée à l'œil sur ses images, et « trop tôt » quand la scène
regardée avait changé entre la cible et la position. Règles de la première version (cible jusqu'à 3 min, en
enjambant les `même-lieu`) : bouton à 21,8 % des positions, bonne cible 64 % du temps seulement. Avec la
`cutsVersion` 2 et les règles ci-dessus : **3,2 %** des positions, 49 cibles, recul médian 44 s, **toutes justes**
(217 propositions sur 217). Le bouton paraît rarement — c'est voulu : il ne doit jamais ramener ailleurs.

**Livré coupé.** `SCENE_RESTART_ENABLED` (public `off` / `admins` / `tous`, défaut `off`, groupe des acteurs à
l'écran) : coupé, le bouton n'est jamais montré, mais la décision tourne là où « À l'écran » a déjà lu les scènes
et le bilan `stop` porte `sceneRestart: "aurait-proposé" | "non:<raison>"` — de quoi mesurer avant d'allumer.
Allumé : `proposé:<utilisé|ignoré|saut|fermé>` sur le bilan, et une ligne `debut-scene` par séance (issue, position,
cible, recul). Sans les acteurs à l'écran (option coupée, Fire TV, lecteur hors ligne, banc), **rien** : ni
décision, ni champ.

**Une fois par séance.** Une reconstruction du lecteur natif ou un passage de main au lecteur serveur remonte les
commandes ; la décision n'est pas reprise (`sceneRestartSession.ts`, un magasin par élément, fini par la ligne
`stop` — `endSceneRestart`). La dernière lecture y est **gelée à l'ouverture** : les rapports de progression
avancent `LastPlayedDate` pendant la séance, et une relecture dirait « il y a une minute ».

**Porteurs.**
- Service : `scenecuts.boundary_features` (à l'assemblage, `results._assemble` → `Built.bounds`, gardé dans
  `results.bounds_json`), `scenecuts.annotate` (à la lecture de `/scenes`, avec les zones de parole et les chapitres
  — `items.chapters_json`, ffprobe une fois à la fin de l'analyse), `scenecuts.backfill_some` (les résultats d'avant,
  sans décoder : regroupement refait depuis la base, seules les mesures écrites ; frontière regroupée autrement
  qu'à l'époque laissée sans verdict). Version propre `CUTS_VERSION` : **`RESULT_VERSION` ne bouge pas**, les
  scènes et leurs personnes restent octet pour octet.
- Laterna : `decideSceneRestart` ; `sceneRestartSession.ts` ; `useSceneRestart` (`playerControls/`) ;
  le bouton dans `PlayerPrompts`, à la place de « Passer l'intro / le récap », qui garde la priorité.

**Appelants.** `PlayerControls` (les trois hôtes : natif, serveur, hors ligne — ce dernier sans acteurs à
l'écran) ; `playback-state` donne `lastPlayedAt` (aucune requête de plus : `fetchPlaybackState` et
`resolveResumeAt` la notent) ; les bilans `stop` du natif (`useNativeSessionRecord`) et du serveur
(`useServerSessionRecord`) ; `sceneRestartAvailable` dans `/api/config/public`, **suivi, jamais demandé**, absent
des doubles des empreintes — elles ne bougent pas.

**Ce qui diffère exprès.** La première minute du fichier est refusée sur la *position*, et le début du fichier
n'est jamais une cible (`cible-début`) ; `début` et `après-saut` restent pourtant des coupes sûres pour le reste
(une reprise juste après est une `scène-récente`, et l'on ne remonte pas par-dessus une plage sautée). Le lecteur serveur ouvert seul ne lit `playback-state` que s'il ne connaît pas sa
position : sinon `absence-inconnue`.

**Tests.** `scene-restart-143.test.ts` (la décision sur les frontières de *Ted Lasso* et du *Flambeau* telles que
le service les rendait en version 1, les cibles refusées, le recul de 90 s, les silences, la séance, le journal), `scene-restart-hook-143.test.tsx` (coupé : mesuré et jamais montré ;
allumé : huit secondes, issues, une fois par séance), `scene-restart-payload-143.test.ts` (le passage par
`scenesForPlayer`), `jellyfin-playback-state-route.test.ts` (`lastPlayedAt`) ; côté service
`xray/tests/test_scenecuts.py` (chapitres, mesures, entrée, règles, deux signaux resserrés, silences, `/scenes`
inchangé sans mesure, résultats d'avant, règles nouvelles sans nouvelle mesure).

## 144. Le mode « Immersion » : une affiche de plus dans la recherche, et un projet à part (10/11/2026)

**La règle.** Chercher exactement « immersion » (espaces et casse ignorés) pose en tête des résultats une
affiche de plus, « Le Chalet », au format de toutes les autres. La presser n'ouvre pas une fiche : la page part
vers `/immersion` par une navigation ordinaire. Tout autre mot — « immersio », « immersion totale » — reste une
recherche. Rien d'autre dans l'application ne mène au mode, et rien ne l'annonce.

**Une fonction.** `isImmersionQuery` et `enterImmersion` (`src/lib/immersionTrigger.ts`), avec l'adresse de la
page, celle de l'affiche et son titre. **Un appelant** : `PlayerSearchPanel` (la carte est un `PlayerResultCard`
ordinaire, sous les puces « Tout » et « Films »).

**Ce que l'application en sait, et pas plus.** Le mode est un projet à part — `immersion/` à la racine, ses
dépendances (three), son build (une étape du `Dockerfile`), ses tests (Playwright), son journal
(`immersion/PROGRESS.md`). L'application ne fait que servir son build : la page par `src/app/immersion/route.ts`,
ses fichiers par `src/app/api/immersion/[...path]/route.ts`, tous deux par `serveImmersionFile`
(`src/lib/immersionFiles.ts`). Sous `/api/` et non dans `public/` : le service worker recopie dans son cache tout
GET hors `/api/` qui n'est ni une image ni une page, et ce cache n'est jamais purgé. Derrière le proxy comme
toute adresse : sans session, la page renvoie à la connexion et ses fichiers répondent 401 ; un lien de partage
n'y a pas accès (liste fermée). `immersion/` est exclu du typage, du lint et des tests de l'application
(`tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`), comme `streamdeck-plugin`.

**Différent exprès.** Le lecteur du mode n'est pas celui de l'application : il passe par la négociation du
lecteur serveur (`POST /api/jellyfin/playback/start`, son toujours en stéréo, conversion HDR → SDR par le
serveur pour les fichiers HDR). Ses lignes dans `player.log` portent `player: "immersion"` — jamais celles du
lecteur serveur : l'activité les reconnaît (`playerOf`, `seances.ts`) et les tient hors du diagnostic
fichier-ou-appareil (`diagnosis.ts`), qui parle des deux lecteurs de l'application. Les empreintes du lecteur ne
le connaissent pas. Depuis la v2 (11/11/2026) il choisit sa piste audio — la négociation est refaite avec
`audioStreamIndex`, à la position où l'on est — et lit les sous-titres texte par la route du lecteur serveur
(`/api/jellyfin/stream/subtitle/…`), nommés par `@/lib/trackLabel` comme dans l'application.

**Ordinateur et tactile (v2).** Le mode se visitait à la souris et au clavier seulement ; il se pilote aussi au
doigt (un manche à gauche, le regard à droite, des boutons pour les gestes du clavier), téléphone tenu en
paysage. Rien ne change côté application : l'affiche de la recherche est la même sur tous les appareils.

**Sa mesure.** Le bouton « Mesurer » de ses réglages joue un parcours fixe par préréglage, avec et sans vidéo,
et envoie une ligne par passage à `startup.log` (`kind: "immersion-bench"`, par `/api/viewport-diag` — le mode n'a
pas d'autre journal) : cadence moyenne, 1 % le plus lent, carte graphique annoncée par le navigateur, définition
réellement rendue — et, depuis 10.34.4, les à-coups : la pire image (`maxMs`), le nombre d'images de plus de 33 et
50 ms (`over33`, `over50`) et où sur le parcours tombent les cinq pires (`slowAt`, « 0.42:61;… ») ; un « 1 % le plus
lent » bas ne disait pas s'il venait d'un endroit de la maison ou de sursauts réguliers. « Avec vidéo » joue le film
en cours, sinon une mire qui est un vrai fichier 1080p (dessinée dans la page, elle pesait sur la mesure). Champs
connus et bornés, compte tiré de la session, comme les autres relevés de cette route.

**Son réglage « Auto » au journal (10.37.0).** Une ligne par visite, envoyée quand la page s'en va
(`kind: "immersion-auto"`, même route) : niveaux de départ, d'arrivée, pire et meilleur, chaque changement
(`secondes:de>vers` suivi de `f` cadence, `a` à-coups, `m` marge pour remonter), la cadence moyenne et les images de
plus de 50 ms. Sans elle, rien ne disait si « Auto » avait trouvé son niveau.

**Chaque visite au journal, et ses erreurs (11/11/2026).** La ligne `immersion-auto` part maintenant à chaque visite,
« Auto » ou non (le nom est resté pour ne pas couper la suite des lignes) : la qualité choisie (`quality`), la phase la
plus avancée atteinte (`phase`) et celle du départ (`end`), la durée depuis l'ouverture de la page (`seconds`, origine
aussi des secondes de `changes`), le nombre d'erreurs (`errors`) et de pertes du contexte WebGL (`contextLost`) ;
les champs d'« Auto » sont `null` et `auto: false` quand il n'a pas tourné. Qualité et phases sont des listes fermées
dans la route. Les erreurs elles-mêmes vont où vont celles du cinéma — `/api/client-error`, `scope: "client"` dans
`server.log` — avec une source `immersion:window`, `immersion:rejection`, `immersion:crash` (la barrière de l'écran de
secours) ou `immersion:webgl` (le contexte perdu, avec l'instant, la qualité et la pièce) : un visiteur avait vu « des
écrans noirs en marchant » et rien n'en restait. Le mode a son propre émetteur (`immersion/src/lib/errorLog.ts`, même
corps que `reportClientError`) parce qu'il s'arrête au premier refus 4xx — le pare-feu bannit sur les 4xx répétées,
et une session expirée répondrait 403 à chaque erreur — et qu'il s'en tient à cinq envois par visite.

**Le pare-feu (10.36.0).** Le mode ne demande ses décors qu'en trois paquets (`immersion/vite.config.ts`,
`assetPacks`) : CrowdSec bannit de tout le serveur une adresse qui demande plus de ~40 noms de fichiers non
statiques distincts en rafale, et le chalet en demandait 73. Le garde-fou est `immersion/tests/e2e/15-requetes`.

**Tests.** `immersion-trigger.test.ts` (le mot exact, l'adresse, et aucun import de three ni du projet dans
`src/`), `immersion-files.test.ts` (types servis, cache, `.br` par les marqueurs de §131, jamais hors du dossier,
404 sans build), `immersion-proxy.test.ts` (307 vers la connexion pour la page, 401 pour les fichiers, hors des
listes publiques, porte des liens de partage), `immersion-activity.test.ts` (reconnu, hors du diagnostic),
`viewport-diag-route.test.ts` (les lignes `immersion-bench` et `immersion-auto`, avec ou sans « Auto ») ; de bout en
bout, `immersion/tests/e2e/` (`16-auto` : la ligne de visite hors « Auto », une erreur et une perte du contexte
envoyées et comptées).

## 145. Les tâches de fond ont un interrupteur, pour les copies de l'application (11/11/2026)

**La règle.** `CINE_BACKGROUND_JOBS=off` : le serveur sert ses pages et ses routes, et rien ne part de
lui-même — ni notification, ni ménage ou écriture dans Jellyfin, ni masquage des demandes, ni planificateur,
ni appel payant. Seuls restent les préchauffages en lecture du catalogue (`startCatalogueWarm`, et les deux
lectures de la fin de `instrumentation.ts`), sans lesquels une instance n'ouvrirait pas comme la production.
Variable absente, ou toute autre valeur : les tâches tournent. La production ne règle rien.

**Pourquoi.** Une copie de l'application lancée à côté de la vraie — le banc du lecteur
(`tools/regress-lecteur/`), une instance d'essai — démarre avec les adresses et les clés de la production :
ses tâches de fond agissent sur les **vrais** services, avec une base recopiée qui n'a pas tout. Le 10/11/2026,
une instance du banc restée sept heures a retiré toutes les cinq minutes le tag de masquage des 92 titres cachés
à un compte (sa base n'avait pas les décisions) ; la production le remettait à son passage suivant. `regress.sh`
neutralisait les tâches une à une (`REPLIQUES_*`, `NEW_ACCOUNT_BLOCKED_TAGS`) : la dernière-née passait toujours.

**Une fonction.** `backgroundJobsEnabled` (`src/lib/backgroundJobs.ts`). **Un appelant** : `src/instrumentation.ts`,
où chaque `start…()` ne part que derrière `if (jobs)`. `regress.sh` passe la variable à ses instances (et garde
ses anciennes neutralisations, pour une image d'un commit d'avant l'interrupteur).

**Différent exprès.** Les tâches déclenchées par un geste ne sont pas concernées : un spectateur de l'instance
qui lance un titre déclenche toujours ce que ce geste déclenche (un rapport de lecture, une analyse à la demande).
L'interrupteur coupe ce qui part **sans** personne.

**Tests.** `background-jobs.test.ts` : les valeurs reconnues ; la lecture de `instrumentation.ts` — tout
`start…()` hors de la liste des préchauffages doit être précédé de `if (jobs)`, si bien qu'ajouter une tâche
sans décider échoue ; et `regress.sh` passe bien la variable.

## 146. Les salons du chalet : un service à part, atteint par l'adresse de Laterna (11/11/2026)

**La règle.** Le mode Immersion à plusieurs passe par un service à part, `laterna-salons` (`salons/`, Node 26 +
WebSocket, son Dockerfile, ses tests, sa CI `salons.yml`), facultatif et coupé par défaut. Les navigateurs ne le
voient jamais : ils ouvrent `/api/salons/ws` **sur l'adresse de Laterna**, et le programme de démarrage relaie cette
connexion montante vers le service sur le réseau Docker (`server-boot/salonsRelay.mjs`, branché par
`server-boot/boot.mjs` avant Next, comme le cadrage des réponses). Même domaine, même HTTPS, même politique de
sécurité (`connect-src 'self'`), aucun changement du relais inverse, aucun port publié.

**Pourquoi un service à part.** Next ne tient pas de connexion permanente, et surtout un salon doit survivre aux
redéploiements de Laterna (plusieurs par jour) : dans le conteneur de l'application, chaque déploiement fermerait
toutes les parties. Ici, un déploiement coupe les connexions une seconde, et chaque client reprend sa place (jeton
de reprise, 60 s).

**Qui entre.** `GET /api/salons/pass` (derrière la session) signe un laissez-passer de cinq minutes avec la clé
partagée `SALONS_KEY` ; le service le vérifie et ne connaît ni compte ni secret de session. Le format est écrit des
deux côtés (`src/lib/salons/pass.ts`, `salons/src/pass.ts`) et un vecteur commun les tient ensemble. La route répond
**toujours 200** à une session : `{ available: false }` quand le jeu à plusieurs n'est pas pour elle (`SALONS_ENABLED`
— audience `off`/`admins`/`tous`, `featureAudience.ts` —, clé absente ou courte, lien de partage) ; le chalet reste
alors solitaire, jeux compris. Un laissez-passer refusé ferme la WebSocket en 4401 **après** la poignée de main :
jamais une réponse 4xx que CrowdSec compterait (§144, « le pare-feu »).

**L'adresse du service** est un réglage comme les autres (`SALONS_URL`, réglage → `.env` → défaut) ; le relais, hors
de Next, la reçoit de la route du laissez-passer sous un symbole partagé (`src/lib/salons/relay.ts`) — publiée juste
avant chaque connexion, retirée quand la fonction est coupée (le relais répond alors 503).

**Le protocole** est un seul fichier, `salons/src/protocol.ts`, que le chalet importe tel quel (l'étape `immersion`
du Dockerfile le copie ; `.dockerignore` ne laisse entrer de `salons/` que lui et `pass.ts`, que les tests de
l'application éprouvent). Le service est l'autorité : un changement d'objet partagé n'existe qu'appliqué et numéroté
par lui, diffusé à tous, demandeur compris. Le plan des étapes suivantes (présence, télévision commune, « Devine le
film », chat, avatars) est dans `immersion/docs/MULTIJOUEUR.md`.

**Réglages** : Configuration → Connexions → « Salons du chalet » (`SALONS_ENABLED`, `SALONS_URL`, `SALONS_KEY`), avec
« Tester » (`/health` derrière la clé) et le lien vers `salons/docs/DEPLOIEMENT.md`.

**Tests.** Dans le service (`node --test`, 23 cas : laissez-passer, protocole, salons à horloge simulée, transport avec
de vrais clients WebSocket — refus en 4401, débit en 4429, message trop gros, reprise, arrêt en 4503).
`salons-pass.test.ts` (vecteur commun, route : ouverte, coupée, réservée, clé courte, lien de partage — toujours 200),
`salons-relay.test.ts` (poignée de main et octets relayés dans les deux sens, autres connexions montantes laissées à
Next, 503 sans adresse, 502 service injoignable, autre origine refusée). Dans le chalet, le scénario
`immersion/tests/e2e/18-salons.spec.ts` (deux navigateurs, un vrai service).

**Étapes 2 et 4 (11/11/2026, même section).** *Le chalet partagé* : en salon, `toggleLamps`/`toggleDoor`/`toggleFire`/
`toggleMusic` ne changent rien eux-mêmes — le store passe le geste au relais `sharedSink` (`immersion/src/net/sync.ts`),
qui l'envoie au service ; l'état ne change qu'au retour, chez tous en même temps. La présence et le chat passent par le
même service (positions des yeux quantifiées, chat borné à 5 messages par 10 s). *« Devine le film »* : le moteur est
un seul fichier (`salons/src/quiz.ts`) joué par le service en salon et par la page seule ; l'application prépare la
partie parmi les films que **tous** les présents peuvent voir (liste signée par le service, `seal.ts`), scelle les
réponses pour le service, sert les images par un jeton chiffré (`/api/quiz/image?t=`, un seul nom pour le pare-feu,
204 sur une absence), et n'enregistre que des bilans signés par le service — ou, seul, recomptés par elle à partir des
réponses données (`soloGames.ts`). Records : `quiz_scores`, lus par `/api/quiz/stats` (Échap → Statistiques). Les
fichiers partagés du service entrent seuls dans le contexte de l'image (`.dockerignore`). Tests : `quiz-build`,
`quiz-routes` ; dans le service, `quiz.test.ts` et les parties de `rooms.test.ts` ; dans le chalet, les scénarios 18
(lampes, porte, présence, chat) et 19 (seul, et à deux avec un vrai service).

**Étapes 3 et 5 (11/11/2026, même section).** *La télévision commune* : en salon, les gestes de lecture (lancer,
reprendre, pause, saut, arrêt) passent par le relais `setSharedPlayback` de `immersion/src/media/commands.ts` jusqu'au
service (`salons/src/tv.ts`) ; chaque page lit son propre flux et le cale sur l'état du salon (`immersion/src/net/tv.ts`
— préparation en pause, « prêt », départ commun à une heure du service, écart rattrapé par la vitesse ou un saut). Un
titre ne se lance que muni d'un droit signé par l'application pour ce salon (`/api/salons/titre`, « tv » de
`seal.ts`) après vérification que **chaque** présent le voit (`getItemFile` sous son identifiant : tags bloqués et
bibliothèques compris) — un refus ne dit pas à cause de qui. *Avatars* : quatre indices bornés (`parseLook`, même
fichier, importé par l'application) gardés par compte (`avatar_looks`, `/api/salons/avatar`). Lien d'invitation :
`/immersion#salon=CODE`, lu une fois puis retiré de l'adresse. Tests : `salons-titre-avatar` ; `tv.test.ts` et
`rooms.test.ts` dans le service ; scénario 20 du chalet (deux navigateurs, vrai service).

## 147. Chasse aux défauts avant l'ouverture des acteurs à l'écran à tous les comptes (11/11/2026)

Une relecture de §137 à §140 et §145, le soir où X-Ray, les questions et « Jusqu'ici » passent de `admins` à `tous`.

- **La commande d'une séance** (`orders.ts`, `api/player/log`) ne part que pour un élément que le compte voit
  (`assertVisible` — l'élément venait du corps de la ligne `start`, résolu avec la clé du serveur), dans les dossiers
  permis (`isLibraryPath`) et jamais pour l'animation que le plan écarte (`isAnimationExcluded`) ; une commande forcée
  par l'administrateur passe. L'épisode suivant n'est cherché qu'à une vraie commande, plus à chaque `start` d'une
  même séance (une relecture complète de la série chez Jellyfin à chaque reconstruction).
- **Le planificateur** (§138) : « Analyser en priorité » rouvre un échec ; un élément déjà en file en `low` est
  remonté en `normal` sans bloquer la liste ; le rang du plan (`plan_rank`) est rendu à un élément qui quitte le
  palier 1 ou la priorité ; une panne de Jellyfin garde le palier 1 au lieu de le vider, et il se relit toutes les
  dix minutes même quand le plan attend ; l'animation s'impose à une ligne déjà écartée ; rien n'est montré « en
  cours » en pause.
- **« Précédemment »** (§137) : coupé au **début** de la tranche (`recapCutS`, clé `:v2`) — la clé est partagée par
  tous les comptes d'une tranche, et un texte coupé à 29:50 servait 9 min 40 d'épisode à qui s'était arrêté à 20:10 ;
  `aucun` ne prend plus la clé partagée ; un `rejeté`/`vide` d'un autre compte se retente une fois au bout d'une heure ;
  une série en échec ne bloque plus le passage (recul 15 min, 1 h, 6 h).
- **Le filet des noms** (§139) : en mot entier (`containsWord` : « Anne » passait dans « année »), le pluriel des
  sources accepté ; « M. », « Dr. »… ne ferment plus une phrase (`isTitleAbbreviation`) ; en allemand, où tout nom
  commun a sa majuscule, seuls les noms déclarés (`NOMS:` / `noms`) sont vérifiés, et leur absence rejette.
- **« Jusqu'ici »** : un refus, une réponse coupée ou un texte vidé deux fois sont gardés une heure (`keepFailure`) au
  lieu d'être repayés à chaque ouverture ; le plafond atteint tait la section au lieu de dire « trop peu vu ».
- **§140** : une borne commune par compte et par jour local, 300 appels payants (`aiDailyTake`, questions,
  « Jusqu'ici », recherche par description) — le plafond mensuel est commun, un seul compte pouvait le vider pour tous.
  Chez OpenAI et Google, les sources partent dans le message, plus dans les consignes.
- **L'usage** se mesure sans ligne de plus : le bilan `stop` porte `xray: "s3 t2 p2"` (`xrayUsage.ts`), relu avec
  `recherche.log` par la tuile d'Activité (`activity/aiUsage.ts`).
- **§145** : la copie de développement (`docker-compose.dev.yml`) démarre avec `CINE_BACKGROUND_JOBS=off`.

## 148. Le son qui commence après l'image : comblé de silence, jamais enjambé (12/11/2026)

**La règle.** Quand le premier son de la piste ouverte arrive plus de `AUDIO_LEAD_GAP_SECONDS` (2 s depuis la relecture du 12/11/2026 — sous ce seuil, une ou deux secondes d’ouverture enjambées, presque toujours du noir, ne valent pas un ré-encodage du film entier) après la
première image lue, le lecteur natif joue l'image dès son début, muette, et comble l'écart par du silence jusqu'au
premier échantillon réel — comme le fichier d'origine se lit ailleurs. Une ouverture, un saut, une reconstruction
ou un changement de piste dans le trou comblent de la même façon. Sous le seuil, rien ne change.

**Pourquoi.** *The Circle* sur iPhone, 12/11/2026 : la piste AC-3 n'a aucun bloc avant 30 s (le conteneur annonce
0). Une MediaSource ne joue que l'intersection de ses tampons — image dès 1,4 s, son dès 30,2 s, rien sous la tête —,
`recover()` relançait au même endroit, le tampon audio de WebKit (5 % du quota) débordait, le lecteur serveur
prenait la main et échouait aussi. Sous 15 s d'écart, `landingFor` posait la tête sur le premier son : le film
partait, sans ses premières secondes d'image, et un retour à 0 s'y recalait. Presque toujours une VF plus courte en
tête que sa VO : *Green Book* (VF 24 s, VO 0,02 s), *WALL·E* (VF 11,8 s), *The Wolf of Wall Street* (VF 8,8 s, trouvé
par le banc), *Scary Movie*, *The Ledge*, *RRR*, *Fly Me to the Moon*… Recensement du 12/11/2026 (931 films, toutes
pistes, ouvertes à 0) : 63 pistes de 44 films au-delà du seuil — 34 au-delà de 2 s, 29 entre 0,5 et 2 s (dont une
quinzaine à 1,00 s tout rond, *1917* compris, vérifiés à ffprobe) ; aucune piste vue en retard à 600 s qui ne l'était
pas à 0.

**Une fonction.** `audioLeadGapSeconds` (`src/lib/webcodecs/audioLeadGap.ts`) décide ; `withLeadSilence` fabrique
le silence (plans nuls aux canaux et à la fréquence du premier bloc réel, total arrondi une fois pour finir sur lui à
l'échantillon près, produit au fil de la demande). **Appelants** : `Remuxer.open` (sonde de la piste copiée, et le
retard vu à l'amorçage d'une piste déjà ré-encodée, pour le journal), `AudioTranscoder.seekTo` (chaque saut,
depuis le début de l'image du segment). La mémoire de la page : `rememberLeadGap` / `rememberedLeadGap`, sous l'objet
du fichier (`rememberedHeaders` le rend tel quel d'une ouverture à l'autre).

**Comment.** Par le ré-encodage existant, seul endroit où l'on sait faire du silence dans n'importe quel codec. Une
piste déjà ré-encodée (DTS, TrueHD ; le Dolby sur Chrome) comble d'elle-même. Une piste **copiée** est sondée là où
la lecture commence — la boucle qui lisait déjà une trame AC-3/E-AC-3 pour la décrire, étendue à toute piste copiée
que `dialogueCanShape` sait décoder dans l'ordre standard (même question que « Améliorer les dialogues », même
réponse) — et, en retard (ou vue en retard plus tôt sur la page), ouverte par un transcodeur (`copiedTrack` : un AAC
multicanal passe par le décodeur mesuré). Aucun transcodeur possible : la copie d'avant, trou enjambé.

**Différent exprès.**
- Écarté : des trames silencieuses écrites à la main dans le codec copié. Une trame AAC-LC se fabrique ; une AC-3 ou
  E-AC-3 beaucoup moins, aucun navigateur n'en encode, et rien ici ne prouverait que le décodeur d'Apple prend les
  nôtres. Un seul mécanisme, déjà éprouvé tous les jours, plutôt qu'un pari par codec.
- La sonde ne lit jamais la tête du fichier pour une reprise (des mégaoctets en itinérance, relu le 23/09/2026) :
  le premier pipeline d'une page ouvert *au-delà* du trou ne le connaît pas, et un saut en arrière dans le trou s'y
  comporte comme avant. Vu une fois sur la page, la piste reste ré-encodée pour tous ses pipelines suivants.
- Le prix, pour un fichier à trou seulement : l'ouverture attend les octets du trou (8 Mo pour *The Circle*, 24 Mo
  pour *WALL·E* — l'AC-3 et l'E-AC-3 les lisaient déjà pour leur description) ; et la piste est ré-encodée
  (seconde génération avec perte, un décodeur sur l'appareil), comme un DTS. Sous 2 s, ce prix achète une ou deux
  secondes d'image d'ouverture que l'atterrissage sautait sans autre dommage : relever `AUDIO_LEAD_GAP_SECONDS` à 2
  rendrait leur copie à ces 29 pistes, et c'est le seul réglage à toucher.
- Le journal : `start` porte `audioLeadGapS` et `audioGap` (`silence` / `enjambé`) pour un fichier à trou, rien pour
  les autres (`audioLeadGapFacts`, `nativeHostHelpers.ts`).

**Tests.** `audioLeadGap.test.ts` (seuil, son avant l'image, durée exacte du silence, canaux, fréquence, identité des
blocs sans trou, fermeture du flux du décodeur sur un saut) ; `webcodecs-audioTranscode.test.ts` (saut dans le trou,
enchaînement sans trou au premier son, décodeur mesuré) ; `webcodecs-remuxer.test.ts` (copie gardée sans trou et sous
le seuil, ré-encodage au-delà, piste non décodable gardée sans sonde, « enjambé » sans encodeur, mémoire de la page,
l'AC-3 lu une seule fois) ; l'empreinte `natif/pistes-son-en-retard…` ; les autres empreintes inchangées.
`audio-gap-bench.spec.ts` (banc, sauté sans `GAP_FILES`) : sur les vrais fichiers, à 0, 10 et 600 s, iPhone et
Chrome simulés, avant et après — toute piste sans trou donne des octets audio identiques.
