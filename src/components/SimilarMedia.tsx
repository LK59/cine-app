"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { HorizontalCarousel } from "@/components/HorizontalCarousel";
import { PosterCard, type PosterCardItem } from "@/components/PosterCard";
import { useT } from "@/components/TranslationProvider";
import type { SimilarMovie } from "@/app/api/radarr/movies/[id]/similar/route";
import type { SimilarSeries } from "@/app/api/sonarr/series/[id]/similar/route";

type Item = (SimilarMovie & { sonarrId?: never }) | (SimilarSeries & { radarrId?: never });

function toPosterCardItem(item: Item, type: "movie" | "series"): PosterCardItem {
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
  if (items.length === 0) return null;

  return (
    <div className="mt-6">
      <h3 className="mb-3 text-sm font-semibold text-white">{t("similar.title")}</h3>
      <HorizontalCarousel className="scrollbar-thin flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory">
        {items.map((item) => (
          <div key={item.tmdbId} className="snap-start">
            <PosterCard item={toPosterCardItem(item, type)} mediaType={type} size="carousel" />
          </div>
        ))}
      </HorizontalCarousel>
    </div>
  );
}
