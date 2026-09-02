"use client";

import { memo } from "react";
import { CinemaSeriesCard } from "@/components/cinema/CinemaSeriesCard";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

// Series-typed mirror of CinemaRow — see its own doc comment (edge fade mask, staggered entrance
// capped at 6 rows).
const EDGE_FADE = {
  maskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
  WebkitMaskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
};

// memo'd for the same reason CinemaRow is — see its own note.
export const CinemaSeriesRow = memo(function CinemaSeriesRow({
  label,
  rowKey,
  rowIndex = 0,
  items,
  cardWidthClassName,
  onFocusItem,
  onSelectItem,
}: {
  label: string;
  rowKey: string;
  rowIndex?: number;
  items: CinemaSeries[];
  cardWidthClassName: string;
  onFocusItem: (item: CinemaSeries) => void;
  onSelectItem: (item: CinemaSeries) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="mb-6 animate-fade-in-up snap-start" style={{ animationDelay: `${Math.min(rowIndex, 6) * 40}ms` }}>
      <h2 className="mb-2 px-8 text-sm font-medium text-white/70 sm:px-12">{label}</h2>
      <div className="scrollbar-thin flex scroll-smooth gap-3 overflow-x-auto px-8 pb-4 pt-3 sm:px-12" style={EDGE_FADE}>
        {items.map((item, i) => (
          <CinemaSeriesCard
            key={item.sonarrId}
            item={item}
            index={i}
            rowKey={rowKey}
            widthClassName={cardWidthClassName}
            onFocusItem={onFocusItem}
            onSelectItem={onSelectItem}
          />
        ))}
      </div>
    </div>
  );
});
