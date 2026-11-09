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
/**
 * Après le focus, le temps laissé au clavier pour se faire mesurer avant de le supposer sans mesure
 * (téléphone seulement) ; et la durée pendant laquelle la vue est relue à chaque image, au cas où iOS
 * n'enverrait son `resize` qu'en retard, ou pas du tout.
 */
export const KEYBOARD_SETTLE_MS = 700;
export const KEYBOARD_POLL_MS = 1000;

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
  /**
   * La hauteur de la vue de mise en page (`innerHeight`). En application installée, iOS peut laisser la
   * fenêtre entière et ne réduire que la vue visuelle : le clavier est alors ce qui manque sous elle,
   * `innerHeight − hauteur − offsetTop`, même si la référence a été relevée trop tard.
   */
  layoutHeight?: number;
  /** Le zoom de la vue visuelle : un pincement réduit aussi la vue, et ce n'est pas un clavier. */
  scale?: number;
  /** Un téléphone tactile : un champ qui prend le focus y ouvre toujours un clavier d'écran. */
  touchPhone?: boolean;
  /** Le focus a moins de `KEYBOARD_SETTLE_MS` : un clavier pas encore mesuré n'est pas encore absent. */
  settling?: boolean;
  /** Le haut du calque du panneau dans la vue de mise en page (0 d'ordinaire). */
  layerTop?: number;
}

/**
 * La branche de la décision, dite au relevé `kind: "clavier"` : `vue` (la vue visuelle a rétréci depuis la
 * référence), `fenetre` (elle est plus courte que la fenêtre restée entière), `attente` (téléphone, focus
 * tout frais, rien de mesuré encore), `inconnu` (téléphone, rien de mesuré après l'attente : la ligne en
 * haut de l'écran, le seul endroit qu'aucun clavier ne couvre), `feuille`, `colonne`.
 */
export type AskLayoutBranch = "vue" | "fenetre" | "attente" | "inconnu" | "feuille" | "colonne";

export type AskPanelLayout =
  | { mode: "full"; top: number; height: number; sheet: boolean; branch: AskLayoutBranch }
  | { mode: "line"; top: number; branch: AskLayoutBranch; pending?: boolean; fromTop?: boolean };

/** Un téléphone tenu debout : le panneau devient une feuille posée en bas, pas une colonne à droite. */
export function isNarrowPortrait(width: number, height: number): boolean {
  return width < 600 && height > width;
}

/** Ce que le clavier cache, d'après ce qu'on sait — 0 si rien ne le montre. */
export function keyboardCover(f: ViewportFacts): { px: number; branch: "vue" | "fenetre" | null } {
  if (!f.focused) return { px: 0, branch: null };
  const shrink = f.baseline - f.height;
  if (shrink > KEYBOARD_MIN_PX) return { px: shrink, branch: "vue" };
  // Un pincement réduit la vue sans clavier : la fenêtre ne compte alors pas.
  const zoomed = (f.scale ?? 1) > 1.05;
  const under = f.layoutHeight !== undefined && !zoomed ? f.layoutHeight - f.height - f.offsetTop : 0;
  if (under > KEYBOARD_MIN_PX) return { px: under, branch: "fenetre" };
  return { px: 0, branch: null };
}

/** La place du panneau, en pixels depuis le haut de son calque (la vue de mise en page, d'ordinaire). */
export function askPanelLayout(f: ViewportFacts): AskPanelLayout {
  const shift = f.layerTop ?? 0;
  const keyboard = keyboardCover(f);
  if (keyboard.branch) {
    // Le bas de la ligne contre le haut du clavier : le bas de la vue visuelle, en coordonnées de mise en page.
    return { mode: "line", top: Math.max(f.offsetTop, f.offsetTop + f.height - LINE_HEIGHT_PX - LINE_GAP_PX) - shift, branch: keyboard.branch };
  }
  if (f.focused && f.touchPhone) {
    // Un téléphone dont le clavier ne se laisse pas mesurer (iOS en application installée n'envoie parfois
    // ni `resize` ni vue plus courte) : la ligne quand même, en haut de ce qu'on voit — jamais le panneau
    // entier, dont le champ finissait sous le clavier. Invisible le temps que le clavier se mesure.
    return { mode: "line", top: f.offsetTop + MARGIN_PX - shift, branch: f.settling ? "attente" : "inconnu", pending: f.settling === true, fromTop: true };
  }
  // La feuille du téléphone debout se décide sur la hauteur de référence : sans quoi un clavier pas encore
  // reconnu (les premières images) la ferait basculer d'une forme à l'autre.
  if (isNarrowPortrait(f.width, Math.max(f.height, f.baseline))) {
    const height = Math.round(f.height * 0.72);
    return { mode: "full", top: f.offsetTop + f.height - height - shift, height, sheet: true, branch: "feuille" };
  }
  return { mode: "full", top: f.offsetTop + MARGIN_PX - shift, height: Math.max(0, f.height - 2 * MARGIN_PX), sheet: false, branch: "colonne" };
}

