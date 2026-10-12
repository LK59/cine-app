"use client";

import { newBadgeKey, type SeriesArrival } from "@/lib/cinemaRails";
import { useT } from "@/components/TranslationProvider";

// The little red "Nouveau" tag Netflix puts on freshly-arrived titles. Shared by every card in
// Cinema Mode (movie, series, desktop, mobile) so the badge means exactly one thing everywhere:
// added to the library within the last month.
//
// Renders nothing at all when the title isn't recent — callers can drop it in unconditionally.
//
// Callers that are themselves "here's what's new" (the Récemment ajoutés rail, and the Top 10,
// which on a growing library is mostly recent) pass showNewBadge={false}: stamping NEW on every
// item of a rail whose whole point is newness says nothing.
//
// A series says why it is there — « Nouvelle série », « Nouvelle saison », « Nouvel épisode » — from
// the catalogue's `arrival` (DECISIONS.md §75); a film, which has no `arrival`, keeps « Nouveau ».
// Same shape for all four: only the words change.
//
// `reasonOnly`, on those same "what's new" rails: a series that came back up for an episode or a
// season still says so — on the rail where it surfaced, that reason is the one thing worth reading
// (12/10/2026: the badge was off exactly where the resurfaced series showed). A film, or a series
// that is itself new, stays bare there.
export function CinemaNewBadge({ addedAt, arrival, reasonOnly = false }: { addedAt: string | null; arrival?: SeriesArrival; reasonOnly?: boolean }) {
  const t = useT();
  const key = newBadgeKey(addedAt, arrival);
  if (!key) return null;
  if (reasonOnly && arrival !== "season" && arrival !== "episode") return null;
  return (
    <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white shadow-lg shadow-black/50">
      {t(key)}
    </span>
  );
}
