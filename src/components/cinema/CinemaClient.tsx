"use client";

import useSWR from "swr";
import { useRef, useState } from "react";
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

  const [focusedItem, setFocusedItem] = useState<CinemaMovie | null>(null);
  const [selectedItem, setSelectedItem] = useState<CinemaMovie | null>(null);
  const heroItem = focusedItem ?? movies?.spotlight[0] ?? null;
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

      {/* Split-screen TV layout: the top pane is a live, non-scrolling preview of whatever card
          has focus (never scrolls away — that's the "sticky" ask) and the bottom pane is its own
          independently scrolling region for the rows. Two panes, not one scroller with a sticky
          hero, so the preview never has to fight scroll position math. The rows pane overlaps up
          into the hero by -mt-16, and the hero's own bottom mask already fades its backdrop to
          transparent (see CinemaHero) — together that blends the two panes into one continuous
          gradient instead of a hard seam. */}
      <div className="flex h-full flex-col">
        {/* Height as inline style, not a basis-[46%] arbitrary-value class — those don't make it
            into the production CSS bundle (see the z-index note above). Smaller than the first
            pass (54%) so the rows pane — and the row labels — has enough room not to overflow. */}
        <div className="relative shrink-0" style={{ flexBasis: "46%" }}>
          {heroItem && <CinemaHero item={heroItem} />}
        </div>

        <div className="scrollbar-thin relative z-10 -mt-16 min-h-0 flex-1 scroll-smooth overflow-y-auto pb-16 pt-20">
          {resumeMovies.length > 0 && (
            <div className="mb-6">
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
