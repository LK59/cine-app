"use client";

import { useState } from "react";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import type { WatchlistStatus } from "@/lib/db";

interface WatchlistPayload {
  tmdbId: number;
  mediaType: "movie" | "series";
  title: string;
  year: number | null;
  posterPath: string | null;
  voteAverage: number | null;
}

/**
 * Optimistically marks an item as added, then rolls back and toasts on
 * failure — the fetch here previously ran fire-and-forget with no
 * res.ok check, so a failed request left the button stuck showing
 * "added" with no way for the user to notice or retry.
 */
export function useAddToWatchlist() {
  const toast = useToast();
  const t = useT();
  const [addedStatus, setAddedStatus] = useState<WatchlistStatus | null>(null);

  async function addToWatchlist(payload: WatchlistPayload, status: WatchlistStatus) {
    const previous = addedStatus;
    setAddedStatus(status);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, status }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setAddedStatus(previous);
      toast.error(t("watchlist.addFailed"));
    }
  }

  return { addedStatus, addToWatchlist };
}
