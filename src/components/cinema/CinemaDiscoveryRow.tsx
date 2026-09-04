"use client";

import { memo } from "react";
import { Plus } from "lucide-react";
import { PosterImage } from "@/components/PosterImage";
import type { DiscoveryItem } from "@/app/api/player/discover/route";

const TV_NAV_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-ink";

const EDGE_FADE = {
  maskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
  WebkitMaskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
};

/**
 * Une rangée de découverte : des titres qui viennent de TMDB, qu'on les possède ou non.
 *
 * Elle a la forme exacte des autres rangées — même carte, même largeur, mêmes attributs
 * `data-tv-*`, donc les flèches la traversent comme le reste. La seule différence visible est une
 * pastille sur ce qui n'est pas encore dans la bibliothèque : un seul catalogue, dont une partie
 * est immédiate.
 *
 * Elle ne pilote pas la bannière : un titre qu'on ne possède pas n'a ni logo, ni fond, ni durée à
 * y afficher. Le focus rend donc la main au carrousel, exactement comme la rangée « Reprendre »
 * le fait déjà pour une reprise qu'elle n'arrive pas à relier à la bibliothèque.
 */
export const CinemaDiscoveryRow = memo(function CinemaDiscoveryRow({
  label,
  rowKey,
  rowIndex = 0,
  items,
  cardWidthClassName,
  missingLabel,
  onFocusItem,
  onSelectItem,
}: {
  label: string;
  rowKey: string;
  rowIndex?: number;
  items: DiscoveryItem[];
  cardWidthClassName: string;
  missingLabel: string;
  onFocusItem: () => void;
  onSelectItem: (item: DiscoveryItem) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div
      data-tv-rowroot
      className="mb-6 animate-fade-in-up snap-start"
      style={{ animationDelay: `${Math.min(rowIndex, 6) * 40}ms` }}
    >
      <h2 className="mb-2 px-8 text-sm font-medium text-white/70 sm:px-12">{label}</h2>
      <div
        className="scrollbar-thin flex scroll-smooth gap-3 overflow-x-auto overflow-y-hidden px-8 pb-4 pt-3 sm:px-12"
        style={EDGE_FADE}
      >
        {items.map((item, i) => (
          <button
            key={`${item.type}-${item.tmdbId}`}
            type="button"
            data-tv-card
            data-tv-row={rowKey}
            data-tv-col={i}
            onFocus={onFocusItem}
            onMouseEnter={onFocusItem}
            onClick={() => onSelectItem(item)}
            title={item.title}
            className={`${cardWidthClassName} relative shrink-0 overflow-hidden rounded-lg shadow-lg shadow-black/40 transition duration-200 hover:z-10 hover:scale-105 hover:shadow-xl hover:shadow-black/60 focus-visible:z-10 focus-visible:scale-105 ${TV_NAV_RING}`}
          >
            <PosterImage
              src={item.poster}
              alt={item.title}
              subtle
              unoptimized
              sizes={"(max-width: 640px) 96px, (max-width: 768px) 112px, (max-width: 1024px) 128px, 144px"}
            />
            {item.libraryId === null && (
              <span
                aria-label={missingLabel}
                title={missingLabel}
                className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white/80 backdrop-blur-sm"
              >
                <Plus size={12} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
});