/** Un téléphone tactile (un iPad garde son panneau entier : un clavier matériel n'y ouvre rien à l'écran). */
export function isTouchPhone(win: Window): boolean {
  try {
    const coarse = typeof win.matchMedia === "function" && win.matchMedia("(pointer: coarse)").matches;
    return coarse && Math.min(win.screen.width, win.screen.height) < 600;
  } catch {
    return false;
  }
}

type Measured = Omit<ViewportFacts, "baseline" | "focused" | "touchPhone" | "settling">;

function read(win: Window, layer: HTMLElement | null): Measured {
  const vv = win.visualViewport;
  let layerTop = 0;
  try {
    layerTop = layer ? Math.round(layer.getBoundingClientRect().top) : 0;
  } catch {
    layerTop = 0;
  }
  const base = vv
    ? { height: vv.height, offsetTop: vv.offsetTop, width: vv.width, scale: vv.scale ?? 1 }
    : { height: win.innerHeight, offsetTop: 0, width: win.innerWidth, scale: 1 };
  return { ...base, layoutHeight: win.innerHeight, layerTop };
}

const sameFacts = (a: Omit<ViewportFacts, "focused">, b: Omit<ViewportFacts, "focused">) =>
  a.height === b.height &&
  a.offsetTop === b.offsetTop &&
  a.width === b.width &&
  a.baseline === b.baseline &&
  a.layoutHeight === b.layoutHeight &&
  a.scale === b.scale &&
  a.layerTop === b.layerTop &&
  a.touchPhone === b.touchPhone;

/**
 * La place du panneau, suivie : `resize` et `scroll` de la vue visuelle (le clavier, le glissé d'iOS),
 * `resize` de la fenêtre (rotation), et, le premier instant du focus, une relecture à chaque image —
 * iOS envoie parfois son `resize` en retard, ou pas du tout. La référence suit la vue tant que le champ
 * n'a pas le focus.
 */
export function useAskPanelLayout(focused: boolean, layerRef?: { current: HTMLElement | null }): { layout: AskPanelLayout; facts: ViewportFacts } {
  const [facts, setFacts] = useState<Omit<ViewportFacts, "focused">>(() => {
    if (typeof window === "undefined") return { height: 800, offsetTop: 0, width: 1200, baseline: 800 };
    const now = read(window, null);
    return { ...now, baseline: now.height, touchPhone: isTouchPhone(window) };
  });
  // L'attente du clavier, remise à chaque prise de focus pendant le rendu (pas une image plus tard : la
  // première image du focus montrerait sinon la ligne en haut, avant de la cacher).
  const [settle, setSettle] = useState({ focused, over: !focused });
  if (settle.focused !== focused) setSettle({ focused, over: !focused });
  useEffect(() => {
    const win = window;
    const focusAt = focused ? Date.now() : 0;
    const update = () =>
      setFacts((prev) => {
        const now = read(win, layerRef?.current ?? null);
        // Sans focus, la vue visuelle est la référence ; une rotation la remet à jour d'elle-même.
        const baseline = focused ? prev.baseline : now.height;
        const next = { ...now, baseline, touchPhone: prev.touchPhone };
        return sameFacts(prev, next) ? prev : next;
      });
    // Relu une image plus tard plutôt que dans le corps de l'effet : le focus vient de changer. Puis, champ
    // actif, à chaque image pendant une seconde, et une dernière fois l'attente finie.
    let frame = win.requestAnimationFrame(function tick() {
      update();
      frame = focused && Date.now() - focusAt < KEYBOARD_POLL_MS ? win.requestAnimationFrame(tick) : 0;
    });
    const settled = focused
      ? win.setTimeout(() => {
          setSettle((prev) => (prev.focused && !prev.over ? { focused: true, over: true } : prev));
          update();
        }, KEYBOARD_SETTLE_MS)
      : undefined;
    const vv = win.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    win.addEventListener("resize", update);
    return () => {
      if (frame) win.cancelAnimationFrame(frame);
      if (settled !== undefined) win.clearTimeout(settled);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      win.removeEventListener("resize", update);
    };
  }, [focused, layerRef]);
  const all = { ...facts, focused, settling: focused && !settle.over };
  return { layout: askPanelLayout(all), facts: all };
}

