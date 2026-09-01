"use client";

import { useT } from "@/components/TranslationProvider";

// Netflix's own "TV Shows / Movies" segmented switch — top center, purely a visual toggle (Tab
// reaches it, Enter/Space activates a focused segment, same as any button) rather than wired
// into the TV-remote arrow-key grid: it sits outside the poster grid entirely, at a different
// screen position than any row, so folding it into that chain would need its own special case
// for no real gain over just tabbing to it.
export function CinemaModeToggle({
  mode,
  onChange,
}: {
  mode: "movies" | "series";
  onChange: (mode: "movies" | "series") => void;
}) {
  const t = useT();
  return (
    <div
      className="fixed left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/40 p-1 backdrop-blur-xs"
      style={{ top: "max(1rem, env(safe-area-inset-top))" }}
    >
      <button
        onClick={() => onChange("movies")}
        className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
          mode === "movies" ? "bg-white text-slate-950" : "text-white/70 hover:text-white"
        }`}
      >
        {t("cinema.moviesTab")}
      </button>
      <button
        onClick={() => onChange("series")}
        className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
          mode === "series" ? "bg-white text-slate-950" : "text-white/70 hover:text-white"
        }`}
      >
        {t("cinema.seriesTab")}
      </button>
    </div>
  );
}
