"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { ArrowLeft, BookmarkCheck, Check, CircleCheck, ListVideo, Plus, RotateCcw, Video } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { ImdbBadge } from "@/components/ImdbBadge";
import { CinemaSimilarRow, useCinemaSimilar, similarRowKeyNav } from "@/components/cinema/CinemaSimilarRow";
import { CinemaScrollHint } from "@/components/cinema/CinemaScrollHint";
import { useCinemaRoute, cinemaNavigate, cinemaClose } from "@/lib/cinemaRoute";
import { PlayButton } from "@/components/PlayButton";
import { usePlayback } from "@/components/PlaybackProvider";
import { usePlayerEnabled } from "@/lib/usePlayerEnabled";
import { useAddToWatchlist } from "@/lib/useAddToWatchlist";
import { useWatchlistStatusMap } from "@/lib/useWatchlistStatusMap";
import { formatContinueLabel } from "@/lib/cinemaContinueLabel";
import { useDelayedClose } from "@/lib/useDelayedClose";
import { useT } from "@/components/TranslationProvider";
import { CinemaEpisodeBrowser } from "@/components/cinema/CinemaEpisodeBrowser";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import type { CinemaEpisodesPayload, CinemaEpisode } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import { MENU_ROW, MENU_ROW_INACTIVE, MENU_BADGE, MENU_BADGE_ACTIVE } from "@/components/cinema/detailMenu";
import { HORIZONTAL_VEIL, VERTICAL_VEIL, COLUMN_STYLE, MENU_STYLE, LOGO_STYLE, SECTION_CLASS, LOGO_CLASS, OVERVIEW_CLASS, CAST_CLASS, COLUMN_GAP, CinemaProgressBar } from "@/components/cinema/CinemaDetailLayout";

const TrailerModal = dynamic(() => import("@/components/TrailerModal").then((m) => m.TrailerModal), { ssr: false });


interface SonarrCastMember {
  tmdbId: number;
  name: string;
  character: string;
  photoUrl: string | null;
}

