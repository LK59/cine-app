"use client";

import { useRef, type CSSProperties } from "react";
import { useT } from "@/components/TranslationProvider";
import { useLiquidLens } from "@/lib/liquidGlass/useLiquidLens";

const TV_NAV_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-black/40";

// Netflix's own "TV Shows / Movies" segmented switch — top center. It sits outside the poster
// grid entirely, so it isn't one of useTvGridNav's data-tv-card cells; instead the active segment
// marks itself data-tv-escape-up so pressing Up from the grid's very first row hands focus here
// (see useTvGridNav.ts), and Left/Right below cycle the two segments the same way the grid's own
// rows do, so once you've arrowed up you can flip tabs without reaching for Tab/mouse.
//
// La même bascule sur le téléphone, dans la barre du haut (`placement="inline"`) : une seule pièce
// pour une seule décision. En verre liquide, avec une lentille blanche qui glisse d'un onglet à
// l'autre et suit le doigt (`useLiquidLens`, DECISIONS.md §45). Elle change d'onglet tout de suite ;
// le contenu du nouvel onglet suit en arrière-plan (voir `useDeferredValue` chez les appelants).
export function CinemaModeToggle({
  mode,
  onChange,
  placement = "floating",
}: {
  mode: "movies" | "series";
  onChange: (mode: "movies" | "series") => void;
  /** `floating` : posée en haut au centre (bureau) ; `inline` : dans une barre (téléphone). */
  placement?: "floating" | "inline";
}) {
  const t = useT();
  const moviesRef = useRef<HTMLButtonElement>(null);
  const seriesRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLSpanElement>(null);
  useLiquidLens({ barRef, lensRef, active: mode, onDragSelect: (key) => onChange(key as "movies" | "series") });

  // Switching segments only updated `mode` — the DOM focus itself stayed put on whichever
  // <button> the keypress originated from, which is a plain React prop change, not something
  // that moves browser focus on its own. That left focus visually stranded on the now-INACTIVE
  // segment (nothing here had a focus ring either, so a keyboard/remote user had no cue focus
  // hadn't actually followed the selection change). Explicitly refocusing the segment that just
  // became active keeps focus visibly attached to the current selection, the same as any other
  // roving-focus control in this app.
  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = mode === "movies" ? "series" : "movies";
      onChange(next);
      (next === "movies" ? moviesRef : seriesRef).current?.focus();
    }
  }

  const floating = placement === "floating";
  const style: CSSProperties | undefined = floating
    ? // Centré sur le contenu, pas sur la fenêtre : le rail du lecteur occupe la bande de gauche,
      // et un `left-1/2` nu laissait la bascule décalée d'une demi-largeur de rail vers la gauche.
      // La variable vaut 0 partout ailleurs, donc rien ne bouge hors du lecteur.
      { top: "max(1rem, env(safe-area-inset-top))", left: "calc(50% + var(--player-rail, 0px) / 2)", touchAction: "pan-y" }
    : { touchAction: "pan-y" };
  return (
    <div
      ref={barRef}
      className={`${floating ? "fixed top-4 z-10 -translate-x-1/2 gap-1 p-1" : "relative justify-self-center gap-0.5 p-0.5"} nav-glass flex items-center rounded-full`}
      style={style}
    >
      <span ref={lensRef} className="nav-lens nav-lens-solid" aria-hidden />
      <button
        ref={moviesRef}
        onClick={() => onChange("movies")}
        data-lens="movies"
        onKeyDown={onKeyDown}
        data-tv-escape-up={mode === "movies" ? "true" : undefined}
        className={`relative z-[1] rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${TV_NAV_RING} ${
          mode === "movies" ? "text-ink" : "text-muted hover:text-white"
        }`}
      >
        {t("cinema.moviesTab")}
      </button>
      <button
        ref={seriesRef}
        onClick={() => onChange("series")}
        data-lens="series"
        onKeyDown={onKeyDown}
        data-tv-escape-up={mode === "series" ? "true" : undefined}
        className={`relative z-[1] rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${TV_NAV_RING} ${
          mode === "series" ? "text-ink" : "text-muted hover:text-white"
        }`}
      >
        {t("cinema.seriesTab")}
      </button>
    </div>
  );
}
