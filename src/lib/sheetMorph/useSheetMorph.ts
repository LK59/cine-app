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
  CARD_IN,
  CARD_OUT,
  appleCloseMotion,
  appleOpenMotion,
  cardTrack,
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
  smooth,
  sourcePose,
  timeAt,
  travelOf,
  uniformCorners,
  type Box,
  type Corners,
  type Motion,
  type Pose,
  type Stage,
} from "./motion";
import { afterTwoFrames, boxOf, clockNow, detectProfile, opacityNow, place, prefersReducedMotion, promote, scaleOf, startTogether, swallowStrayClick, translateYOf } from "./dom";
import { hideSource, installPressTracker, peekPress, showSource, takePress, visibleSource, type SheetSource } from "./source";

/**
 * L'ouverture et la fermeture des fiches de titre (DECISIONS.md §61) : la carte touchée devient le
 * visuel de la fiche, et la fiche y retourne.
 *
 * Validé tel quel sur la page « Tests animations » (lot H, neuf passes, 10/10/2026) ; cette fonction
 * en est le portage dans les vraies fiches — CinemaMobileDetail (téléphone), CinemaMovieDetail et
 * CinemaSeriesDetail (bureau, iPad), PlayerDiscoverSheet (les deux). Une décision, un endroit.
 *
 * Ce que la fiche marque dans son DOM, et que ce crochet lit :
 * - `data-sheet-photo` : son visuel (une `<img>`), caché le temps du trajet ;
 * - `data-sheet-veil` : les voiles posés sur le visuel, copiés dans le calque du trajet ;
 * - `data-sheet-content` : ce qui arrive d'un bloc à 90 % du trajet et s'efface à la fermeture ;
 * - `data-sheet-settle` : ce qui ne paraît qu'une fois posé (le flou localisé du bureau) ;
 * - `data-sheet-glass` : le verre (un `backdrop-filter`), coupé pendant le mouvement.
 *
 * Les trois choses qui ont réglé la forme du code, chacune payée d'une passe sur le banc :
 *
 * 1. **Un calque à part, sous la fiche.** Le trajet (la fenêtre transformée, ses deux images) et
 *    l'assombrissement vivent dans un calque inséré juste avant la fiche dans `body`, au même plan :
 *    la colonne de la fiche passe donc *au-dessus* de l'image qui vole, comme dans la fiche posée,
 *    et la fiche du dessous d'une cascade, elle, passe dessous. Le fond de la fiche est transparent
 *    là où l'image arrive — la bande de la bannière sur le téléphone, tout l'écran au bureau — ;
 *    géométriquement, la fenêtre ne sort jamais de cette bande pendant que la carte monte.
 * 2. **La fermeture ne retient pas l'adresse.** Au premier instant d'une fermeture, la fiche est
 *    copiée (`cloneNode`, son défilement compris) dans ce calque, et c'est la copie qui redescend et
 *    s'efface pendant que le calque revole vers l'affiche ; la vraie fiche est cachée et rend
 *    l'adresse aussitôt. Retenue le temps du trajet, l'adresse gardait le titre : une affiche touchée
 *    pendant le retour empilait une entrée par-dessus, que la fermeture différée défaisait ensuite.
 *    Ainsi, l'accueil répond dès que la fermeture commence — on rouvre une autre fiche, ou la même,
 *    sans attendre (huitième passe).
 * 3. **Rien ne tourne sur le fil principal pendant le trajet.** Tout est mesuré avant, échantillonné
 *    en images clés (transformations et opacités seulement, ≥ 60 par trajet), créé en pause, lancé
 *    deux images après le montage et le décodage des deux images, sur un même `startTime`. Aucun
 *    rendu React pendant le mouvement : ce crochet ne pose d'état qu'à la décision du premier rendu.
 */

if (typeof document !== "undefined") installPressTracker();

export type SheetLayout = "phone" | "desktop";

export type SheetMorphOptions = {
  /** La mise en page de la fiche : la bannière 16:9 d'une carte qui monte, ou le visuel plein écran. */
  layout: SheetLayout;
  /** La racine de la fiche (la carte au téléphone, l'écran entier au bureau). */
  rootRef: RefObject<HTMLElement | null>;
  /** Là où l'image arrive : la bannière au téléphone, la racine elle-même au bureau. */
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
};

