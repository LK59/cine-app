"use client";

import { useRef, type ReactNode, type RefObject } from "react";
import { useLiquidLens } from "@/lib/liquidGlass/useLiquidLens";

/**
 * La pilule de navigation du téléphone, à lentille (DECISIONS.md §45) — une seule pièce pour les
 * deux interfaces : la barre du bas du cinéma (`PlayerBottomBar`) et celle de la gestion
 * (`MobileNav`), depuis le 13/10/2026.
 *
 * La gestion avait sa propre pilule, recopiée de l'allure du cinéma (§81) : un fond de verre et un
 * onglet allumé, mais ni lentille qui glisse, ni geste, ni glisser d'un onglet à l'autre — deux
 * barres qui se ressemblaient et ne répondaient pas pareil sous le doigt. La matière (`nav-glass`),
 * la pastille (`nav-lens`) et le geste (`useLiquidLens`) vivent ici ; ce que fait un onglet — ouvrir
 * un panneau du cinéma, changer de page de la gestion, ouvrir la feuille « Plus » — reste à la barre
 * qui l'emploie.
 *
 * Les onglets sont les enfants, marqués `data-lens="<clé>"` : la lentille se pose sous celui dont la
 * clé est `active`, et un glisser qui finit sur un autre appelle `onDragSelect`. Les enfants sont une
 * fonction parce que la barre du cinéma a besoin de `moved` dans ses écouteurs (le second appui sur
 * Recherche ne lève pas le clavier après un glisser).
 */
export function LiquidNavPill({
  active,
  onDragSelect,
  compact,
  interactive = true,
  className = "",
  children,
}: {
  /** La clé (`data-lens`) de l'onglet ouvert, ou `null` : aucun, et la pastille s'efface. */
  active: string | null;
  /** Un glisser fini sur un autre onglet ; `navigatedOnDown` : l'appui avait déjà navigué. */
  onDragSelect: (key: string, navigatedOnDown: boolean) => void;
  /** Couché sur un écran court : la barre se resserre et les onglets perdent leurs mots. */
  compact: boolean;
  /** Visible mais pas encore touchable (la barre du cinéma pendant la sortie d'une fiche). */
  interactive?: boolean;
  className?: string;
  children: (lens: { moved: RefObject<boolean> }) => ReactNode;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLSpanElement>(null);
  const { moved } = useLiquidLens({ barRef, lensRef, active, relayout: compact, onDragSelect });

  return (
    <div
      ref={barRef}
      // Le verre liquide, et non plus le fond franc de `player-bar` : essayé sur la page « Tests
      // animations » au-dessus d'une liste qui défile, il est resté fluide sur iPhone — choisi le
      // 04/10/2026. `pan-y` : un défilement vertical commencé sur la barre fait toujours défiler la
      // page ; le glisser horizontal est à la lentille.
      data-liquid-nav
      className={`nav-glass relative ${interactive ? "pointer-events-auto" : "pointer-events-none"} flex items-center gap-1 rounded-full ${
        compact ? "px-1.5 py-1" : "px-2 py-1.5"
      }${className ? ` ${className}` : ""}`}
      style={{ touchAction: "pan-y" }}
    >
      <span ref={lensRef} className="nav-lens" aria-hidden />
      {children({ moved })}
    </div>
  );
}

/**
 * Les classes d'un onglet de la pilule.
 *
 * `player-tab` porte la transition des couleurs *et* du geste : la classe utilitaire de Tailwind ne
 * décrivait que la couleur, et les deux écriraient `transition`. Largeur fixe pour les quatre
 * onglets du cinéma ; à la mesure des mots (`fit`) pour les cinq de la gestion — « Téléchargements »
 * ne tient pas dans un cinquième de téléphone. La lentille prend la largeur de l'onglet, quelle
 * qu'elle soit.
 */
export function liquidTabClass({ compact, on, fit = false }: { compact: boolean; on: boolean; fit?: boolean }): string {
  const size = fit
    ? compact
      ? "h-11 min-w-12 shrink px-1.5 gap-0"
      : "h-14 min-w-12 shrink px-1.5 gap-0.5"
    : compact
      ? "h-11 w-14 gap-0"
      : "h-14 w-16 gap-0.5";
  return `player-tab relative flex flex-col items-center justify-center rounded-full ${size} ${on ? "text-white" : "text-subtle active:text-muted"}`;
}

/**
 * Le nom d'un onglet, sous son pictogramme.
 *
 * 10 px, à la taille des barres d'onglets du système : une ligne de plus coûterait sa place à la
 * barre (seule exception à la règle des 11 px, `design-tokens.test.ts`). Sur un écran court, le
 * nom n'est plus affiché mais reste dit : sans lui, le bouton n'avait aucun nom pour un lecteur
 * d'écran (relu le 24/09/2026). À la mesure des mots (`fit`), un nom trop long se coupe plutôt que
 * de passer à la ligne.
 */
export function LiquidTabLabel({ compact, on, fit = false, children }: { compact: boolean; on: boolean; fit?: boolean; children: ReactNode }) {
  return (
    <span className={compact ? "sr-only" : `${fit ? "max-w-full truncate whitespace-nowrap " : ""}text-[10px] ${on ? "font-semibold" : "font-medium"}`}>
      {children}
    </span>
  );
}
