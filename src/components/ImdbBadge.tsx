"use client";

import { Star } from "lucide-react";

// Single source of truth for the small amber IMDb rating pill — was previously duplicated
// ad-hoc (fiche pages, watchlist) with slightly different sizes; now shared everywhere a
// poster or a sheet header shows a rating, including the poster-grid overlay use below.
export function ImdbBadge({
  rating,
  size = "xs",
  className,
}: {
  rating: string | number | null | undefined;
  size?: "xs" | "sm";
  className?: string;
}) {
  if (rating === null || rating === undefined || rating === "") return null;
  const value = typeof rating === "number" ? rating.toFixed(1) : rating;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-sm bg-amber-500/20 font-semibold text-amber-400 ${
        size === "xs" ? "px-1 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"
      } ${className ?? ""}`}
    >
      <Star size={size === "xs" ? 9 : 11} className="fill-current" /> {value}
    </span>
  );
}
