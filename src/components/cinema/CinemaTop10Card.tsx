"use client";

import { PosterImage } from "@/components/PosterImage";
import { CinemaNewBadge } from "@/components/cinema/CinemaNewBadge";

const TV_NAV_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-ink";

// One entry of the numbered Top 10 rail: an oversized outlined rank digit with the poster tucked
// against it, which is the single most recognizable shape on a Netflix home screen.
//
// A card, not a whole row — the desktop and mobile clients each wrap it in their own row shell
// (they differ in padding, entrance animation and scroll-snap), while the card itself, the part
// that has to look identical in both, lives here once.
//
// The digit is styled inline rather than with Tailwind: the font-size, line-height and text
// stroke it needs are all arbitrary values, and this project's production CSS bundle drops
// arbitrary-value classes.
export function CinemaTop10Card({
  rank,
  title,
  posterUrl,
  addedAt,
  widthClassName,
  numberFontSize,
  rowKey,
  index,
  showNewBadge = true,
  onFocusItem,
  onSelectItem,
}: {
  rank: number;
  title: string;
  posterUrl: string | null;
  addedAt: string | null;
  widthClassName: string;
  numberFontSize: string;
  // Desktop only — wires the card into useTvGridNav's arrow-key navigation. Omitted on mobile,
  // which has no keyboard to navigate with.
  rowKey?: string;
  index?: number;
  // Off on rails that are themselves "what's new" — see CinemaNewBadge's own note.
  showNewBadge?: boolean;
  onFocusItem?: () => void;
  onSelectItem: () => void;
}) {
  return (
    <button
      type="button"
      {...(rowKey ? { "data-tv-card": true, "data-tv-row": rowKey, "data-tv-col": index } : {})}
      onFocus={onFocusItem}
      onMouseEnter={onFocusItem}
      onClick={onSelectItem}
      aria-label={`${rank}. ${title}`}
      className={`flex shrink-0 items-end transition duration-200 hover:z-10 hover:scale-105 focus-visible:z-10 focus-visible:scale-105 ${TV_NAV_RING}`}
    >
      {/* The digit sizes its own box. A fixed-width slot was tried and reverted: right-aligning
          the glyph in it pulled every number tight against its poster, which read as cramped. */}
      <span
        aria-hidden
        className="shrink-0 select-none font-black leading-none text-ink"
        style={{
          fontSize: numberFontSize,
          // 1, not a tighter value: the row clips its own vertical overflow (it has to, or a
          // focus-scaled poster spills out of it), and a line box shorter than the glyph let the
          // digits hang below it and get their feet cut off — which is what made the 4 in
          // particular look broken.
          lineHeight: 1,
          // Hollow numeral — the fill matches the page so only the outline reads, exactly like
          // Netflix's. A solid digit at this size would fight the poster next to it.
          WebkitTextStroke: "2px rgba(255,255,255,0.45)",
        }}
      >
        {rank}
      </span>
      <div className={`${widthClassName} relative -ml-3 overflow-hidden rounded-lg shadow-lg shadow-black/40`}>
        <PosterImage src={posterUrl} alt={title} subtle unoptimized sizes="150px" />
        {showNewBadge && <CinemaNewBadge addedAt={addedAt} />}
      </div>
    </button>
  );
}
