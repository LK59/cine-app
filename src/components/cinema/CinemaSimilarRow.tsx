"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { similarInLibrary } from "@/lib/cinemaSimilar";
import { uniqueById } from "@/lib/cinemaRails";
import { PosterImage } from "@/components/PosterImage";
import { CinemaNewBadge } from "@/components/cinema/CinemaNewBadge";
import { useT } from "@/components/TranslationProvider";
import type { CinemaMovie, CinemaMoviesPayload } from "@/app/api/cinema/movies/route";
import type { CinemaSeries, CinemaSeriesPayload } from "@/app/api/cinema/series/route";

// "Plus comme ça", at the bottom of a detail sheet — but only titles from your own library, so
// everything it proposes can be started on the spot (see lib/cinemaSimilar for why not TMDB's
// recommendations).
//
// Fetches its own payload rather than taking one as a prop: the SWR key is already in cache
// whenever the browse screen behind it has loaded, so this costs nothing, and it keeps the three
// detail sheets (desktop movie, desktop series, mobile) from each having to thread the catalog
// down. Renders nothing when the subject has no genres in common with anything.

// Radarr and Sonarr ids never collide within one payload, and a row only ever holds one of the
// two kinds.
function idOf(item: CinemaMovie | CinemaSeries): number {
  return "radarrId" in item ? item.radarrId : item.sonarrId;
}

export function CinemaSimilarRow({
  subject,
  mediaType,
  onSelect,
}: {
  subject: CinemaMovie | CinemaSeries;
  mediaType: "movies" | "series";
  onSelect: (item: CinemaMovie | CinemaSeries) => void;
}) {
  const t = useT();
  const { data: movies } = useSWR<CinemaMoviesPayload>(mediaType === "movies" ? "/api/cinema/movies" : null, fetcher);
  const { data: series } = useSWR<CinemaSeriesPayload>(mediaType === "series" ? "/api/cinema/series" : null, fetcher);

  const items = useMemo(() => {
    const payload = mediaType === "movies" ? movies : series;
    if (!payload) return [];
    const all: (CinemaMovie | CinemaSeries)[] = uniqueById(
      [...payload.spotlight, ...Object.values(payload.rows).flat()],
      idOf
    );
    const subjectId = idOf(subject);
    return similarInLibrary(subject, all, (candidate) => idOf(candidate) === subjectId);
  }, [movies, series, mediaType, subject]);

  if (items.length === 0) return null;

  return (
    <section className="mt-4 w-full">
      <h2 className="mb-2 text-sm font-medium text-white/70">{t("cinema.similar")}</h2>
      <div className="scrollbar-thin flex gap-3 overflow-x-auto pb-2">
        {items.map((item) => (
          <button
            key={idOf(item)}
            type="button"
            onClick={() => onSelect(item)}
            className="relative w-20 shrink-0 overflow-hidden rounded-lg shadow-lg shadow-black/40 transition-transform hover:scale-105 focus-visible:scale-105 sm:w-24"
          >
            <PosterImage src={item.posterUrl} alt={item.title} subtle unoptimized sizes="120px" />
            <CinemaNewBadge addedAt={item.addedAt} />
          </button>
        ))}
      </div>
    </section>
  );
}
