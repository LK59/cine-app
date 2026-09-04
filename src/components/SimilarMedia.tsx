"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { Rail } from "@/components/Rail";
import { PosterCard, type PosterCardItem } from "@/components/PosterCard";
import { useT } from "@/components/TranslationProvider";
import type { SimilarMovie } from "@/app/api/radarr/movies/[id]/similar/route";
import type { SimilarSeries } from "@/app/api/sonarr/series/[id]/similar/route";
import { useWatchlistStatusMap } from "@/lib/useWatchlistStatusMap";
import type { WatchlistStatus } from "@/lib/db";

type Item = (SimilarMovie & { sonarrId?: never }) | (SimilarSeries & { radarrId?: never });

function toPosterCardItem(item: Item, type: "movie" | "series", watchlistStatus?: WatchlistStatus | null): PosterCardItem {
  const libraryHref = type === "movie"
    ? (item.radarrId ? `/radarr/${item.radarrId}` : null)
    : (item.sonarrId ? `/sonarr/${item.sonarrId}` : null);
  return {
    tmdbId: item.tmdbId,
    title: item.title,
    year: item.year,
    posterUrl: item.posterPath,
    rating: item.voteAverage,
    inLibrary: item.inLibrary,
    libraryHref,
    watchlistStatus,
  };
}

interface Props {
  apiUrl: string;
  type: "movie" | "series";
}

export function SimilarMedia({ apiUrl, type }: Props) {
  const { data } = useSWR<{ items: Item[] }>(apiUrl, fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    dedupingInterval: 3_600_000,
  });
  const t = useT();

  const items = data?.items ?? [];
  const statusMap = useWatchlistStatusMap(items.map((item) => ({ mediaType: type, tmdbId: item.tmdbId })));
  if (items.length === 0) return null;

  return (
    <div className="mt-6">
      <h3 className="mb-3 text-sm font-semibold text-white">{t("similar.title")}</h3>
      <Rail>
        {items.map((item) => (
          <div key={item.tmdbId} className="snap-start">
            <PosterCard item={toPosterCardItem(item, type, statusMap[`${type}:${item.tmdbId}`])} mediaType={type} size="carousel" />
          </div>
        ))}
      </Rail>
    </div>
  );
}
