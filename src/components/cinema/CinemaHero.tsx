"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { Video, Bookmark, BookmarkCheck, Plus, Check } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { ImdbBadge } from "@/components/ImdbBadge";
import { PlayButton } from "@/components/PlayButton";
import { useAddToWatchlist } from "@/lib/useAddToWatchlist";
import { useT } from "@/components/TranslationProvider";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

const TrailerModal = dynamic(() => import("@/components/TrailerModal").then((m) => m.TrailerModal), { ssr: false });

// Same treatment as DashboardHero/the fiche pages' own hero — kept as a literal duplicate
// (not extracted to a shared constant) since Cinema Mode's hero is a good deal taller and could
// reasonably diverge from the standard hero's exact fade curve later without that being a
// surprise cross-component change.
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

// The primary view (backdrop/title/rating/genres/overview) comes entirely from `item` — already
// fetched up front for the whole library by CinemaClient, so switching focus is an instant
// in-memory swap, no loading flash. Only cast + trailer (secondary, heavier) are fetched lazily
// here, reusing the EXISTING /api/radarr/movies/[id]/info endpoint (already returns both) rather
// than a new one — CinemaClient debounces how often `item` actually changes this component's key
// so fast arrow-key scrubbing across a row doesn't fire a request per card.
export function CinemaHero({ item }: { item: CinemaMovie }) {
  const t = useT();
  const [showTrailer, setShowTrailer] = useState(false);
  // The primary render below (title/backdrop/rating/overview) always uses `item` directly —
  // instant. Only this secondary fetch (cast/trailer) is debounced, so fast arrow-key scrubbing
  // across a row doesn't fire a request per card it passes through.
  const [debouncedId, setDebouncedId] = useState(item.radarrId);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedId(item.radarrId), 200);
    return () => clearTimeout(timer);
  }, [item.radarrId]);
  const { data: rawInfo } = useSWR<RadarrInfo>(`/api/radarr/movies/${debouncedId}/info`, fetcher);
  // Guards against showing the PREVIOUS item's cast/trailer under the new title during the
  // debounce window — SWR still has that data cached from before debouncedId catches up.
  const info = debouncedId === item.radarrId ? rawInfo : undefined;
  const { addedStatus, addToWatchlist } = useAddToWatchlist();

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

  return (
    <div className="relative h-[70vh] min-h-[420px] w-full shrink-0 overflow-hidden">
      {item.backdropUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={item.radarrId}
          src={item.backdropUrl}
          alt=""
          className="absolute inset-0 h-full w-full animate-fade-in object-cover object-top"
          style={{ maskImage: BACKDROP_MASK, WebkitMaskImage: BACKDROP_MASK }}
        />
      )}
      <div className="absolute inset-0 bg-linear-to-r from-slate-950/85 via-slate-950/35 to-transparent" />

      <div className="relative flex h-full max-w-2xl flex-col justify-end gap-4 px-8 pb-12 sm:px-12">
        <h1 className="text-4xl font-bold leading-tight text-white drop-shadow-lg sm:text-6xl">{item.title}</h1>

        <div className="flex flex-wrap items-center gap-3 text-sm text-white/80">
          <span>{item.year}</span>
          {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
          {item.genres.length > 0 && <span>{item.genres.slice(0, 3).join(" · ")}</span>}
        </div>

        <p className="line-clamp-3 max-w-xl text-sm text-white/90 drop-shadow-sm sm:text-base">
          {info?.tmdb?.overview || item.overview}
        </p>

        {info?.tmdb && info.tmdb.cast.length > 0 && (
          <p className="max-w-xl truncate text-xs text-white/60">
            {t("cinema.cast")} {info.tmdb.cast.slice(0, 5).map((c) => c.name).join(", ")}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <PlayButton itemId={item.jellyfinItemId} title={item.title} variant="primary" />
          {info?.trailerKey && (
            <button onClick={() => setShowTrailer(true)} className="btn-ghost">
              <Video size={16} /> {t("cinema.trailer")}
            </button>
          )}
          <button onClick={toggleWatched} className="btn-ghost" aria-pressed={addedStatus === "watched"}>
            {addedStatus === "watched" ? <Check size={16} /> : <BookmarkCheck size={16} />} {t("cinema.markWatched")}
          </button>
          <button onClick={toggleAddToList} className="btn-ghost" aria-pressed={addedStatus === "to_watch"}>
            {addedStatus === "to_watch" ? <Bookmark size={16} /> : <Plus size={16} />} {t("cinema.addToList")}
          </button>
        </div>
      </div>

      {showTrailer && info?.trailerKey && (
        <TrailerModal youtubeKey={info.trailerKey} title={item.title} onClose={() => setShowTrailer(false)} />
      )}
    </div>
  );
}