/**
 * Le relevé du clavier (`kind: "clavier"` dans `startup.log`, 09/11/2026) — l'iPhone du propriétaire, en
 * application installée : couché, le clavier couvrait le champ ; debout, le panneau ne s'était pas réduit du
 * tout. Rien ne disait si le focus arrivait, si la vue visuelle bougeait, ni quelle branche avait décidé.
 * Une ligne au focus, une 600 ms plus tard, une à chaque `resize` de la vue champ actif — six par ouverture
 * du panneau au plus —, sur les écrans tactiles seulement. Même chemin que `kind: "hauteur"`.
 */
export const KEYBOARD_DIAG_MAX = 6;

export function keyboardSnapshot(
  win: Window,
  els: { panel: HTMLElement | null; input: HTMLElement | null; layer: HTMLElement | null },
  state: { trigger: string; layout: AskPanelLayout; facts: ViewportFacts; where: string; placement: string; events: Record<string, number> },
): Record<string, unknown> {
  const vv = win.visualViewport;
  const rect = (el: HTMLElement | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
  };
  let standalone = false;
  try {
    standalone =
      (win.navigator as Navigator & { standalone?: boolean }).standalone === true ||
      (typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches);
  } catch {
    standalone = false;
  }
  let orientation: string | null = null;
  try {
    orientation = win.screen.orientation?.type ?? (win.innerWidth > win.innerHeight ? "landscape" : "portrait");
  } catch {
    orientation = null;
  }
  return {
    kind: "clavier",
    trigger: state.trigger,
    branch: state.layout.branch,
    mode: state.layout.mode,
    where: state.where,
    placement: state.placement,
    focusedState: state.facts.focused,
    active: !!els.input && win.document.activeElement === els.input,
    inner: win.innerHeight,
    outer: win.outerHeight,
    innerW: win.innerWidth,
    client: win.document.documentElement.clientHeight,
    vv: vv ? Math.round(vv.height) : null,
    vvTop: vv ? Math.round(vv.offsetTop) : null,
    vvPageTop: vv ? Math.round(vv.pageTop) : null,
    vvScale: vv ? Math.round(vv.scale * 100) / 100 : null,
    baseline: Math.round(state.facts.baseline),
    scrollY: Math.round(win.scrollY),
    screenW: win.screen.width,
    screenH: win.screen.height,
    orientation,
    standalone,
    touchPhone: state.facts.touchPhone === true,
    layerTop: rect(els.layer)?.top ?? null,
    panelTop: rect(els.panel)?.top ?? null,
    panelBottom: rect(els.panel)?.bottom ?? null,
    inputTop: rect(els.input)?.top ?? null,
    inputBottom: rect(els.input)?.bottom ?? null,
    events: state.events,
  };
}

export function sendKeyboardDiag(snapshot: Record<string, unknown>, build: { build: string; version: string }): void {
  try {
    void fetch("/api/viewport-diag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...snapshot, ...build }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* un relevé perdu ne coûte rien */
  }
}

/**
 * Rien derrière le panneau ne défile ni ne saute : iOS fait glisser la page vers un champ qui prend le
 * focus, et la laisse parfois décalée une fois le clavier refermé. La position de la page est relevée à
 * l'ouverture et remise après chaque perte de focus (le clavier a fini de partir), et au départ du panneau.
 */
export function restorePageScroll(win: Window, at: { x: number; y: number }): void {
  if (win.scrollX !== at.x || win.scrollY !== at.y) win.scrollTo(at.x, at.y);
}
