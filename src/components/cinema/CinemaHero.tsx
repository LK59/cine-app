"use client";

import useSWR from "swr";
import { useEffect, useState } from "react";
import { fetcher } from "@/lib/swr";
import { ImdbBadge } from "@/components/ImdbBadge";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

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

// Passive preview pane for the browse screen — no buttons here on purpose (Netflix TV home:
// the top pane is just a live preview of whatever's focused, never actionable on its own).
// Opening CinemaMovieDetail (click/Enter on a card) is what surfaces Lecture/Bande-annonce/Vu/Ma
// liste. Cast still fetched here (not just in the detail overlay) since this pane already shows
// it, same lazy/debounced approach so fast arrow-key scrubbing across a row doesn't fire a
// request per card it passes through.
export function CinemaHero({ item }: { item: CinemaMovie }) {
  const [debouncedId, setDebouncedId] = useState(item.radarrId);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedId(item.radarrId), 200);
    return () => clearTimeout(timer);
  }, [item.radarrId]);
  const { data: rawInfo } = useSWR<RadarrInfo>(`/api/radarr/movies/${debouncedId}/info`, fetcher);
  // Guards against showing the PREVIOUS item's cast under the new title during the debounce
  // window — SWR still has that data cached from before debouncedId catches up.
  const info = debouncedId === item.radarrId ? rawInfo : undefined;

  return (
    // Height as an inline style, not h-[70vh] min-h-[420px] — those arbitrary-value Tailwind
    // classes weren't making it into the production CSS bundle (confirmed live: the exact same
    // content rendered fine, fully visible, once given real height via style={} instead), while
    // this file's *named* utility classes (max-w-2xl, text-4xl, etc.) all worked correctly.
    <div className="relative h-full w-full overflow-hidden">
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

      <div className="relative flex h-full max-w-2xl flex-col justify-end gap-4 px-8 pb-10 sm:px-12">
        <h1 className="text-4xl font-bold leading-tight text-white drop-shadow-lg sm:text-6xl">{item.title}</h1>

        <div className="flex flex-wrap items-center gap-3 text-sm text-white/80">
          <span>{item.year}</span>
          {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
          {item.genres.length > 0 && <span>{item.genres.slice(0, 3).join(" · ")}</span>}
        </div>

        <p className="line-clamp-2 max-w-xl text-sm text-white/90 drop-shadow-sm sm:text-base">
          {info?.tmdb?.overview || item.overview}
        </p>

        {info?.tmdb?.cast && info.tmdb.cast.length > 0 && (
          <p className="max-w-xl truncate text-xs text-white/60">
            {info.tmdb.cast.slice(0, 5).map((c) => c.name).join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}
