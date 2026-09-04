"use client";

import useSWR from "swr";
import { useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Info, Play, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { fetcher } from "@/lib/swr";
import { leaveCinema } from "@/lib/leaveCinema";
import { useCinemaRoute, cinemaNavigate, cinemaClose } from "@/lib/cinemaRoute";
import { uniqueById } from "@/lib/cinemaRails";
import { useIsShortViewport } from "@/lib/useIsMobile";
import { useRotatingIndex } from "@/lib/useRotatingIndex";
import { playSeriesNextEpisode } from "@/lib/playSeriesNextEpisode";
import { formatContinueLabel } from "@/lib/cinemaContinueLabel";
import { usePlayback } from "@/components/PlaybackProvider";
import { PosterImage } from "@/components/PosterImage";
import { CinemaSearchOverlay } from "@/components/cinema/CinemaSearchOverlay";
import { CinemaNewBadge } from "@/components/cinema/CinemaNewBadge";
import { CinemaTop10Card } from "@/components/cinema/CinemaTop10Card";
import { useCinemaMyList } from "@/lib/useCinemaMyList";
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
  // Same URL-backed layers as the desktop client, which is what makes the phone's back-swipe
  // close a sheet instead of leaving Cinema Mode — see lib/cinemaRoute.
  const route = useCinemaRoute();
  const mediaType = route.tab;
  const setMediaType = (tab: "movies" | "series") => cinemaNavigate({ tab }, "replace");
  const router = useRouter();
  const searchOpen = route.search;
  const setSearchOpen = (open: boolean) =>
    open ? cinemaNavigate({ search: true }) : cinemaClose({ search: false });
  const short = useIsShortViewport();

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

  // The open sheet is read back out of the URL rather than held in state — that's what lets the
  // back-swipe close it. Nothing resolves until the payload is in, so a cold deep link simply
  // opens the sheet the moment the data lands.
  const selected = useMemo(() => {
    const id = isSeries ? route.serie : route.film;
    if (id === null || !payload) return null;
    const all = uniqueById(
      [...payload.spotlight, ...Object.values(payload.rows).flat()],
      (item: CinemaMovie | CinemaSeries) => ("radarrId" in item ? item.radarrId : item.sonarrId)
    );
    const item = all.find((x) => ("radarrId" in x ? x.radarrId : x.sonarrId) === id);
    return item ? { item, mediaType } : null;
  }, [isSeries, route.serie, route.film, payload, mediaType]);
  // Same rail as desktop: watchlist ∩ library, so every card is playable (see the hook).
  const myListMovies = useCinemaMyList("movie", movies);
  const myListSeries = useCinemaMyList("series", series);
  // A rotating carousel of the latest arrivals rather than a single fixed pick — same idea and
  // same cadence as the dashboard's own hero, kept in this screen's own visual language (poster
  // key art, Lire / Plus d'infos). Pauses while a sheet or the search is covering it: rotating
  // artwork nobody can see just burns image decodes.
  const heroItems = (payload?.recentlyAdded?.length ? payload.recentlyAdded : payload?.spotlight ?? []).slice(0, 8);
  const [heroIndex, setHeroIndex] = useRotatingIndex(heroItems.length, selected !== null || searchOpen);
  const hero = heroItems[heroIndex];
  const myList = isSeries ? myListSeries : myListMovies;
  // The two payloads key their items differently; every rail below just needs *a* stable id.
  const itemId = (item: CinemaMovie | CinemaSeries) =>
    "radarrId" in item ? item.radarrId : item.sonarrId;

  const openDetail = useCallback((item: CinemaMovie | CinemaSeries, type: "movies" | "series") => {
    cinemaNavigate(
      type === "series"
        ? { tab: "series", serie: (item as CinemaSeries).sonarrId, film: null }
        : { tab: "movies", film: (item as CinemaMovie).radarrId, serie: null }
    );
  }, []);

  const exit = () => leaveCinema(router);

  if (typeof document === "undefined") return null;

  const loading = moviesLoading || (isSeries && seriesLoading && !series);

  // Progress segments, same pattern (and same fill animation) as the dashboard hero's own — the
  // one place the carousel is visible as a carousel, and a way to jump straight to a title.
  const heroDots = heroItems.length > 1 && (
    <div className="mt-3 flex max-w-xs gap-1">
      {heroItems.map((item, i) => (
        <button
          key={itemId(item)}
          type="button"
          onClick={() => setHeroIndex(i)}
          aria-label={item.title}
          className="h-1 flex-1 overflow-hidden rounded-full bg-white/25"
        >
          {i < heroIndex && <div className="h-full w-full bg-white" />}
          {i === heroIndex && <div key={heroIndex} className="h-full animate-hero-fill bg-white" />}
        </button>
      ))}
    </div>
  );

  // Identical in both hero layouts below — same buttons, same handlers, only the box around them
  // changes with the orientation.
  const heroActions = hero && (
    <div className="flex gap-2">
      <button
        type="button"
        // A series id isn't playable on its own — it has to resolve its next-up episode first
        // (see playSeriesNextEpisode). This was starting a Series item id before.
        onClick={() =>
          isSeries
            ? playSeriesNextEpisode(playback, hero)
            : playback.play({ itemId: hero.jellyfinItemId, title: hero.title })
        }
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
  );

  // app-viewport instead of inset-0's implicit height: in an installed PWA that resolves to the
  // real screen, where the viewport iOS lays the app out in at first is short — see the note in
  // globals.css.
  return createPortal(
    <div className="app-viewport fixed inset-x-0 top-0 flex animate-fade-in flex-col overflow-hidden bg-slate-950" style={{ zIndex: 45 }}>
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
          className="btn btn-ghost btn-icon h-9 w-9 shrink-0"
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
          // Replaces the search entry rather than stacking on it — see the desktop client's own
          // note on why coming back to a search that lost its query would be worse.
          onSelectMovie={(item) =>
            cinemaNavigate({ search: false, tab: "movies", film: item.radarrId, serie: null }, "replace")
          }
          onSelectSeries={(item) =>
            cinemaNavigate({ search: false, tab: "series", serie: item.sonarrId, film: null }, "replace")
          }
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
            Netflix leads its own phone home screen with.

            Sideways, that shape doesn't fit: a full-width 2:3 poster is roughly twice the height
            of a landscape phone, so the art was cropped to a sliver and the title and buttons sat
            below the fold — the "broken banner". The same pieces laid out as a row (small poster,
            text and actions beside it) stay entirely on screen at any landscape height. The rows
            underneath are untouched in both orientations. */}
        {hero && (
          <section className="px-4 pt-2">
            {short ? (
              <div className="flex gap-4 rounded-2xl bg-slate-900/70 p-3 shadow-xl shadow-black/50">
                <div className="w-24 shrink-0 overflow-hidden rounded-lg">
                  <PosterImage src={hero.posterUrl} alt={hero.title} subtle unoptimized priority sizes="120px" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col justify-center">
                  {hero.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={hero.logoUrl} alt={hero.title} className="mb-2 max-h-12 w-auto max-w-full self-start object-contain drop-shadow-lg" />
                  ) : (
                    <h1 className="mb-2 truncate text-xl font-bold text-white drop-shadow-lg">{hero.title}</h1>
                  )}
                  {hero.genres.length > 0 && (
                    <p className="mb-3 truncate text-xs text-white/70">{hero.genres.slice(0, 3).join(" · ")}</p>
                  )}
                  {heroActions}
                  {heroDots}
                </div>
              </div>
            ) : (
              <div className="relative overflow-hidden rounded-2xl bg-slate-900 shadow-xl shadow-black/50">
                <PosterImage src={hero.posterUrl} alt={hero.title} subtle unoptimized priority sizes="100vw" />
                <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-slate-950 via-slate-950/70 to-transparent p-4 pt-16">
                  {hero.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={hero.logoUrl} alt={hero.title} className="mx-auto mb-2 max-h-14 w-auto max-w-full object-contain drop-shadow-lg" />
                  ) : (
                    <h1 className="mb-2 text-center text-2xl font-bold text-white drop-shadow-lg font-display">{hero.title}</h1>
                  )}
                  {hero.genres.length > 0 && (
                    <p className="mb-3 text-center text-xs text-white/70">{hero.genres.slice(0, 3).join(" · ")}</p>
                  )}
                  {heroActions}
                  {heroDots}
                </div>
              </div>
            )}
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

        {/* The curated rails, ahead of the genre rows — same three as desktop, same definitions
            (see lib/cinemaRails). Each hides itself when it has nothing to show. */}
        {payload && payload.top10.length > 0 && (
          <MobileRow label={t("cinema.top10")}>
            {payload.top10.map((item, i) => (
              <CinemaTop10Card
                key={itemId(item)}
                rank={i + 1}
                title={item.title}
                posterUrl={item.posterUrl}
                addedAt={item.addedAt}
                widthClassName={POSTER_WIDTH}
                showNewBadge={false}
                numberFontSize="4.5rem"
                onSelectItem={() => openDetail(item, mediaType)}
              />
            ))}
          </MobileRow>
        )}

        <PosterRow label={t("cinema.recentlyAdded")} items={payload?.recentlyAdded ?? []} itemId={itemId} onSelect={(item) => openDetail(item, mediaType)} showNewBadge={false} />
        <PosterRow label={t("cinema.myList")} items={myList} itemId={itemId} onSelect={(item) => openDetail(item, mediaType)} />

        {payload?.genres.map((genre) => {
          const items = (payload.rows[genre] ?? []).slice(0, ROW_ITEM_LIMIT);
          if (items.length === 0) return null;
          return <PosterRow key={genre} label={genre} items={items} itemId={itemId} onSelect={(item) => openDetail(item, mediaType)} />;
        })}
      </div>

      {selected && (
        <CinemaMobileDetail
          item={selected.item}
          mediaType={selected.mediaType}
          onClose={() => cinemaClose({ film: null, serie: null })}
          onSelectSimilar={(item) => openDetail(item, selected.mediaType)}
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

// One rail of posters — the shape every mobile row except Continue Watching and Top 10 uses.
// Generic over the item type so the movie and series tabs share it; returns nothing when empty,
// which is what lets the curated rails be dropped in unconditionally above.
function PosterRow<T extends { title: string; posterUrl: string | null; addedAt: string | null }>({
  label,
  items,
  itemId,
  onSelect,
  showNewBadge = true,
}: {
  label: string;
  items: T[];
  itemId: (item: T) => number;
  onSelect: (item: T) => void;
  showNewBadge?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <MobileRow label={label}>
      {items.map((item) => (
        <button
          key={itemId(item)}
          type="button"
          onClick={() => onSelect(item)}
          className={`${POSTER_WIDTH} relative shrink-0 overflow-hidden rounded-lg transition-transform active:scale-95`}
        >
          <PosterImage src={item.posterUrl} alt={item.title} subtle unoptimized sizes="(max-width: 640px) 112px, 128px" />
          {showNewBadge && <CinemaNewBadge addedAt={item.addedAt} />}
        </button>
      ))}
    </MobileRow>
  );
}

function MobileRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mt-6" style={ROW_CONTAINMENT}>
      <h2 className="mb-2 px-4 text-sm font-semibold text-white">{label}</h2>
      <div className="scrollbar-thin flex gap-3 overflow-x-auto overflow-y-hidden px-4 pb-1">{children}</div>
    </section>
  );
}
