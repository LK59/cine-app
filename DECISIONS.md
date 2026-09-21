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
  langue demandée n'existe qu'en TrueHD, les deux diffèrent exprès : on ouvre sur ce qui joue, et
  choisir la VO à l'écran passe la main au lecteur serveur (test dédié dans `preferredAudio.test.ts`).
- Sans préférence, `preferredAudio` prend la plus riche des pistes jouables, et l'écran ne touche
  à rien (`chooseAudioTrack` rend `null`) : pas de désaccord possible, donc pas de bascule.

## 4. Quand un fichier va au lecteur serveur

**Règle.** Un refus qui vise le *lecteur* (aucun chemin local ne portera ce fichier) arrête la
chaîne et passe au serveur ; un refus qui vise le *chemin* essaie le suivant. Voir `CLAUDE.md`.

**Porteur.** `choosePlaybackPath` (`pathSelector.ts`) à l'ouverture : TrueHD/MLP partout
(`SANS_DECODEUR`), Dolby Vision sans couche HDR10.

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

## 7. Refermer une fiche, et ce qu'on relit après une lecture

**Porteurs.** `cinemaClose` (seule sortie), `useDelayedClose` / `useExitDelay` (l'un ou l'autre,
jamais les deux pour une même décision), `refreshAfterPlayback` (les quatre vues relues à la
fermeture du lecteur, par les deux lecteurs). Contrat complet dans `CLAUDE.md`, « The sheet
lifecycle ».

**Tests.** `decisions-partagees.test.ts`, `useDelayedClose.test.tsx`, `useExitDelay.test.tsx`,
`sheet-stack-under-discover.test.ts`, `cinemaRoute.test.tsx`, `refreshAfterPlayback.test.ts`.

**Voulu.** Le mobile n'a pas de champ `episodes` dans l'adresse : ses épisodes vivent dans la
fiche, pas dans un panneau.

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

## 8. Pastilles de qualité

**Porteur.** `qualityBadges` (`videoQuality.ts`) et `QualityBadges.tsx`, pour les deux bannières et
les deux fiches. Tests : `videoQuality.test.ts`. Les tranches de qualité de la page Radarr sont un
filtre d'administration, pas une pastille.

## 9. La langue de l'interface

**Porteur.** `getLocaleFromCookie` / `localeOf` (`i18n.ts`).

**Reste connu.** `app/layout.tsx` et `api/search/route.ts` relisent le cookie à la main, sans le
`decodeURIComponent` de `localeOf`. Sans effet aujourd'hui : les quatre valeurs possibles n'ont
rien à décoder.

---

## Ce qui n'est pas une dette

Deux interfaces — bureau et mobile — ne sont pas une décision dupliquée : ce sont deux produits
(voir `CLAUDE.md`). La dette, c'est une *règle* écrite deux fois. Le bon axe n'est pas la taille
d'écran : un correctif de reprise a manqué la fiche série alors qu'il avait touché le film et sa
jumelle mobile. On compte les endroits qui décident, pas les mises en page.
