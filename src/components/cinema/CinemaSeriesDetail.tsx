"use client";

import { ShareButton, shareableFrom } from "@/components/share/ShareControl";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { ListVideo } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { ImdbBadge } from "@/components/ImdbBadge";
import { CinemaSimilarRow, useCinemaSimilar, similarRowKeyNav } from "@/components/cinema/CinemaSimilarRow";
import { CinemaCastRow } from "@/components/cinema/CinemaCastRow";
import { detailColumnMotion } from "@/lib/sheetMotion";
import { useCinemaRoute, cinemaNavigate, cinemaClose } from "@/lib/cinemaRoute";
import { PlayButton } from "@/components/PlayButton";
import { usePlayback } from "@/components/PlaybackProvider";
import { usePlayerEnabled } from "@/lib/usePlayerEnabled";
import { useWatchlistToggle } from "@/lib/useWatchlistToggle";
import { useSheetKeys } from "@/lib/useSheetKeys";
import { useJellyfinItemState } from "@/lib/useJellyfinItemState";
import { useT } from "@/components/TranslationProvider";
import { genreLabel } from "@/lib/top10Label";
import { CinemaEpisodeBrowser } from "@/components/cinema/CinemaEpisodeBrowser";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import type { CinemaEpisode } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import { MENU_ROW, MENU_ROW_INACTIVE, MENU_BADGE, focusFirstAction, detailMenuArrowNav } from "@/components/cinema/detailMenu";
import { COLUMN_STYLE, MENU_STYLE, COLUMN_GAP, CinemaOverview, CinemaDetailModal } from "@/components/cinema/CinemaDetailLayout";
import { useDesktopSheetShell, DesktopSheetFrame, DetailTrailerRow } from "@/components/cinema/DesktopSheetShell";
import { playEpisodeFrom } from "@/lib/episodeRow";
import { useSheetPlay } from "@/lib/useSheetPlay";
import { CinemaRatingsLine, CinemaTagline, ReservedLine, useLateArrival, useRuntimeLabel } from "@/components/cinema/CinemaDetailExtras";
import { sheetOverview, sheetLeadFacts, sheetEpisodeRuntime } from "@/lib/sheetFacts";
import { OfflinePlayButton } from "@/components/offline/OfflineDownloadControl";
import { TitleToggleRow, WATCHED_FACE, WATCHLIST_FACE } from "@/components/cinema/TitleToggles";
import { CinemaDetailPages, CinemaDetailTitle, CinemaDetailCastLine } from "@/components/cinema/CinemaDetailPages";

const TrailerModal = dynamic(() => import("@/components/TrailerModal").then((m) => m.TrailerModal), { ssr: false });


interface SonarrCastMember {
  tmdbId: number;
  name: string;
  character: string;
  photoUrl: string | null;
}

interface SonarrInfo {
  /** Pour les notes critiques de « Voir plus ». */
  imdbId?: string | null;
  /** `runtime` : la durée d'un épisode, en minutes (TMDB). */
  tmdb: { overview: string; tagline?: string | null; cast: SonarrCastMember[]; runtime?: number | null } | null;
  trailerKey: string | null;
}

