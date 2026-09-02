"use client";

import { CinemaTop10Card } from "@/components/cinema/CinemaTop10Card";

// Same edge fade as CinemaRow/CinemaSeriesRow — see the doc comment there for why it's a static
// mask rather than a scroll-position check.
const EDGE_FADE = {
  maskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
  WebkitMaskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
};

interface Top10Item {
  posterUrl: string | null;
  title: string;
  addedAt: string | null;
}

// The desktop Top 10 rail. Generic over the item type so the movie and series tabs share one
// implementation — the rail only ever reads a poster, a title and an added date, which both
// payloads have (the callbacks keep the caller's own concrete type).
//
// Taller than a normal row on purpose: the rank digit needs the room, and Netflix's own Top 10
// row is likewise the one row that breaks the grid's rhythm.
export function CinemaTop10Row<T extends Top10Item>({
  label,
  rowKey,
  rowIndex = 0,
  items,
  idOf,
  cardWidthClassName,
  onFocusItem,
  onSelectItem,
}: {
  label: string;
  rowKey: string;
  rowIndex?: number;
  items: T[];
  idOf: (item: T) => number;
  cardWidthClassName: string;
  onFocusItem: (item: T) => void;
  onSelectItem: (item: T) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="mb-6 animate-fade-in-up snap-start" style={{ animationDelay: `${Math.min(rowIndex, 6) * 40}ms` }}>
      <h2 className="mb-2 px-8 text-sm font-medium text-white/70 sm:px-12">{label}</h2>
      <div className="scrollbar-thin flex scroll-smooth items-end gap-3 overflow-x-auto overflow-y-hidden px-8 pb-4 pt-3 sm:px-12" style={EDGE_FADE}>
        {items.map((item, i) => (
          <CinemaTop10Card
            key={idOf(item)}
            rank={i + 1}
            title={item.title}
            posterUrl={item.posterUrl}
            addedAt={item.addedAt}
            widthClassName="w-24 sm:w-28 md:w-32 lg:w-36"
            numberFontSize="6.5rem"
            showNewBadge={false}
            rowKey={rowKey}
            index={i}
            onFocusItem={() => onFocusItem(item)}
            onSelectItem={() => onSelectItem(item)}
          />
        ))}
      </div>
    </div>
  );
}
