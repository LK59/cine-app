"use client";

import useSWR from "swr";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Info, Play, Search } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { formatContinueLabel } from "@/lib/cinemaContinueLabel";
import { usePlayback } from "@/components/PlaybackProvider";
import { PosterImage } from "@/components/PosterImage";
import { CinemaSearchOverlay } from "@/components/cinema/CinemaSearchOverlay";
import { useT } from "@/components/TranslationProvider";
import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import type { CinemaMoviesPayload, CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeriesPayload, CinemaSeries } from "@/app/api/cinema/series/route";
import type { CinemaNextUpPayload } from "@/app/api/cinema/next-up/route";

// Roughly a third of a phone's width, so a row always shows "two and a bit" posters — the visual
// cue that it scrolls, without a card so small the artwork stops being readable.
// The lightweight resume feed — /api/dashboard also carries these, but only alongside a full
// sweep of every service, the torrent client and disk stats, which is a lot of upstream work to
// wait on just to draw one row.
interface CinemaResumeItem {
  id: string;
  name: string;
  type: string;
  progress: number;
  positionTicks: number;
  runtimeTicks: number;
  imageTag: string | null;
}

const POSTER_WIDTH = "w-28 sm:w-32";
const CONTINUE_WIDTH = "w-44 sm:w-48";
// A phone row is flicked through, not traversed — past a couple of dozen cards nobody is
// scrolling horizontally any further, and every extra card is DOM and decoded artwork the
// browser carries for the whole session.
const ROW_ITEM_LIMIT = 24;

