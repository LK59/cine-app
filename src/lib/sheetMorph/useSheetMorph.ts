"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { phoneSheetCorner } from "@/lib/sheetMotion";
import { arrivedByBack } from "@/lib/cinemaRoute";
import {
  CONTENT_OUT_MS,
  DIM,
  FADE_IN_MS,
  FADE_OUT_MS,
  GHOST_FADE_MS,
  GHOST_SNAP_AT,
  HANDOVER_MS,
  HOME_SCALE,
  IDENTITY,
  PLAIN_OUT_DROP,
  PLAIN_OUT_MS,
  REVEAL_AT,
  REVEAL_MS,
  REVEAL_RISE_PX,
  GLASS_IN,
  appleCloseMotion,
  appleOpenMotion,
  cardOpenPoses,
  cardRestPose,
  clamp,
  closePoses,
  closeStartVelocity,
  coverTf,
  lerp,
  lerpBox,
  lerpCorners,
  lerpTf,
  morphTracks,
  openPoses,
  releaseVelocity,
  sampleMotion,
  shiftPose,
  smooth,
  sourcePose,
  timeAt,
  travelOf,
  uniformCorners,
  type Box,
  type Corners,
  type Motion,
  type Pose,
  type Sample,
  type Stage,
} from "./motion";
import { afterTwoFrames, clearSheetTimeout, sheetFrame, sheetTimeout, boxOf, clockNow, detectProfile, opacityNow, place, prefersReducedMotion, promote, scaleOf, startTogether, swallowStrayClick, translateYOf } from "./dom";
import { hideSource, installPressTracker, peekPress, showSource, takePress, visibleSource, type SheetSource } from "./source";

/**
 * L'ouverture et la fermeture des fiches de titre (DECISIONS.md §61) : la carte touchée devient la
 * fiche, et la fiche y retourne.
 *
 * Validé sur la page « Tests animations » (lot H, neuf passes, 10/10/2026) ; cette fonction en est le
 * portage dans les vraies fiches — CinemaMobileDetail (téléphone), CinemaMovieDetail et
 * CinemaSeriesDetail (bureau, iPad), PlayerDiscoverSheet (les deux). Une décision, un endroit.
 *
 * Ce que la fiche marque dans son DOM, et que ce crochet lit :
 * - `data-sheet-photo` : son visuel (une `<img>`), caché le temps du trajet ;
 * - `data-sheet-veil` : les voiles posés sur le visuel, copiés dans le calque du trajet ;
 * - `data-sheet-content` : ce qui arrive d'un bloc à 90 % du trajet et s'efface à la fermeture ;
 * - `data-sheet-settle` : ce qui ne paraît qu'une fois posé (le flou localisé du bureau) ;
 * - `data-sheet-glass` : le verre (un `backdrop-filter`), coupé pendant le mouvement.
 *
 * Ce qui a réglé la forme du code, chaque point payé d'une passe :
 *
 * 1. **Un calque à part, sous la fiche.** Le trajet (la fenêtre transformée et ce qu'elle porte) et
 *    l'assombrissement vivent dans un calque inséré juste avant la fiche dans `body`, au même plan :
 *    la colonne de la fiche passe *au-dessus* de ce qui vole, et la fiche du dessous d'une cascade,
 *    elle, passe dessous. Le fond de la fiche est transparent pendant le trajet.
 * 2. **Au téléphone, la carte entière est la fenêtre** (`cardOpenPoses`, le modèle des cartes
 *    d'iOS) : l'affiche grandit jusqu'à la carte, bannière en haut, encre dessous, et la carte
 *    rétrécit d'une pièce dans l'affiche à la fermeture. La bannière volant seule au-dessus d'un fond
 *    de carte qui montait à part plongeait, se décollait, et redescendait plus vite que le doigt
 *    (audit du 10/10/2026). Au bureau et à l'iPad large, la fenêtre reste le visuel plein écran.
 * 3. **La fermeture ne retient pas l'adresse.** Au premier instant d'une fermeture, ce qui est à
 *    l'écran de la fiche est copié dans ce calque, et c'est la copie qui s'efface pendant que la
 *    fenêtre revole vers l'affiche ; la vraie fiche est cachée et rend l'adresse aussitôt : l'accueil
 *    répond dès que la fermeture commence (huitième passe).
 * 4. **Rien ne tourne sur le fil principal pendant le trajet.** Tout est mesuré avant, échantillonné
 *    en images clés (transformations et opacités seulement, ≥ 60 par trajet ; pas de rayon animé, qui
 *    se peint sur le fil principal à chaque image), créé en pause, lancé une image après que le
 *    montage — ou la copie de la fermeture — a été mis en page, sur un même `startTime`. Le seul
 *    rendu React est celui du repos (`settled`), après l'arrivée.
 */

if (typeof document !== "undefined") installPressTracker();

export type SheetLayout = "phone" | "desktop";

export type SheetMorphOptions = {
  /** La mise en page de la fiche : la carte du téléphone, ou le visuel plein écran. */
  layout: SheetLayout;
  /** La racine de la fiche (la carte au téléphone, l'écran entier au bureau). */
  rootRef: RefObject<HTMLElement | null>;
  /** Là où arrive le visuel : la bannière au téléphone, la racine elle-même au bureau. */
  imageRef: RefObject<HTMLElement | null>;
  /** Faux pour une fiche recouverte : elle ne s'ouvre ni ne se ferme d'elle-même. */
  active: boolean;
  /** La fiche a commencé à sortir (`closing` de `useDelayedClose`, ou `leaving` de la coquille). */
  leaving: boolean;
  /** Montée par un retour (`arrivedByBack`) : elle se découvre, rien ne vole. */
  revealed: boolean;
  /** Faux tant que le visuel n'est pas connu (la fiche TMDB attend sa réponse) : pas de trajet à l'ouverture. */
  ready?: boolean;
  /** La sortie découvre un écran qui n'est pas dessiné : aucune animation, l'échange en un rendu. */
  instantExit?: boolean;
  /**
   * Vrai quand une autre transition mène cette fiche — la continuité du fond au bureau
   * (`desktopContinuity.ts`) : ce crochet ne fait alors rien du tout. Décidé au montage.
   */
  off?: boolean;
};

export type SheetMorph = {
  /**
   * Vrai quand ce crochet mène l'entrée de la fiche (un trajet, ou le fondu de « Réduire les
   * animations ») : la fiche retire alors sa propre classe d'entrée. Fixé au montage, pour la vie de
   * la fiche — remise plus tard, la classe rejouerait l'entrée.
   */
  handlesEntry: boolean;
  /**
   * Vrai une fois l'entrée posée, au premier moment calme qui suit (ou d'emblée, sans entrée menée
   * ici) : ce qui est sous la ligne de flottaison se monte alors. Monté sur une minuterie fixe, il
   * tombait au milieu ou à la fin du trajet, dans un contenu promu (audit du 10/10/2026).
   */
  settled: boolean;
};

type Entry = "morph" | "fade" | "none";

/** Une fermeture en vol : de quoi la retourner en ouverture, ou la couper pour une autre. */
type Flight = {
  source: SheetSource;
  layout: SheetLayout;
  /** Le relais final a commencé (la vraie carte est revenue dessous) — trop tard pour la retourner. */
  handover: boolean;
  takeOver: () => { pose: Pose; v0: (ahead: number) => number; dim: number; home: number | null };
  cut: () => { dim: number; home: number | null };
};

