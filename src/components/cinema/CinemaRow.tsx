"use client";

import { CinemaCard } from "@/components/cinema/CinemaCard";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

export function CinemaRow({
  label,
  rowKey,
  items,
  onFocusItem,
  onSelectItem,
}: {
  label: string;
  rowKey: string;
  items: CinemaMovie[];
  onFocusItem: (item: CinemaMovie) => void;
  onSelectItem: (item: CinemaMovie) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="mb-8">
      <h2 className="mb-3 px-8 text-lg font-semibold text-white sm:px-12">{label}</h2>
      <div className="scrollbar-thin flex gap-3 overflow-x-auto px-8 pb-4 sm:px-12">
        {items.map((item, i) => (
          <CinemaCard
            key={item.radarrId}
            item={item}
            index={i}
            rowKey={rowKey}
            onFocusItem={onFocusItem}
            onSelectItem={onSelectItem}
          />
        ))}
      </div>
    </div>
  );
}
