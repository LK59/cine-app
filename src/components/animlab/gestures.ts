// Les gestes d'appui de la page « Tests animations ».
//
// Chacun s'accroche à un bouton par des écouteurs natifs et n'écrit que `transform` / `opacity`,
// par `element.animate()` — le compositeur les joue, React ne se redessine jamais pendant un geste.
// Deux principes tirés du lecteur (02/10/2026) valent pour tous :
// - le geste se joue jusqu'au bout : un tap franc dure quarante millisecondes, et un geste tenu
//   par `:active` n'atteint jamais son creux. L'aller se termine toujours avant que le retour parte ;
// - un nouvel appui remplace le précédent, sans empiler les animations.

import { springKeyframes, type SpringParams } from "./spring";
import type { PointerCapture } from "@/lib/usePointerCapture";

export type GestureKind = "liquid" | "active" | "player" | "hold" | "swell" | "swellGlow" | "jelly" | "stretch" | "resist";

export type GestureSettings = { spring: SpringParams; slow: number };

export const GESTURES: { kind: GestureKind; name: string; hint: string }[] = [
  { kind: "liquid", name: "Liquide (choix du 04/10)", hint: "Gonfle + étirement vers le doigt, comme iOS 26. Dans une pilule, c'est toute la pilule qui s'étire. Zone de toucher élargie de 12 px, et le doigt peut glisser jusqu'à 24 px hors du verre sans annuler l'appui." },
  { kind: "active", name: "Actuel (:active)", hint: "La règle CSS d'aujourd'hui sur la plupart des boutons : tenue par le contact, invisible sur un tap rapide." },
  { kind: "player", name: "Creux + un rebond (lecteur)", hint: "Le geste du lecteur depuis la 8.2.4 : joué jusqu'au bout, un seul dépassement. Courbe fixe, ignore les réglages du ressort." },
  { kind: "hold", name: "Ressort tenu", hint: "S'enfonce tant que le doigt reste, repart sur le ressort réglé plus haut au relâchement." },
  { kind: "swell", name: "Gonfle (Liquid Glass)", hint: "Le bouton grossit et s'éclaire sous le doigt, comme les verres d'iOS 26, puis se pose sur le ressort." },
  { kind: "swellGlow", name: "Gonfle + lueur au doigt", hint: "Pareil, avec une lumière qui suit le doigt à l'intérieur du verre." },
  { kind: "jelly", name: "Gélatine", hint: "S'écrase en largeur, puis oscille entre large et haut. Plus le ressort est mou, plus c'est vivant (ou fragile)." },
  { kind: "stretch", name: "Étirement vers le doigt", hint: "Glisse le doigt en restant appuyé : le verre s'étire vers lui, puis revient en ressort. Le geste le plus « liquide »." },
  { kind: "resist", name: "Icône qui résiste", hint: "La surface s'enfonce pendant que l'icône grossit — la matière s'écrase au lieu de rétrécir. Celui de la barre d'onglets." },
];

const ID = "alab";
const PRESS_MS = 110;

function cancelOwn(el: Element) {
  for (const a of el.getAnimations()) if (a.id === ID) a.cancel();
}

function play(el: Element | null, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  if (!el || typeof (el as HTMLElement).animate !== "function") return null;
  const anim = (el as HTMLElement).animate(keyframes, options);
  anim.id = ID;
  return anim;
}

function spring(el: Element | null, from: number, to: number, settings: GestureSettings, frame: (x: number, v: number) => Keyframe, velocity = 0) {
  if (!el) return;
  const { keyframes, duration } = springKeyframes(from, to, settings.spring, (s) => frame(s.x, s.v), velocity);
  cancelOwn(el);
  play(el, keyframes, { duration: duration * settings.slow, easing: "linear" });
}

const scaleFrame = (x: number): Keyframe => ({ transform: `scale(${x})` });

/**
 * Accroche un geste à un bouton ; rend la fonction qui le décroche. `getSettings` est relu à
 * chaque appui, pour que les curseurs du ressort s'appliquent sans réaccrocher quoi que ce soit.
 */