/** Les fermetures en vol, toutes fiches confondues : une ouverture les coupe ou en retourne une. */
const flights = new Set<Flight>();
/** Le recul de l'accueil du bureau — une seule animation à la fois, quelle que soit la fiche qui la mène. */
const homeMotion: { anim: Animation | null } = { anim: null };

const homeElement = () => (typeof document === "undefined" ? null : document.querySelector<HTMLElement>("[data-sheet-home]"));

/** Les autres fiches ouvertes : seule la première fait reculer l'accueil, celles du dessus passent devant une fiche. */
function otherSheetsOpen(root: HTMLElement): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-sheet-morph-root]")).some((el) => el !== root && el.style.visibility !== "hidden");
}

/**
 * Sans Web Animations (jsdom, un moteur très ancien), rien ne vole : la fiche entre par sa propre
 * classe et sort d'un coup. Tous les navigateurs visés l'ont ; les tests de composants, non.
 */
function canAnimate(): boolean {
  return typeof Element !== "undefined" && typeof Element.prototype.animate === "function";
}

function decideEntry(o: SheetMorphOptions): Entry {
  if (o.off) return "none";
  if (typeof window === "undefined" || !canAnimate() || !o.active || o.revealed || !peekPress()) return "none";
  if (prefersReducedMotion()) return "fade";
  return o.ready === false ? "none" : "morph";
}

/** Le fond d'une fiche pendant un trajet : transparent — la fenêtre porte l'encre de la carte au téléphone, le visuel plein écran au bureau. */
function holdTransparent(layout: SheetLayout): Partial<CSSStyleDeclaration> {
  return layout === "phone" ? { backgroundColor: "transparent", backgroundImage: "none", boxShadow: "none" } : { backgroundColor: "transparent" };
}

const LINEAR = (duration: number, fill: FillMode = "both"): KeyframeAnimationOptions => ({ duration, easing: "linear", fill });

/** Au premier moment calme (une image, puis l'inactivité du navigateur) : le rendu du repos ne tombe pas sur l'arrivée. */
function whenCalm(fn: () => void): () => void {
  let cancelled = false;
  let idleId: number | null = null;
  const cancelFrame = sheetFrame(() => {
    if (cancelled) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (typeof w.requestIdleCallback === "function") idleId = w.requestIdleCallback(() => !cancelled && fn(), { timeout: 250 });
    else sheetTimeout(() => !cancelled && fn(), 0);
  });
  return () => {
    cancelled = true;
    cancelFrame();
    const w = window as Window & { cancelIdleCallback?: (id: number) => void };
    if (idleId !== null) w.cancelIdleCallback?.(idleId);
  };
}

/**
 * Le calque du trajet, inséré juste avant la fiche dans le DOM et au même plan qu'elle : la fiche
 * passe devant lui, tout ce qui était dessous passe derrière. Ni transformation, ni `contain` — la
 * copie d'une fiche (`position: fixed`) doit s'y placer par rapport à l'écran.
 */
function createLayer(root: HTMLElement, ink: string): { layer: HTMLElement; dim: HTMLElement } {
  const layer = document.createElement("div");
  layer.setAttribute("data-sheet-morph-layer", "");
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: getComputedStyle(root).zIndex || "47" });
  const dim = document.createElement("div");
  Object.assign(dim.style, { position: "absolute", inset: "0", background: ink, opacity: "0" });
  layer.appendChild(dim);
  root.parentNode?.insertBefore(layer, root);
  return { layer, dim };
}

/**
 * La fenêtre du trajet et ce qu'elle porte : l'encre de la carte (téléphone), le visuel de la fiche
 * et ses voiles, l'affiche touchée — ces deux derniers chacun dans un fondu à part (`bdFade`,
 * `posterFade`), qui reprend la main quand le visuel arrive en plein vol.
 */
type MorphWindow = { win: HTMLElement; inner: HTMLElement; bd: HTMLElement; bdImg: HTMLImageElement; poster: HTMLImageElement; bdFade: HTMLElement; posterFade: HTMLElement };

function buildWindow(
  layer: HTMLElement,
  before: Node | null,
  stage: Stage,
  base: Box,
  banner: Box,
  source: Box,
  posterSrc: string,
  backdropSrc: string,
  veils: Element[],
  radius: number,
  card: { box: Box; ink: string } | null
): MorphWindow {
  const win = document.createElement("div");
  // Un rayon fixe, en unités de la fenêtre : animé, il se peignait sur le fil principal à chaque
  // image et ses coins traînaient derrière la transformation (audit du 10/10/2026). Étiré avec la
  // fenêtre, il n'est un peu faux qu'au tout début, quand la fenêtre est petite et va vite.
  Object.assign(win.style, { position: "absolute", overflow: "hidden", transformOrigin: "0 0", borderRadius: `${radius}px` });
  place(win, base);
  const inner = document.createElement("div");
  Object.assign(inner.style, { position: "absolute", left: "0", top: "0", width: `${stage.W}px`, height: `${stage.H}px`, transformOrigin: "0 0" });
  if (card) {
    const ink = document.createElement("div");
    Object.assign(ink.style, { position: "absolute", background: card.ink });
    place(ink, card.box);
    inner.appendChild(ink);
  }
  const layerOf = () => {
    const el = document.createElement("div");
    Object.assign(el.style, { position: "absolute", inset: "0" });
    return el;
  };
  const bdFade = layerOf();
  const bd = document.createElement("div");
  Object.assign(bd.style, { position: "absolute", overflow: "hidden", transformOrigin: "0 0" });
  place(bd, banner);
  const bdImg = document.createElement("img");
  bdImg.alt = "";
  bdImg.decoding = "async";
  Object.assign(bdImg.style, { position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "cover" });
  bdImg.src = backdropSrc;
  bd.appendChild(bdImg);
  // Les voiles voyagent avec le visuel : posés à leur place pendant que l'image vole, ils
  // assombrissaient l'accueil hors de la fenêtre (troisième passe).
  for (const veil of veils) {
    const copy = veil.cloneNode(true) as HTMLElement;
    Object.assign(copy.style, { position: "absolute", inset: "0", visibility: "visible" });
    bd.appendChild(copy);
  }
  bdFade.appendChild(bd);
  const posterFade = layerOf();
  const poster = document.createElement("img");
  poster.alt = "";
  Object.assign(poster.style, { position: "absolute", objectFit: "cover", transformOrigin: "0 0" });
  place(poster, source);
  poster.src = posterSrc;
  posterFade.appendChild(poster);
  inner.append(bdFade, posterFade);
  win.appendChild(inner);
  layer.insertBefore(win, before);
  return { win, inner, bd, bdImg, poster, bdFade, posterFade };
}

/** Les pistes du trajet sur la fenêtre, créées en pause : transformations et opacités seulement. */
function trackAnims(w: MorphWindow, poseAt: (q: number) => Pose, motion: Motion, base: Box, stage: Stage, samples: Sample[]): Animation[] {
  const tracks = morphTracks(poseAt, samples, base, stage, "transform");
  const opts = LINEAR(motion.duration);
  const anims = [w.win.animate(tracks.win, opts), w.inner.animate(tracks.inner, opts), w.bd.animate(tracks.bd, opts), w.poster.animate(tracks.poster, opts)];
  for (const a of anims) (a as Partial<Animation>).pause?.();
  return anims;
}

/** Attend le décodage des images du trajet — au plus 150 ms : elles sont d'ordinaire déjà là. */
function decoded(imgs: HTMLImageElement[]): Promise<unknown> {
  const all = Promise.all(imgs.map((img) => img.decode?.().catch(() => undefined)));
  return Promise.race([all, new Promise<void>((ok) => sheetTimeout(() => ok(), 150))]);
}

