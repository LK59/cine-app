"use client";

import { memo } from "react";
import { CinemaCard } from "@/components/cinema/CinemaCard";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

// Fades the scroller's own left/right edges to transparent — a plain CSS mask on the row itself,
// not a JS scroll-position check that would hide/show it depending on how far you've scrolled.
// Netflix does track scroll position for this; a static fade is a fraction of the complexity and
// reads the same in practice, since a card is already visibly cropped at the edge either way —
// the fade is what makes that cropping look deliberate instead of like a rendering glitch.
const EDGE_FADE = {
  maskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
  WebkitMaskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
};

// memo'd: focus changes re-render CinemaClient on every arrow keypress (the hero above is driven
// by whatever card has focus), and without this that walks the entire grid — every row, every
// card — on each press. Every prop passed in is already stable across those renders (the item
// arrays come straight off the SWR payload, the callbacks are useCallback'd there), so the rows
// simply opt out of that work entirely.
export const CinemaRow = memo(function CinemaRow({
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
  // Staggers this row's entrance animation behind the ones above it — capped at 6 so a long
  // genre list doesn't make the later rows feel like they're crawling in. Only visible the first
  // time a row actually mounts (a plain CSS animation, no replay-on-rerender logic needed): once
  // on the very first load, and again on each Films/Séries switch, since CinemaClient remounts
  // this whole tree per tab (see its own note on why that swap is a fresh mount, not a re-render).
  rowIndex?: number;
  items: CinemaMovie[];
  cardWidthClassName: string;
  onFocusItem: (item: CinemaMovie) => void;
  onSelectItem: (item: CinemaMovie) => void;
}) {
  if (items.length === 0) return null;

  return (
    // snap-start: the scroll pane above (CinemaClient) is snap-y/snap-mandatory — this makes
    // THIS row's top edge (the label) one of the valid rest positions.
    <div className="mb-6 animate-fade-in-up snap-start" style={{ animationDelay: `${Math.min(rowIndex, 6) * 40}ms` }}>
      {/* Thin, small, muted — a section label, not a heading competing with the poster row
          beneath it. */}
      <h2 className="mb-2 px-8 text-sm font-medium text-white/70 sm:px-12">{label}</h2>
      {/* pt-3, not just pb-4: the row scroller forces overflow-y to `auto` too (any element
          with overflow-x:auto and no explicit overflow-y computes it that way per spec), so a
          hover/focus-scaled card with no room above it gets its top edge clipped by this same
          box — this is what "les affiches sont coupées" turned out to be. */}
      <div className="scrollbar-thin flex scroll-smooth gap-3 overflow-x-auto px-8 pb-4 pt-3 sm:px-12" style={EDGE_FADE}>
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
});
