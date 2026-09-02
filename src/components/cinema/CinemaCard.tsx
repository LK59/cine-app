"use client";

import { PosterImage } from "@/components/PosterImage";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

const TV_NAV_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950";

// Deliberately not PosterCard — no watchlist-status chrome, no ActionSheet, no click-to-navigate.
// A card's only job here is to report "I'm focused" (mouse hover or keyboard arrow-nav, both via
// onFocus/onMouseEnter) so the hero above can show it — everything else about the title lives in
// the hero, not on the card itself, hence the reduced chrome. data-tv-* wires it into the
// existing useTvGridNav() convention (see CinemaClient) unchanged. onClick (mouse click, or
// Enter/Space on a focused button — free from native <button> semantics) escalates from preview
// to CinemaMovieDetail, same "click the tile to open it big" gesture as Netflix's TV app.
export function CinemaCard({
  item,
  index,
  rowKey,
  widthClassName,
  onFocusItem,
  onSelectItem,
}: {
  item: CinemaMovie;
  index: number;
  rowKey: string;
  widthClassName: string;
  onFocusItem: (item: CinemaMovie) => void;
  onSelectItem: (item: CinemaMovie) => void;
}) {
  return (
    <button
      type="button"
      data-tv-card
      data-tv-row={rowKey}
      data-tv-col={index}
      onFocus={() => onFocusItem(item)}
      onMouseEnter={() => onFocusItem(item)}
      onClick={() => onSelectItem(item)}
      className={`${widthClassName} shrink-0 overflow-hidden rounded-lg transition-transform duration-200 hover:z-10 hover:scale-105 focus-visible:z-10 focus-visible:scale-105 ${TV_NAV_RING}`}
    >
      <PosterImage src={item.posterUrl} alt={item.title} subtle />
    </button>
  );
}
