"use client";

import { ShareButton, shareableFrom } from "@/components/share/ShareControl";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { formatMinutes } from "@/lib/format";
import { ImdbBadge } from "@/components/ImdbBadge";
import { QualityBadges } from "@/components/cinema/QualityBadges";
import { CinemaSimilarRow, useCinemaSimilar, similarRowKeyNav } from "@/components/cinema/CinemaSimilarRow";
import { CinemaCollectionRow, useCinemaCollection } from "@/components/cinema/CinemaCollectionRow";
import { CinemaCastRow } from "@/components/cinema/CinemaCastRow";
import { PlayButton } from "@/components/PlayButton";
import { usePlayerEnabled } from "@/lib/usePlayerEnabled";
import { useWatchlistToggle } from "@/lib/useWatchlistToggle";
import { detailColumnMotion } from "@/lib/sheetMotion";
import { useSheetKeys } from "@/lib/useSheetKeys";
import { useJellyfinItemState } from "@/lib/useJellyfinItemState";
import { useT } from "@/components/TranslationProvider";
import { genreLabel } from "@/lib/top10Label";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import { OfflineDownloadControl, OfflinePlayButton } from "@/components/offline/OfflineDownloadControl";
import { MENU_ROW, MENU_ROW_INACTIVE, MENU_BADGE, focusFirstAction, detailMenuArrowNav } from "@/components/cinema/detailMenu";
import { COLUMN_STYLE, MENU_STYLE, COLUMN_GAP, CinemaOverview, CinemaDetailModal } from "@/components/cinema/CinemaDetailLayout";
import { useDesktopSheetShell, DesktopSheetFrame, DetailTrailerRow } from "@/components/cinema/DesktopSheetShell";
import { useSheetPlay } from "@/lib/useSheetPlay";
import { CinemaRatingsLine, CinemaTagline, ReservedLine, useLateArrival } from "@/components/cinema/CinemaDetailExtras";
import { sheetOverview, sheetRuntimeMinutes, sheetLeadFacts } from "@/lib/sheetFacts";
import { TitleToggleRow, WATCHED_FACE, WATCHLIST_FACE } from "@/components/cinema/TitleToggles";
import { CinemaDetailPages, CinemaDetailTitle, CinemaDetailCastLine } from "@/components/cinema/CinemaDetailPages";

const TrailerModal = dynamic(() => import("@/components/TrailerModal").then((m) => m.TrailerModal), { ssr: false });


interface RadarrCastMember {
  tmdbId: number;
  name: string;
  character: string;
  photoUrl: string | null;
}

interface RadarrInfo {
  /** Pour les notes critiques de « Voir plus ». */
  imdbId?: string | null;
  /** `runtime` est la durée du film en minutes : elle vient de TMDB, comme le synopsis. */
  tmdb: { overview: string; tagline?: string | null; cast: RadarrCastMember[]; runtime?: number | null } | null;
  trailerKey: string | null;
}