interface SonarrInfo {
  tmdb: { overview: string; cast: SonarrCastMember[] } | null;
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
}: {
  item: CinemaSeries;
  onClose: () => void;
  // Same role as CinemaMovieDetail's — swaps the subject instead of stacking sheets.
  onSelectSimilar?: (item: CinemaSeries) => void;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  /** Vrai dès que le spectateur a lui-même déplacé le focus — voir l'effet plus bas. */
  const userMovedFocus = useRef(false);
  const [showTrailer, setShowTrailer] = useState(false);
  // In the URL like every other Cinema layer, so Back closes the season browser and returns to
  // this sheet instead of leaving the mode (see lib/cinemaRoute).
  const showEpisodes = useCinemaRoute().episodes;
  const setShowEpisodes = (open: boolean) =>
    open ? cinemaNavigate({ episodes: true }) : cinemaClose({ episodes: false });
  const { data: info } = useSWR<SonarrInfo>(`/api/sonarr/series/${item.sonarrId}/info`, fetcher);
  const { data: episodesData } = useSWR<CinemaEpisodesPayload>(`/api/cinema/series/${item.jellyfinItemId}/episodes`, fetcher);
  // Same fix as CinemaMovieDetail: without an initialStatus, Vu/À voir always opened looking
  // un-toggled even for a series already on the watchlist. item.tmdbId can be null (Sonarr
  // doesn't always resolve one) — bulk-status has nothing to look up then, same as toggleWatched/
  // toggleAddToList below already treat that case (tmdbId ?? 0).
  const statusMap = useWatchlistStatusMap(item.tmdbId ? [{ mediaType: "series", tmdbId: item.tmdbId }] : []);
  const { addedStatus, addToWatchlist, removeFromWatchlist } = useAddToWatchlist(
    item.tmdbId ? statusMap[`series:${item.tmdbId}`] ?? null : null
  );
  const [logoErrored, setLogoErrored] = useState(false);

  // Same exit-animation delay as CinemaMovieDetail — see that hook's own doc comment.
  const { closing, requestClose } = useDelayedClose(onClose, 220);

  // Drives both the second snap section and the chevron pointing at it: with nothing similar in
  // the library there's no second screen, so neither should exist.
  const similar = useCinemaSimilar(item, "series");
  const hasSimilar = !!onSelectSimilar && similar.length > 0;

  const playerEnabled = usePlayerEnabled();
  // Re-runs once playerEnabled AND episodesData (Play only renders once nextEpisode is known —
  // see the doc comment above) resolve, same race this fixed on the movie side: landing before
  // either does otherwise freezes focus on whatever row happened to be first at that moment.
  useEffect(() => {
    // Tant que le spectateur n'a pas bougé lui-même — voir la fiche film pour le détail.
    const frame = requestAnimationFrame(() => {
      if (userMovedFocus.current) return;
      containerRef.current?.querySelector<HTMLButtonElement>("[data-detail-menu]")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [playerEnabled, info?.trailerKey, episodesData?.nextEpisode]);

  // Same as CinemaMovieDetail — see its own note. The sheet stays open under the player so
  // closing the player comes back here, and stands down from the keyboard while it's up there.
  const playback = usePlayback();
  const playerOwnsKeyboard = playback.mode === "full";
  const wasPlayerFullScreen = useRef(playerOwnsKeyboard);
  useEffect(() => {
    if (wasPlayerFullScreen.current && !playerOwnsKeyboard) {
      containerRef.current?.querySelector<HTMLButtonElement>("[data-detail-menu]")?.focus();
    }
    wasPlayerFullScreen.current = playerOwnsKeyboard;
  }, [playerOwnsKeyboard]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // CinemaEpisodeBrowser has its own Escape handler (also on window) that closes just
      // itself — same guard TrailerModal needed, for the same reason.
      if (showTrailer || showEpisodes || playerOwnsKeyboard) return;
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        requestClose();
        return;
      }
      // The similar-titles row below the menu takes the arrow keys when focus is in it (and
      // claims the Down that enters it from the last menu row) — see similarRowKeyNav.
      if (similarRowKeyNav(e, containerRef.current)) return;

      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      userMovedFocus.current = true;
      const rows = Array.from(containerRef.current?.querySelectorAll<HTMLButtonElement>("[data-detail-menu]") ?? []);
      if (rows.length === 0) return;
      e.preventDefault();
      const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown") rows[Math.min(idx + 1, rows.length - 1)]?.focus();
      else rows[Math.max(idx - 1, 0)]?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, showTrailer, showEpisodes, playerOwnsKeyboard]);

  function toggleWatched() {
    if (watched) removeFromWatchlist({ tmdbId: item.tmdbId ?? 0, mediaType: "series" });
    else
      addToWatchlist(
        { tmdbId: item.tmdbId ?? 0, mediaType: "series", title: item.title, year: item.year, posterPath: item.posterUrl, voteAverage: null },
        "watched"
      );
  }

  function toggleAddToList() {
    if (inList) removeFromWatchlist({ tmdbId: item.tmdbId ?? 0, mediaType: "series" });
    else
      addToWatchlist(
        { tmdbId: item.tmdbId ?? 0, mediaType: "series", title: item.title, year: item.year, posterPath: item.posterUrl, voteAverage: null },
        "to_watch"
      );
  }

  // The episode right after `currentItemId` in flat (season, episode) order — same "next up"
  // semantics PlayButton's getNextEpisode already expects (see PlayerHost's own credits-time
  // auto-advance), powered here by the same season/episode list "Plus d'épisodes" already needs.
  function getNextEpisode(currentItemId: string) {
    const flat = (episodesData?.seasons ?? []).flatMap((s) => s.episodes);
    const idx = flat.findIndex((e) => e.jellyfinItemId === currentItemId);
    if (idx === -1 || idx === flat.length - 1) return null;
    return { itemId: flat[idx + 1].jellyfinItemId, title: flat[idx + 1].title };
  }

  function playEpisode(ep: CinemaEpisode) {
    playback.play({
      itemId: ep.jellyfinItemId,
      title: ep.title,
      resumeAt: ep.resumeTicks ? ep.resumeTicks / 10_000_000 : undefined,
      getNextEpisode,
    });
    setShowEpisodes(false);
  }

  if (typeof document === "undefined") return null;

  const watched = addedStatus === "watched";
  const inList = addedStatus === "to_watch";
  const nextEpisode = episodesData?.nextEpisode;
  const hasResume = !!nextEpisode?.resumeTicks && nextEpisode.resumeTicks > 0;

  return createPortal(
    <div
      ref={containerRef}
      className={`fixed inset-0 overflow-hidden bg-ink ${closing ? "animate-fade-out" : "animate-fade-in"}`}
      style={{ zIndex: 46 }}
    >
      {item.backdropUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.backdropUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      )}
      <div
        className="absolute inset-x-0 bottom-0 backdrop-blur-md"
        style={{
          height: "45%",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
        }}
      />
      {/* Deux voiles à étapes explicites plutôt qu'un dégradé en trois arrêts : voir
          CinemaDetailLayout, où la raison de chaque pourcentage est écrite. */}
      <div className="absolute inset-0" style={{ background: VERTICAL_VEIL }} />
      <div className="absolute inset-0" style={{ background: HORIZONTAL_VEIL }} />

      <button
        onClick={requestClose}
        className="btn btn-ghost fixed left-4 top-4 z-10 rounded-full bg-black/55 px-3 py-2"
        style={{ top: "max(1rem, env(safe-area-inset-top))" }}
      >
        <ArrowLeft size={16} /> {t("cinema.back")}
      </button>

      {/* Two snap positions, like the browse screen: the title block, then the similar titles.
          Each section is min-h-full so it fills the viewport on its own, which is what stops the
          scroll from ever resting halfway between the two.

          justify-end inside a min-h-full section, NOT items-end on the scroller: a flex container
          aligned to its end edge clips whatever overflows past its START edge and makes it
          unreachable by scrolling — that's what pushed the logo and title off the top of the
          screen when the similar row first landed here. A section that simply grows can't. */}
      <div className="scrollbar-thin relative h-full snap-y snap-mandatory overflow-y-auto scroll-smooth">
        <div data-snap-section className={SECTION_CLASS}>
        <div
          key={item.sonarrId}
          style={COLUMN_STYLE}
          className={`flex flex-col ${COLUMN_GAP} px-8 sm:px-16 ${closing ? "animate-fade-out-down" : "animate-fade-in-up"}`}
        >
          {item.logoUrl && !logoErrored ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.logoUrl}
              alt={item.title}
              onError={() => setLogoErrored(true)}
              style={LOGO_STYLE}
              className={LOGO_CLASS}
            />
          ) : (
            <h1 className="text-2xl font-bold leading-tight text-white drop-shadow-lg sm:text-4xl font-display">{item.title}</h1>
          )}

          <div className="flex flex-wrap items-center gap-3 text-sm text-white/80">
            <span>{item.year}</span>
            {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
            {item.genres.length > 0 && <span>{item.genres.slice(0, 3).join(" · ")}</span>}
          </div>

          <CinemaProgressBar resumeTicks={nextEpisode?.resumeTicks} runtimeTicks={nextEpisode?.runtimeTicks} />

          <p className={OVERVIEW_CLASS}>
            {info?.tmdb?.overview || item.overview}
          </p>

          {info?.tmdb?.cast && info.tmdb.cast.length > 0 && (
            <p className={CAST_CLASS}>
              {t("cinema.cast")} {info.tmdb.cast.slice(0, 5).map((c) => c.name).join(", ")}
            </p>
          )}

          {/* Plus étroit que le texte au-dessus, sans être une colonne à part — voir MENU_STYLE. */}
          <div className="mt-2 flex flex-col gap-1" style={MENU_STYLE}>
            {nextEpisode && (
              <PlayButton
                itemId={nextEpisode.itemId}
                title={nextEpisode.title}
                resumeTicks={nextEpisode.resumeTicks}
                runtimeTicks={nextEpisode.runtimeTicks}
                getNextEpisode={getNextEpisode}
                variant="row"
                // PlayButton's own default label (elapsed time, no episode code) is meant for
                // every Lire button in the app, not just Cinema Mode's — overridden here so this
                // one reads exactly like the Continue Watching row's cards (same helper, "Lire
                // EpX SX" / "Reprendre EpX SX - 30min restants"), since a user landing here from
                // that row would otherwise see two different labels for the same episode.
                label={formatContinueLabel(
                  t,
                  nextEpisode.resumeTicks,
                  nextEpisode.runtimeTicks,
                  nextEpisode.seasonNumber,
                  nextEpisode.episodeNumber
                )}
                // La même ligne que les autres : c'est le sélecteur qui se peint en blanc.
                className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
              />
            )}

            {/* Only when the NEXT episode itself has progress — a fresh, never-started episode
                already opens at 0 via Lire above, same reasoning as CinemaMovieDetail's own
                restart row. resumeAt deliberately omitted, not 0 — PlayerHost only seeks when
                it's truthy, so leaving it out already starts at the beginning. */}
            {nextEpisode && hasResume && (
              <button
                data-detail-menu
                onClick={() => playback.play({ itemId: nextEpisode.itemId, title: nextEpisode.title, getNextEpisode })}
                className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
              >
                <span className={MENU_BADGE}>
                  <RotateCcw size={14} />
                </span>
                <span className="text-sm font-medium">{t("cinema.restartFromBeginning")}</span>
              </button>
            )}

            {info?.trailerKey && (
              <button data-detail-menu onClick={() => setShowTrailer(true)} className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
                <span className={MENU_BADGE}>
                  <Video size={14} />
                </span>
                <span className="text-sm font-medium">{t("cinema.trailer")}</span>
              </button>
            )}

            {episodesData?.seasons && episodesData.seasons.length > 0 && (
              <button data-detail-menu onClick={() => setShowEpisodes(true)} className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
                <span className={MENU_BADGE}>
                  <ListVideo size={14} />
                </span>
                <span className="text-sm font-medium">{t("cinema.moreEpisodes")}</span>
              </button>
            )}

            <button
              data-detail-menu
              onClick={toggleWatched}
              aria-pressed={watched}
              className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
            >
              <span className={watched ? MENU_BADGE_ACTIVE : MENU_BADGE}>
                {watched ? <CircleCheck size={16} /> : <Check size={14} />}
              </span>
              <span className="text-sm font-medium">
                {watched ? t("cinema.watchedState") : t("cinema.markWatched")}
              </span>
            </button>

            {/* L'état tient dans la pastille, et non dans la ligne entière.
                Une ligne pleine d'accent criait plus fort que le repère de sélection lui-même :
                sur un menu parcouru à la télécommande, la ligne « déjà dans ma liste » avait donc
                l'air d'être celle qu'on venait de désigner. La pastille change de forme (un plus
                devient un marque-page coché) et de couleur ; la ligne, elle, reste disponible
                pour dire ce qu'elle a toujours dit : où l'on se trouve. */}
            <button
              data-detail-menu
              onClick={toggleAddToList}
              aria-pressed={inList}
              className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
            >
              <span className={inList ? MENU_BADGE_ACTIVE : MENU_BADGE}>
                {inList ? <BookmarkCheck size={16} /> : <Plus size={14} />}
              </span>
              {/* Le libellé dit l'état, pas le geste. */}
              <span className="text-sm font-medium">
                {inList ? t("cinema.inMyList") : t("watchlist.statuses.toWatch")}
              </span>
            </button>
          </div>

        </div>
        {hasSimilar && <CinemaScrollHint />}
        </div>

        {/* Its own full-height snap position — centred rather than pinned to the top, so landing
            on it reads as a deliberate second screen instead of one row stranded above a lot of
            empty backdrop. */}
        {hasSimilar && (
          <div data-snap-section className="flex min-h-full snap-start flex-col justify-center px-8 sm:px-16">
            <CinemaSimilarRow items={similar} onSelect={(next) => onSelectSimilar!(next as CinemaSeries)} />
          </div>
        )}
      </div>

      {showTrailer && info?.trailerKey && (
        <TrailerModal
          youtubeKey={info.trailerKey}
          title={item.title}
          onClose={() => {
            setShowTrailer(false);
            // Same focus-restore fix as CinemaMovieDetail — see its own note.
            requestAnimationFrame(() => containerRef.current?.querySelector<HTMLButtonElement>("[data-detail-menu]")?.focus());
          }}
        />
      )}

      {showEpisodes && episodesData?.seasons && (
        <CinemaEpisodeBrowser
          title={item.title}
          seasons={episodesData.seasons}
          nextEpisodeId={nextEpisode?.itemId}
          onClose={() => {
            setShowEpisodes(false);
            // Same focus-restore fix — CinemaEpisodeBrowser unmounting otherwise leaves focus
            // stranded on <body>, same as TrailerModal above.
            requestAnimationFrame(() => containerRef.current?.querySelector<HTMLButtonElement>("[data-detail-menu]")?.focus());
          }}
          onPlayEpisode={playEpisode}
        />
      )}
    </div>,
    document.body
  );
}
