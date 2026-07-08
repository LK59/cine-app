"use client";

import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { HorizontalCarousel } from "@/components/HorizontalCarousel";
import { Star, CheckCircle } from "lucide-react";
import type { SimilarMovie } from "@/app/api/radarr/movies/[id]/similar/route";
import type { SimilarSeries } from "@/app/api/sonarr/series/[id]/similar/route";

type Item = (SimilarMovie & { sonarrId?: never }) | (SimilarSeries & { radarrId?: never });

function SimilarCard({ item, type }: { item: Item; type: "movie" | "series" }) {
  const href = type === "movie"
    ? (item.radarrId ? `/radarr/${item.radarrId}` : null)
    : (item.sonarrId ? `/sonarr/${item.sonarrId}` : null);

  const card = (
    <div className="group relative w-24 shrink-0 select-none [touch-action:manipulation]">
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-slate-800">
        {item.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.posterPath}
            alt={item.title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-slate-600 text-xs text-center p-1">{item.title}</div>
        )}
        {item.inLibrary && (
          <div className="absolute right-1.5 top-1.5 rounded-full bg-emerald-500/90 p-0.5">
            <CheckCircle size={9} className="text-white" />
          </div>
        )}
        {item.voteAverage > 0 && (
          <div className="absolute bottom-1.5 left-1.5 flex items-center gap-0.5 rounded bg-black/70 px-1 py-0.5 text-[9px] text-amber-400 backdrop-blur-sm">
            <Star size={7} fill="currentColor" />
            {item.voteAverage.toFixed(1)}
          </div>
        )}
      </div>
      <p className="mt-1 truncate text-[11px] font-medium text-slate-400 transition-colors group-hover:text-slate-200">{item.title}</p>
      {item.year && <p className="text-[10px] text-slate-600">{item.year}</p>}
    </div>
  );

  return href ? <Link href={href}>{card}</Link> : card;
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

  const items = data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <div className="mt-6">
      <h3 className="mb-3 text-sm font-semibold text-white">Dans le même genre</h3>
      <HorizontalCarousel className="scrollbar-thin flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory">
        {items.map((item) => (
          <div key={item.tmdbId} className="snap-start">
            <SimilarCard item={item} type={type} />
          </div>
        ))}
      </HorizontalCarousel>
    </div>
  );
}
