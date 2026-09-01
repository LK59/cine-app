"use client";

import { CinemaCard } from "@/components/cinema/CinemaCard";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

export function CinemaRow({
  label,
  rowKey,
  items,
  cardWidthClassName,
  onFocusItem,
  onSelectItem,
}: {
  label: string;
  rowKey: string;
  items: CinemaMovie[];
  cardWidthClassName: string;
  onFocusItem: (item: CinemaMovie) => void;
  onSelectItem: (item: CinemaMovie) => void;
}) {
  if (items.length === 0) return null;

  return (
    // snap-start: the scroll pane above (CinemaClient) is snap-y/snap-mandatory — this makes
    // THIS row's top edge (the label) one of the valid rest positions, so scrolling by any
    // means always lands with a full row (label + posters) in view, never mid-row.
    <div className="mb-6 snap-start">
      {/* Thin, small, muted — a section label, not a heading competing with the poster row
          beneath it. */}
      <h2 className="mb-2 px-8 text-sm font-medium text-white/70 sm:px-12">{label}</h2>
      {/* pt-3, not just pb-4: the row scroller forces overflow-y to `auto` too (any element
          with overflow-x:auto and no explicit overflow-y computes it that way per spec), so a
          hover/focus-scaled card with no room above it gets its top edge clipped by this same
          box — this is what "les affiches sont coupées" turned out to be. */}
      <div className="scrollbar-thin flex scroll-smooth gap-3 overflow-x-auto px-8 pb-4 pt-3 sm:px-12">
        {items.map((item, i) => (
          <CinemaCard
            key={item.radarrId}
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
