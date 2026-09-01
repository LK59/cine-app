"use client";

import useSWR from "swr";
import { useEffect, useState } from "react";
import { fetcher } from "@/lib/swr";
import { ImdbBadge } from "@/components/ImdbBadge";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

interface RadarrCastMember {
  tmdbId: number;
  name: string;
  character: string;
  photoUrl: string | null;
}

interface RadarrInfo {
  tmdb: { overview: string; cast: RadarrCastMember[] } | null;
  trailerKey: string | null;
  logoUrl: string | null;
}

// Text only — the backdrop image/gradients live in CinemaClient now, as one continuous
// full-screen background layer shared with the rows pane beneath (see its own doc comment for
// why: keeping the image scoped to just this component's box was exactly what produced a hard
// seam where the hero "ended"). This is purely a passive preview pane — no buttons here on
// purpose (Netflix TV home: the top pane is just a live preview of whatever's focused, never
// actionable on its own). Opening CinemaMovieDetail (click/Enter on a card) is what surfaces
// Lecture/Bande-annonce/Vu/À voir. Cast still fetched here (not just in the detail overlay) since
// this pane already shows it, same lazy/debounced approach so fast arrow-key scrubbing across a
// row doesn't fire a request per card it passes through.
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
  // A logoUrl existing doesn't mean the image actually loads — TMDB logo assets 404 or time out
  // often enough in practice that this needs its own fallback, same as any other image here.
  // Without it, a broken logo left NOTHING in its place (no title at all, just an empty gap) —
  // there was never a text fallback to fall back to since the choice between <img>/<h1> was
  // already locked in before the browser even tried loading the image.
  const [logoErrored, setLogoErrored] = useState(false);
  // Reset when the logo itself changes, adjusted during render (not a separate effect) per
  // React's own guidance for deriving state from a prop change, to avoid an extra render pass.
  const [lastLogoUrl, setLastLogoUrl] = useState(info?.logoUrl);
  if (info?.logoUrl !== lastLogoUrl) {
    setLastLogoUrl(info?.logoUrl);
    setLogoErrored(false);
  }

  return (
    <div key={item.radarrId} className="relative flex h-full max-w-2xl flex-col justify-end gap-3 px-8 pb-10 sm:px-12">
      {info?.logoUrl && !logoErrored ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={info.logoUrl}
          alt={item.title}
          onError={() => setLogoErrored(true)}
          className="max-h-16 w-auto max-w-full object-contain drop-shadow-lg sm:max-h-24"
        />
      ) : (
        <h1 className="text-3xl font-bold leading-tight text-white drop-shadow-lg sm:text-5xl">{item.title}</h1>
      )}

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
  );
}
