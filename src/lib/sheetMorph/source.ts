import { visibleFraction } from "./dom";

/**
 * D'où part une fiche (DECISIONS.md §61) : la carte qu'on vient de toucher, retenue au geste.
 *
 * Une fiche s'ouvre par l'adresse (`cinemaRoute.ts`) : elle se monte un tour plus tard, sans rien
 * savoir de ce qui l'a ouverte — « closing is a request, not a fact », et l'ouverture aussi. Plutôt
 * que de faire passer la carte touchée par chacune des quinze sortes de rangées, de grilles et de
 * résultats qui ouvrent une fiche, le geste est noté ici, une fois pour toutes, à la capture : le
 * dernier appui (relâché sans avoir glissé) ou la dernière touche Entrée sur un élément qui porte
 * une image. La fiche qui se monte dans la seconde le reprend ; plus tard, il ne vaut plus rien —
 * une adresse ouverte autrement (un lien, un retour) ne part de nulle part.
 *
 * `data-sheet-source-target` (un sélecteur) désigne une autre image que celle du bouton — le visuel
 * de la bannière du bureau pour « Plus d'infos ». `data-sheet-no-source` exclut une zone.
 */

export type SheetSource = {
  /** Ce qu'on a touché : c'est lui qui reçoit le focus au retour. */
  control: HTMLElement;
  /** Le cadre de l'image — ce qui disparaît pendant que la fiche est ouverte, et où elle revient. */
  frame: HTMLElement;
  /** L'adresse de l'image déjà chargée : le calque du trajet la réutilise, sans rien télécharger. */
  image: string;
  radius: number;
};

/** Au-delà, l'appui ne dit plus rien de la fiche qui se monte. */
const PRESS_FRESH_MS = 1200;
/** Plus loin que ça, le doigt a glissé (une rangée qu'on fait défiler) : pas un appui. */
const PRESS_SLOP_PX = 10;
/** Les éléments qui peuvent être une source : un bouton, un lien, ou ce qui s'en déclare une. */
const CONTROL = "[data-sheet-source], button, a, [role='button']";

let pending: { source: SheetSource; at: number } | null = null;
let down: { control: HTMLElement; x: number; y: number; id: number } | null = null;
let installed = false;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function radiusOf(el: Element): number {
  const r = parseFloat(getComputedStyle(el).borderTopLeftRadius);
  return Number.isFinite(r) ? r : 0;
}

/**
 * Le cadre de l'image : le plus haut de ses parents (jusqu'au bouton) qui a exactement sa taille.
 * Pour une carte ordinaire, c'est le bouton lui-même ; pour une carte du Top 10, le cadre de
 * l'affiche, sans le grand chiffre qui la précède — il reste à l'écran pendant que l'affiche part.
 */
function frameOf(img: HTMLElement, control: HTMLElement): { frame: HTMLElement; radius: number } {
  const ir = img.getBoundingClientRect();
  let frame: HTMLElement = img;
  let radius = radiusOf(img);
  if (ir.width <= 0 || ir.height <= 0) return { frame: control, radius: radiusOf(control) };
  for (let p = img.parentElement; p; p = p.parentElement) {
    const r = p.getBoundingClientRect();
    if (Math.abs(r.left - ir.left) > 2 || Math.abs(r.top - ir.top) > 2 || Math.abs(r.width - ir.width) > 2 || Math.abs(r.height - ir.height) > 2) break;
    frame = p;
    radius = Math.max(radius, radiusOf(p));
    if (p === control) break;
  }
  return { frame, radius };
}

/** La source qu'un élément touché désigne, s'il en désigne une. */
export function sourceFrom(node: EventTarget | null): SheetSource | null {
  if (!(node instanceof Element)) return null;
  let control = node.closest<HTMLElement>(CONTROL);
  if (!control || control.closest("[data-sheet-no-source], [data-sheet-morph-layer]")) return null;
  // Un bouton posé sur une carte qui se déclare source (« Plus d'infos » sur l'affiche de la
  // bannière du téléphone) ouvre la fiche depuis cette carte.
  if (!control.querySelector("img") && !control.hasAttribute("data-sheet-source-target")) {
    const card = control.parentElement?.closest<HTMLElement>("[data-sheet-source]");
    if (card) control = card;
  }
  const selector = control.getAttribute("data-sheet-source-target");
  const holder = selector ? document.querySelector<HTMLElement>(selector) : control;
  if (!holder) return null;
  const img = holder instanceof HTMLImageElement ? holder : holder.querySelector<HTMLImageElement>("img");
  const image = img ? img.currentSrc || img.src : "";
  if (!img || !image) return null;
  const { frame, radius } = frameOf(img, selector ? holder : control);
  return { control, frame, image, radius };
}

