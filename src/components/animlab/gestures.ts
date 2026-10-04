// Les gestes d'appui de la page « Tests animations ».
//
// Chacun s'accroche à un bouton par des écouteurs natifs et n'écrit que `transform` / `opacity`,
// par `element.animate()` — le compositeur les joue, React ne se redessine jamais pendant un geste.
// Deux principes tirés du lecteur (02/10/2026) valent pour tous :
// - le geste se joue jusqu'au bout : un tap franc dure quarante millisecondes, et un geste tenu
//   par `:active` n'atteint jamais son creux. L'aller se termine toujours avant que le retour parte ;
// - un nouvel appui remplace le précédent, sans empiler les animations.

import { springKeyframes, type SpringParams } from "@/lib/liquidGlass/spring";
import type { PointerCapture } from "@/lib/usePointerCapture";
import { attachLiquid } from "@/lib/liquidGlass/liquid";

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
  if (kind === "liquid") return attachLabLiquid(el, getSettings);
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
 * Celui du lecteur et de la barre du bas : `src/lib/liquidGlass/liquid.ts`, branché ici avec la
 * lueur de la page (reflet qui monte, lumière qui suit le doigt) et ses réglages en direct.
 */

function labLight(el: HTMLElement, on: boolean, x: number, y: number) {
  const sheen = el.querySelector(":scope > .alab-sheen");
  const glow = el.querySelector<HTMLElement>(":scope > .alab-glowclip > .alab-glow");
  if (on && glow) labFollow(el, x, y);
  for (const layer of [sheen, glow]) {
    if (!layer || typeof (layer as HTMLElement).animate !== "function") continue;
    layer.getAnimations().forEach((a) => a.cancel());
    (layer as HTMLElement).animate([{ opacity: on ? 0 : 1 }, { opacity: on ? 1 : 0 }], { duration: on ? 110 : 320, easing: "ease-out", fill: "forwards" });
  }
}

function labFollow(el: HTMLElement, x: number, y: number) {
  const glow = el.querySelector<HTMLElement>(":scope > .alab-glowclip > .alab-glow");
  if (!glow) return;
  const box = el.getBoundingClientRect();
  glow.style.transform = `translate(${x - box.left}px, ${y - box.top}px)`;
}

export function attachLabLiquid(surface: HTMLElement, getSettings: () => GestureSettings): () => void {
  return attachLiquid(surface, {
    targets: ".alab-btn",
    spring: () => getSettings().spring,
    slow: () => getSettings().slow,
    light: labLight,
    follow: labFollow,
  });
}
