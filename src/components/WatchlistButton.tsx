"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { Bookmark, BookmarkCheck } from "lucide-react";
import type { WatchlistItem, WatchlistStatus } from "@/lib/db";

interface Props {
  mediaType: "movie" | "series";
  tmdbId: number;
  title: string;
  year?: number | null;
  posterPath?: string | null;
  defaultStatus?: WatchlistStatus;
  size?: "sm" | "md";
  className?: string;
}

export function WatchlistButton({
  mediaType, tmdbId, title, year, posterPath, defaultStatus = "to_watch", size = "md", className = ""
}: Props) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);

  const itemKey = `/api/watchlist/item?mediaType=${mediaType}&tmdbId=${tmdbId}`;
  const { data } = useSWR<{ item: WatchlistItem | null }>(itemKey, fetcher, { shouldRetryOnError: false });
  const inList = !!data?.item;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      if (inList) {
        await fetch("/api/watchlist", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tmdbId, mediaType }),
        });
      } else {
        await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaType, tmdbId, title, year, posterPath, status: defaultStatus }),
        });
      }
      mutate(itemKey);
      mutate("/api/watchlist");
    } finally {
      setBusy(false);
    }
  }

  const Icon = inList ? BookmarkCheck : Bookmark;
  const label = inList ? "Retirer de la liste" : "Ajouter à la liste";
  const sizeClass = size === "sm" ? "p-1.5" : "px-3 py-1.5";
  const iconSize = size === "sm" ? 13 : 14;

  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={label}
      className={`flex items-center gap-1.5 rounded transition-colors ${sizeClass} ${
        inList
          ? "bg-accent-500/20 text-accent-400 hover:bg-accent-500/30"
          : "bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white"
      } ${className}`}
    >
      <Icon size={iconSize} />
      {size === "md" && <span className="text-xs">{inList ? "Dans la liste" : "Ajouter"}</span>}
    </button>
  );
}
