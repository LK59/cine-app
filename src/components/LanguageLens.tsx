"use client";

import { useRef } from "react";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n";
import { useLiquidLens } from "@/lib/liquidGlass/useLiquidLens";
import { TOGGLE_SETTLE } from "@/lib/liquidGlass/liquid";

/**
 * Le choix de la langue des deux accueils — l'assistant de premier lancement et l'accueil d'un
 * compte (05/10/2026). Une pilule de verre liquide et sa lentille, celle de la bascule Films/Séries
 * (`useLiquidLens`, DECISIONS.md §45) : un appui choisit, un glisser promène la lentille et choisit
 * la langue où elle se pose. Un seul composant pour que les deux écrans proposent la même chose.
 *
 * Les libellés sont dans leur propre langue (`LOCALE_LABELS`), et non traduits : on choisit sa
 * langue avant de la lire.
 */
export function LanguageLens({
  value,
  onChange,
  disabled = false,
  label,
}: {
  value: Locale;
  onChange: (locale: Locale) => void;
  disabled?: boolean;
  label: string;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLSpanElement>(null);
  useLiquidLens({
    barRef,
    lensRef,
    active: value,
    onDragSelect: (key) => {
      if (!disabled) onChange(key as Locale);
    },
    settleSpring: TOGGLE_SETTLE,
  });
  return (
    <div
      ref={barRef}
      role="radiogroup"
      aria-label={label}
      className="nav-glass relative flex w-full max-w-sm items-center gap-0.5 rounded-full p-1"
      style={{ touchAction: "pan-y" }}
    >
      <span ref={lensRef} className="nav-lens" aria-hidden />
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={value === l}
          lang={l}
          data-lens={l}
          disabled={disabled}
          onClick={() => onChange(l)}
          className={`relative z-[1] min-w-0 flex-1 whitespace-nowrap rounded-full px-2 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
            value === l ? "text-white" : "text-muted hover:text-white"
          }`}
        >
          {LOCALE_LABELS[l]}
        </button>
      ))}
    </div>
  );
}
