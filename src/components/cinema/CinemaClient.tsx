"use client";

import useSWR from "swr";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useTvGridNav } from "@/lib/useTvGridNav";
import { usePlayback } from "@/components/PlaybackProvider";
import { PosterImage } from "@/components/PosterImage";
import { CinemaHero } from "@/components/cinema/CinemaHero";
import { CinemaRow } from "@/components/cinema/CinemaRow";
import { CinemaMovieDetail } from "@/components/cinema/CinemaMovieDetail";
import { CinemaShortcutsGuide } from "@/components/cinema/CinemaShortcutsGuide";
import { useT } from "@/components/TranslationProvider";
import type { CinemaMoviesPayload, CinemaMovie } from "@/app/api/cinema/movies/route";
import type { DashboardPayload, ResumeItem } from "@/app/api/dashboard/route";

const TV_NAV_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950";

// Fades the SHARP copy of the backdrop out by ~72% of the *whole screen's* height (not just the
// hero pane's own box — this mask is applied to a full-height image, see the background layer
// below) — a blurred, darkened duplicate sits behind it, so wherever this one has faded to
// transparent, the blurred one shows through instead of hitting solid slate-950. That's what
// makes the wash "keep going" past the hero into the rows pane instead of stopping at a hard
// edge right at the category label.
const BACKDROP_MASK =
  "linear-gradient(to bottom, rgba(0,0,0,0.97) 0%, rgba(0,0,0,0.82) 18%, rgba(0,0,0,0.50) 35%, rgba(0,0,0,0.18) 52%, rgba(0,0,0,0.04) 65%, rgba(0,0,0,0) 72%)";

// w-24→xl:w-36 (96px→144px), down from the original w-40/sm:w-48 (160/192px) fixed pair — that
// fixed size overflowed the row on anything shorter than a large desktop window, pushing the row
// label itself off (above) the visible area. Shared between ContinueCard and CinemaCard so both
// grids stay visually aligned.
const CARD_WIDTH = "w-24 sm:w-28 md:w-32 lg:w-36";

// Continue-watching items come from Jellyfin's resume list (via the existing dashboard payload —
// same data DashboardClient's own resume row already uses), not the /api/cinema/movies library
// data — they don't carry backdrop/genres/overview, so they don't participate in the hero-focus
// mechanic, just poster + progress + direct play. Still wired into the same data-tv-* grid so
// keyboard/arrow navigation covers it seamlessly with the genre rows below.
function ContinueCard({ item, index }: { item: ResumeItem; index: number }) {
  const playback = usePlayback();
  return (
    <button
      type="button"
      data-tv-card
      data-tv-row="continue"
      data-tv-col={index}
      onClick={() =>
        playback.play({
          itemId: item.id,
          title: item.name,
          resumeAt: item.positionTicks > 0 ? item.positionTicks / 10_000_000 : undefined,
        })
      }
      className={`relative ${CARD_WIDTH} shrink-0 overflow-hidden rounded-lg text-left transition-transform duration-200 hover:z-10 hover:scale-105 focus-visible:z-10 focus-visible:scale-105 ${TV_NAV_RING}`}
    >
      <PosterImage
        src={item.imageTag ? `/api/jellyfin/image?itemId=${item.id}&tag=${item.imageTag}` : null}
        alt={item.name}
        aspectRatio="aspect-video"
        // Auth-gated route — Next's image optimizer proxies through an internal request that
        // doesn't forward cookies, so it 400s there. Same reasoning as DashboardClient's
        // identical resume-card image (see PosterImage's own doc comment).
        unoptimized
      />
      <div className="absolute inset-x-0 bottom-0 h-1.5 bg-white/25">
        <div className="h-full bg-accent-500" style={{ width: `${item.progress}%` }} />
      </div>
      <p className="mt-1 truncate text-xs text-white/80">{item.name}</p>
    </button>
  );
}

