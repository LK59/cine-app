"use client";

import { useState } from "react";
import { CirclePlus } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { RequestFlowModal } from "@/components/RequestFlowModal";

// Extracted from the watchlist page (its original home) so the home dashboard's own watchlist
// teaser row can request an item too, and shared with PosterCard (discover/search/
// recommendations) — one place to keep the actual request flow consistent everywhere.
// Delegates the confirm-and-submit logic entirely to RequestFlowModal (movie: plain confirm,
// series: season picker — Jellyseerr needs a `seasons` field for a tv request, or it 500s).
export function RequestButton({
  mediaType,
  tmdbId,
  title,
}: {
  mediaType: "movie" | "series";
  tmdbId: number;
  title: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);

  return (
    <>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        disabled={done}
        className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium transition-colors ${
          done ? "bg-emerald-500/20 text-emerald-400" : "bg-white/10 text-white hover:bg-white/20"
        }`}
      >
        <CirclePlus size={9} />
        {done ? t("common.requested") : t("common.request")}
      </button>
      {open && (
        <RequestFlowModal
          mediaType={mediaType}
          tmdbId={tmdbId}
          title={title}
          onClose={() => setOpen(false)}
          onSuccess={() => setDone(true)}
        />
      )}
    </>
  );
}