/**
 * La copie de la fiche qui sort à sa place : inerte, sans vidéo ni identifiant, ses animations CSS et
 * son verre coupés (`.sheet-morph-clone`, globals.css), défilée exactement comme l'original.
 */
function cloneSheet(root: HTMLElement, layer: HTMLElement): HTMLElement {
  const copy = root.cloneNode(true) as HTMLElement;
  finishCopy(copy, layer);
  // Le défilement, après l'insertion : le conteneur intérieur du bureau et les rangées horizontales
  // (titres similaires) — sinon la copie repartirait en haut.
  const walkA = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const walkB = document.createTreeWalker(copy, NodeFilter.SHOW_ELEMENT);
  for (let a: Node | null = walkA.currentNode, b: Node | null = walkB.currentNode; a && b; a = walkA.nextNode(), b = walkB.nextNode()) {
    const ea = a as HTMLElement;
    if (ea.scrollTop || ea.scrollLeft) {
      (b as HTMLElement).scrollTop = ea.scrollTop;
      (b as HTMLElement).scrollLeft = ea.scrollLeft;
    }
  }
  return copy;
}

function finishCopy(copy: HTMLElement, layer: HTMLElement): void {
  copy.classList.add("sheet-morph-clone");
  copy.removeAttribute("data-sheet-morph-root");
  copy.removeAttribute("data-sheet-flying");
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  for (const el of Array.from(copy.querySelectorAll("video, audio, iframe"))) el.remove();
  for (const el of Array.from(copy.querySelectorAll("[id]"))) el.removeAttribute("id");
  copy.style.pointerEvents = "none";
  copy.style.visibility = "visible";
  layer.appendChild(copy);
}

/**
 * La copie *légère* de la fiche du téléphone pour sa sortie : seulement ce qui est à l'écran.
 *
 * Copier toute la fiche — la liste des épisodes, les rangées de titres similaires et toutes leurs
 * images — coûtait une longue image sur l'iPhone juste au départ du retour (Louis, 8.31.4). Ici,
 * chaque bloc entièrement hors de l'écran devient un simple bloc vide de la même hauteur (le
 * défilement reste exact), et seuls les blocs visibles sont copiés en entier. Les mesures se font sur
 * l'original pendant qu'on assemble des nœuds détachés : aucune mise en page forcée entre deux lectures.
 */
function cloneVisible(root: HTMLElement, layer: HTMLElement, H: number): HTMLElement {
  const deep: [HTMLElement, HTMLElement][] = [];
  const build = (el: HTMLElement, depth: number): HTMLElement => {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > H) {
      const hole = el.cloneNode(false) as HTMLElement;
      Object.assign(hole.style, { height: `${r.height}px`, minHeight: "0", boxSizing: "border-box", overflow: "hidden", visibility: "hidden" });
      return hole;
    }
    if (depth < 3 && el.children.length > 0 && r.height > H) {
      // Plus grand que l'écran : on descend d'un cran pour n'en garder que la partie visible.
      const shallow = el.cloneNode(false) as HTMLElement;
      for (const child of Array.from(el.childNodes)) {
        shallow.appendChild(child instanceof HTMLElement ? build(child, depth + 1) : child.cloneNode(true));
      }
      return shallow;
    }
    const copy = el.cloneNode(true) as HTMLElement;
    deep.push([el, copy]);
    return copy;
  };
  const copy = root.cloneNode(false) as HTMLElement;
  for (const child of Array.from(root.childNodes)) copy.appendChild(child instanceof HTMLElement ? build(child, 1) : child.cloneNode(true));
  finishCopy(copy, layer);
  copy.scrollTop = root.scrollTop;
  // Les rangées horizontales copiées gardent leur défilement (titres similaires).
  for (const [a, b] of deep) {
    const walkA = document.createTreeWalker(a, NodeFilter.SHOW_ELEMENT);
    const walkB = document.createTreeWalker(b, NodeFilter.SHOW_ELEMENT);
    for (let x: Node | null = walkA.currentNode, y: Node | null = walkB.currentNode; x && y; x = walkA.nextNode(), y = walkB.nextNode()) {
      const ex = x as HTMLElement;
      if (ex.scrollLeft || ex.scrollTop) {
        (y as HTMLElement).scrollLeft = ex.scrollLeft;
        (y as HTMLElement).scrollTop = ex.scrollTop;
      }
    }
  }
  return copy;
}

/** Le fondu du relais d'affiche vers le vrai visuel : assez long pour se voir comme un fondu, pas comme une attente. */
export const STAND_IN_FADE_MS = 300;

/**
 * Le visuel arrivé en plein vol : il paraît sur l'affiche *pendant* le trajet, en fondu, au lieu de
 * la remplacer d'un coup à l'arrivée. Fini au plus tard à 70 % du trajet ou à l'arrivée ; trop tard
 * pour un fondu qui se voie (moins de `MIDFLIGHT_MIN_MS`), le relais d'arrivée s'en charge.
 */
const MIDFLIGHT_MIN_MS = 60;
const MIDFLIGHT_FADE_MS = 140;

/**
 * L'image qui a volé reste posée sur la bannière tant que le vrai visuel n'y est pas *entièrement*
 * chargé, puis s'efface en fondu.
 *
 * Trois façons d'avoir montré du noir, chacune vue : un visuel encore en chargement rendu opaque à
 * l'arrivée (un JPEG progressif lourd se peint par bandes — la fine bande d'image en haut d'une
 * bannière noire, au premier lancement, sur une fiche de série : Louis, iPhone, 10/10/2026) ; un
 * visuel dont l'adresse change après l'arrivée (les données fraîches qui remplacent celles du cache) ;
 * un visuel monté seulement après l'arrivée. La garde suit donc l'image *présente* dans la bannière
 * (`MutationObserver`), pas celle du départ, et ne la rend opaque qu'une fois chargée. Un visuel qui
 * échoue, ou qui n'existe pas, laisse l'image en place : une affiche vaut mieux qu'une bannière vide.
 */
