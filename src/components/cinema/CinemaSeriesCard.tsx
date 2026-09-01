"use client";

import { PosterImage } from "@/components/PosterImage";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const TV_NAV_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950";

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
}: {
  item: CinemaSeries;
  index: number;
  rowKey: string;
  widthClassName: string;
  onFocusItem: (item: CinemaSeries) => void;
  onSelectItem: (item: CinemaSeries) => void;
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
      <PosterImage src={item.posterUrl} alt={item.title} />
    </button>
  );
}
