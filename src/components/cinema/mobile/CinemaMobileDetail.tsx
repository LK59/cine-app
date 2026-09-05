"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { BookmarkCheck, Check, ChevronDown, CircleCheck, Play, Plus, RotateCcw, Video, X } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { formatContinueLabel } from "@/lib/cinemaContinueLabel";
import { useDelayedClose } from "@/lib/useDelayedClose";
import { useSwipeToDismiss } from "@/lib/useSwipeToDismiss";
import { useAddToWatchlist } from "@/lib/useAddToWatchlist";
import { useWatchlistStatusMap } from "@/lib/useWatchlistStatusMap";
import { usePlayerEnabled } from "@/lib/usePlayerEnabled";
import { usePlayback } from "@/components/PlaybackProvider";
import { PosterImage } from "@/components/PosterImage";
import { CinemaEpisodeProgress } from "@/components/cinema/CinemaEpisodeProgress";
import { formatDurationShort } from "@/lib/format";
import { ImdbBadge } from "@/components/ImdbBadge";
import { CinemaSimilarRow, useCinemaSimilar } from "@/components/cinema/CinemaSimilarRow";
import { useT } from "@/components/TranslationProvider";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import type { CinemaProgressPayload } from "@/app/api/cinema/progress/[itemId]/route";
import type { CinemaEpisodesPayload, CinemaEpisode } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";

const TrailerModal = dynamic(() => import("@/components/TrailerModal").then((m) => m.TrailerModal), { ssr: false });

interface DetailInfo {
  tmdb: { overview: string; cast: { tmdbId: number; name: string }[] } | null;
  trailerKey: string | null;
}

