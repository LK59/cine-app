"use client";

import { PosterImage } from "@/components/PosterImage";
import { CinemaNewBadge } from "@/components/cinema/CinemaNewBadge";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const TV_NAV_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-ink";

// Series-typed mirror of CinemaCard — see its own doc comment for the reasoning (deliberately
// not PosterCard, data-tv-* grid convention, onSelectItem escalates to the detail overlay). Kept
// as a literal duplicate rather than a generic <T> component: the two item shapes (CinemaMovie
// vs CinemaSeries) already diverge (sonarrId vs radarrId, etc.) and are likely to diverge more
// once series grow their own fields, so a shared generic would just be an abstraction fighting
// two different futures.
export function CinemaSeriesCard({
  item,
  index,
  rowKey,
  widthClassName,
  onFocusItem,
  onSelectItem,
  showNewBadge = true,
}: {
  item: CinemaSeries;
  index: number;
  rowKey: string;
  widthClassName: string;
  onFocusItem: (item: CinemaSeries) => void;
  onSelectItem: (item: CinemaSeries) => void;
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
