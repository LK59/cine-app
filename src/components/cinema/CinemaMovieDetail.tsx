"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { ArrowLeft, Video, Bookmark, BookmarkCheck, Plus, Check } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { ImdbBadge } from "@/components/ImdbBadge";
import { PlayButton } from "@/components/PlayButton";
import { useAddToWatchlist } from "@/lib/useAddToWatchlist";
import { useT } from "@/components/TranslationProvider";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

const TrailerModal = dynamic(() => import("@/components/TrailerModal").then((m) => m.TrailerModal), { ssr: false });

const BACKDROP_MASK =
  "linear-gradient(to bottom, rgba(0,0,0,0.97) 0%, rgba(0,0,0,0.82) 18%, rgba(0,0,0,0.50) 35%, rgba(0,0,0,0.18) 52%, rgba(0,0,0,0.04) 65%, rgba(0,0,0,0) 72%)";

interface RadarrCastMember {
  tmdbId: number;
  name: string;
  character: string;
  photoUrl: string | null;
}

interface RadarrInfo {
  tmdb: { overview: string; cast: RadarrCastMember[] } | null;
  trailerKey: string | null;
}

// "The banner opened big" — click/Enter on a card (or the hero) escalates from CinemaHero's
// passive preview into this: a full-screen, ONLY-this-on-screen detail à la Netflix's TV app.
// No standard button row — one row per action instead (Lecture/Bande-annonce/Vu/Ma liste), each
// with its own icon badge, native-focusable so the TV-remote arrow keys below just move between
// them. Portaled to document.body for the same reason CinemaClient's own fixed layers are (see
// its doc comment): PageTransition's lingering transform breaks `position: fixed` otherwise.
export function CinemaMovieDetail({ item, onClose }: { item: CinemaMovie; onClose: () => void }) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [showTrailer, setShowTrailer] = useState(false);
  const { data: info } = useSWR<RadarrInfo>(`/api/radarr/movies/${item.radarrId}/info`, fetcher);
  const { addedStatus, addToWatchlist } = useAddToWatchlist();

  // Lands focus on the first menu row as soon as the overlay opens — a TV remote user should
  // never need to press Down before Play is reachable.
  useEffect(() => {
    containerRef.current?.querySelector<HTMLButtonElement>("[data-detail-menu]")?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const rows = Array.from(containerRef.current?.querySelectorAll<HTMLButtonElement>("[data-detail-menu]") ?? []);
      if (rows.length === 0) return;
      e.preventDefault();
      const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown") rows[Math.min(idx + 1, rows.length - 1)]?.focus();
      else rows[Math.max(idx - 1, 0)]?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggleWatched() {
    addToWatchlist(
      { tmdbId: item.tmdbId, mediaType: "movie", title: item.title, year: item.year, posterPath: item.posterUrl, voteAverage: null },
      addedStatus === "watched" ? "to_watch" : "watched"
    );
  }

  function toggleAddToList() {
    addToWatchlist(
      { tmdbId: item.tmdbId, mediaType: "movie", title: item.title, year: item.year, posterPath: item.posterUrl, voteAverage: null },
      "to_watch"
    );
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    // z-index as inline style, not a Tailwind class — arbitrary-value classes weren't making it
    // into the production CSS bundle (see CinemaClient's own note). Above CinemaClient's own
    // z-200/201 layers, comfortably above everything else always-mounted in the app.
    <div ref={containerRef} className="fixed inset-0 overflow-y-auto bg-slate-950 animate-fade-in" style={{ zIndex: 220 }}>
      <button
        onClick={onClose}
        className="fixed left-4 top-4 z-10 flex items-center gap-2 rounded-full bg-black/50 px-3 py-2 text-sm font-medium text-white backdrop-blur-xs hover:bg-black/70"
        style={{ top: "max(1rem, env(safe-area-inset-top))" }}
      >
        <ArrowLeft size={16} /> {t("cinema.back")}
      </button>

      <div className="relative w-full overflow-hidden" style={{ height: "60vh", minHeight: 360 }}>
        {item.backdropUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.backdropUrl}
            alt=""
            className="absolute inset-0 h-full w-full animate-fade-in object-cover object-top"
            style={{ maskImage: BACKDROP_MASK, WebkitMaskImage: BACKDROP_MASK }}
          />
        )}
        <div className="absolute inset-0 bg-linear-to-r from-slate-950/85 via-slate-950/35 to-transparent" />

        <div className="relative flex h-full max-w-2xl flex-col justify-end gap-4 px-8 pb-10 sm:px-12">
          <h1 className="text-4xl font-bold leading-tight text-white drop-shadow-lg sm:text-6xl">{item.title}</h1>

          <div className="flex flex-wrap items-center gap-3 text-sm text-white/80">
            <span>{item.year}</span>
            {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
            {item.genres.length > 0 && <span>{item.genres.slice(0, 3).join(" · ")}</span>}
          </div>

          <p className="line-clamp-3 max-w-xl text-sm text-white/90 drop-shadow-sm sm:text-base">
            {info?.tmdb?.overview || item.overview}
          </p>

          {info?.tmdb?.cast && info.tmdb.cast.length > 0 && (
            <p className="max-w-xl truncate text-xs text-white/60">
              {t("cinema.cast")} {info.tmdb.cast.slice(0, 5).map((c) => c.name).join(", ")}
            </p>
          )}
        </div>
      </div>

      <div className="mx-auto flex max-w-2xl flex-col gap-1 px-8 pb-16 pt-4 sm:px-12">
        <PlayButton itemId={item.jellyfinItemId} title={item.title} variant="row" />

        {info?.trailerKey && (
          <button
            data-detail-menu
            onClick={() => setShowTrailer(true)}
            className="flex w-full items-center gap-4 rounded-lg px-6 py-4 text-left text-white hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10">
              <Video size={16} />
            </span>
            <span className="text-base font-medium">{t("cinema.trailer")}</span>
          </button>
        )}

        <button
          data-detail-menu
          onClick={toggleWatched}
          aria-pressed={addedStatus === "watched"}
          className="flex w-full items-center gap-4 rounded-lg px-6 py-4 text-left text-white hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10">
            {addedStatus === "watched" ? <Check size={16} /> : <BookmarkCheck size={16} />}
          </span>
          <span className="text-base font-medium">{t("cinema.markWatched")}</span>
        </button>

        <button
          data-detail-menu
          onClick={toggleAddToList}
          aria-pressed={addedStatus === "to_watch"}
          className="flex w-full items-center gap-4 rounded-lg px-6 py-4 text-left text-white hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10">
            {addedStatus === "to_watch" ? <Bookmark size={16} /> : <Plus size={16} />}
          </span>
          <span className="text-base font-medium">{t("cinema.addToList")}</span>
        </button>
      </div>

      {showTrailer && info?.trailerKey && (
        <TrailerModal youtubeKey={info.trailerKey} title={item.title} onClose={() => setShowTrailer(false)} />
      )}
    </div>,
    document.body
  );
}
