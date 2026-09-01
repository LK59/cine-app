"use client";

import { useRouter } from "next/navigation";
import useSWR from "swr";
import { useState } from "react";
import { X } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useTvGridNav } from "@/lib/useTvGridNav";
import { usePlayback } from "@/components/PlaybackProvider";
import { PosterImage } from "@/components/PosterImage";
import { CinemaHero } from "@/components/cinema/CinemaHero";
import { CinemaRow } from "@/components/cinema/CinemaRow";
import { CinemaDebugBoundary } from "@/components/cinema/CinemaDebugBoundary";
import { useT } from "@/components/TranslationProvider";
import type { CinemaMoviesPayload, CinemaMovie } from "@/app/api/cinema/movies/route";
import type { DashboardPayload, ResumeItem } from "@/app/api/dashboard/route";

const TV_NAV_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950";

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
      className={`relative w-40 shrink-0 overflow-hidden rounded-lg text-left transition-transform duration-200 hover:z-10 hover:scale-110 focus-visible:z-10 focus-visible:scale-110 sm:w-48 ${TV_NAV_RING}`}
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
  const router = useRouter();
  const t = useT();
  useTvGridNav();

  const { data: movies, error: moviesError, isLoading: moviesLoading } = useSWR<CinemaMoviesPayload>(
    "/api/cinema/movies",
    fetcher
  );
  const { data: dashboard } = useSWR<DashboardPayload>("/api/dashboard", fetcher);
  const resumeMovies = (dashboard?.resume.data?.items ?? []).filter((r) => r.type === "Movie");

  const [focusedItem, setFocusedItem] = useState<CinemaMovie | null>(null);
  const heroItem = focusedItem ?? movies?.spotlight[0] ?? null;

  const exitButton = (
    <button onClick={() => router.push("/")} className="btn-primary">
      {t("cinema.standardMode")}
    </button>
  );

  if (moviesLoading) {
    return (
      <div className="fixed inset-0 z-[45] flex items-center justify-center bg-slate-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    );
  }

  if (moviesError) {
    return (
      <div className="fixed inset-0 z-[45] flex flex-col items-center justify-center gap-4 bg-slate-950 p-8 text-center">
        <p className="max-w-sm text-sm text-red-400">{moviesError.message || t("common.unknown")}</p>
        {exitButton}
      </div>
    );
  }

  if (movies && movies.spotlight.length === 0) {
    return (
      <div className="fixed inset-0 z-[45] flex flex-col items-center justify-center gap-4 bg-slate-950 p-8 text-center">
        <p className="max-w-sm text-sm text-slate-400">{t("cinema.empty")}</p>
        {exitButton}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[45] overflow-y-auto bg-slate-950">
      <button
        onClick={() => router.push("/")}
        className="fixed right-4 top-4 z-50 flex items-center gap-2 rounded-full bg-black/50 px-4 py-2 text-sm font-medium text-white backdrop-blur-xs hover:bg-black/70"
        style={{ top: "max(1rem, env(safe-area-inset-top))" }}
      >
        <X size={16} /> {t("cinema.standardMode")}
      </button>

      <CinemaDebugBoundary>
        {heroItem && <CinemaHero item={heroItem} />}

        <div className="relative -mt-16 pb-12">
          {resumeMovies.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-3 px-8 text-lg font-semibold text-white sm:px-12">{t("cinema.continueWatching")}</h2>
              <div className="scrollbar-thin flex gap-3 overflow-x-auto px-8 pb-4 sm:px-12">
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
              onFocusItem={setFocusedItem}
            />
          ))}
        </div>
      </CinemaDebugBoundary>
    </div>
  );
}