function standInUntilLoaded(container: HTMLElement, standIn: string): void {
  const photoNow = () => container.querySelector<HTMLImageElement>("[data-sheet-photo]");
  const first = photoNow();
  const over = document.createElement("div");
  over.setAttribute("data-sheet-standin", "");
  over.setAttribute("aria-hidden", "true");
  const box: Partial<CSSStyleDeclaration> =
    first && getComputedStyle(container).position === "static"
      ? { left: `${first.offsetLeft}px`, top: `${first.offsetTop}px`, width: `${first.offsetWidth}px`, height: `${first.offsetHeight}px` }
      : { inset: "0" };
  Object.assign(over.style, {
    position: "absolute",
    ...box,
    pointerEvents: "none",
    backgroundImage: `url("${standIn}")`,
    backgroundSize: "cover",
    backgroundPosition: "center",
  } satisfies Partial<CSSStyleDeclaration>);
  // Au-dessus du visuel, sous les voiles (ses frères suivants) ; sans visuel, en tête de la bannière —
  // un visuel monté plus tard par React prend la place du fond uni, sous elle.
  if (first) first.insertAdjacentElement("afterend", over);
  else container.prepend(over);

  let watched: HTMLImageElement | null = null;
  let done = false;
  const ready = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;
  const finish = (img: HTMLImageElement) => {
    if (done) return;
    done = true;
    observer?.disconnect();
    watched?.removeEventListener("load", onLoad);
    img.style.transition = "none";
    img.style.opacity = "1";
    if (!over.isConnected || typeof over.animate !== "function") {
      over.remove();
      return;
    }
    const anim = over.animate([{ opacity: 1 }, { opacity: 0 }], { duration: STAND_IN_FADE_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" });
    anim.onfinish = () => over.remove();
  };
  const onLoad = () => {
    if (watched && ready(watched)) finish(watched);
  };
  const check = () => {
    if (done) return;
    if (!over.isConnected) {
      observer?.disconnect();
      return;
    }
    const img = photoNow();
    if (img !== watched) {
      watched?.removeEventListener("load", onLoad);
      watched = img;
      watched?.addEventListener("load", onLoad);
    }
    if (img && ready(img)) finish(img);
  };
  const observer = typeof MutationObserver === "function" ? new MutationObserver(check) : null;
  observer?.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  check();
}

export function useSheetMorph(opts: SheetMorphOptions): SheetMorph {
  // Décidé au premier rendu — la fiche en retire sa classe d'entrée dès ce rendu-là.
  const [entry] = useState<Entry>(() => decideEntry(opts));
  const [settled, setSettled] = useState(entry === "none");
  const optsRef = useRef(opts);
  // Tenu à jour avant les autres effets de mise en page : la fermeture lit les options du rendu où
  // elle commence, pas celles du précédent.
  useLayoutEffect(() => {
    optsRef.current = opts;
  });

  // Tout ce que l'ouverture et la fermeture se transmettent. Rien de cela ne fait redessiner.
  const st = useRef<{
    source: SheetSource | null;
    layer: HTMLElement | null;
    dim: HTMLElement | null;
    win: MorphWindow | null;
    /** L'aller en cours ou fini : de quoi reprendre son point et sa vitesse si une fermeture l'interrompt. */
    run: {
      motion: Motion;
      poseAt: (q: number) => Pose;
      startedAt: number | null;
      span: number;
      /** Où se pose le visuel (la bannière au téléphone), et la boîte de base de la fenêtre (la carte). */
      target: Box;
      base: Box;
      stage: Stage;
      /** L'animation qui règle l'horloge du trajet : son `currentTime` dit où il en est vraiment. */
      clock: Animation | null;
    } | null;
    openAnims: Animation[];
    cancelStart: (() => void) | null;
    timers: number[];
    /** Ce que l'ouverture a changé sur la vraie fiche, à défaire à l'arrivée. */
    restore: (() => void)[];
    /** Le verre, rendu deux images après l'arrivée et non dans l'image même du relais. */
    restoreGlass: (() => void)[];
    unpromote: (() => void) | null;
    /** Le visuel a pris la place de l'affiche pendant le trajet (arrivé en plein vol). */
    bdShown: boolean;
    cancelCalm: (() => void) | null;
    closing: boolean;
    closeAt: number;
    mountedAt: number;
    ownsHome: boolean;
    moves: { t: number; y: number }[];
    upAt: number;
    clickAt: number;
  }>({
    source: null,
    layer: null,
    dim: null,
    win: null,
    run: null,
    openAnims: [],
    cancelStart: null,
    timers: [],
    restore: [],
    restoreGlass: [],
    unpromote: null,
    bdShown: false,
    cancelCalm: null,
    closing: false,
    closeAt: 0,
    mountedAt: 0,
    ownsHome: false,
    moves: [],
    upAt: -Infinity,
    clickAt: -Infinity,
  });

  // Le doigt sur la fiche : sa vitesse au relâché lance le retour, et un retour lancé par le
  // relâchement (le geste de la bannière) avale le `click` qui le suit. Écouté sur la racine, donc
  // avant React, dont les écouteurs sont sur le conteneur du portail.
  useEffect(() => {
    const root = opts.rootRef.current;
    if (!root) return;
    const s = st.current;
    const onDown = (e: PointerEvent) => {
      s.moves = [{ t: e.timeStamp, y: e.clientY }];
    };
    const onMove = (e: PointerEvent) => {
      if (!e.buttons && e.pointerType === "mouse") return;
      s.moves.push({ t: e.timeStamp, y: e.clientY });
      if (s.moves.length > 12) s.moves.shift();
    };
    const onUp = (e: PointerEvent) => {
      s.moves.push({ t: e.timeStamp, y: e.clientY });
      s.upAt = performance.now();
    };
    const onClick = () => {
      s.clickAt = performance.now();
    };
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove, { passive: true });
    root.addEventListener("pointerup", onUp);
    root.addEventListener("click", onClick);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("click", onClick);
    };
  }, [opts.rootRef]);

  /** Le repos : ce qui attendait l'arrivée se monte, au premier moment calme. */
  function markSettled() {
    const s = st.current;
    if (s.cancelCalm) return;
    s.cancelCalm = whenCalm(() => setSettled(true));
  }

  // L'ouverture, une fois, au montage.
  useLayoutEffect(() => {
    const root = opts.rootRef.current;
    if (!root || optsRef.current.off) return;
    const s = st.current;
    root.setAttribute("data-sheet-morph-root", "");
    const o = optsRef.current;
    // Gardée même sans trajet à l'ouverture (la fiche TMDB qui attend sa réponse) : la fermeture
    // pourra y revenir.
    // Repris tel quel au second montage du mode strict de React : l'appui, lui, est déjà consommé.
    s.source = s.source ?? (!o.revealed && o.active ? takePress() : null);
    if (entry === "morph" && s.source) openMorph(root, s.source);
    else if (entry !== "none") openFade(root);
    else if (entry === "none") markSettled();
    s.mountedAt = performance.now();
    return () => {
      s.cancelCalm?.();
      s.cancelCalm = null;
      if (s.closing) return;
      // Démontée par un retour (le bouton du navigateur, `history.back()` d'ailleurs) : la même
      // fermeture que la croix — la racine est encore dans la page quand ce nettoyage s'exécute.
      // Pas au double montage du mode strict, qui défait un montage à l'instant même où il a lieu.
      if (arrivedByBack() && optsRef.current.active && root.isConnected && canAnimate() && performance.now() - s.mountedAt > 100) {
        beginClose(root);
        return;
      }
      // Démontée sans fermeture (une adresse qui saute plusieurs écrans) : tout ce qui est à elle
      // part avec elle, l'affiche reparaît.
      stopOpen();
      s.layer?.remove();
      if (s.source) showSource(s.source);
      if (s.ownsHome) {
        homeMotion.anim?.cancel();
        homeMotion.anim = null;
      }
    };
    // Une fois : la décision est prise au premier rendu, et tout le reste se lit dans des refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recouverte par une autre fiche (ou rendue au dessus) : son calque suit son plan. Et une fiche qui
  // a survécu à sa fermeture — un écran empilé par-dessus pendant la sortie — redevient visible
  // quand elle repasse au-dessus.
  useLayoutEffect(() => {
    const s = st.current;
    const root = opts.rootRef.current;
    if (!root) return;
    if (s.layer) s.layer.style.zIndex = getComputedStyle(root).zIndex || s.layer.style.zIndex;
    if (opts.active && s.closing && !opts.leaving && performance.now() - s.closeAt > 1500) {
      root.style.visibility = "";
      s.closing = false;
    }
  }, [opts.active, opts.leaving, opts.rootRef]);

  // La fermeture : au premier rendu où la fiche sort.
  useLayoutEffect(() => {
    if (!opts.leaving || st.current.closing || optsRef.current.off) return;
    const root = opts.rootRef.current;
    if (root) beginClose(root);
    // `beginClose` ne lit que des refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.leaving]);

  /** L'ouverture s'arrête net : plus rien d'elle ne peut révéler une ligne ou basculer un calque. */
  function stopOpen() {
    const s = st.current;
    s.cancelStart?.();
    s.cancelStart = null;
    for (const a of s.openAnims.splice(0)) a.cancel();
    for (const id of s.timers.splice(0)) clearSheetTimeout(id);
    for (const undo of s.restore.splice(0)) undo();
    for (const undo of s.restoreGlass.splice(0)) undo();
    s.unpromote?.();
    s.unpromote = null;
    s.win?.win.remove();
    s.win = null;
  }

  /** Change un style le temps de l'ouverture, en notant comment le rendre. */
  function hold(el: HTMLElement, styles: Partial<CSSStyleDeclaration>, list: (() => void)[] = st.current.restore) {
    const before: Record<string, string> = {};
    for (const k of Object.keys(styles)) before[k] = (el.style as unknown as Record<string, string>)[k];
    Object.assign(el.style, styles);
    list.push(() => Object.assign(el.style, before));
  }

  /** « Réduire les animations » : un fondu, rien qui se déplace. */
  function openFade(root: HTMLElement) {
    const s = st.current;
    const ink = getComputedStyle(root).backgroundColor || "#0a0a0f";
    const { layer, dim } = createLayer(root, ink);
    s.layer = layer;
    s.dim = dim;
    s.openAnims.push(
      root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN_MS, easing: "ease-out" }),
      dim.animate([{ opacity: 0 }, { opacity: DIM }], { duration: FADE_IN_MS, easing: "ease-out", fill: "both" }),
    );
    s.timers.push(sheetTimeout(markSettled, FADE_IN_MS));
  }

  function openMorph(root: HTMLElement, source: SheetSource) {
    const s = st.current;
    const o = optsRef.current;
    const image = o.imageRef.current;
    if (!image) return openFade(root);
    const layout = o.layout;
    const phone = layout === "phone";
    const stage: Stage = { W: window.innerWidth, H: window.innerHeight };

    // 1. Tout lire d'un coup, avant d'écrire quoi que ce soit.
    const ink = getComputedStyle(root).backgroundColor || "#0a0a0f";
    const target = boxOf(image);
    const srcBox = boxOf(source.frame);
    const rootRect = root.getBoundingClientRect();
    const photo = root.querySelector<HTMLImageElement>("[data-sheet-photo]");
    const veils = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-veil]"));
    const content = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-content]"));
    const settle = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-settle]"));
    const glass = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-glass]"));
    const h = layout === "desktop" && !otherSheetsOpen(root) ? homeElement() : null;
    // Au téléphone, la carte : du haut de la fiche au bas de l'écran, c'est elle qui grandit.
    const card: Box = { x: rootRect.left, y: rootRect.top, w: rootRect.width, h: Math.max(1, stage.H - rootRect.top) };
    // Le rayon de la fenêtre : celui de la carte au téléphone, celui de l'affiche ailleurs (le visuel
    // plein écran n'en montre rien, les coins de l'écran le cachent).
    const radius = phone ? phoneSheetCorner(0) : source.radius;
    const endCorners: Corners = uniformCorners(radius);
    const base = phone ? card : target;

    // 2. Une fermeture en vol : on la retourne si c'est la même affiche, sinon on la coupe — et
    //    l'assombrissement, le recul de l'accueil repartent d'où elle les avait laissés.
    let reversed: ReturnType<Flight["takeOver"]> | null = null;
    let dimFrom = 0;
    let homeFrom: number | null = null;
    for (const f of Array.from(flights)) {
      if (!reversed && f.source.control === source.control && f.layout === layout && !f.handover) {
        reversed = f.takeOver();
        dimFrom = reversed.dim;
        homeFrom = reversed.home;
      } else {
        const left = f.cut();
        dimFrom = Math.max(dimFrom, left.dim);
        homeFrom = homeFrom === null ? left.home : left.home === null ? homeFrom : Math.min(homeFrom, left.home);
      }
    }
    if (h && homeFrom === null) homeFrom = homeMotion.anim ? scaleOf(h) : 1;

    // 3. Les poses de l'aller : depuis la carte touchée, ou depuis là où en était le retour qu'on reprend.
    const fromCorners = uniformCorners(source.radius);
    const fresh = phone ? cardOpenPoses(srcBox, fromCorners, card, target, endCorners) : openPoses(srcBox, fromCorners, target, endCorners);
    const end = fresh.end;
    let poseAt: (q: number) => Pose;
    let v0 = 0;
    if (reversed) {
      const P = reversed.pose;
      poseAt = (q) => ({
        box: lerpBox(P.box, end.box, q),
        corners: lerpCorners(P.corners, end.corners, q),
        bd: lerpTf(P.bd, end.bd, q),
        poster: lerpTf(P.poster, end.poster, q),
        bdOpacity: lerp(P.bdOpacity, 1, smooth(0, 0.6, q)),
        posterOpacity: P.posterOpacity * (1 - smooth(0, 0.5, q)),
      });
      v0 = reversed.v0(travelOf(P.box, end.box));
    } else {
      poseAt = fresh.at;
    }
    // Le visuel de la fiche pas encore chargé : on ne l'attend pas. L'affiche touchée vole pleine,
    // le visuel est tenu éteint par son fondu (`bdFade`) — et paraît en fondu dès qu'il est décodé,
    // même en plein vol. Rien n'est téléchargé pour animer.
    const bdReady = !photo || (photo.complete && photo.naturalWidth > 0);
    const waitBd = !bdReady && !reversed;
    if (waitBd) {
      const base0 = poseAt;
      poseAt = (q) => ({ ...base0(q), bdOpacity: 1, posterOpacity: 1 });
    }
    const startBox = poseAt(0).box;
    const motion = appleOpenMotion(startBox, end.box, stage, detectProfile(), v0);
    const d = motion.duration;
    const samples = sampleMotion(motion);

    // 4. Écrire : le calque, la fenêtre, la fiche transparente.
    const { layer, dim } = createLayer(root, ink);
    s.layer = layer;
    s.dim = dim;
    const backdropSrc = photo?.currentSrc || photo?.src || source.image;
    const w = buildWindow(layer, null, stage, base, target, srcBox, source.image, backdropSrc, veils, radius, phone ? { box: card, ink } : null);
    s.win = w;
    if (waitBd) w.bdFade.style.opacity = "0";
    hideSource(source);
    hold(root, holdTransparent(layout));
    // Et par un attribut sur la racine (globals.css) : un visuel ou un voile monté *pendant* le trajet
    // se cache aussi, au lieu de paraître à sa place au repos par-dessus une carte encore en route.
    root.setAttribute("data-sheet-flying", "");
    s.restore.push(() => root.removeAttribute("data-sheet-flying"));
    if (photo) hold(photo, { visibility: "hidden" });
    for (const el of veils) hold(el, { visibility: "hidden" });
    for (const el of settle) hold(el, { visibility: "hidden" });
    // Un flou d'arrière-plan au-dessus d'un calque qui bouge se recalcule à chaque image ; rendu
    // deux images après l'arrivée, pas dans l'image même du relais.
    for (const el of glass) hold(el, { backdropFilter: "none", webkitBackdropFilter: "none" } as Partial<CSSStyleDeclaration>, s.restoreGlass);

    // 5. Les animations, créées en pause : la fiche se dessine aussitôt à son point de départ.
    const anims = s.openAnims;
    const go = (el: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions) => {
      const a = el?.animate(frames, options);
      if (!a) return;
      (a as Partial<Animation>).pause?.();
      anims.push(a);
    };
    anims.push(...trackAnims(w, poseAt, motion, base, stage, samples));
    go(dim, samples.map(({ offset, q }) => ({ offset, opacity: lerp(dimFrom, DIM, clamp(q, 0, 1)) })), LINEAR(d));
    // Le contenu part quand l'image est en place pour l'œil, d'un seul bloc — au téléphone, la carte
    // est alors presque entière autour de lui.
    const revealAt = timeAt(samples, d, REVEAL_AT);
    for (const el of content)
      go(el, [{ opacity: 0, transform: `translateY(${REVEAL_RISE_PX}px)` }, { opacity: 1, transform: "none" }], {
        duration: REVEAL_MS,
        delay: revealAt,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "backwards",
      });
    if (phone) {
      // La croix (son verre) paraît de 30 à 95 % du trajet, comme dans la maquette.
      const glassAt = timeAt(samples, d, GLASS_IN.from);
      const glassMs = Math.max(GLASS_IN.minMs, timeAt(samples, d, GLASS_IN.to) - glassAt);
      for (const el of glass) go(el, [{ opacity: 0 }, { opacity: 1 }], { duration: glassMs, delay: glassAt, easing: "ease-out", fill: "backwards" });
    }
    if (h) {
      homeMotion.anim?.cancel();
      const a = h.animate(
        samples.map(({ offset, q }) => ({ offset, transform: `scale(${lerp(homeFrom ?? 1, HOME_SCALE, clamp(q, 0, 1)).toFixed(5)})` })),
        LINEAR(d),
      );
      (a as Partial<Animation>).pause?.();
      anims.push(a);
      homeMotion.anim = a;
      s.ownsHome = true;
    }
    s.unpromote = promote([w.win, w.inner, w.bd, w.poster, w.bdFade, w.posterFade, dim, h, ...content]);
    const run = { motion, poseAt, startedAt: null as number | null, span: travelOf(startBox, end.box), target, base, stage, clock: anims[0] ?? null };
    s.run = run;
    s.bdShown = !waitBd;

    // 6. Le visuel décodé en plein vol : il paraît sur l'affiche, en fondu, fini à 70 % du trajet ou à
    //    l'arrivée — au lieu du « changement brutal » de l'affiche étirée au vrai visuel à l'arrivée.
    if (waitBd) {
      void w.bdImg.decode?.().then(
        () => {
          if (s.win !== w || s.closing || s.bdShown) return;
          const t = run.startedAt == null ? 0 : clockNow() - run.startedAt;
          const until = Math.min(d, Math.max(timeAt(samples, d, 0.7), t + MIDFLIGHT_FADE_MS));
          const ms = until - t;
          if (ms < MIDFLIGHT_MIN_MS) return;
          s.bdShown = true;
          const fade = { duration: ms, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" as FillMode };
          anims.push(w.bdFade.animate([{ opacity: 0 }, { opacity: 1 }], fade), w.posterFade.animate([{ opacity: 1 }, { opacity: 0 }], fade));
        },
        () => {},
      );
    }

    // 7. Le départ : les images déjà là décodées, deux images de plus, et tout part sur la même.
    let cancelled = false;
    s.cancelStart = () => {
      cancelled = true;
    };
    void decoded(bdReady ? [w.poster, w.bdImg] : [w.poster]).then(() => {
      if (cancelled) return;
      s.cancelStart = afterTwoFrames(() => {
        if (cancelled || s.closing) return;
        s.cancelStart = null;
        run.startedAt = startTogether(anims);
        // Ce que la fenêtre montrait à l'arrivée sert de relais : le visuel s'il a paru en vol, sinon l'affiche.
        s.timers.push(sheetTimeout(() => settleOpen(photo, s.bdShown ? backdropSrc : source.image), d));
      });
    });
  }

  /**
   * L'arrivée : le vrai visuel prend le relais de la fenêtre, pixel pour pixel ; l'assombrissement
   * reste. Dans cette image-là, seulement l'échange — les calques rendus au navigateur et le verre
   * rétabli suivent deux images plus tard : tout faire d'un coup alourdissait l'image du relais.
   */
  function settleOpen(photo: HTMLImageElement | null, standIn: string) {
    const s = st.current;
    if (s.closing) return;
    const loaded = !!photo && photo.complete && photo.naturalWidth > 0;
    if (loaded) {
      photo.style.transition = "none";
      photo.style.opacity = "1";
    } else {
      // Le visuel pas (encore) entièrement là, ou pas encore monté : l'image qui a volé reste sur la
      // bannière jusqu'à lui, puis s'efface en fondu — jamais de bannière noire, ni de changement
      // brutal (`standInUntilLoaded`).
      // Sans visuel du tout, seulement au téléphone : la bannière y est un cadre à part ; au bureau, ce
      // serait la fiche entière.
      const container = photo?.parentElement ?? (optsRef.current.layout === "phone" ? optsRef.current.imageRef.current : null);
      if (container) standInUntilLoaded(container, standIn);
    }
    for (const undo of s.restore.splice(0)) undo();
    s.win?.win.remove();
    s.win = null;
    // Les animations finies gardent leur dernière image (assombrissement, recul de l'accueil, contenu
    // posé) ; celles du trajet sont parties avec la fenêtre. On les oublie sans les annuler.
    s.openAnims = s.openAnims.filter((a) => (a.effect as KeyframeEffect | null)?.target === s.dim || a === homeMotion.anim);
    const unpromote = s.unpromote;
    s.unpromote = null;
    const glass = s.restoreGlass.splice(0);
    const cancel = sheetFrame(() => {
      const again = sheetFrame(() => {
        unpromote?.();
        if (!s.closing) for (const undo of glass) undo();
      });
      s.restore.push(again);
    });
    // Une fermeture qui tombe entre-temps annule le report et rend le verre elle-même (`stopOpen`).
    s.restore.push(cancel, () => {
      unpromote?.();
      for (const undo of glass) undo();
    });
    markSettled();
  }

  function beginClose(root: HTMLElement) {
    const s = st.current;
    const o = optsRef.current;
    s.closing = true;
    s.closeAt = performance.now();
    s.cancelCalm?.();
    s.cancelCalm = null;
    const layout = o.layout;
    const phone = layout === "phone";
    const stage: Stage = { W: window.innerWidth, H: window.innerHeight };
    const now = performance.now();
    // Fermée par le relâchement du doigt (le geste) et non par un `click` : celui qui suit irait à
    // ce qu'il y a dessous, la fiche n'ayant déjà plus de pointeur.
    const byRelease = now - s.upAt < 150 && s.clickAt < s.upAt;
    const fingerVy = byRelease ? releaseVelocity(s.moves) : 0;
    if (byRelease) swallowStrayClick();

    if (o.instantExit || !canAnimate()) {
      stopOpen();
      s.layer?.remove();
      if (s.source) showSource(s.source);
      root.style.visibility = "hidden";
      return;
    }

    // 1. Tout lire d'où on en est, *avant* d'arrêter l'ouverture : la carte (le doigt), le point et
    //    la vitesse de l'aller (lus sur son horloge), chaque opacité.
    const run = s.run;
    const midOpen = !!s.win && !!run;
    // Le temps du trajet lu sur l'animation elle-même (son `currentTime`) plutôt que recalculé à
    // l'horloge : une fermeture pendant l'aller part ainsi de la pose réellement peinte.
    const clockTime = run?.clock?.currentTime;
    const elapsed =
      typeof clockTime === "number" && run?.startedAt != null ? clockTime : run?.startedAt != null ? clockNow() - run.startedAt : 0;
    const qNow = run && midOpen ? (run.startedAt == null ? 0 : run.motion.q(elapsed)) : 1;
    const vNow = run && midOpen && run.startedAt != null ? run.motion.v(elapsed) : 0;
    // La carte du téléphone tirée au doigt, la fiche du bureau tirée par sa poignée.
    const cardFrom = translateYOf(getComputedStyle(root).transform);
    const rootOpacity = opacityNow(root);
    const contentSel = "[data-sheet-content]";
    const contentNow = Array.from(root.querySelectorAll<HTMLElement>(contentSel)).map((el) => opacityNow(el));
    // La croix du téléphone s'efface deux fois moins vite que le contenu, comme dans la maquette.
    const glassNow = phone ? Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-glass]")).map((el) => opacityNow(el)) : [];
    const dimNow = s.dim ? opacityNow(s.dim) : 0;
    const bdFadeNow = s.win ? opacityNow(s.win.bdFade) : 1;
    const posterFadeNow = s.win ? opacityNow(s.win.posterFade) : 1;
    const h = s.ownsHome ? homeElement() : null;
    const homeNow = h ? scaleOf(h) : null;
    const image = o.imageRef.current;
    // La bannière où elle est (tirée au doigt), ou le point de l'aller.
    const imageNow = image ? boxOf(image) : null;
    const rootRectNow = root.getBoundingClientRect();
    const restingTop = rootRectNow.top - cardFrom;

    // 2. L'ouverture s'arrête ; la fiche reprend son allure posée — c'est elle que la copie reproduit.
    stopOpen();
    if (homeMotion.anim && s.ownsHome) {
      homeMotion.anim.cancel();
      homeMotion.anim = null;
    }
    // Lue une fois la fiche rendue à son allure posée : pendant l'aller, son fond est transparent.
    const ink = getComputedStyle(root).backgroundColor || "#0a0a0f";
    const layer = s.layer ?? createLayer(root, ink).layer;
    if (!s.layer) {
      s.layer = layer;
      s.dim = layer.firstElementChild as HTMLElement;
    }
    const dim = s.dim;
    for (const a of dim?.getAnimations?.() ?? []) a.cancel();
    if (dim) dim.style.opacity = String(dimNow);

    const source = s.source ? visibleSource(s.source, [root, layer]) : null;
    if (s.source && source && source.frame !== s.source.frame) showSource(s.source);
    const reduced = prefersReducedMotion();
    const canFly = !!source && !!imageNow && !reduced && imageNow.w > 0;
    const photo = root.querySelector<HTMLImageElement>("[data-sheet-photo]");

    // 3. La copie prend la place de la fiche, qui se cache et rend l'adresse. Au téléphone, seulement
    //    ce qui est à l'écran (`cloneVisible`) : la copie entière coûtait une longue image au départ.
    const copy = phone ? cloneVisible(root, layer, stage.H) : cloneSheet(root, layer);
    copy.style.transform = cardFrom ? `translateY(${cardFrom.toFixed(2)}px)` : "";
    copy.style.transition = "none";
    copy.style.opacity = String(rootOpacity);
    const copyContent = Array.from(copy.querySelectorAll<HTMLElement>(contentSel));
    copyContent.forEach((el, i) => (el.style.opacity = String(contentNow[i] ?? 1)));
    const copyGlass = phone ? Array.from(copy.querySelectorAll<HTMLElement>("[data-sheet-glass]")) : [];
    copyGlass.forEach((el, i) => (el.style.opacity = String(glassNow[i] ?? 1)));
    root.style.visibility = "hidden";
    // Une fiche qui survit à sa fermeture (un écran empilé par-dessus pendant l'animation) ne doit pas
    // rester invisible : rendue au bout d'un moment si elle est toujours là et au-dessus.
    const survive = sheetTimeout(() => {
      if (root.isConnected && optsRef.current.active) {
        root.style.visibility = "";
        s.closing = false;
      }
    }, 1500);
    s.timers.push(survive);

    const others: Animation[] = [];
    const removeLayer = () => layer.remove();
    /** Tout est créé en pause, et part une image plus tard — la copie mise en page, rien ne saute. */
    const paused = (a: Animation) => {
      (a as Partial<Animation>).pause?.();
      return a;
    };

    if (!canFly) {
      // Pas de trajet : l'affiche n'est plus à l'écran (ou les animations sont réduites) — la fiche
      // descend un peu en s'effaçant, ou s'efface simplement.
      const ms = reduced ? FADE_OUT_MS : PLAIN_OUT_MS;
      const drop = reduced ? 0 : PLAIN_OUT_DROP;
      others.push(
        paused(
          copy.animate(
            [
              { opacity: rootOpacity, transform: `translateY(${cardFrom}px)` },
              { opacity: 0, transform: `translateY(${cardFrom + drop}px)` },
            ],
            { duration: ms, easing: reduced ? "ease-in" : "cubic-bezier(0.4, 0, 1, 1)", fill: "both" },
          ),
        ),
      );
      if (dim) others.push(paused(dim.animate([{ opacity: dimNow }, { opacity: 0 }], { duration: ms, easing: "ease-in", fill: "both" })));
      if (h && homeNow !== null && homeNow !== 1)
        others.push(paused(h.animate([{ transform: `scale(${homeNow})` }, { transform: "none" }], { duration: ms, easing: "cubic-bezier(0.2, 0, 0, 1)" })));
      const plainSource = s.source;
      let timer = 0;
      const cancelGo = sheetFrame(() => {
        startTogether(others);
        timer = sheetTimeout(() => {
          flights.delete(plain);
          removeLayer();
          if (plainSource) showSource(plainSource);
        }, ms);
      });
      // Une ouverture pendant cette sortie la coupe net : sa copie et son assombrissement partent, la
      // nouvelle fiche reprend l'assombrissement où il en était. Elle ne se retourne pas (`handover`).
      const plain: Flight = {
        source: plainSource ?? { control: root, frame: root, image: "", radius: 0 },
        layout,
        handover: true,
        // Jamais appelé : une ouverture ne retourne qu'un trajet dont le relais n'a pas commencé.
        takeOver: () => {
          const box = { x: 0, y: 0, w: 0, h: 0 };
          return { pose: { box, corners: uniformCorners(0), bd: IDENTITY, poster: IDENTITY, bdOpacity: 0, posterOpacity: 0 }, v0: () => 0, dim: 0, home: null };
        },
        cut: () => {
          const left = { dim: dim ? opacityNow(dim) : 0, home: h ? scaleOf(h) : null };
          cancelGo();
          clearSheetTimeout(timer);
          for (const a of others) a.cancel();
          flights.delete(plain);
          removeLayer();
          if (plainSource) showSource(plainSource);
          return left;
        },
      };
      flights.add(plain);
      return;
    }

    // 4. Le trajet du retour.
    const srcBox = boxOf(source.frame);
    const srcCorners = uniformCorners(source.radius);
    let base: Box;
    let banner: Box;
    let cur: Pose;
    let radius: number;
    if (phone) {
      // La carte entière rétrécit dans l'affiche — d'où elle est (tirée au doigt), ou du point de
      // l'aller qu'on interrompt.
      const card: Box = { x: rootRectNow.left, y: restingTop, w: rootRectNow.width, h: Math.max(1, stage.H - restingTop) };
      const bannerRest: Box = { ...imageNow, y: imageNow.y - cardFrom };
      base = midOpen && run ? run.base : card;
      banner = midOpen && run ? run.target : bannerRest;
      radius = phoneSheetCorner(0);
      // Tirée au doigt pendant l'aller, la carte repart de la pose de l'aller plus le doigt — là où la
      // copie, décalée d'autant, la montre.
      cur = midOpen && run ? shiftPose(run.poseAt(qNow), cardFrom) : cardRestPose(card, uniformCorners(radius), bannerRest, srcBox, cardFrom);
    } else {
      base = midOpen && run ? run.target : imageNow;
      banner = base;
      radius = source.radius;
      cur = midOpen && run ? run.poseAt(qNow) : { box: imageNow, corners: uniformCorners(0), bd: IDENTITY, poster: coverTf(srcBox, imageNow), bdOpacity: 1, posterOpacity: 0 };
    }
    // Interrompu en plein vol, l'aller pouvait tenir le visuel éteint (pas encore décodé) ou être en
    // train de le faire paraître (`bdFade`, `posterFade`) : le retour part des opacités peintes.
    if (midOpen) cur = { ...cur, bdOpacity: cur.bdOpacity * bdFadeNow, posterOpacity: cur.posterOpacity * posterFadeNow };
    const toPose = sourcePose(srcBox, srcCorners, banner);
    // La vitesse de départ : celle de l'aller interrompu, ou celle du doigt projetée sur le chemin de
    // la carte — une seule pièce, rien ne peut s'en séparer.
    const v0 = closeStartVelocity(cur.box, toPose.box, run && midOpen ? { v: vNow, span: run.span } : null, fingerVy);
    const motion = appleCloseMotion(cur.box, toPose.box, stage, detectProfile(), v0);
    const d = motion.duration;
    const samples = sampleMotion(motion);
    const poseAt = closePoses(cur, toPose);
    const veils = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-veil]"));
    const w = buildWindow(layer, copy, stage, base, banner, srcBox, source.image, photo?.currentSrc || photo?.src || source.image, veils, radius, phone ? { box: base, ink } : null);
    hideSource(source);
    // La copie, sans son visuel ni ses voiles, qui sont dans la fenêtre ; transparente — l'encre de la
    // carte est dans la fenêtre au téléphone, le visuel plein écran au bureau.
    Object.assign(copy.style, holdTransparent(layout));
    for (const sel of ["[data-sheet-photo]", "[data-sheet-veil]", "[data-sheet-settle]"])
      for (const el of Array.from(copy.querySelectorAll<HTMLElement>(sel))) el.style.visibility = "hidden";

    const ghost = trackAnims(w, poseAt, motion, base, stage, samples);
    if (phone) {
      // Le contenu s'efface sur le premier quart du trajet, depuis où il en est ; la croix deux fois
      // moins vite. La copie ne bouge pas : la carte qui rétrécit est dans la fenêtre, dessous.
      const outMs = Math.max(CONTENT_OUT_MS, timeAt(samples, d, 0.25));
      copyContent.forEach((el, i) => {
        const from = contentNow[i] ?? 1;
        others.push(paused(el.animate([{ opacity: from }, { opacity: 0 }], { duration: from > 0 ? outMs : 1, easing: "ease-in", fill: "both" })));
      });
      copyGlass.forEach((el, i) => {
        const from = glassNow[i] ?? 1;
        others.push(paused(el.animate([{ opacity: from }, { opacity: 0 }], { duration: from > 0 ? outMs * 2 : 1, easing: "ease-in", fill: "both" })));
      });
    } else {
      // Au bureau, la copie ne porte plus que la colonne, le bouton Retour et la poignée : elle
      // s'efface d'un bloc pendant que l'image revole.
      others.push(paused(copy.animate([{ opacity: rootOpacity }, { opacity: 0 }], { duration: CONTENT_OUT_MS, easing: "ease-in", fill: "both" })));
    }
    if (dim) others.push(paused(dim.animate(samples.map(({ offset, q }) => ({ offset, opacity: dimNow * (1 - clamp(q, 0, 1)) })), LINEAR(d))));
    if (h && homeNow !== null && homeNow !== 1)
      others.push(paused(h.animate(samples.map(({ offset, q }) => ({ offset, transform: `scale(${lerp(homeNow, 1, clamp(q, 0, 1)).toFixed(5)})` })), LINEAR(d, "none"))));
    const unpromote = promote([w.win, w.inner, w.bd, w.poster, dim, h, ...copyContent]);

    let startedAt: number | null = null;
    const timers: number[] = [];
    const elapsedNow = () => (startedAt == null ? 0 : clockNow() - startedAt);
    const flight: Flight = {
      source,
      layout,
      handover: false,
      takeOver: () => {
        const t = elapsedNow();
        const r = motion.q(t);
        const vr = motion.v(t);
        const left = { pose: poseAt(r), dim: dim ? opacityNow(dim) : 0, home: h ? scaleOf(h) : null };
        end(false);
        // Le retour avançait de `vr·longueur` pixels par seconde vers la carte ; l'aller repart à
        // contre-sens, à −vr·longueur / (point → fiche).
        const span = travelOf(cur.box, toPose.box);
        return { ...left, v0: (ahead: number) => (ahead > 4 ? (-vr * span) / ahead : 0) };
      },
      cut: () => {
        const r = flight.handover ? 1 : motion.q(elapsedNow());
        const left = { dim: dim ? opacityNow(dim) : 0, home: h ? scaleOf(h) : null };
        cancelGo();
        for (const a of others) a.cancel();
        for (const id of timers.splice(0)) clearSheetTimeout(id);
        flights.delete(flight);
        dim?.remove();
        copy.remove();
        showSource(source);
        unpromote();
        if (r >= GHOST_SNAP_AT) {
          removeLayer();
        } else {
          for (const a of ghost) (a as Partial<Animation>).pause?.();
          const fade = w.win.animate([{ opacity: opacityNow(w.win) }, { opacity: 0 }], { duration: GHOST_FADE_MS, easing: "ease-out", fill: "both" });
          fade.onfinish = removeLayer;
        }
        return left;
      },
    };
    /** La fin du retour, ou sa reprise par une ouverture (`restoreSource` faux : l'affiche reste cachée). */
    const end = (restoreSource: boolean) => {
      flights.delete(flight);
      cancelGo();
      for (const id of timers.splice(0)) clearSheetTimeout(id);
      for (const a of [...ghost, ...others]) a.cancel();
      unpromote();
      removeLayer();
      if (restoreSource) showSource(source);
    };
    flights.add(flight);
    // Le départ, une image plus tard : la copie et la fenêtre sont mises en page, la première image
    // peinte est le point de départ. Lancé dans la tâche même de la fermeture (le rendu React, la
    // copie), le retour perdait ses premières images et se lisait comme un saut (audit du 10/10/2026).
    const cancelGo = sheetFrame(() => {
      startedAt = startTogether([...ghost, ...others]);
      // Le relais : la vraie carte reparaît dessous, et la fenêtre, superposée à elle, s'efface par-dessus.
      timers.push(
        sheetTimeout(() => {
          flight.handover = true;
          unpromote();
          showSource(source);
          copy.remove();
          const fade = w.win.animate([{ opacity: 1 }, { opacity: 0 }], { duration: HANDOVER_MS, easing: "ease-out", fill: "both" });
          fade.onfinish = () => {
            flights.delete(flight);
            removeLayer();
          };
        }, d),
      );
    });
  }

  return { handlesEntry: entry !== "none", settled };
}

/** Pour les tests : les fermetures en vol, et de quoi repartir d'une page propre. */
export const sheetMorphForTests = {
  flights: () => flights.size,
  reset: () => {
    flights.clear();
    homeMotion.anim = null;
  },
};
