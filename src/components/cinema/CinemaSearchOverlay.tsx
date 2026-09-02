"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { Search, X } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { searchCinemaLibrary } from "@/lib/cinemaSearch";
import { useDelayedClose } from "@/lib/useDelayedClose";
import { useLocale, useT } from "@/components/TranslationProvider";
import { PosterImage } from "@/components/PosterImage";
import type { CinemaMovie, CinemaMoviesPayload } from "@/app/api/cinema/movies/route";
import type { CinemaSeries, CinemaSeriesPayload } from "@/app/api/cinema/series/route";

// Cinema Mode's own search — same natural-language engine as the global bar, but scoped to the
// library and running client-side (see lib/cinemaSearch.ts). Nothing here touches /api/search or
// the global search UI; both stay exactly as they are.
//
// One overlay for both layouts: the phone and the desktop want the same thing (a field on top, a
// poster grid below), only at different densities — which is a responsive grid, not two
// components.

// The rows payload repeats a title once per genre it belongs to; the search wants each title once.
function uniqueItems<T>(payload: { rows: Record<string, T[]>; spotlight: T[] } | undefined, id: (x: T) => number): T[] {
  if (!payload) return [];
  const byId = new Map<number, T>();
  for (const item of payload.spotlight) byId.set(id(item), item);
  for (const list of Object.values(payload.rows)) for (const item of list) byId.set(id(item), item);
  return [...byId.values()];
}

const MAX_RESULTS = 60;

export function CinemaSearchOverlay({
  onClose,
  onSelectMovie,
  onSelectSeries,
}: {
  onClose: () => void;
  onSelectMovie: (item: CinemaMovie) => void;
  onSelectSeries: (item: CinemaSeries) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const { closing, requestClose } = useDelayedClose(onClose, 180);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Both keys are already in SWR's cache whenever the browse grid has them, so opening the search
  // is free on the movies side; the series side is what actually forces the lazy /api/cinema/series
  // fetch here — the search has to be able to find a series even from the Films tab.
  const { data: movies } = useSWR<CinemaMoviesPayload>("/api/cinema/movies", fetcher);
  const { data: series } = useSWR<CinemaSeriesPayload>("/api/cinema/series", fetcher);

  const allMovies = useMemo(() => uniqueItems(movies, (m) => m.radarrId), [movies]);
  const allSeries = useMemo(() => uniqueItems(series, (s) => s.sonarrId), [series]);
  const results = useMemo(
    () => searchCinemaLibrary(query, allMovies, allSeries, locale).slice(0, MAX_RESULTS),
    [query, allMovies, allSeries, locale]
  );

  // Escape closes; the arrow keys walk the result cards. The grid's own useTvGridNav is paused
  // while this is open (see CinemaClient), so nothing competes for the arrow keys here.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const cards = Array.from(containerRef.current?.querySelectorAll<HTMLElement>("[data-search-card]") ?? []);
      if (cards.length === 0) return;
      const idx = cards.indexOf(document.activeElement as HTMLElement);
      if (idx === -1) {
        if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          e.preventDefault();
          cards[0].focus();
        }
        return;
      }
      e.preventDefault();
      const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
      const next = cards[Math.min(cards.length - 1, Math.max(0, idx + (forward ? 1 : -1)))];
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={containerRef}
      className={`fixed inset-x-0 top-0 flex flex-col bg-slate-950 ${closing ? "animate-fade-out" : "animate-fade-in"}`}
      // Above the browse screen (45) and the detail sheets (46/48), below the player (80). It was
      // 44 — i.e. *under* the opaque browse screen: the field was really there and really focused
      // (the keyboard came up) but every pixel of it was painted over, so the search looked dead.
      //
      // 100dvh rather than inset-0: on iOS the dynamic viewport unit is the one that tracks the
      // browser chrome, so the results list ends where the screen does instead of running under it.
      style={{
        zIndex: 50,
        height: "100dvh",
        paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <div className="flex items-center gap-3 px-4 pb-3 sm:px-8">
        <div className="flex flex-1 items-center gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-3 focus-within:border-white/30">
          <Search className="h-5 w-5 shrink-0 text-slate-400" />
          <input
            /* The overlay exists only to be typed into. */
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("cinema.searchPlaceholder")}
            aria-label={t("cinema.search")}
            className="w-full bg-transparent text-lg text-white outline-none placeholder:text-slate-500"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="shrink-0 text-slate-400 hover:text-white"
              aria-label={t("cinema.search")}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={requestClose}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          aria-label={t("cinema.back")}
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 sm:px-8"
        // Touching the results means you're done typing: dropping the keyboard here gives the grid
        // the whole screen back, and stops the first tap on a poster from being swallowed by the
        // keyboard dismissing itself.
        onTouchStart={() => (document.activeElement as HTMLElement | null)?.blur()}
      >
        {query.trim().length < 2 ? (
          <p className="mt-10 text-center text-sm text-slate-500">{t("cinema.searchHint")}</p>
        ) : results.length === 0 ? (
          <p className="mt-10 text-center text-sm text-slate-500">{t("cinema.searchEmpty")}</p>
        ) : (
          <>
            <p className="pb-3 text-xs text-slate-500">{t("cinema.searchResults", { n: results.length })}</p>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-8">
              {results.map((r) => (
                <button
                  key={`${r.kind}-${r.kind === "movie" ? r.item.radarrId : r.item.sonarrId}`}
                  type="button"
                  data-search-card="true"
                  onClick={() => (r.kind === "movie" ? onSelectMovie(r.item) : onSelectSeries(r.item))}
                  className="group text-left outline-none"
                >
                  <div className="relative overflow-hidden rounded-lg ring-white transition group-hover:scale-105 group-focus-visible:scale-105 group-focus-visible:ring-2">
                    <PosterImage src={r.item.posterUrl} alt={r.item.title} sizes="150px" subtle unoptimized />
                  </div>
                  <p className="mt-1.5 truncate text-xs text-slate-200">{r.item.title}</p>
                  <p className="truncate text-xs text-slate-500">
                    {r.item.year || ""}
                    {r.kind === "series" ? ` · ${t("cinema.seriesTab")}` : ""}
                  </p>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
