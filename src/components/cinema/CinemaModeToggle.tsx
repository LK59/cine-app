"use client";

import { useT } from "@/components/TranslationProvider";

// Netflix's own "TV Shows / Movies" segmented switch — top center. It sits outside the poster
// grid entirely, so it isn't one of useTvGridNav's data-tv-card cells; instead the active segment
// marks itself data-tv-escape-up so pressing Up from the grid's very first row hands focus here
// (see useTvGridNav.ts), and Left/Right below cycle the two segments the same way the grid's own
// rows do, so once you've arrowed up you can flip tabs without reaching for Tab/mouse.
export function CinemaModeToggle({
  mode,
  onChange,
}: {
  mode: "movies" | "series";
  onChange: (mode: "movies" | "series") => void;
}) {
  const t = useT();

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      onChange(mode === "movies" ? "series" : "movies");
    }
  }

  return (
    <div
      className="fixed left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/40 p-1 backdrop-blur-xs"
      style={{ top: "max(1rem, env(safe-area-inset-top))" }}
    >
      <button
        onClick={() => onChange("movies")}
        onKeyDown={onKeyDown}
        data-tv-escape-up={mode === "movies" ? "true" : undefined}
        className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none ${
          mode === "movies" ? "bg-white text-slate-950" : "text-white/70 hover:text-white"
        }`}
      >
        {t("cinema.moviesTab")}
      </button>
      <button
        onClick={() => onChange("series")}
        onKeyDown={onKeyDown}
        data-tv-escape-up={mode === "series" ? "true" : undefined}
        className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none ${
          mode === "series" ? "bg-white text-slate-950" : "text-white/70 hover:text-white"
        }`}
      >
        {t("cinema.seriesTab")}
      </button>
    </div>
  );
}
