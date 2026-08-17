"use client";

import { useState } from "react";
import { CirclePlus } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";

// Extracted from the watchlist page (its original home) so the home dashboard's own watchlist
// teaser row can request an item too — same POST, same idle/loading/done/error states, one
// place to keep them consistent.
export function RequestButton({ mediaType, tmdbId }: { mediaType: "movie" | "series"; tmdbId: number }) {
  const t = useT();
  const toast = useToast();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  async function doRequest(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setState("loading");
    try {
      const res = await fetch("/api/jellyseerr/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: mediaType === "movie" ? "movie" : "tv", mediaId: tmdbId }),
      });
      if (res.ok) {
        setState("done");
        // Cache carries availability/request status shown elsewhere (discover, watchlist) —
        // matches PosterCard's own request flow so a request made from here shows up there too
        // without waiting out the cache's own TTL.
        fetch("/api/cache/invalidate", { method: "POST" }).catch(() => {});
      } else {
        // Was previously silent about why — just turned red with no explanation, which read as
        // "broken" rather than "rejected for a reason" (already requested, Jellyseerr
        // unreachable, etc.). Surfacing the server's actual message matches what PosterCard
        // already does for the exact same action on discover/search/recommendations.
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t("common.unknown"));
        setState("error");
      }
    } catch {
      toast.error(t("common.unknown"));
      setState("error");
    }
  }
  return (
    <button
      onClick={doRequest}
      disabled={state === "loading" || state === "done"}
      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium transition-colors ${
        state === "done" ? "bg-emerald-500/20 text-emerald-400" :
        state === "error" ? "bg-red-500/20 text-red-400" :
        "bg-white/10 text-white hover:bg-white/20"
      }`}
    >
      <CirclePlus size={9} />
      {state === "done" ? t('common.requested') : state === "loading" ? "…" : t('common.request')}
    </button>
  );
}
