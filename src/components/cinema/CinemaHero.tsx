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
}

// Text only — the backdrop image/gradients (and, once focus dwells long enough, the trailer
// video that takes over from them — see CinemaTrailerBackdrop) live in CinemaClient now, as one
// continuous full-screen background layer shared with the rows pane beneath (see its own doc
// comment for why: keeping the image scoped to just this component's box was exactly what
// produced a hard seam where the hero "ended"). This is purely a passive preview pane — no
// buttons here on purpose (Netflix TV home: the top pane is just a live preview of whatever's
// focused, never actionable on its own). Opening CinemaMovieDetail (click/Enter on a card) is
// what surfaces Lecture/Bande-annonce/Vu/À voir. Cast still fetched here (not just in the detail
// overlay) since this pane already shows it, same lazy/debounced approach so fast arrow-key
// scrubbing across a row doesn't fire a request per card it passes through.
export function CinemaHero({
  item,
  onTrailerKeyChange,
}: {
  item: CinemaMovie;
  // Reports this item's trailer key up to CinemaClient, which owns the dwell-triggered video
  // backdrop and needs the same value this already fetches — a state-lifting callback rather
  // than a second parallel fetch there, so the two never have their own independently-debounced
  // (and therefore possibly briefly disagreeing) opinions about what the current trailer is.
  onTrailerKeyChange?: (key: string | null) => void;
}) {
  const [debouncedId, setDebouncedId] = useState(item.radarrId);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedId(item.radarrId), 200);
    return () => clearTimeout(timer);
  }, [item.radarrId]);
  const { data: rawInfo } = useSWR<RadarrInfo>(`/api/radarr/movies/${debouncedId}/info`, fetcher);
  // Guards against showing the PREVIOUS item's cast under the new title during the debounce
  // window — SWR still has that data cached from before debouncedId catches up.
  const info = debouncedId === item.radarrId ? rawInfo : undefined;

  useEffect(() => {
    onTrailerKeyChange?.(info?.trailerKey ?? null);
  }, [info?.trailerKey, onTrailerKeyChange]);

  // item.logoUrl now comes bulk-included in the /api/cinema/movies payload (same as
  // poster/backdrop already were) instead of a separate per-item fetch — known synchronously
  // the instant this renders, no debounce/timing dance needed at all, and CinemaClient's own
  // warm-up effect prefetches every logo image alongside the backdrops, so by the time focus
  // actually lands here the browser has usually already cached it. Just a plain onError
  // fallback to text, same pattern as any other image in this app.
  const [logoErrored, setLogoErrored] = useState(false);
  // Reset adjusted during render (not an effect), synchronously in the same render item.radarrId
  // changes — this is a single persistent component instance across focus changes, not
  // remounted per item, so stale error state would otherwise survive into the next title.
  const [resetForId, setResetForId] = useState(item.radarrId);
  if (item.radarrId !== resetForId) {
    setResetForId(item.radarrId);
    setLogoErrored(false);
  }

  return (
    <div key={item.radarrId} className="relative flex h-full max-w-2xl flex-col justify-end gap-3 px-8 pb-10 sm:px-12">
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

      {/* Rien plutôt que de l'anglais. Le synopsis traduit vient de TMDB et met un instant à
          arriver ; celui qui servait de repli vient de Radarr, qui ne traduit pas — alors sous
          une interface en français, l'accueil affichait un texte en anglais le temps que le bon
          arrive, puis le remplaçait. Une ligne vide un court instant se remarque moins qu'une
          langue qui change sous les yeux. */}
      <p className="line-clamp-2 min-h-[2lh] max-w-xl text-sm text-white/90 drop-shadow-sm sm:text-base">
        {info?.tmdb?.overview ?? (info ? item.overview : "")}
      </p>

      {info?.tmdb?.cast && info.tmdb.cast.length > 0 && (
        <p className="max-w-xl truncate text-xs text-white/60">
          {info.tmdb.cast.slice(0, 5).map((c) => c.name).join(", ")}
        </p>
      )}
    </div>
  );
}
