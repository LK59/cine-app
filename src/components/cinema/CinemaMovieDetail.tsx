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

// A row is "active" (already Vu / déjà dans Ma liste) once toggled — background + ring + accent
// icon color, not just an icon swap, so the click has an unmistakable visual result. The earlier
// icon-only version (Plus↔Bookmark, both thin 16px outlines) read as "nothing happened" even
// though the request had gone through.
const MENU_ROW =
  "flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left text-white transition-colors focus-visible:outline-none";
const MENU_ROW_INACTIVE = "hover:bg-white/10 focus-visible:bg-white/10";
const MENU_ROW_ACTIVE = "bg-accent-600/25 ring-1 ring-accent-500/50 hover:bg-accent-600/30";
const MENU_BADGE = "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10";
const MENU_BADGE_ACTIVE = "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-500/30 text-accent-300";

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
// The backdrop fills the entire screen (blurred + darkened, not cropped to a header strip) with
// the title/synopsis/menu anchored to the left, over the darkest part of it — same "ambient
// background, content on the left" layout as Netflix's own TV UI. No standard button row — one
// row per action instead (Lecture/Bande-annonce/Vu/Ma liste), each with its own icon badge,
// native-focusable so the TV-remote arrow keys below just move between them. Portaled to
// document.body for the same reason CinemaClient's own fixed layers are (see its doc comment):
// PageTransition's lingering transform breaks `position: fixed` otherwise.
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

  const watched = addedStatus === "watched";
  const inList = addedStatus === "to_watch";

  return createPortal(
    // z-index as inline style, not a Tailwind class — arbitrary-value classes weren't making it
    // into the production CSS bundle (see CinemaClient's own note). Just above CinemaClient's own
    // z-45 browse layer, both still well below PlayerHost's z-80 — pressing Lecture needs the
    // player to end up on TOP of this, not hidden behind it (see CinemaClient's z-index note).
    <div ref={containerRef} className="fixed inset-0 animate-fade-in overflow-hidden bg-slate-950" style={{ zIndex: 46 }}>
      {item.backdropUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.backdropUrl}
          alt=""
          // scale-110: blur-2xl softens the image's own edges too, which would otherwise show a
          // faint unblurred fringe right at the viewport edge — scaling past the frame first
          // pushes that fringe outside it.
          className="absolute inset-0 h-full w-full scale-110 object-cover blur-2xl"
        />
      )}
      {/* Full-bleed dim + a stronger left-side gradient so the content column always sits over
          the darkest part of the image regardless of what the backdrop looks like. */}
      <div className="absolute inset-0 bg-slate-950/55" />
      <div className="absolute inset-0 bg-linear-to-r from-slate-950 via-slate-950/60 to-slate-950/10" />

      <button
        onClick={onClose}
        className="fixed left-4 top-4 z-10 flex items-center gap-2 rounded-full bg-black/50 px-3 py-2 text-sm font-medium text-white backdrop-blur-xs transition-colors hover:bg-black/70"
        style={{ top: "max(1rem, env(safe-area-inset-top))" }}
      >
        <ArrowLeft size={16} /> {t("cinema.back")}
      </button>

      <div className="relative z-10 flex h-full items-center overflow-y-auto scroll-smooth py-16">
        <div key={item.radarrId} className="flex w-full max-w-md animate-fade-in-up flex-col gap-4 px-8 sm:px-16">
          <h1 className="text-3xl font-bold leading-tight text-white drop-shadow-lg sm:text-5xl">{item.title}</h1>

          <div className="flex flex-wrap items-center gap-3 text-sm text-white/80">
            <span>{item.year}</span>
            {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
            {item.genres.length > 0 && <span>{item.genres.slice(0, 3).join(" · ")}</span>}
          </div>

          <p className="line-clamp-3 text-sm text-white/90 drop-shadow-sm sm:text-base">
            {info?.tmdb?.overview || item.overview}
          </p>

          {info?.tmdb?.cast && info.tmdb.cast.length > 0 && (
            <p className="truncate text-xs text-white/60">
              {t("cinema.cast")} {info.tmdb.cast.slice(0, 5).map((c) => c.name).join(", ")}
            </p>
          )}

          <div className="mt-2 flex flex-col gap-1">
            <PlayButton itemId={item.jellyfinItemId} title={item.title} variant="row" />

            {info?.trailerKey && (
              <button data-detail-menu onClick={() => setShowTrailer(true)} className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
                <span className={MENU_BADGE}>
                  <Video size={14} />
                </span>
                <span className="text-sm font-medium">{t("cinema.trailer")}</span>
              </button>
            )}

            <button
              data-detail-menu
              onClick={toggleWatched}
              aria-pressed={watched}
              className={`${MENU_ROW} ${watched ? MENU_ROW_ACTIVE : MENU_ROW_INACTIVE}`}
            >
              <span className={watched ? MENU_BADGE_ACTIVE : MENU_BADGE}>
                {watched ? <Check size={14} /> : <BookmarkCheck size={14} />}
              </span>
              <span className="text-sm font-medium">{t("cinema.markWatched")}</span>
            </button>

            <button
              data-detail-menu
              onClick={toggleAddToList}
              aria-pressed={inList}
              className={`${MENU_ROW} ${inList ? MENU_ROW_ACTIVE : MENU_ROW_INACTIVE}`}
            >
              <span className={inList ? MENU_BADGE_ACTIVE : MENU_BADGE}>
                {inList ? <Bookmark size={14} /> : <Plus size={14} />}
              </span>
              <span className="text-sm font-medium">{t("cinema.addToList")}</span>
            </button>
          </div>
        </div>
      </div>

      {showTrailer && info?.trailerKey && (
        <TrailerModal youtubeKey={info.trailerKey} title={item.title} onClose={() => setShowTrailer(false)} />
      )}
    </div>,
    document.body
  );
}
