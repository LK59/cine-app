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
export function useAddToWatchlist(initialStatus: WatchlistStatus | null = null) {
  const toast = useToast();
  const t = useT();
  const [addedStatus, setAddedStatus] = useState<WatchlistStatus | null>(initialStatus);
  // Tracks the initialStatus value already reconciled into addedStatus below, so the
  // adjustment only runs once per actual change instead of on every render.
  const [reconciledStatus, setReconciledStatus] = useState(initialStatus);

  // initialStatus usually arrives after mount (it comes from a bulk-status fetch keyed on
  // whatever's currently rendered) — useState's initializer only runs once, so without this
  // adjustment a status resolved after first paint would never reach addedStatus. Only adopts
  // it when nothing has been set locally yet, so it can't clobber an in-progress optimistic
  // update. Applied during render (rather than in an effect) per React's guidance for
  // adjusting state from a prop change, to avoid an extra render pass.
  if (initialStatus !== reconciledStatus) {
    setReconciledStatus(initialStatus);
    if (initialStatus !== null) setAddedStatus((prev) => prev ?? initialStatus);
  }

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

  // Un-toggling: back to no status at all, not silently reassigned to some other status. Needed
  // by any "toggle" UI (Cinema Mode's Vu/À voir rows) built on a single-status field — without
  // this, the only way to leave a status was to overwrite it with a DIFFERENT one, so clicking
  // an already-active toggle to turn it off looked like it flipped to the other option instead.
  async function removeFromWatchlist(payload: { tmdbId: number; mediaType: "movie" | "series" }) {
    const previous = addedStatus;
    setAddedStatus(null);
    try {
      const res = await fetch("/api/watchlist", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error();
    } catch {
      setAddedStatus(previous);
      toast.error(t("watchlist.addFailed"));
    }
  }

  return { addedStatus, addToWatchlist, removeFromWatchlist };
}