// Netflix's own mobile title page: a 16:9 preview up top, then title/meta, a white primary
// action, the synopsis, a row of icon actions, and — for a series — the season's episode list.
//
// One component for both media types here, unlike the desktop pair (CinemaMovieDetail /
// CinemaSeriesDetail): on mobile this is a single scrolling column whose two branches are small
// and local (which /info endpoint to read, and whether an episode list follows), so splitting it
// would mean two near-identical 300-line files rather than the genuinely diverging layouts the
// desktop split exists for.
export function CinemaMobileDetail({
  item,
  mediaType,
  onClose,
  onSelectSimilar,
}: {
  item: CinemaMovie | CinemaSeries;
  mediaType: "movies" | "series";
  onClose: () => void;
  // Swaps this sheet's subject when a "Titres similaires" poster is tapped, rather than stacking
  // a second sheet on top of it.
  onSelectSimilar?: (item: CinemaMovie | CinemaSeries) => void;
}) {
  const t = useT();
  const playback = usePlayback();
  const playerEnabled = usePlayerEnabled();
  const [showTrailer, setShowTrailer] = useState(false);
  const { closing, requestClose } = useDelayedClose(onClose, 220);
  const similar = useCinemaSimilar(item, mediaType);
  // Grab the banner and pull the sheet away — see the hook. Only the artwork above the title is
  // a handle; everything from the Lire button down scrolls as usual.
  const swipe = useSwipeToDismiss(requestClose);

  const isSeries = mediaType === "series";
  const infoUrl = isSeries
    ? `/api/sonarr/series/${(item as CinemaSeries).sonarrId}/info`
    : `/api/radarr/movies/${(item as CinemaMovie).radarrId}/info`;
  const { data: info } = useSWR<DetailInfo>(infoUrl, fetcher);

  // Movies carry their resume point on a per-user endpoint (the library payload is shared across
  // viewers); a series' equivalent is whichever episode Jellyfin says is next up.
  const { data: progress } = useSWR<CinemaProgressPayload>(
    isSeries ? null : `/api/cinema/progress/${item.jellyfinItemId}`,
    fetcher
  );
  const { data: episodesData } = useSWR<CinemaEpisodesPayload>(
    isSeries ? `/api/cinema/series/${item.jellyfinItemId}/episodes` : null,
    fetcher
  );

  const tmdbId = item.tmdbId ?? 0;
  const statusMap = useWatchlistStatusMap(tmdbId ? [{ mediaType: isSeries ? "series" : "movie", tmdbId }] : []);
  const { addedStatus, addToWatchlist, removeFromWatchlist } = useAddToWatchlist(
    tmdbId ? statusMap[`${isSeries ? "series" : "movie"}:${tmdbId}`] ?? null : null
  );
  const watched = addedStatus === "watched";
  const inList = addedStatus === "to_watch";

  const [logoErrored, setLogoErrored] = useState(false);
  const [backdropFailed, setBackdropFailed] = useState(false);
  const seasons = episodesData?.seasons ?? [];
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const activeSeason = selectedSeason ?? seasons[0]?.seasonNumber ?? null;
  const episodes = seasons.find((s) => s.seasonNumber === activeSeason)?.episodes ?? [];

  // Escape still closes on the mobile layout — a hardware/bluetooth keyboard on a tablet, and
  // desktop browsers emulating a phone viewport, both reach this screen.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (showTrailer) return;
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, showTrailer]);

  // Deliberately stays open underneath the player: dismissing the player should land back on
  // the sheet you started from, not on the browse grid behind it.

  const nextEpisode = episodesData?.nextEpisode;
  const resumeTicks = isSeries ? nextEpisode?.resumeTicks ?? null : progress?.resumeTicks ?? null;
  const runtimeTicks = isSeries ? nextEpisode?.runtimeTicks ?? null : progress?.runtimeTicks ?? null;
  const hasResume = !!resumeTicks && resumeTicks > 0;
  const playTargetId = isSeries ? nextEpisode?.itemId : item.jellyfinItemId;
  const playTargetTitle = isSeries ? nextEpisode?.title ?? item.title : item.title;

  // Flat (season, episode) order — powers the player's own credits-time auto-advance, same
  // contract PlayButton/PlayerHost already expect on desktop.
  function getNextEpisode(currentItemId: string) {
    const flat = seasons.flatMap((s) => s.episodes);
    const idx = flat.findIndex((e) => e.jellyfinItemId === currentItemId);
    if (idx === -1 || idx === flat.length - 1) return null;
    return { itemId: flat[idx + 1].jellyfinItemId, title: flat[idx + 1].title };
  }

  function play(fromStart = false) {
    if (!playTargetId) return;
    playback.play({
      itemId: playTargetId,
      title: playTargetTitle,
      resumeAt: !fromStart && resumeTicks ? resumeTicks / 10_000_000 : undefined,
      ...(isSeries ? { getNextEpisode } : {}),
    });
  }

  function playEpisode(episode: CinemaEpisode) {
    playback.play({
      itemId: episode.jellyfinItemId,
      title: episode.title,
      resumeAt: episode.resumeTicks ? episode.resumeTicks / 10_000_000 : undefined,
      getNextEpisode,
    });
  }

  function toggleWatched() {
    if (watched) removeFromWatchlist({ tmdbId, mediaType: isSeries ? "series" : "movie" });
    else
      addToWatchlist(
        { tmdbId, mediaType: isSeries ? "series" : "movie", title: item.title, year: item.year, posterPath: item.posterUrl, voteAverage: null },
        "watched"
      );
  }

  function toggleInList() {
    if (inList) removeFromWatchlist({ tmdbId, mediaType: isSeries ? "series" : "movie" });
    else
      addToWatchlist(
        { tmdbId, mediaType: isSeries ? "series" : "movie", title: item.title, year: item.year, posterPath: item.posterUrl, voteAverage: null },
        "to_watch"
      );
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      // The entrance animation is dropped from the first touch onwards, not just while the
      // finger is down: it animates the same transform this does (a running animation beats an
      // inline style, so the sheet wouldn't follow the finger at all), and letting it back in on
      // release made the sheet replay its whole entrance every time a drag sprang back — which
      // is what the "weird animation on release" was.
      className={`app-viewport fixed inset-x-0 top-0 overflow-y-auto overscroll-contain bg-ink ${
        swipe.touched ? "" : closing ? "animate-fade-out" : "animate-slide-up"
      }`}
      // Starts the artwork below the status bar rather than behind it: iOS dims and blurs that
      // strip in a standalone PWA, so a full-bleed image there just comes out muddy and the close
      // button lands in the murk.
      style={{
        // Au-dessus des panneaux du rail (46) : une fiche ouverte depuis la recherche ou Ma liste
        // les recouvre sans les refermer, pour qu'un retour y ramène.
        zIndex: 47,
        paddingTop: "env(safe-area-inset-top, 0px)",
        transform: swipe.touched ? `translateY(${swipe.offset}px)` : undefined,
        // No transition while the finger is down: the sheet is not animating towards the finger,
        // it is where the finger is. On release the spring back (or the rest of the way out) is
        // what gets eased.
        transition: swipe.dragging
          ? "none"
          : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1), border-radius 200ms ease-out",
        // Stays fully opaque on the way down — fading it turned the gesture into a screen effect
        // you could see the grid through. It's one solid panel being moved out of the way, so it
        // gets the two things a panel gets when it lifts off the screen edge: corners and a
        // shadow, both proportional to how far it has come.
        borderTopLeftRadius: swipe.offset > 0 ? Math.min(28, swipe.offset * 0.5) : undefined,
        borderTopRightRadius: swipe.offset > 0 ? Math.min(28, swipe.offset * 0.5) : undefined,
        boxShadow: swipe.offset > 0 ? "0 -18px 50px rgba(0,0,0,0.55)" : undefined,
      }}
    >
      {/* 16:9 header image, bleeding into the page under a gradient rather than ending on a hard
          edge — the same treatment the desktop sheet uses, scaled to a phone. */}
      <div
        className="relative aspect-video w-full"
        {...swipe.handlers}
        // touch-action none: the browser must not claim this gesture for its own scrolling, or
        // it steals the pointer stream halfway through the drag. Only this block gives that up —
        // the rest of the sheet scrolls natively.
        style={{ touchAction: "none" }}
      >
        {/* Un échec de chargement retombe sur le fond uni, comme une absence d'image.
            Sans cela le navigateur dessinait sa propre vignette d'image cassée — un « ? » en
            plein milieu de la bannière, ce qu'on voyait sur les fiches de séries dont le visuel
            manque. */}
        {item.backdropUrl && !backdropFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.backdropUrl}
            alt=""
            onError={() => setBackdropFailed(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-slate-900" />
        )}
        <div className="absolute inset-0 bg-linear-to-t from-ink via-ink/20 to-transparent" />
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={requestClose}
          aria-label={t("cinema.back")}
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white active:scale-95"
        >
          <X size={18} />
        </button>
      </div>

      <div className="-mt-6 px-4 pb-16">
        {item.logoUrl && !logoErrored ? (
          <CinemaLogo src={item.logoUrl} alt={item.title} surface="phone" onError={() => setLogoErrored(true)} className="mb-3 object-left" />
        ) : (
          <h1 className="mb-3 text-2xl font-bold leading-tight text-white font-display">{item.title}</h1>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-white/70">
          <span>{item.year}</span>
          {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
          {isSeries && seasons.length > 0 && (
            <span>{t("cinema.seasonCount", { n: seasons.length })}</span>
          )}
          {item.genres.length > 0 && <span className="truncate">{item.genres.slice(0, 3).join(" · ")}</span>}
        </div>

        {playerEnabled && playTargetId && (
          <button
            type="button"
            onClick={() => play()}
            className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-white px-4 py-3 text-base font-semibold text-ink transition-transform active:scale-95"
          >
            <Play size={18} fill="currentColor" />
            {formatContinueLabel(
              t,
              resumeTicks,
              runtimeTicks,
              isSeries ? nextEpisode?.seasonNumber : null,
              isSeries ? nextEpisode?.episodeNumber : null
            )}
          </button>
        )}

        {playerEnabled && playTargetId && hasResume && (
          <button
            type="button"
            onClick={() => play(true)}
            className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-white/10 px-4 py-3 text-sm font-medium text-white transition-transform active:scale-95"
          >
            <RotateCcw size={16} />
            {t("cinema.restartFromBeginning")}
          </button>
        )}

        {info?.trailerKey && (
          <button
            type="button"
            onClick={() => setShowTrailer(true)}
            className="mb-4 flex w-full items-center justify-center gap-2 rounded-md bg-white/10 px-4 py-3 text-sm font-medium text-white transition-transform active:scale-95"
          >
            <Video size={16} />
            {t("cinema.trailer")}
          </button>
        )}

        <p className="mb-3 text-sm leading-6 text-white/90">{info?.tmdb?.overview || item.overview}</p>

        {info?.tmdb?.cast && info.tmdb.cast.length > 0 && (
          <p className="mb-5 text-xs leading-5 text-white/50">
            {t("cinema.cast")} {info.tmdb.cast.slice(0, 5).map((c) => c.name).join(", ")}
          </p>
        )}

        {/* Netflix's icon-over-label action row — big touch targets, no text buttons competing
            with the primary white one above. */}
        <div className="mb-6 flex items-start gap-8">
          {/* Deux coches identiques côte à côte, dont l'une servait à la fois d'« ajouter » et
              d'« ajouté » : rien ne distinguait les deux boutons ni les deux états. Un plus qui
              devient un marque-page coché se lit d'un coup d'œil, et le libellé dit l'état. */}
          <button type="button" onClick={toggleInList} aria-pressed={inList} className="flex w-16 flex-col items-center gap-1.5 active:scale-95">
            {inList ? <BookmarkCheck size={22} className="text-accent-400" /> : <Plus size={22} className="text-white" />}
            <span className="text-center text-xs leading-tight text-white/70">
              {inList ? t("cinema.inMyList") : t("watchlist.statuses.toWatch")}
            </span>
          </button>
          <button type="button" onClick={toggleWatched} aria-pressed={watched} className="flex w-16 flex-col items-center gap-1.5 active:scale-95">
            {watched ? <CircleCheck size={22} className="text-accent-400" /> : <Check size={22} className="text-white" />}
            <span className="text-center text-xs leading-tight text-white/70">
              {watched ? t("cinema.watchedState") : t("cinema.markWatched")}
            </span>
          </button>
        </div>

        {isSeries && seasons.length > 0 && (
          <>
            {/* Horizontal season pills rather than Netflix's dropdown: same job, one tap instead
                of two, and no popover to position/dismiss on a small screen. */}
            {seasons.length > 1 && (
              <div className="scrollbar-thin -mx-4 mb-3 flex gap-2 overflow-x-auto px-4">
                {seasons.map((season) => {
                  const active = season.seasonNumber === activeSeason;
                  return (
                    <button
                      key={season.seasonNumber}
                      type="button"
                      onClick={() => setSelectedSeason(season.seasonNumber)}
                      className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-sm transition-colors ${
                        active ? "bg-white text-ink font-medium" : "bg-white/10 text-white/80"
                      }`}
                    >
                      {season.seasonNumber === 0 ? t("cinema.specials") : t("cinema.season", { n: season.seasonNumber })}
                      {active && <ChevronDown size={14} />}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="space-y-4">
              {episodes.map((episode) => (
                <button
                  key={episode.jellyfinItemId}
                  type="button"
                  onClick={() => playEpisode(episode)}
                  className="flex w-full gap-3 text-left active:scale-95"
                >
                  <div className="relative w-32 shrink-0">
                    <PosterImage src={episode.thumbnailUrl} alt={episode.title} aspectRatio="aspect-video" unoptimized subtle />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-xs">
                        <Play size={14} fill="currentColor" />
                      </span>
                    </span>
                    {episode.watched && (
                      <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent-500/90">
                        <Check size={10} className="text-white" />
                      </span>
                    )}
                    <CinemaEpisodeProgress
                      resumeTicks={episode.resumeTicks}
                      runtimeTicks={episode.runtimeTicks}
                      watched={episode.watched}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white">
                      {episode.episodeNumber}. {episode.title}
                      {episode.jellyfinItemId === nextEpisode?.itemId && (
                        <span className="ml-2 rounded-full bg-accent-600/25 px-2 py-0.5 text-xs font-medium text-accent-300">
                          {t("cinema.nextUpBadge")}
                        </span>
                      )}
                    </p>
                    {/* Remaining time on a started episode, runtime otherwise — same rule as the
                        desktop season browser. */}
                    {episode.resumeTicks && episode.runtimeTicks && !episode.watched ? (
                      <p className="mt-0.5 text-xs text-accent-300">
                        {t("cinema.timeRemaining", { time: formatDurationShort(episode.runtimeTicks - episode.resumeTicks) })}
                      </p>
                    ) : (
                      episode.runtimeMinutes && <p className="mt-0.5 text-xs text-white/50">{episode.runtimeMinutes} min</p>
                    )}
                    {episode.overview && <p className="mt-1 line-clamp-3 text-xs leading-5 text-white/60">{episode.overview}</p>}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {onSelectSimilar && <CinemaSimilarRow items={similar} onSelect={onSelectSimilar} />}
      </div>

      {showTrailer && info?.trailerKey && (
        <TrailerModal youtubeKey={info.trailerKey} title={item.title} onClose={() => setShowTrailer(false)} />
      )}
    </div>,
    document.body
  );
}