// "The banner opened big" — click/Enter on a card (or the hero) escalates from CinemaHero's
// passive preview into this: a full-screen, ONLY-this-on-screen detail à la Netflix's TV app.
// The backdrop fills the entire screen and stays crisp everywhere EXCEPT a soft backdrop-blur
// zone behind the bottom third (where the menu sits) — the earlier version blurred the whole
// image, which just looked broken instead of ambient. Only the button column is narrow — the
// title/synopsis/cast get the full text column width so the title doesn't wrap onto 3 lines.
// Portaled to document.body for the same reason CinemaClient's own fixed layers are (see its doc
// comment): PageTransition's lingering transform breaks `position: fixed` otherwise.
export function CinemaMovieDetail({
  item,
  onClose,
  onSelectSimilar,
  /**
   * Cette fiche est recouverte par une autre.
   *
   * Elle reste montée, avec ses données et son défilement, pour qu'un retour la retrouve intacte
   * plutôt que de la reconstruire — c'est ce qui faisait recharger la rangée « Titres similaires »
   * en revenant du titre qu'on venait d'y ouvrir. Dessous, elle ne prend ni le clavier ni le
   * focus : deux fiches montées ensemble écoutent Échap toutes les deux, et celle du dessous
   * ramenait le focus sur son propre menu à chaque flèche.
   */
  underneath = false,
}: {
  item: CinemaMovie;
  onClose: () => void;
  // Lets the "Titres similaires" row swap this sheet's subject for another title, rather than
  // stacking a second sheet on top of the first.
  onSelectSimilar?: (item: CinemaMovie) => void;
  underneath?: boolean;
}) {
  const t = useT();
  const [showTrailer, setShowTrailer] = useState(false);
  const [showSynopsis, setShowSynopsis] = useState(false);
  const { data: info, error: infoError } = useSWR<RadarrInfo>(`/api/radarr/movies/${item.radarrId}/info`, fetcher);
  // L'accroche, la distribution et la bande-annonce n'arrivent que par cette réponse : leur place
  // est tenue dès l'ouverture, et elles s'y posent en fondu — voir `useLateArrival`.
  const late = useLateArrival(info !== undefined || infoError !== undefined);
  // L'accroche et la bande-annonce viennent du catalogue quand il les sait : là dès l'ouverture,
  // sans fondu. La description ne sert qu'à défaut — voir `sheetLeadFacts`.
  const lead = sheetLeadFacts(item, info, info !== undefined || infoError !== undefined);
  // CinemaMovie (the /api/cinema/movies payload) carries no per-user watch progress at all
  // (Radarr/TMDB fields only, shared across every viewer) — without this, Lecture always started
  // a partly-watched movie over from 0 unless the movie happened to be opened via the Continue
  // Watching row instead (a different endpoint, with its own resume point already attached).
  //
  // La même réponse porte « vu » et « favori », qui vivent chez Jellyfin et non dans la base
  // locale — voir useJellyfinItemState pour pourquoi une seconde copie finissait toujours par
  // mentir.
  const { progress, watched, known: flagsKnown, busy: flagsBusy, toggleWatched } =
    useJellyfinItemState(item.jellyfinItemId);
  // Ce que Jellyfin a dit de la position, sinon ce que la reprise gardée sur l'appareil en sait :
  // « Reprendre · 1 h 10 restantes » dès l'ouverture, sans rien affirmer ; le fichier introuvable,
  // la copie hors ligne, le préchargement — le bouton Lire de toutes les fiches, `useSheetPlay`.
  const { facts, fileMissing, offlinePlayable, label: playLabel } = useSheetPlay({ kind: "movie", jellyfinItemId: item.jellyfinItemId, title: item.title, progress });
  // « À voir » : son état de départ, la garde `canJoinWatchlist` et l'écriture, par le crochet de
  // toutes les fiches (`useWatchlistToggle`, §117.4). « Vu » et « Favori » sont chez Jellyfin (plus
  // haut) : un titre peut être à la fois dans la liste et marqué vu.
  // Sans identifiant TMDB — un film que Jellyfin a seul (§89) peut n'en avoir aucun —, pas de ligne.
  const { listable, inList, toggle: toggleAddToList } = useWatchlistToggle({
    mediaType: "movie",
    tmdbId: item.tmdbId,
    title: item.title,
    year: item.year,
    posterPath: item.posterUrl,
  });
  // item.logoUrl comes bulk-included in the /api/cinema/movies payload now (see CinemaHero's own
  // note) — known synchronously, prefetched alongside backdrops by CinemaClient's warm-up
  // effect. A failed logo shows the written title and retries on its own (`useImageRetry`).

  // L'habillage des deux fiches du bureau (`useDesktopSheetShell`) : l'arrivée par un retour, la
  // fermeture différée (Échap/Retour arrière, le bouton Retour, la poignée passent tous par
  // `requestClose`), le trajet ou la continuité (§61), la poignée au doigt, le focus rendu au retour
  // du lecteur, et le drapeau « le spectateur a bougé lui-même » remis à zéro à chaque titre.
  const shell = useDesktopSheetShell({ subjectKey: item.radarrId, underneath, onClose });
  const { containerRef, userHasMovedFocus, markUserMovedFocus, revealed, morph, requestClose, playerOwnsKeyboard } = shell;

  // Drives both the second snap section and the chevron pointing at it: with nothing similar in
  // the library there's no second screen, so neither should exist.
  const similar = useCinemaSimilar(item, "movies");
  const collection = useCinemaCollection(item.radarrId);
  const hasSimilar = !!onSelectSimilar && similar.length > 0;
  const cast = info?.tmdb?.cast ?? [];
  // Le second écran existe dès qu'il a quelque chose à montrer — le casting compris. Le rappel de
  // défilement ne le suivait que pour les titres similaires : une saga seule n'était pas annoncée.
  const hasBelow = hasSimilar || collection.parts.length > 0 || cast.length > 0;


  // Lands focus on the first menu row as soon as the overlay opens — a TV remote user should
  // never need to press Down before Play is reachable. PlayButton itself only renders once
  // usePlayerEnabled() resolves (it starts false while /api/config/public is in flight, same
  // hook, separate call here) — on a mount that lands before that resolves, this ran once,
  // found no Play row yet, and focused Bande-annonce instead: a click/Enter right after opening
  // played the trailer instead of the film. Re-running once playerEnabled flips true (and once
  // trailerKey is known, which can also reorder what's "first") re-targets focus at whichever
  // row is now actually first, catching that race instead of freezing on its initial guess.
  // (Le drapeau `userMovedFocus` repart de zéro à chaque titre, dans `useDesktopSheetShell`.)
  const playerEnabled = usePlayerEnabled();
  useEffect(() => {
    /**
     * Le premier passage a lieu avant que `usePlayerEnabled` ait répondu, donc avant que la
     * ligne de lecture existe : le focus tombe alors sur « Recommencer » ou « Bande-annonce »,
     * et l'effet est rejoué pour le rattraper une fois la ligne apparue.
     *
     * La garde ne peut donc pas être « quelqu'un a déjà le focus dans le menu » — c'est vrai
     * précisément dans le cas qu'il s'agit de rattraper, et la correction ne se faisait jamais.
     * Elle est « quelqu'un a bougé lui-même » : tant que personne n'a touché aux flèches ni
     * cliqué, la première ligne reste la bonne cible.
     */
    const frame = requestAnimationFrame(() => {
      if (underneath || userHasMovedFocus()) return;
      focusFirstAction(containerRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [playerEnabled, lead.trailerKey, item.radarrId, underneath, containerRef, userHasMovedFocus]);

  // Échap et Retour arrière referment, les flèches parcourent le menu — et rien quand une feuille
  // est posée par-dessus ou qu'on tape dans un champ : la règle de toutes les fiches, `useSheetKeys`.
  useSheetKeys({
    // The player is on top and owns the keyboard — see above. TrailerModal has its own Escape
    // handler (also on window) that closes just itself — without this guard, Escape while the
    // trailer is open closed BOTH it and this whole detail overlay at once.
    listening: !underneath && !playerOwnsKeyboard && !showTrailer && !showSynopsis,
    onClose: requestClose,
    onKey: (e) => {
      // The similar-titles row below the menu takes the arrow keys when focus is in it (and
      // claims the Down that enters it from the last menu row) — see similarRowKeyNav.
      if (similarRowKeyNav(e, containerRef.current)) return;

      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      markUserMovedFocus();
      detailMenuArrowNav(e, containerRef.current);
    },
  });

  if (typeof document === "undefined") return null;

  return createPortal(
    // La couche plein écran, son fond, la poignée et le bouton Retour : `DesktopSheetFrame`.
    <DesktopSheetFrame
      containerRef={containerRef}
      revealed={revealed}
      handlesEntry={morph.handlesEntry}
      gripStyle={shell.gripStyle}
      grip={shell.grip}
      onBack={requestClose}
      underneath={underneath}
      backdropUrl={item.backdropUrl}
    >

      {/* Partager ce film par un lien (DECISIONS.md §112) : une pastille discrète en face du retour,
          hors du menu de la fiche — administrateur seul, rien pour les autres. */}
      {shareableFrom("movie", { jellyfinItemId: item.jellyfinItemId, fileMissing }) && (
        <ShareButton
          variant="icon"
          iconClassName="btn btn-ghost fixed z-10 rounded-full bg-black/55 p-2.5 float-edge"
          iconStyle={{ top: "max(1rem, env(safe-area-inset-top))", right: "1rem" }}
          kind="movie"
          itemId={item.jellyfinItemId}
          radarrId={item.radarrId ?? null}
          title={item.title}
          year={item.year ?? null}
          posterUrl={item.posterUrl ?? null}
        />
      )}

      {/* Two snap positions, like the browse screen: the title block, then the similar titles.
          Each section is min-h-full so it fills the viewport on its own, which is what stops the
          scroll from ever resting halfway between the two.

          justify-end inside a min-h-full section, NOT items-end on the scroller: a flex container
          aligned to its end edge clips whatever overflows past its START edge and makes it
          unreachable by scrolling — that's what pushed the logo and title off the top of the
          screen when the similar row first landed here. A section that simply grows can't. */}
      {/* Les deux pages, écrites une fois pour le film, la série et la fiche découverte —
          voir `CinemaDetailPages`. */}
      <CinemaDetailPages
        first={
        <div
          key={item.radarrId}
          data-sheet-content=""
          style={COLUMN_STYLE}
          // La sortie est celle de la copie (`useSheetMorph`), plus celle de la colonne.
          className={`flex flex-col ${COLUMN_GAP} px-8 sm:px-16 ${detailColumnMotion({ leaving: false, revealed: revealed || morph.handlesEntry })}`}
        >
          <CinemaDetailTitle title={item.title} logoUrl={item.logoUrl} />

          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>{item.year}</span>
            {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
            {/* Voir la note jumelle de la fiche téléphone : la durée manquait, et c'est la
                troisième chose qu'on veut savoir avant de lancer un film. */}
            {/* Celle du catalogue, là dès l'ouverture ; TMDB seulement quand il n'en a pas. */}
            {formatMinutes(sheetRuntimeMinutes(item.runtimeMinutes, info?.tmdb?.runtime)) && (
              <span>{formatMinutes(sheetRuntimeMinutes(item.runtimeMinutes, info?.tmdb?.runtime))}</span>
            )}
            <QualityBadges quality={item.quality} />
          {item.genres.length > 0 && <span>{item.genres.slice(0, 3).map((g) => genreLabel(g, t)).join(" · ")}</span>}
          </div>

          {!lead.taglineKnown ? <ReservedLine className="h-[1.1rem]" /> : <CinemaTagline text={lead.tagline} className={lead.taglineLate ? late.fade : ""} />}

          <CinemaOverview
            text={sheetOverview(item.overview, info?.tmdb?.overview)}
            readMore={t("cinema.readMore")}
            // Jusqu'à cinq lignes quand la page a de la place au-dessus du logo — voir CinemaOverview.
            maxLines={5}
            alwaysOpenable={!!info?.imdbId}
            onOpen={() => setShowSynopsis(true)}
          />

          {late.pending && <ReservedLine className="h-4" />}
          {/* Les noms mènent chacun à leur fiche ; voir `CinemaDetailCastLine`. */}
          <CinemaDetailCastLine cast={cast} className={late.fade} />

          {/* Plus étroit que le texte au-dessus, sans être une colonne à part : deux tiers de
              la largeur du bloc — voir MENU_STYLE. */}
          <div data-detail-actions className="mt-2 flex flex-col gap-1" style={MENU_STYLE}>
            {/* Un téléchargement lisible passe en tête, et « Lire » devient « Lire en ligne » (Louis, 19/10/2026). */}
            {/* Même si la bibliothèque a perdu le fichier : la copie de l'appareil est alors la seule lisible (§109). */}
            {offlinePlayable && (
              <OfflinePlayButton download={offlinePlayable} onlineResumeTicks={facts.resumeTicks} onlineKnown={facts.resumeKnown} variant="row" rowClassName={`${MENU_ROW} ${MENU_ROW_INACTIVE}`} badgeClassName={MENU_BADGE} />
            )}
            <PlayButton
              itemId={item.jellyfinItemId}
              title={item.title}
              resumeTicks={facts.resumeTicks ?? undefined}
              runtimeTicks={facts.runtimeTicks ?? undefined}
              // Tant que Jellyfin n'a pas répondu, ne rien affirmer : la reprise locale donne le
              // libellé, la position reste au serveur.
              resumeKnown={facts.resumeKnown}
              unavailable={fileMissing}
              reserve
              variant="row"
              // Same override as CinemaSeriesDetail's own Play button — see its doc comment —
              // so a movie opened from the Continue Watching row and one opened from its own
              // poster card show the identical "Reprendre - 1h10 restants" wording.
              label={playLabel}
              // La même ligne que les autres : c'est le sélecteur qui se peint en blanc, pas
              // elle. Deux blancs à l'écran — un fixe et un mobile — se disputaient le sens.
              className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
            />

            {/* Only when there's actually something to restart FROM — a movie with no progress
                already opens fresh via Lecture above, so this would just be a redundant second
                "Lire" button.

                `resumeAt: 0`, explicitement. Le champ était omis, et le commentaire d'origine le
                justifiait par le lecteur stable, qui ne saute que sur une valeur vraie. Le
                lecteur natif, lui, lit un champ absent comme « prends la position du serveur » :
                « Recommencer » reprenait donc exactement là où l'on venait de s'arrêter.

                Par `PlayButton` et non une ligne réécrite ici (29/09/2026) : la copie locale
                n'avait pas sa garde de lecture intégrée, et s'affichait avec `PLAYER_ENABLED=false`
                pour mener à « Lecteur intégré désactivé ». La reprise à écarter, le fichier absent
                et le zéro explicite y sont décidés une fois — voir DECISIONS §1. */}
            <PlayButton
              restart
              itemId={item.jellyfinItemId}
              title={item.title}
              resumeTicks={facts.resumeTicks ?? undefined}
              unavailable={fileMissing}
              variant="row"
              label={t("cinema.restartFromBeginning")}
              className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
            />

            {/* Sa place est tenue, invisible et hors du clavier, tant que la description n'est pas là. */}
            <DetailTrailerRow lead={lead} late={late} onOpen={() => setShowTrailer(true)} />

            {/* Le téléchargement hors ligne (bêta, 19/10/2026) : Lire, Bande-annonce, puis Télécharger (Louis). */}
            {!fileMissing && (
              <OfflineDownloadControl
                variant="row"
                rowClassName={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
                badgeClassName={MENU_BADGE}
                itemId={item.jellyfinItemId}
                radarrId={item.radarrId ?? null}
                title={item.title}
                year={item.year ?? null}
                posterUrl={item.posterUrl ?? null}
                runtimeMinutes={item.runtimeMinutes ?? null}
                onlineResumeTicks={facts.resumeTicks}
                onlineKnown={facts.resumeKnown}
              />
            )}

            {/* « Vu » puis « À voir » : la forme de toutes les fiches (`TitleToggles`, §117.4). Estompé
                tant que Jellyfin n'a pas répondu : ce bouton écrit, et proposer d'écrire une valeur
                qu'on n'a pas lue est la façon la plus sûre de la changer par erreur. */}
            <TitleToggleRow face={WATCHED_FACE} on={watched} onClick={toggleWatched} disabled={flagsBusy} unknown={!flagsKnown} />

            {/* L'état tient dans la pastille, et non dans la ligne entière.
                Une ligne pleine d'accent criait plus fort que le repère de sélection lui-même :
                sur un menu parcouru à la télécommande, la ligne « déjà dans ma liste » avait donc
                l'air d'être celle qu'on venait de désigner. */}
            {listable && <TitleToggleRow face={WATCHLIST_FACE} on={inList} onClick={toggleAddToList} />}
          </div>

        </div>
        }
        below={
          hasBelow && (
            <>
              {/* Its own full-height snap position — centred rather than pinned to the top, so landing
                  on it reads as a deliberate second screen instead of one row stranded above a lot of
                  empty backdrop. */}
              {/* La saga partage la section des titres similaires plutôt que d'en réclamer une à elle :
                  deux écrans pleins à faire défiler l'un après l'autre, pour deux rangées, c'est une
                  promenade là où on voulait une réponse. */}
            {/* Le même rappel que la rangée du dessous : ouvrir un titre de la saga et ouvrir un
                titre similaire sont le même geste, donc le même chemin — et donc, à la fermeture,
                la même animation. */}
            {/* Le casting d'abord : c'est ce qu'on vient chercher en descendant sous un film. */}
            <CinemaCastRow cast={cast} />
            <CinemaCollectionRow name={collection.name} parts={collection.parts} onSelectOwned={onSelectSimilar} />
            {hasSimilar && <CinemaSimilarRow items={similar} onSelect={(next) => onSelectSimilar?.(next as CinemaMovie)} />}
            </>
          )
        }
      />

      {showTrailer && lead.trailerKey && (
        <TrailerModal
          youtubeKey={lead.trailerKey}
          title={item.title}
          onClose={() => {
            setShowTrailer(false);
            // TrailerModal doesn't restore focus itself (it wasn't built with a keyboard-nav
            // parent in mind) — without this, closing it leaves document.activeElement on
            // <body>, so this overlay's own Up/Down handler (indexOf returns -1) needs an extra,
            // wasted keypress before arrow-nav does anything again. Same class of bug already
            // fixed for the player's own menu-close case.
            requestAnimationFrame(() => focusFirstAction(containerRef.current));
          }}
        />
      )}

      {showSynopsis && (
        <CinemaDetailModal
          title={item.title}
          closeLabel={t("common.close")}
          onClose={() => {
            setShowSynopsis(false);
            // Rendre le focus à la ligne qui a ouvert la fenêtre, comme le fait la bande-annonce.
            requestAnimationFrame(() =>
              focusFirstAction(containerRef.current)
            );
          }}
        >
          <p>{sheetOverview(item.overview, info?.tmdb?.overview)}</p>
          <CinemaRatingsLine imdbId={info?.imdbId} />
        </CinemaDetailModal>
      )}
    </DesktopSheetFrame>,
    document.body
  );
}
