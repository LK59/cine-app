"use client";

import { Info, Play } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

// The welcome screen's two actions, under the hero's title treatment: a solid white Lecture and a
// translucent Plus d'infos. Netflix's own web home leads with exactly this pair, and it's the
// same pair the mobile Cinema hero already uses — this is the desktop rendering of it.
//
// Presentational only. Both heroes render it; what the buttons actually do (play a movie from its
// resume point, resolve a series' next-up episode, open the detail sheet) is decided by
// CinemaClient, which is where the resume data and the sheet state already live.
export function CinemaHeroActions({
  onPlay,
  onMoreInfo,
  busy = false,
}: {
  onPlay: () => void;
  onMoreInfo: () => void;
  // Set while a series' next-up episode is being resolved on click — one request, but a visible
  // one, so the button says it's working rather than looking ignored.
  busy?: boolean;
}) {
  const t = useT();
  return (
    <div className="mt-1 flex items-center gap-3">
      <button
        type="button"
        onClick={onPlay}
        disabled={busy}
        className="flex items-center gap-2 rounded-md bg-white px-6 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-black/30 transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:opacity-70"
      >
        <Play size={18} fill="currentColor" />
        {t("common.play")}
      </button>
      <button
        type="button"
        onClick={onMoreInfo}
        className="flex items-center gap-2 rounded-md bg-white/20 px-6 py-2.5 text-sm font-medium text-white backdrop-blur-xs transition hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
      >
        <Info size={18} />
        {t("cinema.moreInfo")}
      </button>
    </div>
  );
}