// The phone counterpart to CinemaClient. Deliberately a separate component rather than responsive
// classes on that one: the desktop screen is a split-pane, keyboard-driven, hover-preview design
// (a hero that follows focus, arrow-key grid nav, a dwell-triggered trailer) — none of which has
// a meaning on touch. This is the Netflix-mobile shape instead: one scrolling column, a poster
// hero with its actions inline, and rows you flick through. Desktop is untouched.
export function CinemaMobileClient() {
  const t = useT();
  const playback = usePlayback();
  const [mediaType, setMediaType] = useState<"movies" | "series">("movies");
  const [selected, setSelected] = useState<{ item: CinemaMovie | CinemaSeries; mediaType: "movies" | "series" } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const { data: movies, error: moviesError, isLoading: moviesLoading } = useSWR<CinemaMoviesPayload>(
    "/api/cinema/movies",
    fetcher
  );
  // Series (and its Continue Watching feed) stay unfetched until the tab is actually opened —
  // same lazy contract as desktop, and more valuable here where the connection may be mobile data.
  const { data: series, isLoading: seriesLoading } = useSWR<CinemaSeriesPayload>(
    mediaType === "series" ? "/api/cinema/series" : null,
    fetcher
  );
  const { data: nextUp } = useSWR<CinemaNextUpPayload>(mediaType === "series" ? "/api/cinema/next-up" : null, fetcher);
  const { data: resume } = useSWR<{ items: CinemaResumeItem[] }>("/api/jellyfin/resume", fetcher);

  const resumeMovies = (resume?.items ?? []).filter((r) => r.type === "Movie");
  const continueSeries = nextUp?.items ?? [];
  const isSeries = mediaType === "series";
  const payload = isSeries ? series : movies;
  const hero = isSeries ? series?.spotlight[0] : movies?.spotlight[0];

  const openDetail = useCallback((item: CinemaMovie | CinemaSeries, type: "movies" | "series") => {
    setSelected({ item, mediaType: type });
  }, []);

  const exit = () => {
    // Plain assignment, not router.push — same reasoning as the sidebar's own entry link.
    window.location.href = "/";
  };

  if (typeof document === "undefined") return null;

  const loading = moviesLoading || (isSeries && seriesLoading && !series);

  return createPortal(
    <div className="fixed inset-0 flex animate-fade-in flex-col overflow-hidden bg-slate-950" style={{ zIndex: 45 }}>
      {/* Sticky chrome: exit on the left, the two library tabs as Netflix-style filter pills. */}
      {/* The safe-area inset alone puts this flush against the status bar, which iOS then dims
          and blurs over in a standalone PWA — the pills came out half-hidden. An explicit gap on
          top of the inset keeps them clear of it. No backdrop-blur either: a blurred layer that
          content scrolls under is one of the most reliable ways to make scrolling stutter on
          iOS, and a solid bar reads the same here. */}
      <header
        className="flex shrink-0 items-center gap-3 bg-slate-950 px-4 pb-3"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.25rem)" }}
      >
        <button
          type="button"
          onClick={exit}
          aria-label={t("cinema.standardMode")}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white active:scale-95"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex gap-2">
          {(["movies", "series"] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setMediaType(type)}
              className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                mediaType === type
                  ? "border-white bg-white text-slate-950 font-medium"
                  : "border-white/25 text-white/80"
              }`}
            >
              {t(type === "movies" ? "cinema.moviesTab" : "cinema.seriesTab")}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label={t("cinema.search")}
          className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white active:scale-95"
        >
          <Search size={18} />
        </button>
      </header>

      {searchOpen && (
        <CinemaSearchOverlay
          onClose={() => setSearchOpen(false)}
          onSelectMovie={(item) => { setSearchOpen(false); setMediaType("movies"); setSelected({ item, mediaType: "movies" }); }}
          onSelectSeries={(item) => { setSearchOpen(false); setMediaType("series"); setSelected({ item, mediaType: "series" }); }}
        />
      )}

      <div className="flex-1 overflow-y-auto overscroll-contain pb-12">
        {loading && (
          <div className="px-4 pt-2">
            <div className="skeleton aspect-2/3 w-full rounded-2xl" />
            <div className="skeleton mt-6 h-4 w-32 rounded" />
            <div className="mt-3 flex gap-3">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className={`skeleton ${POSTER_WIDTH} aspect-2/3 shrink-0 rounded-lg`} />
              ))}
            </div>
          </div>
        )}

        {moviesError && <p className="px-4 pt-6 text-sm text-red-400">{moviesError.message || t("common.unknown")}</p>}
        {!loading && payload && payload.spotlight.length === 0 && (
          <p className="px-4 pt-6 text-sm text-slate-400">{t("cinema.empty")}</p>
        )}

        {/* Hero: portrait key art with the title treatment and its two actions inline, the shape
            Netflix leads its own phone home screen with. */}
        {hero && (
          <section className="px-4 pt-2">
            <div className="relative overflow-hidden rounded-2xl bg-slate-900 shadow-xl shadow-black/50">
              <PosterImage src={hero.posterUrl} alt={hero.title} subtle unoptimized priority sizes="100vw" />
              <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-slate-950 via-slate-950/70 to-transparent p-4 pt-16">
                {hero.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={hero.logoUrl} alt={hero.title} className="mx-auto mb-2 max-h-14 w-auto max-w-full object-contain drop-shadow-lg" />
                ) : (
                  <h1 className="mb-2 text-center text-2xl font-bold text-white drop-shadow-lg">{hero.title}</h1>
                )}
                {hero.genres.length > 0 && (
                  <p className="mb-3 text-center text-xs text-white/70">{hero.genres.slice(0, 3).join(" · ")}</p>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => playback.play({ itemId: hero.jellyfinItemId, title: hero.title })}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md bg-white px-3 py-2.5 text-sm font-semibold text-slate-950 transition-transform active:scale-95"
                  >
                    <Play size={16} fill="currentColor" />
                    {t("common.play")}
                  </button>
                  <button
                    type="button"
                    onClick={() => openDetail(hero, mediaType)}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md bg-white/15 px-3 py-2.5 text-sm font-medium text-white transition-transform active:scale-95"
                  >
                    <Info size={16} />
                    {t("cinema.moreInfo")}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Continue watching — landscape stills with a progress bar and the same resume wording
            the desktop cards use. */}
        {!isSeries && resumeMovies.length > 0 && (
          <MobileRow label={t("cinema.continueWatching")}>
            {resumeMovies.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() =>
                  playback.play({
                    itemId: entry.id,
                    title: entry.name,
                    resumeAt: entry.positionTicks > 0 ? entry.positionTicks / 10_000_000 : undefined,
                  })
                }
                className={`${CONTINUE_WIDTH} shrink-0 text-left active:scale-95`}
              >
                <div className="relative overflow-hidden rounded-lg">
                  <PosterImage
                    src={entry.imageTag ? `/api/jellyfin/image?itemId=${entry.id}&tag=${entry.imageTag}` : null}
                    alt={entry.name}
                    aspectRatio="aspect-video"
                    unoptimized
                    subtle
                  />
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-xs">
                      <Play size={16} fill="currentColor" />
                    </span>
                  </span>
                  <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
                    <div className="h-full bg-accent-500" style={{ width: `${entry.progress}%` }} />
                  </div>
                </div>
                <p className="mt-1.5 truncate text-xs font-medium text-white/90">{entry.name}</p>
                <p className="truncate text-xs text-white/50">
                  {formatContinueLabel(t, entry.positionTicks, entry.runtimeTicks)}
                </p>
              </button>
            ))}
          </MobileRow>
        )}

        {isSeries && continueSeries.length > 0 && (
          <MobileRow label={t("cinema.continueWatching")}>
            {continueSeries.map((entry) => (
              <button
                key={entry.jellyfinItemId}
                type="button"
                onClick={() =>
                  playback.play({
                    itemId: entry.jellyfinItemId,
                    title: entry.title,
                    resumeAt: entry.resumeTicks ? entry.resumeTicks / 10_000_000 : undefined,
                  })
                }
                className={`${CONTINUE_WIDTH} shrink-0 text-left active:scale-95`}
              >
                <div className="relative overflow-hidden rounded-lg">
                  <PosterImage src={entry.thumbnailUrl} alt={entry.title} aspectRatio="aspect-video" unoptimized subtle />
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-xs">
                      <Play size={16} fill="currentColor" />
                    </span>
                  </span>
                  {entry.resumeTicks && entry.runtimeTicks ? (
                    <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
                      <div
                        className="h-full bg-accent-500"
                        style={{ width: `${Math.min((entry.resumeTicks / entry.runtimeTicks) * 100, 99)}%` }}
                      />
                    </div>
                  ) : null}
                </div>
                <p className="mt-1.5 truncate text-xs font-medium text-white/90">{entry.title}</p>
                <p className="truncate text-xs text-white/50">
                  {formatContinueLabel(t, entry.resumeTicks, entry.runtimeTicks, entry.seasonNumber, entry.episodeNumber)}
                </p>
              </button>
            ))}
          </MobileRow>
        )}

        {payload?.genres.map((genre) => {
          const items = (payload.rows[genre] ?? []).slice(0, ROW_ITEM_LIMIT);
          if (items.length === 0) return null;
          return (
            <MobileRow key={genre} label={genre}>
              {items.map((item) => (
                <button
                  key={isSeries ? (item as CinemaSeries).sonarrId : (item as CinemaMovie).radarrId}
                  type="button"
                  onClick={() => openDetail(item, mediaType)}
                  className={`${POSTER_WIDTH} shrink-0 overflow-hidden rounded-lg transition-transform active:scale-95`}
                >
                  <PosterImage
                    src={item.posterUrl}
                    alt={item.title}
                    subtle
                    unoptimized
                    sizes="(max-width: 640px) 112px, 128px"
                  />
                </button>
              ))}
            </MobileRow>
          );
        })}
      </div>

      {selected && (
        <CinemaMobileDetail
          item={selected.item}
          mediaType={selected.mediaType}
          onClose={() => setSelected(null)}
        />
      )}
    </div>,
    document.body
  );
}

// Full-bleed horizontal scroller: the label keeps the page's padding, the track itself runs to
// both edges so a row reads as continuing past the screen rather than stopping inside a gutter.
//
// content-visibility lets the browser skip layout and paint entirely for rows that are off
// screen — with a dozen-plus rows of artwork that's the difference between scrolling the whole
// document and scrolling the two rows you can actually see. contain-intrinsic-size gives it a
// placeholder height so the scrollbar doesn't jump around as rows render; `auto` there means it
// remembers each row's real height once measured.
const ROW_CONTAINMENT = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 210px",
} as React.CSSProperties;

function MobileRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mt-6" style={ROW_CONTAINMENT}>
      <h2 className="mb-2 px-4 text-sm font-semibold text-white">{label}</h2>
      <div className="scrollbar-thin flex gap-3 overflow-x-auto px-4 pb-1">{children}</div>
    </section>
  );
}
