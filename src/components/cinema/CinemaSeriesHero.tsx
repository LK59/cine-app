"use client";

import useSWR from "swr";
import { useEffect, useState } from "react";
import { fetcher } from "@/lib/swr";
import { ImdbBadge } from "@/components/ImdbBadge";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

interface SonarrCastMember {
  tmdbId: number;
  name: string;
  character: string;
  photoUrl: string | null;
}

interface SonarrInfo {
  tmdb: { overview: string; cast: SonarrCastMember[] } | null;
  trailerKey: string | null;
  localTrailerUrl: string | null;
}

// Series-typed mirror of CinemaHero — see its own doc comment (text-only passive preview,
// logo/backdrop + dwell-triggered trailer video live in CinemaClient's shared background,
// debounced cast fetch, trailerKey/localTrailerUrl lifted up via callbacks). Fetches
// /api/sonarr/series/[id]/info — the standard (non-Cinema) series info route, already shaped as
// {tmdb:{overview,cast}, trailerKey, localTrailerUrl}, same as the movie one — no new endpoint
// needed for this.
export function CinemaSeriesHero({
  item,
  onTrailerKeyChange,
  onLocalTrailerUrlChange,
}: {
  item: CinemaSeries;
  onTrailerKeyChange?: (key: string | null) => void;
  onLocalTrailerUrlChange?: (url: string | null) => void;
}) {
  const [debouncedId, setDebouncedId] = useState(item.sonarrId);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedId(item.sonarrId), 200);
    return () => clearTimeout(timer);
  }, [item.sonarrId]);
  const { data: rawInfo } = useSWR<SonarrInfo>(`/api/sonarr/series/${debouncedId}/info`, fetcher);
  const info = debouncedId === item.sonarrId ? rawInfo : undefined;

  useEffect(() => {
    onTrailerKeyChange?.(info?.trailerKey ?? null);
    onLocalTrailerUrlChange?.(info?.localTrailerUrl ?? null);
  }, [info?.trailerKey, info?.localTrailerUrl, onTrailerKeyChange, onLocalTrailerUrlChange]);

  const [logoErrored, setLogoErrored] = useState(false);
  const [resetForId, setResetForId] = useState(item.sonarrId);
  if (item.sonarrId !== resetForId) {
    setResetForId(item.sonarrId);
    setLogoErrored(false);
  }

  return (
    <div key={item.sonarrId} className="relative flex h-full max-w-2xl flex-col justify-end gap-3 px-8 pb-10 sm:px-12">
      {item.logoUrl && !logoErrored ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.logoUrl}
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
