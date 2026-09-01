"use client";

import { CinemaSeriesCard } from "@/components/cinema/CinemaSeriesCard";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

// Series-typed mirror of CinemaRow — see its own doc comment.
export function CinemaSeriesRow({
  label,
  rowKey,
  items,
  cardWidthClassName,
  onFocusItem,
  onSelectItem,
}: {
  label: string;
  rowKey: string;
  items: CinemaSeries[];
  cardWidthClassName: string;
  onFocusItem: (item: CinemaSeries) => void;
  onSelectItem: (item: CinemaSeries) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="mb-6 snap-start">
      <h2 className="mb-2 px-8 text-sm font-medium text-white/70 sm:px-12">{label}</h2>
      <div className="scrollbar-thin flex scroll-smooth gap-3 overflow-x-auto px-8 pb-4 pt-3 sm:px-12">
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
}
