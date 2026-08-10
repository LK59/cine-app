"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import type { WatchlistStatus } from "@/lib/db";

/**
 * Bulk-resolves current watchlist status for a set of TMDB items, so browsing surfaces
 * (Discover, Recommendations, similar titles, collections, global search) can show a title
 * as already-added instead of always defaulting to "not on the list" until touched in the
 * current page session.
 */
export function useWatchlistStatusMap(
  items: { mediaType: "movie" | "series"; tmdbId: number }[]
): Record<string, WatchlistStatus | null> {
  const key = items.length
    ? `/api/watchlist/bulk-status?items=${items.map((i) => `${i.mediaType}:${i.tmdbId}`).join(",")}`
    : null;
  const { data } = useSWR<Record<string, WatchlistStatus | null>>(key, fetcher);
  return data ?? {};
}