/** Les écouteurs du geste, posés une fois, à la capture — avant que quiconque ne l'arrête. */
export function installPressTracker(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "pointerdown",
    (e) => {
      const control = e.target instanceof Element ? e.target.closest<HTMLElement>(CONTROL) : null;
      down = control ? { control, x: e.clientX, y: e.clientY, id: e.pointerId } : null;
    },
    true,
  );
  document.addEventListener(
    "pointerup",
    (e) => {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > PRESS_SLOP_PX) return;
      note(d.control);
    },
    true,
  );
  // Le clavier, la souris sans `pointerup` noté (un clic synthétisé), et ce que `useTap` laisse au `click`.
  document.addEventListener("click", (e) => note(e.target), true);
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" || e.key === " ") note(document.activeElement);
    },
    true,
  );
}

function note(node: EventTarget | null): void {
  const source = sourceFrom(node);
  if (source) pending = { source, at: now() };
  // Un appui ailleurs (un bouton sans image, la croix d'une fiche) efface le précédent : la fiche
  // qui se monterait ensuite n'en vient pas.
  else if (node instanceof Element && node.closest(CONTROL)) pending = null;
}

/** Y a-t-il un appui récent ? Sans le consommer — la décision du premier rendu. */
export function peekPress(): boolean {
  return pending !== null && now() - pending.at <= PRESS_FRESH_MS && pending.source.frame.isConnected;
}

/** L'appui récent, consommé : une seule fiche part d'un appui. */
export function takePress(): SheetSource | null {
  const p = pending;
  pending = null;
  if (!p || now() - p.at > PRESS_FRESH_MS || !p.source.frame.isConnected) return null;
  return p.source;
}

/** Oublie l'appui en attente (les tests, et une fiche qui se monte sans vouloir en partir). */
export function forgetPress(): void {
  pending = null;
  down = null;
}

/**
 * La source, retrouvée au moment du retour.
 *
 * La carte d'origine peut avoir été redessinée entre-temps — une rangée qui se réordonne à
 * l'arrivée de données fraîches, une grille remontée. Son élément n'est alors plus dans la page :
 * on cherche une image visible de même adresse, hors de ce qu'on exclut (la fiche qui se ferme, les
 * calques du trajet). Visible à moitié au moins, sinon rien : on ne vole pas vers un endroit qu'on
 * ne voit pas.
 */
export function visibleSource(source: SheetSource, exclude: (Element | null)[]): SheetSource | null {
  if (source.frame.isConnected && visibleFraction(source.frame) >= 0.5) return source;
  for (const img of Array.from(document.images)) {
    if ((img.currentSrc || img.src) !== source.image) continue;
    if (exclude.some((e) => e?.contains(img)) || img.closest("[data-sheet-morph-layer]")) continue;
    const control = img.closest<HTMLElement>(CONTROL);
    if (!control) continue;
    const { frame, radius } = frameOf(img, control);
    if (visibleFraction(frame) >= 0.5) return { control, frame, image: source.image, radius };
  }
  return null;
}

/** Cache le cadre de l'affiche le temps que la fiche en vient ou y retourne — sans transition d'opacité. */
export function hideSource(source: SheetSource): void {
  const s = source.frame.style;
  s.transitionProperty = "transform, box-shadow";
  s.opacity = "0";
}

/**
 * La rend, instantanément. La transition d'opacité reste coupée deux images de plus : rétablie dans
 * la même image que l'opacité, la règle de base des boutons ferait remonter l'affiche en 150 ms sous
 * le calque qui s'efface — le clignotement plus foncé de la neuvième passe.
 */
export function showSource(source: SheetSource): void {
  const el = source.frame;
  el.style.opacity = "";
  const raf = typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame.bind(window) : (cb: () => void) => window.setTimeout(cb, 16);
  raf(() =>
    raf(() => {
      if (el.style.opacity === "") el.style.transitionProperty = "";
    }),
  );
}

