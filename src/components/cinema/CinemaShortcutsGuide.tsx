"use client";

import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, CornerDownLeft, Undo2 } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

// TV-remote-style legend, browse screen only — CinemaMovieDetail intentionally shows nothing
// but its own backdrop/menu (see its doc comment), so this never renders there. Purely
// informational, never focusable/interactive itself.
export function CinemaShortcutsGuide() {
  const t = useT();

  return (
    <div
      className="fixed right-4 z-10 flex items-center gap-3 rounded-full bg-black/40 px-4 py-2 text-xs text-white/70 backdrop-blur-xs"
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
