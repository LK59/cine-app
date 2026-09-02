"use client";

import { isRecentlyAdded } from "@/lib/cinemaRails";
import { useT } from "@/components/TranslationProvider";

// The little red "Nouveau" tag Netflix puts on freshly-arrived titles. Shared by every card in
// Cinema Mode (movie, series, desktop, mobile) so the badge means exactly one thing everywhere:
// added to the library within the last month.
//
// Renders nothing at all when the title isn't recent — callers can drop it in unconditionally.
export function CinemaNewBadge({ addedAt }: { addedAt: string | null }) {
  const t = useT();
  if (!isRecentlyAdded(addedAt)) return null;
  return (
    <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white shadow-lg shadow-black/50">
      {t("cinema.newBadge")}
    </span>
  );
}
