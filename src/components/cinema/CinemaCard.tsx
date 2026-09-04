"use client";

import { PosterImage } from "@/components/PosterImage";
import { CinemaNewBadge } from "@/components/cinema/CinemaNewBadge";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

const TV_NAV_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-ink";

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
  showNewBadge = true,
}: {
  item: CinemaMovie;
  index: number;
  rowKey: string;
  widthClassName: string;
  onFocusItem: (item: CinemaMovie) => void;
  onSelectItem: (item: CinemaMovie) => void;
  // Off on the rails that are themselves about what's new — see CinemaNewBadge.
  showNewBadge?: boolean;
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
      className={`${widthClassName} relative shrink-0 overflow-hidden rounded-lg shadow-lg shadow-black/40 transition duration-200 hover:z-10 hover:scale-105 hover:shadow-xl hover:shadow-black/60 focus-visible:z-10 focus-visible:scale-105 ${TV_NAV_RING}`}
    >
      {/* unoptimized: these URLs are already TMDB CDN images requested at the exact width this
          card renders at (see the cinema payload routes). Routing them through Next's optimizer
          instead meant this server transcoding hundreds of posters on demand while you scroll —
          the single biggest source of the scroll lag on a phone. The CDN does that job better,
          and for free. */}
      <PosterImage
        src={item.posterUrl}
        alt={item.title}
        subtle
        unoptimized
        // Matches CARD_WIDTH's own breakpoints (96/112/128/144px) so Next serves a
        // poster sized for the slot rather than the shared grid default.
        sizes={"(max-width: 640px) 96px, (max-width: 768px) 112px, (max-width: 1024px) 128px, 144px"}
      />
      {showNewBadge && <CinemaNewBadge addedAt={item.addedAt} />}
    </button>
  );
}
