import { isAppleTouchDevice } from "@/lib/iosInstall";

/**
 * L'écran rétréci de l'application installée sur iPhone et iPad (04/11/2026).
 *
 * Revenu dans Laterna après un moment, le propriétaire trouvait la page coupée aux deux tiers : la
 * barre flottante posée au milieu de l'écran, du noir dessous, comme si le clavier était encore
 * là. Un passage par l'accueil, ou parfois un glissé, la remettait d'aplomb. C'est un défaut de
 * WebKit en mode installé (`display-mode: standalone`), signalé sur iOS 26 (WebKit 301857) : une fois
 * le clavier fermé, la hauteur de la fenêtre reste celle *avec* le clavier, et tout ce qui se mesure
 * en `vh` (`app-viewport`) garde cette hauteur-là. Rien en CSS ne la remesure ; ce qui marche,
 * relevé par d'autres, est de retirer un instant du rendu un élément de toute la hauteur, avec une
 * mise en page synchrone entre les deux — WebKit relit alors la vraie hauteur.
 *
 * Le cas confirmé par le propriétaire le même jour : le clavier ouvert dans une autre app, puis retour
 * dans Laterna — qui se dessine à la hauteur avec clavier, et peut même *démarrer* ainsi, sans
 * avoir jamais vu sa vraie hauteur. Sur iPhone, la référence est donc aussi l'écran lui-même : en
 * application installée, `black-translucent` et `viewport-fit=cover`, la page en occupe toute la
 * hauteur. Pas sur iPad, où une fenêtre partagée (Split View, Stage Manager) est légitimement plus
 * basse que l'écran.
 *
 * Seulement quand la page est vraiment plus basse que la plus haute vue dans cette orientation, et
 * qu'aucun champ n'a le focus (le clavier peut être là pour de bon). Jamais pendant un film : retirer
 * du rendu une vidéo qui joue n'est pas un geste anodin. Les positions de défilement sont remises
 * telles quelles.
 */

const SETTLE_AFTER_BLUR_MS = 140;
const SETTLE_AFTER_SHOW_MS = 300;
/** Le jeu toléré entre deux mesures de la même orientation. */
const SLACK_PX = 4;

export type ViewportHealDeps = {
  win: Window;
  /** L'élément de toute la hauteur qu'on retire un instant du rendu. */
  shell: () => HTMLElement | null;
  /** Un film à l'écran : on ne touche à rien. */
  playing: () => boolean;
  /** La hauteur que la page doit avoir, quand l'appareil la donne (iPhone) ; `null` sinon. */
  fullHeight?: () => number | null;
};

function editableFocused(doc: Document): boolean {
  const el = doc.activeElement as HTMLElement | null;
  if (!el || el === doc.body) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(type);
}

/** La hauteur que la page croit avoir : la fenêtre, et la coquille si elle est plus basse. */
function measuredHeight(win: Window, shell: HTMLElement | null): number {
  const inner = win.innerHeight;
  const box = shell ? shell.getBoundingClientRect().height : inner;
  return Math.min(inner, box);
}

/** Retire la coquille du rendu le temps d'une mise en page, et remet chaque défilement où il était. */
export function reflowShell(shell: HTMLElement): void {
  const scrolled: [Element, number, number][] = [];
  for (const el of shell.querySelectorAll("*")) {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) scrolled.push([el, el.scrollTop, el.scrollLeft]);
  }
  const previous = shell.style.display;
  shell.style.display = "none";
  void shell.offsetHeight;
  shell.style.display = previous;
  for (const [el, top, left] of scrolled) {
    el.scrollTop = top;
    el.scrollLeft = left;
  }
}

/**
 * Écoute la fenêtre et répare la hauteur quand elle est restée coincée. Renvoie de quoi se
 * désabonner. Les dépendances sont injectées pour les tests ; `installViewportHeal` pose les vraies.
 */
export function watchViewportHeal({ win, shell, playing, fullHeight = () => null }: ViewportHealDeps): () => void {
  const doc = win.document;
  // La plus grande hauteur vue, par largeur : tourner l'appareil change légitimement la hauteur.
  const tallest = new Map<number, number>();
  const note = () => {
    const width = win.innerWidth;
    tallest.set(width, Math.max(tallest.get(width) ?? 0, win.innerHeight));
  };
  note();

  let timer: number | undefined;
  const heal = () => {
    timer = undefined;
    if (doc.visibilityState === "hidden" || editableFocused(doc) || playing()) return;
    const el = shell();
    if (!el) return;
    const best = Math.max(tallest.get(win.innerWidth) ?? 0, fullHeight() ?? 0);
    if (best - measuredHeight(win, el) <= SLACK_PX) return;
    reflowShell(el);
    note();
  };
  const later = (ms: number) => {
    if (timer !== undefined) win.clearTimeout(timer);
    timer = win.setTimeout(heal, ms);
  };

  const onFocusOut = () => later(SETTLE_AFTER_BLUR_MS);
  const onVisible = () => {
    if (doc.visibilityState === "visible") later(SETTLE_AFTER_SHOW_MS);
  };
  const onPageShow = () => later(SETTLE_AFTER_SHOW_MS);
  // Un rétrécissement sans champ actif chez nous : le clavier d'une autre app, appliqué au retour
  // par un glissé de la barre d'accueil — parfois après l'évènement de visibilité.
  const onResize = () => {
    note();
    later(SETTLE_AFTER_SHOW_MS);
  };
  win.addEventListener("resize", onResize);
  doc.addEventListener("focusout", onFocusOut);
  doc.addEventListener("visibilitychange", onVisible);
  win.addEventListener("pageshow", onPageShow);
  return () => {
    if (timer !== undefined) win.clearTimeout(timer);
    win.removeEventListener("resize", onResize);
    doc.removeEventListener("focusout", onFocusOut);
    doc.removeEventListener("visibilitychange", onVisible);
    win.removeEventListener("pageshow", onPageShow);
  };
}

/** L'application installée sur iPhone ou iPad, et rien d'autre : ailleurs, la hauteur ne se coince pas. */
export function installViewportHeal(): () => void {
  if (typeof window === "undefined" || !isAppleTouchDevice()) return () => {};
  if (window.matchMedia?.("(display-mode: standalone)").matches !== true) return () => {};
  const iphone = /iPhone|iPod/.test(navigator.userAgent);
  return watchViewportHeal({
    win: window,
    // Les dimensions de `screen` sont celles du portrait, quelle que soit l'orientation : la largeur
    // de la page dit laquelle des deux est sa hauteur. Une largeur qui ne correspond à aucune : rien.
    fullHeight: () => {
      if (!iphone) return null;
      const { width, height } = window.screen;
      if (window.innerWidth === width) return height;
      if (window.innerWidth === height) return width;
      return null;
    },
    shell: () => document.querySelector<HTMLElement>(".app-viewport"),
    playing: () => Array.from(document.querySelectorAll("video")).some((v) => !v.paused && !v.ended),
  });
}
