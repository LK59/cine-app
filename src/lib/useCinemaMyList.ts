"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { uniqueById } from "@/lib/cinemaRails";
import type { WatchlistItem } from "@/lib/db";

interface CinemaLibraryItem {
  tmdbId: number | null;
  genres: string[];
}

interface CinemaLibraryPayload<T> {
  rows: Record<string, T[]>;
  spotlight: T[];
}

// "Ma liste" — the titles you marked as to-watch, narrowed to the ones actually in the library.
//
// The watchlist can hold anything you found through search or Discover, including films nobody
// has downloaded yet. Those have no Jellyfin item and no poster in this payload, so a Cinema rail
// is the wrong place for them: every card there is meant to start playing when you press it. The
// intersection is what belongs on the rail; the full watchlist already has its own page.
export function useCinemaMyList<T extends CinemaLibraryItem>(
  mediaType: "movie" | "series",
  payload: CinemaLibraryPayload<T> | undefined
): T[] {
  const { data } = useSWR<{ items: WatchlistItem[] }>("/api/watchlist?status=to_watch", fetcher);

  return useMemo(() => {
    if (!payload || !data?.items?.length) return [];
    const wanted = new Set(data.items.filter((w) => w.mediaType === mediaType).map((w) => w.tmdbId));
    if (wanted.size === 0) return [];
    const all = uniqueById([...payload.spotlight, ...Object.values(payload.rows).flat()], (item) => item.tmdbId ?? 0);
    return all.filter((item) => item.tmdbId !== null && wanted.has(item.tmdbId));
  }, [payload, data, mediaType]);
}
