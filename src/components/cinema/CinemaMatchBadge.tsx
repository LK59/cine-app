"use client";

import { matchPercent } from "@/lib/cinemaRails";
import { useT } from "@/components/TranslationProvider";

// Netflix's green "97 % de correspondance", next to the year and the IMDb badge. Ours is openly
// the IMDb rating rendered that way (see matchPercent) rather than a personalized score.
//
// A component rather than an inline expression because it appears in five places (both heroes,
// both desktop sheets, the mobile sheet) and because the null case has to disappear entirely —
// no "— % de correspondance" when a title has no rating.
export function CinemaMatchBadge({ rating }: { rating: string | null }) {
  const t = useT();
  const percent = matchPercent(rating);
  if (percent === null) return null;
  return <span className="font-semibold text-green-400">{t("cinema.matchPercent", { n: percent })}</span>;
}
