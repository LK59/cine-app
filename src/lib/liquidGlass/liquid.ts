// Le geste « liquide » : le verre gonfle sous le doigt, s'étire vers lui, puis revient sur le
// ressort (DECISIONS.md §45). Choisi le 04/10/2026 sur la page « Tests animations ».
//
// Accroché à une *surface* — un bouton seul, ou la pilule qui en porte plusieurs : c'est alors la
// pilule entière qui gonfle et s'étire, et le bouton visé ne fait que s'allumer. Rien ici ne passe
// par React : `transform` est écrit sur le nœud pendant le doigt, puis le retour est un ressort
// simulé une fois et joué par `element.animate()` — le compositeur s'en charge seul.
//
// **Le clic n'est pas remplacé.** Un appui posé sur un bouton et relâché dessus produit le clic
// natif, qui part tel quel : c'est le chemin de presque tous les appuis, et il reste exactement
// celui d'avant — même cible, même geste utilisateur (AirPlay, le plein écran et `play()` en ont
// besoin). Le geste n'intervient que dans deux cas, que le navigateur seul traiterait mal :
// - le doigt s'est posé dans la marge (12 px autour du verre) ou a glissé hors du bouton sans
//   dépasser 24 px du verre : le clic natif tombe à côté (sur la pilule, ou sur le fond, qui
//   montrerait ou cacherait les commandes) — il est arrêté, et le bouton visé est cliqué *depuis
//   ce clic natif*, donc toujours dans le geste utilisateur ;
// - le doigt est parti plus loin : l'appui est annulé ; un clic qui tomberait encore dans la
//   pilule est arrêté, un clic ailleurs part comme avant.
// Si aucun clic natif ne vient (un doigt qui a glissé, sur iOS), le bouton visé est cliqué au bout
// de 300 ms. Un clic du clavier ou d'un programme (`detail` à 0, ou non fiable) n'est jamais touché.

import { springKeyframes, type SpringParams } from "./spring";

/** Masse 1 : k = (2π / réponse)², c = 4π·ζ / réponse — la description de SwiftUI. */
export function toSpring(response: number, ratio: number): SpringParams {
  return { stiffness: (2 * Math.PI / response) ** 2, damping: (4 * Math.PI * ratio) / response };
}

/** Le ressort retenu (« Apple » sur la page de tests) : réponse 0,45 s, amortissement 0,8. */
export const LIQUID_SPRING = toSpring(0.45, 0.8);
/** La zone de toucher élargie autour du verre (`[data-liquid]::before`, globals.css). */
export const LIQUID_SLOP = 12;
/** Jusqu'où le doigt peut s'éloigner du verre sans annuler l'appui. */
export const LIQUID_KEEP = 24;

const PRESS_MS = 130;
const ID = "liquid";
const FALLBACK_CLICK_MS = 300;

/** Gonflé de 10 px environ, sans dépasser 12 % : un rond de 52 px prend 12 %, une pilule de 220 px 5 %. */
export function swellFor(w: number, h: number): number {
  return Math.min(1.12, 1 + 10 / Math.max(w, h, 1));
}

/**
 * Ce qui tire le verre, depuis la position du doigt par rapport à son centre posé. Dans une
 * pilule, seul compte ce qui dépasse des demi-ronds des bouts : le doigt qui passe d'un bouton à
 * l'autre ne doit pas tirer, celui qui sort du bord, si. Pour un rond, c'est la distance au centre.
 */
export function pullFrom(dx: number, dy: number, w: number, h: number): { r: number; angle: number } {
  const round = Math.min(w, h) / 2;
  const rx = Math.max(Math.abs(dx) - w / 2 + round, 0) * Math.sign(dx);
  const ry = Math.max(Math.abs(dy) - h / 2 + round, 0) * Math.sign(dy);
  return { r: Math.hypot(rx, ry), angle: Math.atan2(ry, rx) };
}

/**
 * La forme du verre tiré vers le doigt : un décalage élastique (de plus en plus dur à tirer) et un
 * allongement en pixels dans l'axe du doigt — le même nombre de pixels pour un rond et une pilule,
 * donc une pilule s'allonge proportionnellement moins. `strength` règle les deux (0,6 pour la barre
 * de navigation, plus discrète que le lecteur).
 */
export function liquidTransform(r: number, angle: number, swell: number, w: number, h: number, strength = 1): string {
  const offset = strength * 12 * (1 - Math.exp(-r / 60));
  const along = Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * h;
  const extra = strength * 14 * (1 - Math.exp(-Math.abs(r) / 80));
  const elongate = 1 + (Math.sign(r) * extra) / Math.max(along, 1);
  const squeeze = 1 / Math.sqrt(Math.max(elongate, 0.5));
  return `translate(${Math.cos(angle) * offset}px, ${Math.sin(angle) * offset}px) rotate(${angle}rad) scale(${elongate * swell}, ${squeeze * swell}) rotate(${-angle}rad)`;
}