// Loaded via next/dynamic({ssr:false}) from page.tsx — same escape hatch this codebase already
// uses for PlayerHostLazy/GlobalSearchLazy. This page is 100% client-fetched (SWR, no data
// during SSR) and was hitting an unrecoverable hydration mismatch (React #418) that left the
// whole content area blank with no error surfaced anywhere (not even a wrapping error boundary —
// hydration failures at the root hydrate() call happen outside a boundary's reach). Disabling SSR
// for this page sidesteps the whole class of problem: nothing to mismatch against since there's
// no server-rendered HTML for it at all.
export function CinemaClient() {
  const t = useT();

  const { data: movies, error: moviesError, isLoading: moviesLoading } = useSWR<CinemaMoviesPayload>(
    "/api/cinema/movies",
    fetcher
  );
  const { data: dashboard } = useSWR<DashboardPayload>("/api/dashboard", fetcher);
  const resumeMovies = (dashboard?.resume.data?.items ?? []).filter((r) => r.type === "Movie");

  // Warms the browser's own image cache for every distinct backdrop in the library, same
  // technique DashboardHero already uses for its (much smaller) rotation set — without it, the
  // FIRST time focus lands on any given title, its backdrop is a cold network fetch, which read
  // as "a second of nothing, then the picture just pops in." Deferred by a beat so it doesn't
  // compete with the initial screen's own critical images (hero, first row).
  useEffect(() => {
    if (!movies) return;
    const seen = new Set<number>();
    const urls: string[] = [];
    for (const list of Object.values(movies.rows)) {
      for (const m of list) {
        if (seen.has(m.radarrId)) continue;
        seen.add(m.radarrId);
        if (m.backdropUrl) urls.push(m.backdropUrl);
      }
    }
    const timer = setTimeout(() => {
      for (const url of urls) Object.assign(new Image(), { src: url });
    }, 400);
    return () => clearTimeout(timer);
  }, [movies]);

  const [focusedItem, setFocusedItem] = useState<CinemaMovie | null>(null);
  const [selectedItem, setSelectedItem] = useState<CinemaMovie | null>(null);
  const heroItem = focusedItem ?? movies?.spotlight[0] ?? null;

  // The backdrop specifically (not the hero's own title/synopsis text, which still updates
  // instantly) is debounced before it's allowed to (re)trigger its crossfade — animating a fresh
  // <img> on every single focus event during fast arrow-key scrubbing across a row is exactly
  // what produced the backdrop "ghosting"/persisting-into-each-other bug (rapid, overlapping
  // restarts of the same opacity keyframe). Settling briefly before committing to a new backdrop
  // keeps the nice crossfade for a deliberate selection without resurrecting that.
  const [debouncedHeroItem, setDebouncedHeroItem] = useState(heroItem);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedHeroItem(heroItem), 150);
    return () => clearTimeout(timer);
  }, [heroItem]);

  // Whatever card was focused (mouse click also focuses a <button> natively) right before
  // CinemaMovieDetail opened — restored on close so arrow-nav resumes exactly where the user
  // left it instead of snapping back to the first card (useTvGridNav treats "nothing focused"
  // as "start over").
  const lastFocusedCard = useRef<HTMLElement | null>(null);

  // Paused while the detail overlay owns Up/Down/Escape for its own vertical menu — see the
  // hook's own doc comment.
  useTvGridNav(selectedItem === null);

  function openDetail(item: CinemaMovie) {
    lastFocusedCard.current = document.activeElement as HTMLElement;
    setSelectedItem(item);
  }

  function closeDetail() {
    setSelectedItem(null);
    // The card is still in the DOM (the browse screen never unmounts under the overlay) but
    // isn't focused yet the instant this runs — the overlay's own focused button is still
    // mid-unmount. One frame later it's safe to move focus back.
    requestAnimationFrame(() => lastFocusedCard.current?.focus());
  }

  // A hard navigation, not router.push — same reasoning as Sidebar's entry link into this page:
  // Next's client-side transition (RSC fetch, mode "cors") was failing at the network level in
  // production for this route specifically.
  const exitButton = (
    <button onClick={() => { window.location.href = "/"; }} className="btn-primary">
      {t("cinema.standardMode")}
    </button>
  );

  // z-index as inline style, not a Tailwind class (arbitrary-value classes weren't making it
  // into the production CSS bundle — see CinemaHero's note on the height fix). Cinema Mode is
  // conceptually just page content (it only uses `fixed` for its own split-screen layout
  // trick), so it belongs BELOW the app's real overlays, not above them — 45 sits above
  // MobileNav (z-40) but below Modal/GlobalSearch (z-50), ActionSheet (z-60), TrailerModal/
  // UpdateBanner (z-70), and critically PlayerHost (z-80): with the old z-200, pressing Lecture
  // started playback (audio, Chrome's media-session UI) entirely behind this screen's opaque
  // background — the player was rendering, just invisible under a higher layer. CinemaMovieDetail
  // sits at 46, just above this.
  const zLayer = { zIndex: 45 };

  // The actual bug, found by comparing rendered outerHTML against the DOM: `fixed inset-0` only
  // pins to the viewport when NO ancestor has a non-`none` transform. The (dashboard) layout
  // wraps every page in PageTransition, whose fade-in-up keyframes end on `transform:
  // translateY(0)` with fill-mode `both` — that's a non-none transform value, retained forever,
  // so it permanently makes PageTransition's wrapper div the containing block for our fixed
  // layer instead of the viewport. The fixed div then collapses inside that zero-size ancestor:
  // fully populated in the DOM (title, backdrop, rows all present, confirmed via outerHTML) but
  // invisible. Portaling straight to document.body — same escape hatch already used by
  // Modal/TrailerModal/PlayerHost/ActionSheet — sidesteps the containing-block issue entirely.
  if (moviesLoading) {
    return createPortal(
      <div className="fixed inset-0 flex items-center justify-center bg-slate-950" style={zLayer}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>,
      document.body
    );
  }

  if (moviesError) {
    return createPortal(
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-slate-950 p-8 text-center" style={zLayer}>
        <p className="max-w-sm text-sm text-red-400">{moviesError.message || t("common.unknown")}</p>
        {exitButton}
      </div>,
      document.body
    );
  }

  if (movies && movies.spotlight.length === 0) {
    return createPortal(
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-slate-950 p-8 text-center" style={zLayer}>
        <p className="max-w-sm text-sm text-slate-400">{t("cinema.empty")}</p>
        {exitButton}
      </div>,
      document.body
    );
  }

  return createPortal(
    <div className="fixed inset-0 animate-fade-in overflow-hidden bg-slate-950" style={zLayer}>
      <button
        onClick={() => { window.location.href = "/"; }}
        className="fixed left-4 top-4 z-10 flex items-center gap-2 rounded-full bg-black/50 px-3 py-2 text-sm font-medium text-white backdrop-blur-xs transition-colors hover:bg-black/70"
        style={{ top: "max(1rem, env(safe-area-inset-top))" }}
        title={t("cinema.standardMode")}
      >
        <ArrowLeft size={16} />
      </button>

      <CinemaShortcutsGuide />

      {/* One continuous ambient background for the WHOLE screen, not scoped to the hero pane —
          a sharp copy of the focused item's backdrop (masked, fading out by ~72% of the full
          screen height) sits over a blurred+darkened duplicate that spans the full height, so
          wherever the sharp one has faded away the wash keeps going (blurred, dim) instead of
          hitting a hard edge right at the rows pane. Both panes below render on top of this with
          transparent backgrounds — the only thing they visually share is this backdrop, not any
          overlapping text/labels (an earlier -mt-16 overlap trick pulled row labels into literal
          collision with the hero's own synopsis/cast line). */}
      <div className="absolute inset-0 overflow-hidden">
        {debouncedHeroItem?.backdropUrl && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={`blur-${debouncedHeroItem.radarrId}`}
              src={debouncedHeroItem.backdropUrl}
              alt=""
              className="absolute inset-0 h-full w-full scale-110 animate-fade-in object-cover object-top blur-2xl"
            />
            <div className="absolute inset-0 bg-slate-950/55" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={debouncedHeroItem.radarrId}
              src={debouncedHeroItem.backdropUrl}
              alt=""
              className="absolute inset-0 h-full w-full animate-fade-in object-cover object-top"
              style={{ maskImage: BACKDROP_MASK, WebkitMaskImage: BACKDROP_MASK }}
            />
          </>
        )}
        <div className="absolute inset-0 bg-linear-to-r from-slate-950/85 via-slate-950/35 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-1/4 bg-linear-to-b from-transparent to-slate-950" />
      </div>

      {/* Split-screen TV layout: the top pane is a live, non-scrolling preview of whatever card
          has focus (never scrolls away — that's the "sticky" ask) and the bottom pane is its own
          independently scrolling region for the rows. Two panes, not one scroller with a sticky
          hero, so the preview never has to fight scroll position math. */}
      <div className="relative z-10 flex h-full flex-col">
        {/* flex-basis 50% via inline style (arbitrary-value classes don't make it into the
            production CSS bundle — see the z-index note above), grow-0 (never grows past 50% on
            a tall screen) shrink (free to shrink below it) — paired with the rows pane's own
            min-h-80 below, the browser's own flex algorithm does the rest: on a short viewport
            (a 13" laptop, say) where 50% + one full row wouldn't both fit, ALL the give comes
            from this pane shrinking, never from the row's guaranteed minimum. No resize
            listener needed — this is exactly what flex-shrink + a sibling's min-height is for. */}
        <div className="relative min-h-0 shrink grow-0" style={{ flexBasis: "50%" }}>
          {heroItem && <CinemaHero item={heroItem} />}
        </div>

        {/* min-h-80 (320px): comfortably fits one full row — label, a card at its largest
            breakpoint size, and the hover/focus scale-up room — so there's always at least one
            complete row on screen no matter how short the viewport is (see the hero pane's own
            note above).
            snap-y/snap-mandatory, back after two failed attempts at a hand-rolled JS equivalent
            (nearest-edge, then "which row have I entered" + scrollend) — both eventually landed
            wrong in some scroll direction or another (a half-visible row peeking in, a label
            scrolled just out of view). Native scroll-snap is the browser's own well-tested
            implementation and is unconditionally reliable about where it comes to rest; the
            tradeoff, honestly, is that a plain (non-inertial) mouse wheel can feel like it snaps
            one row per notch rather than gliding — a known, inherent trait of mandatory snap with
            discrete wheel input, not something further JS here fixed better than the browser
            itself. Reliability was the explicit priority over that. */}
        <div className="scrollbar-thin relative min-h-80 flex-1 snap-y snap-mandatory scroll-smooth overflow-y-auto pb-16 pt-6">
          {resumeMovies.length > 0 && (
            <div className="mb-6 snap-start">
              <h2 className="mb-2 px-8 text-sm font-medium text-white/70 sm:px-12">{t("cinema.continueWatching")}</h2>
              <div className="scrollbar-thin flex scroll-smooth gap-3 overflow-x-auto px-8 pb-4 pt-3 sm:px-12">
                {resumeMovies.map((item, i) => (
                  <ContinueCard key={item.id} item={item} index={i} />
                ))}
              </div>
            </div>
          )}

          {movies?.genres.map((genre) => (
            <CinemaRow
              key={genre}
              label={genre}
              rowKey={`genre-${genre}`}
              items={movies.rows[genre] ?? []}
              cardWidthClassName={CARD_WIDTH}
              onFocusItem={setFocusedItem}
              onSelectItem={openDetail}
            />
          ))}
        </div>
      </div>

      {selectedItem && <CinemaMovieDetail item={selectedItem} onClose={closeDetail} />}
    </div>,
    document.body
  );
}