export function attachGesture(el: HTMLElement, kind: GestureKind, getSettings: () => GestureSettings, capture?: PointerCapture): () => void {
  if (kind === "active") return () => {};
  if (kind === "liquid") return attachLiquid(el, getSettings, capture);
  const sheen = el.querySelector(":scope > .alab-sheen");
  const glow = el.querySelector<HTMLElement>(":scope > .alab-glowclip > .alab-glow");
  const icon = el.querySelector(":scope > .alab-icon, :scope > svg");

  let down = false;
  let pressAnim: Animation | null = null;
  // L'étirement : le décalage du doigt par rapport au centre, au moment du relâchement.
  let stretch = { r: 0, angle: 0 };

  const placeGlow = (e: PointerEvent) => {
    if (!glow) return;
    const box = el.getBoundingClientRect();
    glow.style.transform = `translate(${e.clientX - box.left}px, ${e.clientY - box.top}px)`;
  };

  const stretchTransform = (r: number, angle: number, swell: number) => {
    const offset = Math.min(r * 0.28, 14);
    const elongate = 1 + Math.min(r / 260, 0.22);
    return `translate(${Math.cos(angle) * offset}px, ${Math.sin(angle) * offset}px) rotate(${angle}rad) scale(${elongate * swell}, ${swell / Math.sqrt(elongate)}) rotate(${-angle}rad)`;
  };

  function onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const s = getSettings();
    down = true;
    cancelOwn(el);
    if (icon) cancelOwn(icon);
    if (sheen) cancelOwn(sheen);
    const ms = PRESS_MS * s.slow;
    switch (kind) {
      case "player":
        play(el, [
          { transform: "scale(1)" },
          { transform: "scale(0.9)", offset: 0.35 },
          { transform: "scale(1.03)", offset: 0.7 },
          { transform: "scale(1)" },
        ], { duration: 380 * s.slow, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
        break;
      case "hold":
        pressAnim = play(el, [{ transform: "scale(1)" }, { transform: "scale(0.9)" }], { duration: ms, easing: "ease-out", fill: "forwards" });
        break;
      case "swell":
      case "swellGlow":
        pressAnim = play(el, [{ transform: "scale(1)" }, { transform: "scale(1.12)" }], { duration: ms * 1.2, easing: "cubic-bezier(0.2, 0.9, 0.3, 1.2)", fill: "forwards" });
        play(sheen, [{ opacity: 0 }, { opacity: 1 }], { duration: ms, fill: "forwards" });
        if (kind === "swellGlow" && glow) {
          placeGlow(e);
          glow.getAnimations().forEach((a) => a.cancel());
          play(glow, [{ opacity: 0 }, { opacity: 1 }], { duration: ms, fill: "forwards" });
        }
        break;
      case "jelly":
        pressAnim = play(el, [{ transform: "scale(1, 1)" }, { transform: "scale(1.12, 0.88)" }], { duration: ms, easing: "ease-out", fill: "forwards" });
        break;
      case "stretch":
        stretch = { r: 0, angle: 0 };
        // Capturé pour suivre le doigt hors du bouton, par le protocole commun (`usePointerCapture`) :
        // une capture tenue par un nœud détaché bloque WebKit, et le crochet la rend au démontage.
        capture?.take(e);
        el.style.transform = "scale(1.06)";
        play(sheen, [{ opacity: 0 }, { opacity: 1 }], { duration: ms, fill: "forwards" });
        break;
      case "resist":
        pressAnim = play(el, [{ transform: "scale(1)" }, { transform: "scale(0.86)" }], { duration: ms, easing: "ease-out", fill: "forwards" });
        play(icon, [{ transform: "scale(1)" }, { transform: "scale(1.16)" }], { duration: ms, easing: "ease-out", fill: "forwards" });
        break;
    }
  }

  function onMove(e: PointerEvent) {
    if (!down) return;
    if (kind === "swellGlow") placeGlow(e);
    if (kind === "stretch") {
      const box = el.getBoundingClientRect();
      const dx = e.clientX - (box.left + box.width / 2);
      const dy = e.clientY - (box.top + box.height / 2);
      stretch = { r: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
      // Écrit sur le nœud, jamais en état React : un rendu par mouvement de doigt, c'est la
      // saccade de la fiche personne (23/09/2026).
      el.style.transform = stretchTransform(stretch.r, stretch.angle, 1.06);
    }
  }

  function release() {
    const s = getSettings();
    switch (kind) {
      case "hold":
        spring(el, 0.9, 1, s, scaleFrame);
        break;
      case "swell":
      case "swellGlow":
        spring(el, 1.12, 1, s, scaleFrame);
        play(sheen, [{ opacity: 1 }, { opacity: 0 }], { duration: 320 * s.slow, easing: "ease-out", fill: "forwards" });
        if (glow) play(glow, [{ opacity: 1 }, { opacity: 0 }], { duration: 320 * s.slow, easing: "ease-out", fill: "forwards" });
        break;
      case "jelly":
        spring(el, 1, 0, s, (x) => ({ transform: `scale(${1 + 0.12 * x}, ${1 - 0.12 * x})` }));
        break;
      case "stretch": {
        const { r, angle } = stretch;
        el.style.transform = "";
        spring(el, 1, 0, s, (x) => ({ transform: stretchTransform(r * Math.max(x, -0.6), angle, 1 + 0.06 * x) }));
        play(sheen, [{ opacity: 1 }, { opacity: 0 }], { duration: 320 * s.slow, easing: "ease-out", fill: "forwards" });
        break;
      }
      case "resist":
        spring(el, 0.86, 1, s, scaleFrame);
        spring(icon, 1.16, 1, s, scaleFrame);
        break;
    }
  }

  function onUp() {
    if (!down) return;
    down = false;
    capture?.release();
    // L'aller d'abord, jusqu'au bout : c'est ce qui rend un tap rapide aussi lisible qu'un appui long.
    const pending = pressAnim;
    pressAnim = null;
    if (pending && pending.playState === "running") pending.finished.then(release, () => {});
    else release();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    onDown(new PointerEvent("pointerdown", { button: 0, clientX: 0, clientY: 0 }));
    onUp();
  }

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("pointerleave", onUp);
  el.addEventListener("keydown", onKey);
  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.removeEventListener("pointerleave", onUp);
    el.removeEventListener("keydown", onKey);
    capture?.release();
    cancelOwn(el);
    el.style.transform = "";
  };
}

/* ─── Le geste liquide ───────────────────────────────────────────────────────
 * Le mélange retenu le 04/10/2026 : le verre gonfle sous le doigt et s'étire vers lui, puis revient
 * sur le ressort. Accroché à une *surface* — un bouton seul, ou la pilule qui porte plusieurs
 * boutons : c'est alors toute la pilule qui gonfle et s'étire, et le bouton visé ne fait que
 * s'éclairer, comme sur iOS.
 *
 * La zone de toucher déborde de 12 px (`.alab-slop`), et l'appui survit à un doigt qui glisse
 * jusqu'à 24 px hors du verre : capturé, le geste reste fluide et rebondit quoi qu'il arrive ; il
 * n'est annulé — sans clic — que si le doigt part plus loin. Le clic est rendu par nous au
 * relâchement, sur le bouton visé à l'appui : capturé par la pilule, le navigateur ne le
 * donnerait qu'à elle. Les clics natifs d'un pointeur sont donc retenus ; ceux du clavier
 * (`detail` à 0) passent tels quels.
 */

const SLOP_KEEP = 24;

/** Gonflé de 10 px environ, sans dépasser 12 % : un rond de 52 px prend 12 %, une pilule de 150 px 7 %. */
function swellFor(w: number, h: number): number {
  return Math.min(1.12, 1 + 10 / Math.max(w, h, 1));
}

/**
 * La forme du verre tiré vers le doigt : un décalage élastique (de plus en plus dur à tirer) et un
 * allongement en pixels dans l'axe du doigt — le même nombre de pixels pour un rond et une pilule,
 * donc une pilule s'allonge proportionnellement moins.
 */
export function liquidTransform(r: number, angle: number, swell: number, w: number, h: number, strength = 1): string {
  const offset = strength * 12 * (1 - Math.exp(-r / 60));
  const along = Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * h;
  const extra = strength * 14 * (1 - Math.exp(-Math.abs(r) / 80));
  const elongate = 1 + (Math.sign(r) * extra) / Math.max(along, 1);
  const squeeze = 1 / Math.sqrt(Math.max(elongate, 0.5));
  return `translate(${Math.cos(angle) * offset}px, ${Math.sin(angle) * offset}px) rotate(${angle}rad) scale(${elongate * swell}, ${squeeze * swell}) rotate(${-angle}rad)`;
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

function distanceOutside(box: DOMRect, x: number, y: number): number {
  const dx = Math.max(box.left - x, 0, x - box.right);
  const dy = Math.max(box.top - y, 0, y - box.bottom);
  return Math.hypot(dx, dy);
}

export function attachLiquid(
  surface: HTMLElement,
  getSettings: () => GestureSettings,
  capture?: PointerCapture,
  options: { strength?: number } = {},
): () => void {
  const strength = options.strength ?? 1;
  const buttons = () => (surface.matches(".alab-btn") ? [surface] : Array.from(surface.querySelectorAll<HTMLElement>(".alab-btn")));
  let down = false;
  let chosen: HTMLElement | null = null;
  let swell = 1;
  let size = { w: 0, h: 0 };
  let pull = { r: 0, angle: 0 };
  let last = { x: 0, y: 0 };

  const lightOf = (el: HTMLElement | null) => ({
    sheen: el?.querySelector(":scope > .alab-sheen") ?? null,
    glow: el?.querySelector<HTMLElement>(":scope > .alab-glowclip > .alab-glow") ?? null,
  });
  const placeGlow = (x: number, y: number) => {
    const { glow } = lightOf(chosen);
    if (!glow || !chosen) return;
    const box = chosen.getBoundingClientRect();
    glow.style.transform = `translate(${x - box.left}px, ${y - box.top}px)`;
  };
  // Le bouton visé : celui sous le doigt, ou, dans la marge, le plus proche.
  const nearest = (x: number, y: number) => {
    let best: HTMLElement | null = null;
    let bestD = Infinity;
    for (const b of buttons()) {
      const d = distanceOutside(b.getBoundingClientRect(), x, y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  };

  function onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const s = getSettings();
    down = true;
    last = { x: e.clientX, y: e.clientY };
    pull = { r: 0, angle: 0 };
    chosen = nearest(e.clientX, e.clientY);
    capture?.take(e);
    // Repris d'où il en est — un appui pendant le rebond du précédent ne doit pas sauter.
    const computed = getComputedStyle(surface).transform;
    const current = computed && computed !== "none" ? computed : "scale(1)";
    cancelOwn(surface);
    size = { w: surface.offsetWidth, h: surface.offsetHeight };
    swell = swellFor(size.w, size.h);
    surface.style.transform = liquidTransform(0, 0, swell, size.w, size.h, strength);
    play(surface, [{ transform: current }, { transform: surface.style.transform }], { duration: PRESS_MS * 1.2 * s.slow, easing: "cubic-bezier(0.2, 0.9, 0.3, 1.25)" });
    const { sheen, glow } = lightOf(chosen);
    play(sheen, [{ opacity: 0 }, { opacity: 1 }], { duration: PRESS_MS * s.slow, fill: "forwards" });
    if (glow) {
      placeGlow(e.clientX, e.clientY);
      play(glow, [{ opacity: 0 }, { opacity: 1 }], { duration: PRESS_MS * s.slow, fill: "forwards" });
    }
  }

  function onMove(e: PointerEvent) {
    if (!down) return;
    last = { x: e.clientX, y: e.clientY };
    placeGlow(e.clientX, e.clientY);
    const box = surface.getBoundingClientRect();
    const dx = e.clientX - (box.left + box.width / 2);
    const dy = e.clientY - (box.top + box.height / 2);
    // Mesuré depuis le centre *posé* : la surface tirée bouge, et mesurer depuis son centre
    // déplacé ferait courir le verre après lui-même. Le décalage déjà appliqué est retiré.
    const shift = 12 * strength * (1 - Math.exp(-pull.r / 60));
    const cx = dx + Math.cos(pull.angle) * shift;
    const cy = dy + Math.sin(pull.angle) * shift;
    pull = pullFrom(cx, cy, size.w, size.h);
    cancelOwn(surface);
    // Écrit sur le nœud, jamais en état React — voir la fiche personne (23/09/2026).
    surface.style.transform = liquidTransform(pull.r, pull.angle, swell, size.w, size.h, strength);
  }

  function end(cancelled: boolean) {
    if (!down) return;
    down = false;
    capture?.release();
    const s = getSettings();
    const keep = !cancelled && distanceOutside(surface.getBoundingClientRect(), last.x, last.y) <= SLOP_KEEP;
    const { r, angle } = pull;
    const startSwell = swell;
    const { w, h } = size;
    surface.style.transform = "";
    // Le retour : le ressort ramène le décalage *et* le gonflement ; ses dépassements passent de
    // l'autre côté, ce qui fait le rebond.
    spring(surface, 1, 0, s, (x) => ({ transform: liquidTransform(r * Math.max(x, -0.5), angle, 1 + (startSwell - 1) * x, w, h, strength) }));
    const { sheen, glow } = lightOf(chosen);
    play(sheen, [{ opacity: 1 }, { opacity: 0 }], { duration: 320 * s.slow, easing: "ease-out", fill: "forwards" });
    if (glow) play(glow, [{ opacity: 1 }, { opacity: 0 }], { duration: 320 * s.slow, easing: "ease-out", fill: "forwards" });
    const target = chosen;
    chosen = null;
    if (keep && target) target.click();
  }
  const onUp = () => end(false);
  const onCancel = () => end(true);
  // Sans capture (refusée par le navigateur), quitter la surface vaut relâcher — avec la même
  // tolérance de 24 px, mesurée au dernier point connu.
  const onLeave = (e: PointerEvent) => {
    if (!down || (capture && surface.hasPointerCapture?.(e.pointerId))) return;
    last = { x: e.clientX, y: e.clientY };
    end(false);
  };
  const onClickCapture = (e: MouseEvent) => {
    if (e.isTrusted && e.detail > 0) {
      e.stopPropagation();
      e.preventDefault();
    }
  };
  // Le clavier : le même rebond, joué d'un coup.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const s = getSettings();
    const sw = swellFor(surface.offsetWidth, surface.offsetHeight);
    spring(surface, 1, 0, s, (x) => ({ transform: `scale(${1 + (sw - 1) * x})` }));
  };

  surface.classList.add("alab-slop");
  surface.addEventListener("pointerdown", onDown);
  surface.addEventListener("pointermove", onMove);
  surface.addEventListener("pointerup", onUp);
  surface.addEventListener("pointercancel", onCancel);
  surface.addEventListener("pointerleave", onLeave);
  surface.addEventListener("click", onClickCapture, true);
  surface.addEventListener("keydown", onKey);
  return () => {
    surface.classList.remove("alab-slop");
    surface.removeEventListener("pointerdown", onDown);
    surface.removeEventListener("pointermove", onMove);
    surface.removeEventListener("pointerup", onUp);
    surface.removeEventListener("pointercancel", onCancel);
    surface.removeEventListener("pointerleave", onLeave);
    surface.removeEventListener("click", onClickCapture, true);
    surface.removeEventListener("keydown", onKey);
    capture?.release();
    cancelOwn(surface);
    surface.style.transform = "";
  };
}
