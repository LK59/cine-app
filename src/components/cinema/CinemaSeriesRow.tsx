"use client";

import { memo, useRef } from "react";
import { useT } from "@/components/TranslationProvider";
import { CATALOGUE_FLIP, useFlipGrid } from "@/lib/useFlipGrid";
import { CinemaSeriesCard } from "@/components/cinema/CinemaSeriesCard";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

// Series-typed mirror of CinemaRow — see its own doc comment (edge fade mask, staggered entrance
// capped at 6 rows).
const EDGE_FADE = {
  maskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
  WebkitMaskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
};

// memo'd for the same reason CinemaRow is — see its own note.
export const CinemaSeriesRow = memo(function CinemaSeriesRow({
  label,
  rowKey,
  rowIndex = 0,
  items,
  cardWidthClassName,
  onFocusItem,
  onSelectItem,
  onSeeAll,
  seeAllKey,
  showNewBadge = true,
}: {
  label: string;
  rowKey: string;
  rowIndex?: number;
  items: CinemaSeries[];
  cardWidthClassName: string;
  showNewBadge?: boolean;
  onFocusItem: (item: CinemaSeries) => void;
  onSelectItem: (item: CinemaSeries) => void;
  /** Ouvre la grille complète de cette rangée, avec ses tris et ses filtres. */
  /**
   * « Voir tout », appelé avec `seeAllKey`. Une fonction stable et une clé plutôt qu'une fonction
   * écrite en ligne par l'appelant : neuve à chaque rendu, elle défaisait le `memo` de la rangée —
   * chaque flèche redessinait vingt rangées et leurs cartes (23/09/2026).
   */
  onSeeAll?: (key: string) => void;
  seeAllKey?: string;
}) {
  const t = useT();
  // Comme CinemaRow : les affiches glissent quand les données fraîches arrivent.
  const track = useRef<HTMLDivElement>(null);
  useFlipGrid(track, items.map((item) => String(item.sonarrId)), CATALOGUE_FLIP);
  if (items.length === 0) return null;

  return (
    <div data-tv-rowroot className="mb-6 animate-fade-in-up snap-start" style={{ animationDelay: `${Math.min(rowIndex, 6) * 40}ms` }}>
      {/* « Voir tout » vit à côté du titre : sur une rangée, tout ce qui est au bout du
          défilement demande de faire défiler pour être découvert. */}
      <div className="mb-2 flex items-baseline justify-between gap-4 px-8 sm:px-12">
        <h2 className="min-w-0 truncate text-sm font-medium text-muted">{label}</h2>
        {onSeeAll && (
          <button
            type="button"
            onClick={() => onSeeAll(seeAllKey ?? "")}
            className="shrink-0 text-xs font-medium text-subtle transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            {t("player.browse.seeAll")}
          </button>
        )}
      </div>
      <div ref={track} className="scrollbar-thin flex scroll-smooth gap-3 overflow-x-auto overflow-y-hidden px-8 pb-4 pt-3 sm:px-12" style={EDGE_FADE}>
        {items.map((item, i) => (
          <CinemaSeriesCard
            key={item.sonarrId}
            item={item}
            index={i}
            rowKey={rowKey}
            widthClassName={cardWidthClassName}
            showNewBadge={showNewBadge}
            onFocusItem={onFocusItem}
            onSelectItem={onSelectItem}
          />
        ))}
      </div>
    </div>
  );
});