export function distanceOutside(box: DOMRect, x: number, y: number): number {
  const dx = Math.max(box.left - x, 0, x - box.right);
  const dy = Math.max(box.top - y, 0, y - box.bottom);
  return Math.hypot(dx, dy);
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function cancelOwn(el: Element) {
  for (const a of el.getAnimations?.() ?? []) if (a.id === ID) a.cancel();
}

function play(el: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  if (typeof (el as HTMLElement).animate !== "function") return null;
  const anim = (el as HTMLElement).animate(keyframes, options);
  anim.id = ID;
  return anim;
}

export type LiquidPressOptions = {
  /** Ce qui, dans une surface, reçoit l'appui (la surface elle-même si elle y répond). */
  targets: string;
  /** Force de l'étirement et du décalage : 1 au lecteur. */
  strength?: number;
  /** Lu à chaque appui : la page de tests règle le ressort et le ralenti en direct. */
  spring?: () => SpringParams;
  slow?: () => number;
  /** Allume ou éteint le bouton visé. Par défaut, l'attribut `data-lit` (globals.css). */
  light?: (el: HTMLElement, on: boolean, x: number, y: number) => void;
  /** Suit le doigt dans le bouton allumé (la lueur de la page de tests). */
  follow?: (el: HTMLElement, x: number, y: number) => void;
  /** Ce qui distingue un clic du doigt : `isTrusted`, que les tests ne peuvent pas fabriquer. */
  trusted?: (e: MouseEvent) => boolean;
};

/** Ce qui garde son propre geste : le curseur du volume se fait glisser, il ne s'étire pas. */
const IGNORE = "input, select, textarea, [data-liquid-ignore]";

const defaultLight = (el: HTMLElement, on: boolean) => {
  if (on) el.setAttribute("data-lit", "");
  else el.removeAttribute("data-lit");
};

/**
 * Le geste, prêt à être branché par délégation : `down(event, surface)` à l'appui, et le reste se
 * suit tout seul (écouteurs posés sur `window` le temps du geste — un doigt suivi au-delà de la
 * surface sans capture de pointeur, ce qui laisse au clic natif sa cible d'origine).
 */
export function createLiquidPress(options: LiquidPressOptions) {
  const strength = options.strength ?? 1;
  const spring = options.spring ?? (() => LIQUID_SPRING);
  const slow = options.slow ?? (() => 1);
  const light = options.light ?? defaultLight;
  const trusted = options.trusted ?? ((e: MouseEvent) => e.isTrusted);

  type Session = {
    surface: HTMLElement;
    chosen: HTMLElement | null;
    pointerId: number;
    swell: number;
    w: number;
    h: number;
    pull: { r: number; angle: number };
    last: { x: number; y: number };
    still: boolean;
    /** La surface au repos, mesurée une fois à l'appui : aucune lecture de mise en page par mouvement. */
    rest: DOMRect;
  };
  let session: Session | null = null;
  let pending: { target: HTMLElement | null; surface: HTMLElement; keep: boolean; timer: number } | null = null;

  const visibleTargets = (surface: HTMLElement) => {
    const all = surface.matches(options.targets) ? [surface] : Array.from(surface.querySelectorAll<HTMLElement>(options.targets));
    return all.filter((b) => b.offsetWidth > 0 && !b.closest("[inert]") && !(b as HTMLButtonElement).disabled);
  };
  // Le bouton visé : celui sous le doigt, ou, dans la marge, le plus proche — pas au-delà.
  const nearest = (surface: HTMLElement, x: number, y: number) => {
    let best: HTMLElement | null = null;
    let bestD = Infinity;
    for (const b of visibleTargets(surface)) {
      const d = distanceOutside(b.getBoundingClientRect(), x, y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return bestD <= LIQUID_SLOP ? best : null;
  };

  function clearPending() {
    if (!pending) return;
    window.clearTimeout(pending.timer);
    window.removeEventListener("click", onClick, true);
    pending = null;
  }

  // Écouté sur `window`, en capture : avant tout le reste, et le seul clic attendu est celui
  // qui suit le relâchement.
  function onClick(e: MouseEvent) {
    if (!pending || !trusted(e) || e.detail === 0) return;
    const p = pending;
    clearPending();
    const target = e.target as Node | null;
    if (p.target && target && p.target.contains(target)) return; // le chemin ordinaire : intact
    if (!p.keep || !p.target) {
      // Annulé (ou rien de visé) : un clic qui tomberait dans la pilule n'actionne rien ;
      // ailleurs, il part comme il serait parti.
      if (target && p.surface.contains(target)) {
        e.stopPropagation();
        e.preventDefault();
      }
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    p.target.click();
  }

  function onMove(e: PointerEvent) {
    const s = session;
    if (!s || e.pointerId !== s.pointerId) return;
    s.last = { x: e.clientX, y: e.clientY };
    if (s.chosen) options.follow?.(s.chosen, e.clientX, e.clientY);
    if (s.still) return;
    // Depuis le centre *au repos* : la surface tirée bouge, et mesurer depuis son centre déplacé
    // ferait courir le verre après lui-même.
    const dx = e.clientX - (s.rest.left + s.rest.width / 2);
    const dy = e.clientY - (s.rest.top + s.rest.height / 2);
    s.pull = pullFrom(dx, dy, s.w, s.h);
    cancelOwn(s.surface);
    s.surface.style.transform = liquidTransform(s.pull.r, s.pull.angle, s.swell, s.w, s.h, strength);
  }

  function end(cancelled: boolean) {
    const s = session;
    if (!s) return;
    session = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    const keep = !cancelled && distanceOutside(s.rest, s.last.x, s.last.y) <= LIQUID_KEEP;
    if (!s.still) {
      const { r, angle } = s.pull;
      const { swell, w, h, surface } = s;
      surface.style.transform = "";
      // Le retour : le ressort ramène le décalage *et* le gonflement ; ses dépassements passent de
      // l'autre côté, ce qui fait le rebond.
      const back = springKeyframes(1, 0, spring(), ({ x }) => ({
        transform: liquidTransform(r * Math.max(x, -0.5), angle, 1 + (swell - 1) * x, w, h, strength),
      }));
      cancelOwn(surface);
      play(surface, back.keyframes, { duration: back.duration * slow(), easing: "linear" });
    }
    if (s.chosen) light(s.chosen, false, s.last.x, s.last.y);
    if (cancelled) return;
    clearPending();
    const target = s.chosen;
    pending = {
      target,
      surface: s.surface,
      keep,
      timer: window.setTimeout(() => {
        // Aucun clic natif n'est venu — un doigt qui a glissé : le bouton visé, quand même.
        const p = pending;
        clearPending();
        if (p?.keep && p.target) p.target.click();
      }, FALLBACK_CLICK_MS),
    };
    window.addEventListener("click", onClick, true);
  }
  const onUp = (e: PointerEvent) => {
    if (session && e.pointerId === session.pointerId) {
      session.last = { x: e.clientX, y: e.clientY };
      end(false);
    }
  };
  const onCancel = (e: PointerEvent) => {
    if (session && e.pointerId === session.pointerId) end(true);
  };

  function down(e: PointerEvent, surface: HTMLElement) {
    if (session || (e.pointerType === "mouse" && e.button !== 0)) return;
    if ((e.target as Element | null)?.closest?.(IGNORE)) return;
    clearPending();
    const w = surface.offsetWidth;
    const h = surface.offsetHeight;
    // Repris d'où il en est : un appui pendant le rebond du précédent ne doit pas sauter. Lu avant
    // d'arrêter ce rebond, et la surface mesurée juste après — au repos, sans transformation.
    const computed = typeof getComputedStyle === "function" ? getComputedStyle(surface).transform : "";
    const from = computed && computed !== "none" ? computed : "scale(1)";
    cancelOwn(surface);
    surface.style.transform = "";
    const rest = surface.getBoundingClientRect();
    const s: Session = {
      surface,
      chosen: nearest(surface, e.clientX, e.clientY),
      pointerId: e.pointerId,
      swell: swellFor(w, h),
      w,
      h,
      pull: { r: 0, angle: 0 },
      last: { x: e.clientX, y: e.clientY },
      // « Réduire les animations » : ni gonflement ni étirement — l'allumage et le clic restent.
      still: prefersReducedMotion(),
      rest,
    };
    session = s;
    if (!s.still) {
      surface.style.transform = liquidTransform(0, 0, s.swell, w, h, strength);
      play(surface, [{ transform: from }, { transform: surface.style.transform }], {
        duration: PRESS_MS * slow(),
        easing: "cubic-bezier(0.2, 0.9, 0.3, 1.25)",
      });
    }
    if (s.chosen) light(s.chosen, true, e.clientX, e.clientY);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  /** Tout rendre : à appeler au démontage de ce qui a branché le geste. */
  function dispose() {
    if (session) {
      const s = session;
      end(true);
      cancelOwn(s.surface);
      s.surface.style.transform = "";
    }
    clearPending();
  }

  return { down, dispose, active: () => session !== null };
}

export type LiquidPress = ReturnType<typeof createLiquidPress>;

/** Le même geste, branché sur une seule surface (la page de tests). Rend la fonction qui le débranche. */
export function attachLiquid(surface: HTMLElement, options: LiquidPressOptions): () => void {
  const press = createLiquidPress(options);
  const onDown = (e: PointerEvent) => press.down(e, surface);
  surface.addEventListener("pointerdown", onDown);
  return () => {
    surface.removeEventListener("pointerdown", onDown);
    press.dispose();
  };
}