type Entry = "morph" | "fade" | "none";

/** Une fermeture en vol : de quoi la retourner en ouverture, ou la couper pour une autre. */
type Flight = {
  source: SheetSource;
  layout: SheetLayout;
  /** Le relais final a commencé (la vraie carte est revenue dessous) — trop tard pour la retourner. */
  handover: boolean;
  takeOver: () => { pose: Pose; v0: (ahead: number) => number; dim: number; home: number | null; cardOpacity: number };
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

/**
 * Le fond d'une fiche pendant un trajet : transparent là où l'image arrive — tout l'écran au bureau,
 * la bande de la bannière au téléphone (`bandAt` : du haut de la carte au bas de la bannière, mesuré
 * sur les deux à la fois, donc indépendant de la montée de la carte ou du doigt). Sous elle, l'encre.
 */
function holeBackground(layout: SheetLayout, bandAt: number, ink: string): Partial<CSSStyleDeclaration> {
  if (layout === "desktop") return { backgroundColor: "transparent" };
  const at = Math.max(0, bandAt);
  return { backgroundColor: "transparent", backgroundImage: `linear-gradient(to bottom, transparent ${at}px, ${ink} ${at}px)` };
}

const LINEAR = (duration: number, fill: FillMode = "both"): KeyframeAnimationOptions => ({ duration, easing: "linear", fill });

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

/** La fenêtre du trajet et ce qu'elle porte : le visuel de la fiche (et ses voiles), l'affiche touchée. */
type MorphWindow = { win: HTMLElement; inner: HTMLElement; bd: HTMLElement; bdImg: HTMLImageElement; poster: HTMLImageElement };

function buildWindow(layer: HTMLElement, before: Node | null, stage: Stage, target: Box, source: Box, posterSrc: string, backdropSrc: string, veils: Element[]): MorphWindow {
  const win = document.createElement("div");
  Object.assign(win.style, { position: "absolute", overflow: "hidden", transformOrigin: "0 0" });
  place(win, target);
  const inner = document.createElement("div");
  Object.assign(inner.style, { position: "absolute", left: "0", top: "0", width: `${stage.W}px`, height: `${stage.H}px`, transformOrigin: "0 0" });
  const bd = document.createElement("div");
  Object.assign(bd.style, { position: "absolute", overflow: "hidden", transformOrigin: "0 0" });
  place(bd, target);
  const bdImg = document.createElement("img");
  bdImg.alt = "";
  bdImg.decoding = "async";
  Object.assign(bdImg.style, { position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "cover" });
  bdImg.src = backdropSrc;
  bd.appendChild(bdImg);
  // Les voiles voyagent avec le visuel : posés à leur place pendant que l'image vole, ils
  // assombrissaient l'accueil hors de la fenêtre — la bande horizontale vue au téléphone, le gris
  // boueux du bureau (troisième passe).
  for (const veil of veils) {
    const copy = veil.cloneNode(true) as HTMLElement;
    Object.assign(copy.style, { position: "absolute", inset: "0", visibility: "visible" });
    bd.appendChild(copy);
  }
  const poster = document.createElement("img");
  poster.alt = "";
  Object.assign(poster.style, { position: "absolute", objectFit: "cover", transformOrigin: "0 0" });
  place(poster, source);
  poster.src = posterSrc;
  inner.append(bd, poster);
  win.appendChild(inner);
  layer.insertBefore(win, before);
  return { win, inner, bd, bdImg, poster };
}

/** Joue les pistes du trajet sur la fenêtre ; rend les animations (créées en pause si demandé). */
function playTracks(w: MorphWindow, poseAt: (q: number) => Pose, motion: Motion, target: Box, stage: Stage, paused: boolean): Animation[] {
  const samples = sampleMotion(motion);
  const tracks = morphTracks(poseAt, samples, target, stage, "transform");
  const opts = LINEAR(motion.duration);
  const anims = [
    w.win.animate(tracks.win, opts),
    w.win.animate(tracks.radius, opts),
    w.inner.animate(tracks.inner, opts),
    w.bd.animate(tracks.bd, opts),
    w.poster.animate(tracks.poster, opts),
  ];
  if (paused) for (const a of anims) (a as Partial<Animation>).pause?.();
  return anims;
}

/** Attend le décodage des deux images du trajet — au plus 150 ms : elles sont d'ordinaire déjà là. */
function decoded(imgs: HTMLImageElement[]): Promise<unknown> {
  const all = Promise.all(imgs.map((img) => img.decode?.().catch(() => undefined)));
  return Promise.race([all, new Promise((ok) => window.setTimeout(ok, 150))]);
}

/** Les éléments de la copie qui correspondent, un à un, à ceux de la fiche — même sélecteur, même ordre. */
function pairs(root: Element, copy: Element, selector: string): [HTMLElement, HTMLElement][] {
  const a = Array.from(root.querySelectorAll<HTMLElement>(selector));
  const b = Array.from(copy.querySelectorAll<HTMLElement>(selector));
  return a.map((el, i) => [el, b[i]] as [HTMLElement, HTMLElement]).filter(([, c]) => !!c);
}

/**
 * La copie de la fiche qui sort à sa place : inerte, sans vidéo ni identifiant, ses animations CSS et
 * son verre coupés (`.sheet-morph-clone`, globals.css), défilée exactement comme l'original.
 */
function cloneSheet(root: HTMLElement, layer: HTMLElement): HTMLElement {
  const copy = root.cloneNode(true) as HTMLElement;
  copy.classList.add("sheet-morph-clone");
  copy.removeAttribute("data-sheet-morph-root");
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  for (const el of Array.from(copy.querySelectorAll("video, audio, iframe"))) el.remove();
  for (const el of Array.from(copy.querySelectorAll("[id]"))) el.removeAttribute("id");
  copy.style.pointerEvents = "none";
  copy.style.visibility = "visible";
  layer.appendChild(copy);
  // Le défilement, après l'insertion : la fiche elle-même au téléphone, son conteneur intérieur au
  // bureau, et les rangées horizontales (titres similaires) — sinon la copie repartirait en haut.
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

export function useSheetMorph(opts: SheetMorphOptions): SheetMorph {
  // Décidé au premier rendu — la fiche en retire sa classe d'entrée dès ce rendu-là.
  const [entry] = useState<Entry>(() => decideEntry(opts));
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
    run: { motion: Motion; poseAt: (q: number) => Pose; startedAt: number | null; span: number; target: Box; stage: Stage } | null;
    openAnims: Animation[];
    cancelStart: (() => void) | null;
    timers: number[];
    /** Ce que l'ouverture a changé sur la vraie fiche, à défaire à l'arrivée. */
    restore: (() => void)[];
    unpromote: (() => void) | null;
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
    unpromote: null,
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
    s.mountedAt = performance.now();
    return () => {
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
    for (const id of s.timers.splice(0)) window.clearTimeout(id);
    for (const undo of s.restore.splice(0)) undo();
    s.unpromote?.();
    s.unpromote = null;
    s.win?.win.remove();
    s.win = null;
  }

  /** Change un style le temps de l'ouverture, en notant comment le rendre. */
  function hold(el: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    const before: Record<string, string> = {};
    for (const k of Object.keys(styles)) before[k] = (el.style as unknown as Record<string, string>)[k];
    Object.assign(el.style, styles);
    st.current.restore.push(() => Object.assign(el.style, before));
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
  }

  function openMorph(root: HTMLElement, source: SheetSource) {
    const s = st.current;
    const o = optsRef.current;
    const image = o.imageRef.current;
    if (!image) return openFade(root);
    const layout = o.layout;
    const stage: Stage = { W: window.innerWidth, H: window.innerHeight };

    // 1. Tout lire d'un coup, avant d'écrire quoi que ce soit.
    const ink = getComputedStyle(root).backgroundColor || "#0a0a0f";
    const target = boxOf(image);
    const srcBox = boxOf(source.frame);
    const rootTop = root.getBoundingClientRect().top;
    const bandAt = target.y + target.h - rootTop;
    const photo = root.querySelector<HTMLImageElement>("[data-sheet-photo]");
    const veils = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-veil]"));
    const content = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-content]"));
    const settle = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-settle]"));
    const glass = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-glass]"));
    const h = layout === "desktop" && !otherSheetsOpen(root) ? homeElement() : null;
    const targetCorners: Corners = layout === "phone" ? [16, 16, 0, 0] : [0, 0, 0, 0];

    // 2. Une fermeture en vol : on la retourne si c'est la même affiche, sinon on la coupe — et
    //    l'assombrissement, le recul de l'accueil, la carte repartent d'où elle les avait laissés.
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

    // 3. Les poses de l'aller : depuis la carte, ou depuis là où en était le retour qu'on reprend.
    const fromCorners = uniformCorners(source.radius);
    const end: Pose = { box: target, corners: targetCorners, bd: IDENTITY, poster: coverTf(srcBox, target), bdOpacity: 1, posterOpacity: 0 };
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
      poseAt = openPoses(srcBox, fromCorners, target, targetCorners).at;
    }
    const startBox = poseAt(0).box;
    const motion = appleOpenMotion(startBox, target, stage, detectProfile(), v0);
    const d = motion.duration;
    const samples = sampleMotion(motion);

    // 4. Écrire : le calque, la fenêtre, la fiche ajourée.
    const { layer, dim } = createLayer(root, ink);
    s.layer = layer;
    s.dim = dim;
    const backdropSrc = photo?.currentSrc || photo?.src || source.image;
    const w = buildWindow(layer, null, stage, target, srcBox, source.image, backdropSrc, veils);
    s.win = w;
    hideSource(source);
    hold(root, holeBackground(layout, bandAt, ink));
    if (photo) hold(photo, { visibility: "hidden" });
    for (const el of veils) hold(el, { visibility: "hidden" });
    for (const el of settle) hold(el, { visibility: "hidden" });
    // Un flou d'arrière-plan au-dessus d'un calque qui bouge se recalcule à chaque image.
    for (const el of glass) hold(el, { backdropFilter: "none", webkitBackdropFilter: "none" } as Partial<CSSStyleDeclaration>);

    // 5. Les animations, créées en pause : la fiche se dessine aussitôt à son point de départ.
    const anims = s.openAnims;
    const go = (el: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions) => {
      const a = el?.animate(frames, options);
      if (!a) return;
      (a as Partial<Animation>).pause?.();
      anims.push(a);
    };
    anims.push(...playTracks(w, poseAt, motion, target, stage, true));
    go(dim, samples.map(({ offset, q }) => ({ offset, opacity: lerp(dimFrom, DIM, clamp(q, 0, 1)) })), LINEAR(d));
    if (layout === "phone") {
      // La carte collée à la bannière (`cardTrack`) : son encre suit le bas de l'image à chaque
      // image clé. Reprise d'un retour : la pose de départ est celle où il en était, et la carte y
      // était déjà collée — elle repart de l'opacité où son effacement l'avait laissée. Sans
      // remplissage à la fin : la montée finie, c'est le style de la carte qui reprend sa
      // transformation — celle du doigt quand on tire la fiche.
      const cardFrom = reversed ? reversed.cardOpacity : 0;
      const cardOpacity = (q: number) => lerp(cardFrom, 1, CARD_IN(q));
      go(root, cardTrack(samples, poseAt, rootTop, bandAt, cardOpacity), LINEAR(d, "backwards"));
    }
    // Le contenu part quand l'image est en place pour l'œil, d'un seul bloc, et se pose avec elle.
    const revealAt = timeAt(samples, d, REVEAL_AT);
    for (const el of content)
      go(el, [{ opacity: 0, transform: `translateY(${REVEAL_RISE_PX}px)` }, { opacity: 1, transform: "none" }], {
        duration: REVEAL_MS,
        delay: revealAt,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "backwards",
      });
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
    s.unpromote = promote([w.win, w.inner, w.bd, w.poster, dim, layout === "phone" ? root : null, h, ...content]);
    const run = { motion, poseAt, startedAt: null as number | null, span: travelOf(startBox, target), target, stage };
    s.run = run;

    // 6. Le départ : les deux images décodées, deux images de plus, et tout part sur la même.
    let cancelled = false;
    s.cancelStart = () => {
      cancelled = true;
    };
    void decoded([w.poster, w.bdImg]).then(() => {
      if (cancelled) return;
      s.cancelStart = afterTwoFrames(() => {
        if (cancelled || s.closing) return;
        s.cancelStart = null;
        run.startedAt = startTogether(anims);
        s.timers.push(window.setTimeout(() => settleOpen(photo), d));
      });
    });
  }

  /** L'arrivée : le vrai visuel prend le relais de la fenêtre, pixel pour pixel ; l'assombrissement reste. */
  function settleOpen(photo: HTMLImageElement | null) {
    const s = st.current;
    if (s.closing) return;
    // Arrivée pendant le trajet, l'image de la fiche serait encore dans son fondu d'arrivée : montrée
    // à moitié transparente, elle assombrirait le relais.
    if (photo?.complete && photo.naturalWidth > 0) {
      photo.style.transition = "none";
      photo.style.opacity = "1";
    }
    for (const undo of s.restore.splice(0)) undo();
    s.win?.win.remove();
    s.win = null;
    s.unpromote?.();
    s.unpromote = null;
    // Les animations finies gardent leur dernière image (assombrissement, recul de l'accueil, contenu
    // posé) ; celles du trajet sont parties avec la fenêtre. On les oublie sans les annuler.
    s.openAnims = s.openAnims.filter((a) => (a.effect as KeyframeEffect | null)?.target === s.dim || a === homeMotion.anim);
  }

  function beginClose(root: HTMLElement) {
    const s = st.current;
    const o = optsRef.current;
    s.closing = true;
    s.closeAt = performance.now();
    const layout = o.layout;
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

    // 1. Tout lire d'où on en est, *avant* d'arrêter l'ouverture : la carte (le doigt ou sa montée),
    //    le point et la vitesse de l'aller (calculés, pas relus dans les styles), chaque opacité.
    const run = s.run;
    const midOpen = !!s.win && !!run;
    const elapsed = run?.startedAt != null ? clockNow() - run.startedAt : 0;
    const qNow = run && midOpen ? (run.startedAt == null ? 0 : run.motion.q(elapsed)) : 1;
    const vNow = run && midOpen && run.startedAt != null ? run.motion.v(elapsed) : 0;
    // La carte du téléphone (sa montée, ou le doigt), la fiche du bureau tirée par sa poignée.
    const cardFrom = translateYOf(getComputedStyle(root).transform);
    const rootOpacity = opacityNow(root);
    const contentSel = layout === "phone" ? "[data-sheet-content], [data-sheet-glass]" : "[data-sheet-content]";
    const contentNow = Array.from(root.querySelectorAll<HTMLElement>(contentSel)).map((el) => opacityNow(el));
    const dimNow = s.dim ? opacityNow(s.dim) : 0;
    const h = s.ownsHome ? homeElement() : null;
    const homeNow = h ? scaleOf(h) : null;
    const image = o.imageRef.current;
    // La bannière où elle est (tirée au doigt, coins arrondis par le geste), ou le point de l'aller.
    const imageNow = image ? boxOf(image) : null;
    const rootTopNow = root.getBoundingClientRect().top;
    const bandAt = imageNow ? imageNow.y + imageNow.h - rootTopNow : 0;
    const restingTop = rootTopNow - cardFrom;

    // 2. L'ouverture s'arrête ; la fiche reprend son allure posée — c'est elle que la copie reproduit.
    stopOpen();
    if (homeMotion.anim && s.ownsHome) {
      homeMotion.anim.cancel();
      homeMotion.anim = null;
    }
    // Lue une fois la fiche rendue à son allure posée : pendant l'aller, son fond est transparent, et
    // la carte de la copie l'aurait été aussi.
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

    // 3. La copie prend la place de la fiche, qui se cache et rend l'adresse.
    const copy = cloneSheet(root, layer);
    copy.style.transform = cardFrom ? `translateY(${cardFrom}px)` : "";
    copy.style.transition = "none";
    copy.style.opacity = String(rootOpacity);
    const copyContent = Array.from(copy.querySelectorAll<HTMLElement>(contentSel));
    copyContent.forEach((el, i) => (el.style.opacity = String(contentNow[i] ?? 1)));
    root.style.visibility = "hidden";
    // Une fiche qui survit à sa fermeture (un écran empilé par-dessus pendant l'animation) ne doit pas
    // rester invisible : rendue au bout d'un moment si elle est toujours là et au-dessus.
    const survive = window.setTimeout(() => {
      if (root.isConnected && optsRef.current.active) {
        root.style.visibility = "";
        s.closing = false;
      }
    }, 1500);
    s.timers.push(survive);

    const others: Animation[] = [];
    const removeLayer = () => layer.remove();

    if (!canFly) {
      // Pas de trajet : l'affiche n'est plus à l'écran (ou les animations sont réduites) — la fiche
      // descend un peu en s'effaçant, ou s'efface simplement.
      const ms = reduced ? FADE_OUT_MS : PLAIN_OUT_MS;
      const drop = reduced ? 0 : PLAIN_OUT_DROP;
      others.push(
        copy.animate(
          [
            { opacity: rootOpacity, transform: `translateY(${cardFrom}px)` },
            { opacity: 0, transform: `translateY(${cardFrom + drop}px)` },
          ],
          { duration: ms, easing: reduced ? "ease-in" : "cubic-bezier(0.4, 0, 1, 1)", fill: "both" },
        ),
      );
      if (dim) others.push(dim.animate([{ opacity: dimNow }, { opacity: 0 }], { duration: ms, easing: "ease-in", fill: "both" }));
      if (h && homeNow !== null && homeNow !== 1)
        others.push(h.animate([{ transform: `scale(${homeNow})` }, { transform: "none" }], { duration: ms, easing: "cubic-bezier(0.2, 0, 0, 1)" }));
      const plainSource = s.source;
      let timer = 0;
      // Une ouverture pendant cette sortie la coupe net : sa copie et son assombrissement partent, la
      // nouvelle fiche reprend l'assombrissement où il en était. Elle ne se retourne pas (`handover`).
      const plain: Flight = {
        source: plainSource ?? { control: root, frame: root, image: "", radius: 0 },
        layout,
        handover: true,
        // Jamais appelé : une ouverture ne retourne qu'un trajet dont le relais n'a pas commencé.
        takeOver: () => {
          const box = { x: 0, y: 0, w: 0, h: 0 };
          return { pose: { box, corners: uniformCorners(0), bd: IDENTITY, poster: IDENTITY, bdOpacity: 0, posterOpacity: 0 }, v0: () => 0, dim: 0, home: null, cardOpacity: 1 };
        },
        cut: () => {
          const left = { dim: dim ? opacityNow(dim) : 0, home: h ? scaleOf(h) : null };
          window.clearTimeout(timer);
          for (const a of others) a.cancel();
          flights.delete(plain);
          removeLayer();
          if (plainSource) showSource(plainSource);
          return left;
        },
      };
      flights.add(plain);
      timer = window.setTimeout(() => {
        flights.delete(plain);
        removeLayer();
        if (plainSource) showSource(plainSource);
      }, ms);
      return;
    }

    // 4. Le trajet du retour.
    const srcBox = boxOf(source.frame);
    const c = layout === "phone" ? phoneSheetCorner(Math.max(0, cardFrom)) : 0;
    const targetCorners: Corners = layout === "phone" ? [c, c, 0, 0] : [0, 0, 0, 0];
    const cur: Pose =
      run && midOpen
        ? run.poseAt(qNow)
        : { box: imageNow, corners: targetCorners, bd: IDENTITY, poster: coverTf(srcBox, imageNow), bdOpacity: 1, posterOpacity: 0 };
    const toPose = sourcePose(srcBox, uniformCorners(source.radius), run && midOpen ? run.target : imageNow);
    const v0 = closeStartVelocity(cur.box, toPose.box, run && midOpen ? { v: vNow, span: run.span } : null, fingerVy);
    const motion = appleCloseMotion(cur.box, toPose.box, stage, detectProfile(), v0);
    const d = motion.duration;
    const samples = sampleMotion(motion);
    const poseAt = closePoses(cur, toPose);
    // Le visuel de la fenêtre se pose sur la boîte de la bannière à sa place — celle qu'avait l'aller.
    const base = run && midOpen ? run.target : imageNow;
    const veils = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-veil]"));
    const w = buildWindow(layer, copy, stage, base, srcBox, source.image, photo?.currentSrc || photo?.src || source.image, veils);
    hideSource(source);
    // La copie, ajourée là où vole l'image : sans son visuel ni ses voiles, qui sont dans la fenêtre.
    Object.assign(copy.style, holeBackground(layout, bandAt, ink));
    for (const sel of ["[data-sheet-photo]", "[data-sheet-veil]", "[data-sheet-settle]"])
      for (const el of Array.from(copy.querySelectorAll<HTMLElement>(sel))) el.style.visibility = "hidden";

    const ghost = playTracks(w, poseAt, motion, base, stage, false);
    if (layout === "phone") {
      // La copie redescend collée à l'image qui rentre dans l'affiche, et s'efface sur la fin (`CARD_OUT`).
      others.push(copy.animate(cardTrack(samples, poseAt, restingTop, bandAt, (q) => rootOpacity * CARD_OUT(q)), LINEAR(d)));
      copyContent.forEach((el, i) => {
        const from = contentNow[i] ?? 1;
        others.push(el.animate([{ opacity: from }, { opacity: 0 }], { duration: from > 0 ? CONTENT_OUT_MS : 1, easing: "ease-in", fill: "both" }));
      });
    } else {
      // Au bureau, la copie ne porte plus que la colonne, le bouton Retour et la poignée : elle
      // s'efface d'un bloc pendant que l'image revole.
      others.push(copy.animate([{ opacity: rootOpacity }, { opacity: 0 }], { duration: CONTENT_OUT_MS, easing: "ease-in", fill: "both" }));
    }
    if (dim) others.push(dim.animate(samples.map(({ offset, q }) => ({ offset, opacity: dimNow * (1 - clamp(q, 0, 1)) })), LINEAR(d)));
    if (h && homeNow !== null && homeNow !== 1)
      others.push(h.animate(samples.map(({ offset, q }) => ({ offset, transform: `scale(${lerp(homeNow, 1, clamp(q, 0, 1)).toFixed(5)})` })), LINEAR(d, "none")));
    const unpromote = promote([w.win, w.inner, w.bd, w.poster, copy, dim, h]);
    const startedAt = startTogether([...ghost, ...others]);

    const timers: number[] = [];
    const flight: Flight = {
      source,
      layout,
      handover: false,
      takeOver: () => {
        const t = clockNow() - startedAt;
        const r = motion.q(t);
        const vr = motion.v(t);
        const pose = poseAt(r);
        const left = { pose, dim: dim ? opacityNow(dim) : 0, home: h ? scaleOf(h) : null, cardOpacity: layout === "phone" ? opacityNow(copy) : 1 };
        end(false);
        // Le retour avançait de `vr·longueur` pixels par seconde vers la carte ; l'aller repart à
        // contre-sens, à −vr·longueur / (point → fiche).
        const span = travelOf(cur.box, toPose.box);
        return { ...left, v0: (ahead: number) => (ahead > 4 ? (-vr * span) / ahead : 0) };
      },
      cut: () => {
        const t = clockNow() - startedAt;
        const r = flight.handover ? 1 : motion.q(t);
        const left = { dim: dim ? opacityNow(dim) : 0, home: h ? scaleOf(h) : null };
        for (const a of others) a.cancel();
        for (const id of timers.splice(0)) window.clearTimeout(id);
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
      for (const id of timers.splice(0)) window.clearTimeout(id);
      for (const a of [...ghost, ...others]) a.cancel();
      unpromote();
      removeLayer();
      if (restoreSource) showSource(source);
    };
    flights.add(flight);
    // Le relais : la vraie carte reparaît dessous, et la fenêtre, superposée à elle, s'efface par-dessus.
    timers.push(
      window.setTimeout(() => {
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
  }

  return { handlesEntry: entry !== "none" };
}

/** Pour les tests : les fermetures en vol, et de quoi repartir d'une page propre. */
export const sheetMorphForTests = {
  flights: () => flights.size,
  reset: () => {
    flights.clear();
    homeMotion.anim = null;
  },
};
