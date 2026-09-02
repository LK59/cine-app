"use client";

// Where you are in an episode you started, shown on the episode itself.
//
// Every other surface in Cinema Mode says where you stopped — the Continue rail, the sheet's own
// Lire button — but the season list, the one screen you actually pick an episode from, said
// nothing: a half-watched episode looked exactly like an untouched one. Watched episodes already
// have their checkmark and are deliberately left alone here; this is only for the in-between.
export function CinemaEpisodeProgress({
  resumeTicks,
  runtimeTicks,
  watched,
}: {
  resumeTicks: number | null;
  runtimeTicks: number | null;
  watched: boolean;
}) {
  if (watched || !resumeTicks || !runtimeTicks || runtimeTicks <= 0) return null;

  // Capped just short of full: a bar rendered at 100% reads as "finished", which is the one thing
  // an unfinished episode must not look like.
  const percent = Math.min(99, Math.max(2, (resumeTicks / runtimeTicks) * 100));

  // Bar only, no label of its own: both call sites already print the remaining time next to the
  // episode title, and a screen reader shouldn't hear it twice.
  return (
    <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
      <div className="h-full bg-accent-500" style={{ width: `${percent}%` }} />
    </div>
  );
}
