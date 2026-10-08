"use client";

import { memo, useRef } from "react";
import { CinemaTop10Card } from "@/components/cinema/CinemaTop10Card";
import { CATALOGUE_FLIP, useFlipGrid } from "@/lib/useFlipGrid";
import { ROW_CONTAINMENT } from "@/lib/rowContainment";

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
//
// memo'd comme les autres rangées (08/10/2026) : sans lui, chaque survol et chaque tour de la
// bannière redessinaient ses dix cartes, dans les deux onglets gardés. `idOf` doit donc être
// stable — une fonction du module chez l'appelant, pas une flèche écrite en ligne.
function Top10Row<T extends Top10Item>({
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
  // Un classement qui change à l'arrivée des données fraîches : les affiches glissent à leur rang.
  const track = useRef<HTMLDivElement>(null);
  useFlipGrid(track, items.map((item) => String(idOf(item))), CATALOGUE_FLIP);
  if (items.length === 0) return null;

  return (
    // Mise en page sautée loin de l'écran — voir `ROW_CONTAINMENT`.
    <div data-tv-rowroot className="mb-6 animate-fade-in-up snap-start" style={{ ...ROW_CONTAINMENT, animationDelay: `${Math.min(rowIndex, 6) * 40}ms` }}>
      <h2 className="mb-2 px-8 text-sm font-medium text-muted sm:px-12">{label}</h2>
      <div ref={track} className="scrollbar-thin flex scroll-smooth items-end gap-3 overflow-x-auto overflow-y-hidden px-8 pb-4 pt-3 sm:px-12" style={EDGE_FADE}>
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

// `memo` efface le paramètre de type : la rangée est rendue avec des films et des séries.
export const CinemaTop10Row = memo(Top10Row) as typeof Top10Row;
