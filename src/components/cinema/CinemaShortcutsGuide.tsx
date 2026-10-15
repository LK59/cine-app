"use client";

import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, CornerDownLeft, Undo2 } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { useIsTouch } from "@/lib/useIsMobile";
import { isFireTv } from "@/lib/fireTv";

// TV-remote-style legend, browse screen only — CinemaMovieDetail intentionally shows nothing
// but its own backdrop/menu (see its doc comment), so this never renders there. Purely
// informational, never focusable/interactive itself.
/** Le bouton « Tous les films » occupe toujours le coin (13/10/2026) — la légende se range à sa gauche. */
export function CinemaShortcutsGuide() {
  const t = useT();
  // Pas sur un appareil qu'on touche (15/10/2026, MOBILE-10) : sur un iPad en portrait (834 px, donc
  // au-delà de `md`), la légende recouvrait la moitié droite de la bascule Films/Séries — « Séries »
  // ne répondait plus au doigt. Et des flèches et une touche Entrée n'y décrivent rien. La Fire TV
  // garde la sienne : c'est sa télécommande qu'elle documente, quoi que Silk dise de son pointeur.
  const touch = useIsTouch();
  if (touch && !isFireTv()) return null;

  return (
    <div
      // hidden below md: this legend is ~330px of chrome pinned right, and the Films/Séries
      // toggle is centred at the same height — on a narrow window the two collide. The shortcuts
      // it documents are the arrow keys, which anyone on a window that small is least likely to
      // be driving the screen with anyway.
      // Le coin haut-droit est de nouveau libre : la loupe qui l'occupait a rejoint le rail, à
      // gauche, avec le reste de la navigation.
      // `pointer-events-none` : purement informative, elle ne prend jamais un clic à ce qu'elle
      // chevaucherait encore (une fenêtre étroite de portable tactile, par exemple).
      className="pointer-events-none fixed right-16 z-10 hidden items-center gap-3 rounded-full px-4 py-2 text-xs text-muted player-bar md:flex"
      style={{ top: "max(1rem, env(safe-area-inset-top))" }}
    >
      <span className="flex items-center gap-1">
        <ArrowUp size={12} />
        <ArrowDown size={12} />
        <ArrowLeft size={12} />
        <ArrowRight size={12} />
        {t("cinema.shortcutsNavigate")}
      </span>
      <span className="flex items-center gap-1">
        <CornerDownLeft size={12} />
        {t("cinema.shortcutsSelect")}
      </span>
      <span className="flex items-center gap-1">
        <Undo2 size={12} />
        {t("cinema.back")}
      </span>
    </div>
  );
}
