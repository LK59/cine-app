import type { CSSProperties } from "react";
import type { Box, MotionProfile } from "./motion";

/**
 * Les outils DOM du mouvement des fiches (DECISIONS.md §61), communs aux vraies fiches
 * (`useSheetMorph`) et à la maquette du banc. Lectures groupées avant un départ, écritures après :
 * rien ici ne doit s'exécuter pendant un trajet.
 */

/** L'horloge des animations — celle que `startTime` attend. */
export function clockNow(): number {
  const c = typeof document !== "undefined" ? document.timeline?.currentTime : null;
  return typeof c === "number" ? c : performance.now();
}

/**
 * Au plus tard ceci, quoi que fasse `requestAnimationFrame` : trois images à 60 Hz, de quoi peindre
 * le montage sans jamais faire attendre le départ.
 *
 * Le moteur n'est pas tenu de donner des images à une page où rien ne bouge — et ici rien ne bouge
 * encore : les animations sont créées en pause, posées à leur point de départ. WebKit (relevé sur le
 * moteur de Safari le 10/10/2026, émulation iPhone) n'a alors rendu une image qu'au bout de ~900 ms
 * pendant que les minuteries tournaient toutes les 50 ms : la fiche restait figée à son départ, la
 * carte encore basse — et la croix, pas encore à sa place, ne recevait pas l'appui qu'on lui
 * destinait. Borné, le départ ne dépend plus de la cadence que le navigateur choisit.
 */
const FRAMES_AT_MOST_MS = 50;

/** Deux images plus tard : le montage de React et sa mise en page sont peints, le départ ne perd pas sa première image. */
export function afterTwoFrames(fn: () => void, atMostMs = FRAMES_AT_MOST_MS): () => void {
  let done = false;
  const raf =
    typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16);
  const fire = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    fn();
  };
  const timer = window.setTimeout(fire, atMostMs);
  raf(() => raf(fire));
  return () => {
    done = true;
    window.clearTimeout(timer);
  };
}

/** Les calques qui vont bouger, promus avant le départ et rendus après : pas de création de calque à la première image. */
export function promote(els: (HTMLElement | null | undefined)[]): () => void {
  const list = els.filter((e): e is HTMLElement => !!e);
  for (const el of list) el.style.willChange = "transform, opacity";
  return () => {
    for (const el of list) el.style.willChange = "";
  };
}

/** Démarre ensemble des animations créées en pause : un même `startTime`, une même première image. */
export function startTogether(anims: Animation[]): number {
  const t0 = clockNow();
  for (const a of anims) {
    if ("startTime" in a) a.startTime = t0;
    else (a as Partial<Animation>).play?.();
  }
  return t0;
}

/**
 * Le `click` qui suit une fermeture servie au relâchement du doigt (le geste de la bannière) est
 * avalé : la fiche, déjà sans pointeur, le laissait tomber sur ce qu'il y a dessous — une affiche,
 * qui rouvrait aussitôt ce qu'on venait de fermer. Un seul, et seulement dans la fenêtre où il arrive.
 */
export function swallowStrayClick(ms = 500): void {
  let timer = 0;
  const done = () => {
    document.removeEventListener("click", stop, true);
    window.clearTimeout(timer);
  };
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    done();
  };
  document.addEventListener("click", stop, true);
  timer = window.setTimeout(done, ms);
}

/** L'opacité où en est un élément, animations comprises — 1 quand le navigateur n'en dit rien (jsdom). */
export function opacityNow(el: Element | null | undefined): number {
  if (!el) return 1;
  const v = parseFloat(getComputedStyle(el).opacity);
  return Number.isFinite(v) ? v : 1;
}

/** Le décalage vertical d'une transformation calculée (`matrix(…)`, `matrix3d(…)`) ou écrite (`translateY(…)`). */
export function translateYOf(transform: string): number {
  const m = /^matrix(3d)?\((.+)\)$/.exec(transform);
  if (m) {
    const v = m[2].split(",").map(Number);
    return (m[1] ? v[13] : v[5]) || 0;
  }
  const y = /translateY\((-?[\d.]+)px\)/.exec(transform);
  return y ? Number(y[1]) : 0;
}

/** L'échelle où en est un élément, animations comprises (`matrix(a, …)`) — 1 quand le navigateur n'en dit rien. */
export function scaleOf(el: Element): number {
  const m = /^matrix\(([^,]+),/.exec(getComputedStyle(el).transform);
  const a = m ? Number(m[1]) : NaN;
  return Number.isFinite(a) && a > 0 ? a : 1;
}

/** La boîte d'un élément, relative à un repère (l'écran par défaut). */
export function boxOf(el: Element, root?: DOMRect): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left - (root?.left ?? 0), y: r.top - (root?.top ?? 0), w: r.width, h: r.height };
}

export function place(el: HTMLElement, b: Box): void {
  Object.assign(el.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
}

/** Le profil de l'appareil, deviné : survol et pointeur fin → ordinateur ; tactile et large → iPad ; sinon téléphone. */
export function detectProfile(): MotionProfile {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "desktop";
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) return "desktop";
  return Math.min(window.innerWidth, window.innerHeight) >= 700 ? "ipad" : "phone";
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Le style d'une affiche d'où une fiche part et où elle revient : cachée par l'opacité, et sans
 * transition sur l'opacité.
 *
 * La règle de base `button:not(:disabled)` (globals.css) fait passer l'opacité de tout bouton en
 * 150 ms. Rendue au relais, l'affiche du téléphone remontait donc de 0 à 1 pendant que le calque du
 * retour s'effaçait par-dessus en 120 ms : un instant, deux images à moitié transparentes sur le fond
 * d'encre — le « mini clignotement » plus foncé vu sur iPhone (neuvième passe, mesuré sous WebKit).
 * Seules la transformation (l'enfoncement au doigt) et l'ombre restent animées.
 */
export function posterStyle(hidden: boolean): CSSProperties {
  return { opacity: hidden ? 0 : undefined, transitionProperty: "transform, box-shadow" };
}

/**
 * La part visible d'un élément : coupé par l'écran et par chaque conteneur qui le rogne autour de
 * lui (une rangée qui défile, une fiche qui défile). Une affiche sortie de sa rangée, ou d'une fiche
 * défilée, ne reçoit pas de trajet de retour — on ne vole pas vers un endroit qu'on ne voit pas.
 */
export function visibleFraction(el: Element): number {
  if (!el.isConnected) return 0;
  const r = el.getBoundingClientRect();
  const area = r.width * r.height;
  if (area <= 0) return 0;
  let l = Math.max(r.left, 0);
  let t = Math.max(r.top, 0);
  let rr = Math.min(r.right, window.innerWidth);
  let b = Math.min(r.bottom, window.innerHeight);
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.display === "none" || cs.visibility === "hidden" || p.hidden) return 0;
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
      const c = p.getBoundingClientRect();
      // Un conteneur sans taille ne rogne rien de mesurable (jsdom, ou un `display: contents`).
      if (c.width > 0 && c.height > 0) {
        l = Math.max(l, c.left);
        t = Math.max(t, c.top);
        rr = Math.min(rr, c.right);
        b = Math.min(b, c.bottom);
      }
    }
  }
  return (Math.max(0, rr - l) * Math.max(0, b - t)) / area;
}