// Series-typed mirror of CinemaMovieDetail — see its own doc comment for the shared layout
// reasoning (full-bleed crisp backdrop with a localized blur/dim zone, narrow left-aligned menu
// separate from the wider text column, z-46 sitting just above the browse layer and below the
// player). Two real differences from the movie version:
//   1. "Lire" targets the series' NEXT episode (Jellyfin's own /Shows/NextUp, same "resume the
//      in-progress episode or start the next unwatched one" logic the standard series page
//      already uses), not the series item itself — Jellyfin can't play a "Series"-typed item,
//      only actual episode files. That means Play only renders once /episodes has resolved,
//      same async-gated pattern already used for the movie side's own usePlayerEnabled race.
//   2. An extra "Plus d'épisodes" row opens CinemaEpisodeBrowser (seasons + episode picker).
export function CinemaSeriesDetail({
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
  item: CinemaSeries;
  onClose: () => void;
  // Same role as CinemaMovieDetail's — swaps the subject instead of stacking sheets.
  onSelectSimilar?: (item: CinemaSeries) => void;
  underneath?: boolean;
}) {
  const t = useT();
  const [showTrailer, setShowTrailer] = useState(false);
  const [showSynopsis, setShowSynopsis] = useState(false);
  // In the URL like every other Cinema layer, so Back closes the season browser and returns to
  // this sheet instead of leaving the mode (see lib/cinemaRoute).
  const showEpisodes = useCinemaRoute().episodes;
  const setShowEpisodes = (open: boolean) =>
    open ? cinemaNavigate({ episodes: true }) : cinemaClose({ episodes: false });
  const { data: info, error: infoError } = useSWR<SonarrInfo>(`/api/sonarr/series/${item.sonarrId}/info`, fetcher);
  // L'accroche, la distribution et la bande-annonce n'arrivent que par cette réponse : leur place
  // est tenue dès l'ouverture, et elles s'y posent en fondu — voir `useLateArrival`.
  const late = useLateArrival(info !== undefined || infoError !== undefined);
  // L'accroche et la bande-annonce viennent du catalogue quand il les sait : là dès l'ouverture,
  // sans fondu. La description ne sert qu'à défaut — voir `sheetLeadFacts`.
  const lead = sheetLeadFacts(item, info, info !== undefined || infoError !== undefined);
  const episodeRuntime = sheetEpisodeRuntime(item.episodeRuntime, info?.tmdb?.runtime);
  // L'épisode que Lire lancerait : celui du serveur quand la liste est là, sinon celui que « À
  // suivre » ou « Reprendre », gardés sur l'appareil, connaissent déjà ; une série jamais commencée
  // garde la place de sa ligne (`playPending`) ; le fichier introuvable, la copie hors ligne en tête
  // (comme un film, Louis 19/10/2026), le préchargement du seul épisode du bouton principal, et la
  // suite de la série relue à la fin d'un épisode — le bouton Lire de toutes les fiches, `useSheetPlay`.
  const {
    facts,
    episodesData,
    playPending,
    waitForServer,
    fileMissing,
    offlinePlayable,
    episodeCode: offlineEpisodeCode,
    label: playLabel,
    getNextEpisode,
  } = useSheetPlay({ kind: "series", jellyfinItemId: item.jellyfinItemId, title: item.title, sonarrId: item.sonarrId, firstEpisode: item.firstEpisode });
  /** L'écran des épisodes est-il vraiment dessiné — il lui faut sa liste, pas seulement l'adresse. */
  const episodesShown = showEpisodes && !!episodesData?.seasons;
  // Marquer une série vue coche la série entière chez Jellyfin, ce qui est exactement le geste
  // qu'on veut : « je l'ai finie », et ses applications le sauront aussi.
  const { watched, known: flagsKnown, busy: flagsBusy, toggleWatched } = useJellyfinItemState(item.jellyfinItemId, "series");
  // « À voir » : son état de départ, la garde `canJoinWatchlist` et l'écriture, par le crochet de
  // toutes les fiches (`useWatchlistToggle`, §117.4). « Vu » et « Favori » sont chez Jellyfin (plus
  // haut) : un titre peut être à la fois dans la liste et marqué vu.
  // Sans identifiant TMDB — Sonarr n'en résout pas toujours un —, pas de ligne.
  const { listable, inList, toggle: toggleAddToList } = useWatchlistToggle({
    mediaType: "series",
    tmdbId: item.tmdbId,
    title: item.title,
    year: item.year,
    posterPath: item.posterUrl,
  });

  // L'habillage des deux fiches du bureau (`useDesktopSheetShell`) : l'arrivée par un retour, la
  // fermeture différée (Échap/Retour arrière, le bouton Retour, la poignée passent tous par
  // `requestClose`), le trajet ou la continuité (§61), la poignée au doigt, le focus rendu au retour
  // du lecteur, et le drapeau « le spectateur a bougé lui-même » remis à zéro à chaque titre.
  const shell = useDesktopSheetShell({ subjectKey: item.sonarrId, underneath, onClose });
  const { containerRef, userHasMovedFocus, markUserMovedFocus, revealed, morph, requestClose, playerOwnsKeyboard } = shell;

  // Drives both the second snap section and the chevron pointing at it: with nothing similar in
  // the library there's no second screen, so neither should exist.
  const similar = useCinemaSimilar(item, "series");
  const hasSimilar = !!onSelectSimilar && similar.length > 0;
  const cast = info?.tmdb?.cast ?? [];
  const runtimeLabel = useRuntimeLabel();
  const hasBelow = hasSimilar || cast.length > 0;

  const playerEnabled = usePlayerEnabled();
  // Re-runs once playerEnabled AND episodesData (Play only renders once nextEpisode is known —
  // see the doc comment above) resolve, same race this fixed on the movie side: landing before
  // either does otherwise freezes focus on whatever row happened to be first at that moment.
  useEffect(() => {
    // Tant que le spectateur n'a pas bougé lui-même — voir la fiche film pour le détail.
    const frame = requestAnimationFrame(() => {
      // Ni sous l'écran des épisodes (15/10/2026, passe de nuit, BUREAU-23) : ouvert par l'adresse
      // (rechargement, lien), il pose le focus sur sa saison, puis `nextEpisode` arrive et relançait
      // cet effet — le focus repartait sur « À suivre », caché dessous, et plus aucune flèche ne
      // bougeait rien. Sa fermeture rend elle-même la main à la première action.
      if (underneath || showEpisodes || userHasMovedFocus()) return;
      focusFirstAction(containerRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [playerEnabled, lead.trailerKey, episodesData?.nextEpisode, facts.targetId, item.sonarrId, underneath, showEpisodes, containerRef, userHasMovedFocus]);

  // Échap et Retour arrière referment, les flèches parcourent le menu — et rien quand une feuille
  // est posée par-dessus ou qu'on tape dans un champ : la règle de toutes les fiches, `useSheetKeys`.
  useSheetKeys({
    // CinemaEpisodeBrowser has its own Escape handler (also on window) that closes just
    // itself — same guard TrailerModal needed, for the same reason.
    listening: !underneath && !showTrailer && !playerOwnsKeyboard && !(showEpisodes && episodesShown),
    // L'adresse dit « épisodes » mais l'écran n'est pas dessiné : sa liste n'est pas encore là
    // (rechargement, retour sur cette entrée) ou n'arrivera pas (Jellyfin en panne). Personne
    // n'écoutait alors Échap — la fiche s'effaçait devant un écran absent, et la touche restait
    // morte pour de bon si la liste échouait (13/10/2026). C'est ce cran-là qu'Échap referme, et
    // les flèches n'ont rien à parcourir.
    onClose: showEpisodes ? () => cinemaClose({ episodes: false }) : requestClose,
    onKey: showEpisodes
      ? undefined
      : (e) => {
          // The similar-titles row below the menu takes the arrow keys when focus is in it (and
          // claims the Down that enters it from the last menu row) — see similarRowKeyNav.
          if (similarRowKeyNav(e, containerRef.current)) return;

          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          markUserMovedFocus();
          detailMenuArrowNav(e, containerRef.current);
        },
  });

  // `getNextEpisode` (plus haut) : the episode right after `currentItemId` in flat (season, episode)
  // order — same "next up" semantics PlayButton and PlayerHost's credits-time auto-advance expect,
  // powered by the same season/episode list "Plus d'épisodes" already needs.
  const playback = usePlayback();

  function playEpisode(ep: CinemaEpisode) {
    // Là où il en est, avec la suite de la série : le lancement des listes d'épisodes (`playEpisodeFrom`).
    playEpisodeFrom(playback, ep, getNextEpisode);
    // L'écran des épisodes reste ouvert sous le lecteur (voir `CinemaEpisodeBrowser`), comme sur le
    // téléphone. Il était refermé ici, par `history.back()` — qui, depuis que le lecteur a son entrée
    // d'historique (§94, 15/10), retirait celle-ci à peine posée : le lecteur se fermait aussitôt et
    // un clic sur un épisode « ne faisait rien » (18/10/2026).
  }

  if (typeof document === "undefined") return null;

  const playTargetId = facts.targetId;

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

      {/* Partager la série entière par un lien (DECISIONS.md §112) : une pastille discrète en face du
          retour, hors du menu de la fiche — administrateur seul. */}
      {shareableFrom("series", { jellyfinItemId: item.jellyfinItemId, fileMissing }) && (
        <ShareButton
          variant="icon"
          iconClassName="btn btn-ghost fixed z-10 rounded-full bg-black/55 p-2.5 float-edge"
          iconStyle={{ top: "max(1rem, env(safe-area-inset-top))", right: "1rem" }}
          kind="series"
          itemId={item.jellyfinItemId}
          sonarrId={item.sonarrId ?? null}
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
          key={item.sonarrId}
          data-sheet-content=""
          style={COLUMN_STYLE}
          // La sortie est celle de la copie (`useSheetMorph`), plus celle de la colonne.
          className={`flex flex-col ${COLUMN_GAP} px-8 sm:px-16 ${detailColumnMotion({ leaving: false, revealed: revealed || morph.handlesEntry })}`}
        >
          <CinemaDetailTitle title={item.title} logoUrl={item.logoUrl} />

          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>{item.year}</span>
            {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
            {/* Celle du catalogue, là dès l'ouverture ; celle de TMDB en fondu sinon — voir `sheetEpisodeRuntime`. */}
            {runtimeLabel(episodeRuntime.minutes, true) && <span className={episodeRuntime.late ? late.fade : ""}>{runtimeLabel(episodeRuntime.minutes, true)}</span>}
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

          {/* Plus étroit que le texte au-dessus, sans être une colonne à part — voir MENU_STYLE. */}
          <div data-detail-actions className="mt-2 flex flex-col gap-1" style={MENU_STYLE}>
            {playPending && (
              <div aria-hidden="true" data-sheet-reserved="" className={`${MENU_ROW} ${MENU_ROW_INACTIVE} invisible`}>
                <span className={MENU_BADGE} />
                <span className="text-sm font-medium">{t("common.play")}</span>
              </div>
            )}
            {/* « Lire en ligne » passe en dessous, comme sur la fiche d'un film. */}
            {/* Même si la bibliothèque a perdu le fichier : la copie de l'appareil est alors la seule lisible (§109). */}
            {playTargetId && offlinePlayable && (
              <OfflinePlayButton
                download={offlinePlayable}
                onlineResumeTicks={facts.resumeTicks}
                onlineKnown={facts.resumeKnown}
                episodeCode={offlineEpisodeCode}
                variant="row"
                rowClassName={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
                badgeClassName={MENU_BADGE}
              />
            )}
            {playTargetId && (
              <PlayButton
                itemId={playTargetId}
                title={facts.title}
                resumeTicks={facts.resumeTicks ?? undefined}
                runtimeTicks={facts.runtimeTicks ?? undefined}
                // Tant que la liste des épisodes n'est pas là, la reprise locale donne le libellé et
                // la position reste au serveur.
                resumeKnown={facts.resumeKnown}
                unavailable={fileMissing}
                reserve
                // « Lire S1·É1 » supposé d'après le catalogue : un appui attend la réponse du serveur.
                waitForServer={waitForServer}
                getNextEpisode={getNextEpisode}
                variant="row"
                // PlayButton's own default label (elapsed time, no episode code) is meant for
                // every Lire button in the app, not just Cinema Mode's — overridden here so this
                // one reads exactly like the Continue Watching row's cards (same helper, "Lire
                // EpX SX" / "Reprendre EpX SX - 30min restants"), since a user landing here from
                // that row would otherwise see two different labels for the same episode.
                // (Un fichier introuvable : `PlayButton` dit « Fichier introuvable » avant tout libellé.)
                label={playLabel}
                // La même ligne que les autres : c'est le sélecteur qui se peint en blanc.
                className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
              />
            )}

            {/* Only when the NEXT episode itself has progress — a fresh, never-started episode
                already opens at 0 via Lire above, same reasoning as CinemaMovieDetail's own
                restart row.

                `resumeAt: 0`, explicitement. Le champ était omis, et le commentaire d'origine le
                justifiait par le lecteur stable, qui ne saute que sur une valeur vraie. Le lecteur
                natif lit un champ absent comme « prends la position du serveur » : « Recommencer »
                reprenait donc l'épisode là où on l'avait laissé. Le jumeau côté film a été corrigé
                d'abord et celui-ci oublié — c'est exactement la dérive que le CLAUDE.md décrit.
                La garde de lecture intégrée l'a été aussi, des deux côtés : d'où `PlayButton`, qui
                porte les trois (29/09/2026, DECISIONS §1). */}
            {playTargetId && (
              <PlayButton
                restart
                itemId={playTargetId}
                title={facts.title}
                resumeTicks={facts.resumeTicks ?? undefined}
                unavailable={fileMissing}
                getNextEpisode={getNextEpisode}
                variant="row"
                label={t("cinema.restartFromBeginning")}
                className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
              />
            )}

            {/* Sa place est tenue, invisible et hors du clavier, tant que la description n'est pas là. */}
            <DetailTrailerRow lead={lead} late={late} onOpen={() => setShowTrailer(true)} />

            {episodesData?.seasons && episodesData.seasons.length > 0 && (
              <button data-detail-menu onClick={() => setShowEpisodes(true)} className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
                <span className={MENU_BADGE}>
                  <ListVideo size={14} />
                </span>
                <span className="text-sm font-medium">{t("cinema.moreEpisodes")}</span>
              </button>
            )}

            {/* « Vu » puis « À voir » : la forme de toutes les fiches (`TitleToggles`, §117.4). Estompé
                tant que Jellyfin n'a pas répondu : ce bouton écrit, et proposer d'écrire une valeur
                qu'on n'a pas lue est la façon la plus sûre de la changer par erreur. */}
            <TitleToggleRow face={WATCHED_FACE} on={watched} onClick={toggleWatched} disabled={flagsBusy} unknown={!flagsKnown} />

            {/* L'état tient dans la pastille, et non dans la ligne entière — voir la fiche film. */}
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
            <CinemaCastRow cast={cast} />
            {hasSimilar && <CinemaSimilarRow items={similar} onSelect={(next) => onSelectSimilar?.(next as CinemaSeries)} />}
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
            // Same focus-restore fix as CinemaMovieDetail — see its own note.
            requestAnimationFrame(() => focusFirstAction(containerRef.current));
          }}
        />
      )}

      {episodesShown && episodesData?.seasons && (
        <CinemaEpisodeBrowser
          title={item.title}
          seasons={episodesData.seasons}
          sonarrId={item.sonarrId}
          seriesItemId={item.jellyfinItemId}
          posterUrl={item.posterUrl}
          nextEpisodeId={episodesData?.nextEpisode?.itemId}
          onClose={() => {
            setShowEpisodes(false);
            // Same focus-restore fix — CinemaEpisodeBrowser unmounting otherwise leaves focus
            // stranded on <body>, same as TrailerModal above.
            requestAnimationFrame(() => focusFirstAction(containerRef.current));
          }}
          onPlayEpisode={playEpisode}
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
