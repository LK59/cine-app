"use client";

import { useEffect, useState } from "react";

/**
 * Le panneau « Poser une question » et le clavier de l'écran (DECISIONS.md §139).
 *
 * Le cas difficile est l'iPhone couché : ~390 px de haut, et un clavier qui en prend plus de la moitié.
 * Le panneau entier n'y tient pas au-dessus du clavier. Donc :
 * - **sans clavier**, le panneau a toute la hauteur visible (à droite ; en bas sur un téléphone debout) ;
 * - **pendant la frappe**, il se réduit à une seule ligne — le champ —, posée juste au-dessus du clavier,
 *   le film visible au-dessus ;
 * - à l'envoi, le champ perd le focus, le clavier se referme, la réponse arrive dans le panneau entier.
 *
 * Tout se place d'après la **vue visuelle** (`visualViewport` : hauteur et décalage), jamais d'après
 * `100vh` ni la hauteur de la fenêtre : iOS 26 laisse parfois la fenêtre à la hauteur du clavier après un
 * clavier ouvert ailleurs (`viewportWatch.ts`), et iOS décale la vue visuelle (`offsetTop`) quand il fait
 * glisser la page vers un champ. Le clavier se reconnaît à la vue visuelle qui rétrécit pendant que le
 * champ a le focus, comparée à la hauteur relevée sans focus (`baseline`) — pas à la fenêtre, qui ne
 * bouge pas sur iOS et peut être déjà fausse.
 */

/** Ce que doit perdre la vue visuelle, champ actif, pour qu'on parle de clavier (une barre d'outils n'y suffit pas). */
export const KEYBOARD_MIN_PX = 120;
/** La hauteur de la ligne réduite (champ et bouton) et son écart au clavier. */
export const LINE_HEIGHT_PX = 56;
const LINE_GAP_PX = 8;
const MARGIN_PX = 12;

export interface ViewportFacts {
  /** La hauteur de la vue visuelle. */
  height: number;
  /** Son décalage dans la vue de mise en page (iOS fait glisser la page vers le champ). */
  offsetTop: number;
  /** La largeur de la vue visuelle. */
  width: number;
  /** La hauteur relevée sans focus dans le champ — la référence pour reconnaître le clavier. */
  baseline: number;
  /** Le champ a le focus. */
  focused: boolean;
}

export type AskPanelLayout =
  | { mode: "full"; top: number; height: number; sheet: boolean }
  | { mode: "line"; top: number };

/** Un téléphone tenu debout : le panneau devient une feuille posée en bas, pas une colonne à droite. */
export function isNarrowPortrait(width: number, height: number): boolean {
  return width < 600 && height > width;
}

/** La place du panneau, en pixels depuis le haut de la vue de mise en page. */
export function askPanelLayout(f: ViewportFacts): AskPanelLayout {
  const keyboard = f.focused && f.baseline - f.height > KEYBOARD_MIN_PX;
  if (keyboard) return { mode: "line", top: Math.max(f.offsetTop, f.offsetTop + f.height - LINE_HEIGHT_PX - LINE_GAP_PX) };
  // La feuille du téléphone debout se décide sur la hauteur de référence : sans quoi un clavier pas encore
  // reconnu (les premières images) la ferait basculer d'une forme à l'autre.
  if (isNarrowPortrait(f.width, Math.max(f.height, f.baseline))) {
    const height = Math.round(f.height * 0.72);
    return { mode: "full", top: f.offsetTop + f.height - height, height, sheet: true };
  }
  return { mode: "full", top: f.offsetTop + MARGIN_PX, height: Math.max(0, f.height - 2 * MARGIN_PX), sheet: false };
}

function read(win: Window): Omit<ViewportFacts, "baseline" | "focused"> {
  const vv = win.visualViewport;
  return vv
    ? { height: vv.height, offsetTop: vv.offsetTop, width: vv.width }
    : { height: win.innerHeight, offsetTop: 0, width: win.innerWidth };
}

/**
 * La place du panneau, suivie : `resize` et `scroll` de la vue visuelle (le clavier, le glissé d'iOS),
 * plus `resize` de la fenêtre (rotation). La référence suit la vue tant que le champ n'a pas le focus.
 */
export function useAskPanelLayout(focused: boolean): AskPanelLayout {
  const [facts, setFacts] = useState<Omit<ViewportFacts, "focused">>(() => {
    if (typeof window === "undefined") return { height: 800, offsetTop: 0, width: 1200, baseline: 800 };
    const now = read(window);
    return { ...now, baseline: now.height };
  });
  useEffect(() => {
    const win = window;
    const update = () =>
      setFacts((prev) => {
        const now = read(win);
        // Sans focus, la vue visuelle est la référence ; une rotation la remet à jour d'elle-même.
        const baseline = focused ? prev.baseline : now.height;
        if (prev.height === now.height && prev.offsetTop === now.offsetTop && prev.width === now.width && prev.baseline === baseline) return prev;
        return { ...now, baseline };
      });
    // Relu une image plus tard plutôt que dans le corps de l'effet : le focus vient de changer.
    const frame = win.requestAnimationFrame(update);
    const vv = win.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    win.addEventListener("resize", update);
    return () => {
      win.cancelAnimationFrame(frame);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      win.removeEventListener("resize", update);
    };
  }, [focused]);
  return askPanelLayout({ ...facts, focused });
}

/**
 * Rien derrière le panneau ne défile ni ne saute : iOS fait glisser la page vers un champ qui prend le
 * focus, et la laisse parfois décalée une fois le clavier refermé. La position de la page est relevée à
 * l'ouverture et remise après chaque perte de focus (le clavier a fini de partir), et au départ du panneau.
 */
export function restorePageScroll(win: Window, at: { x: number; y: number }): void {
  if (win.scrollX !== at.x || win.scrollY !== at.y) win.scrollTo(at.x, at.y);
}
