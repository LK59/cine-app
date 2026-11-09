"use client";

import { useEffect, useState, type RefObject } from "react";
import { onScreenRowBottom, onScreenRowWidth } from "@/lib/xray/client";

/**
 * Où se pose « À l'écran » (DECISIONS.md §138, 10.27) — mesuré, pas supposé. L'iPhone couché du
 * propriétaire : la rangée, posée à une hauteur fixe (`PROMPT_BOTTOM`), passait sous −10 / lecture / +10.
 *
 * - **le bas** : juste au-dessus du bloc du titre (`titleRow`, la rangée titre + réglages), quelle que
 *   soit sa hauteur (un logo, un titre sur deux lignes) — `onScreenRowBottom` ;
 * - **la largeur** (10.27.1) : aussi loin que possible à droite — 16 px avant les boutons du centre
 *   seulement s'ils chevauchent la hauteur de la ligne des pilules, sinon 16 px avant la pilule des
 *   outils si elle la chevauche, sinon jusqu'au bord sûr — `onScreenRowWidth`.
 *
 * Relu à chaque changement de taille de la fenêtre, de la vue visuelle, d'une rotation, et de la taille
 * des commandes, du bloc du titre, du groupe du centre et de la pilule des outils (`ResizeObserver`),
 * toujours dans une image (`requestAnimationFrame`), jamais dans le corps d'un effet. Groupe du centre
 * absent (une attente qui montre la roue) : la dernière largeur reste.
 */
export function useOnScreenPlacement(
  refs: {
    wrap: RefObject<HTMLElement | null>;
    center: RefObject<HTMLElement | null>;
    titleRow: RefObject<HTMLElement | null>;
    tools?: RefObject<HTMLElement | null>;
  },
  active: boolean
): { bottom: number | null; maxWidth: number | null } {
  const [placed, setPlaced] = useState<{ bottom: number | null; maxWidth: number | null }>({ bottom: null, maxWidth: null });
  const { wrap, center, titleRow, tools } = refs;
  useEffect(() => {
    if (!active) return;
    const win = window;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = wrap.current;
      const chrome = box?.parentElement;
      const title = titleRow.current;
      if (!box || !chrome || !title) return;
      const chromeRect = chrome.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const bottom = titleRect.height > 0 || titleRect.top > 0 ? onScreenRowBottom(chromeRect, titleRect) : null;
      // La ligne des pilules (et du bouton rond), pas l'étiquette : c'est elle qui s'étend vers la droite.
      const row = (box.querySelector("[data-onscreen-line]") as HTMLElement | null) ?? (box.querySelector("[data-player-onscreen]") as HTMLElement | null) ?? box;
      const rowRect = row.getBoundingClientRect();
      const whole = (box.querySelector("[data-player-onscreen]") as HTMLElement | null)?.getBoundingClientRect();
      const height = rowRect.height || 44;
      // Posée par son bas : la ligne des pilules est le bas de la rangée.
      const rowBottom = bottom === null ? (whole?.bottom ?? rowRect.bottom) : chromeRect.bottom - bottom;
      const centerRect = center.current?.getBoundingClientRect();
      // Un groupe absent ou pas encore posé (aucune taille) ne dit rien : la dernière largeur reste.
      const measured = centerRect && centerRect.width > 0 ? centerRect : null;
      const toolsRect = tools?.current?.getBoundingClientRect();
      setPlaced((prev) => {
        const maxWidth = measured
          ? onScreenRowWidth(
              { left: rowRect.left, right: rowRect.right, top: rowBottom - height, bottom: rowBottom },
              { center: measured, tools: toolsRect && toolsRect.width > 0 ? toolsRect : null }
            )
          : prev.maxWidth;
        return prev.bottom === bottom && prev.maxWidth === maxWidth ? prev : { bottom, maxWidth };
      });
    };
    const schedule = () => {
      if (!frame) frame = win.requestAnimationFrame(measure);
    };
    schedule();
    const vv = win.visualViewport;
    win.addEventListener("resize", schedule);
    win.addEventListener("orientationchange", schedule);
    vv?.addEventListener("resize", schedule);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      for (const el of [wrap.current?.parentElement, titleRow.current, center.current, tools?.current]) if (el) observer.observe(el);
    }
    return () => {
      if (frame) win.cancelAnimationFrame(frame);
      win.removeEventListener("resize", schedule);
      win.removeEventListener("orientationchange", schedule);
      vv?.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [active, wrap, center, titleRow, tools]);
  return active ? placed : { bottom: null, maxWidth: null };
}
