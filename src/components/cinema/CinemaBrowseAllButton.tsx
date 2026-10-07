"use client";

import { LayoutGrid } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { BROWSE_ALL } from "@/lib/cinemaBrowse";

/**
 * « Tous les films » / « Toutes les séries » en tête de l'accueil (DECISIONS.md §52) — pour une
 * installation qui veut le catalogue entier à un geste, et non au bout des rangées. Celui de
 * l'onglet affiché : la grille complète suit l'onglet (`route.tab`).
 *
 * Dans le verre de la bascule voisine. Au bureau, une pilule avec son nom ; sur téléphone, où la
 * barre n'a de place que pour des ronds, l'icône seule, nommée pour les lecteurs d'écran.
 */
export function CinemaBrowseAllButton({ mediaType, compact = false }: { mediaType: "movies" | "series"; compact?: boolean }) {
  const t = useT();
  const label = t(`player.browse.all.${mediaType}`);
  return (
    <button
      type="button"
      onClick={() => cinemaNavigate({ browse: BROWSE_ALL })}
      aria-label={label}
      title={label}
      data-liquid
      className={`nav-glass flex shrink-0 items-center justify-center rounded-full text-white ${compact ? "h-9 w-9" : "h-[2.375rem] gap-2 px-4 text-sm font-medium"}`}
    >
      <LayoutGrid size={compact ? 17 : 16} aria-hidden />
      {!compact && <span>{label}</span>}
    </button>
  );
}
