"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { arrivedByBack } from "@/lib/cinemaRoute";
import {
  CONTENT_OUT_MS,
  FADE_IN_MS,
  FADE_OUT_MS,
  REVEAL_AT,
  REVEAL_MS,
  REVEAL_RISE_PX,
  appleCloseMotion,
  appleOpenMotion,
  clamp,
  lerp,
  sampleMotion,
  smooth,
  timeAt,
  type Box,
  type Motion,
  type Stage,
} from "./motion";
import { afterTwoFrames, clearSheetTimeout, sheetTimeout, boxOf, detectProfile, opacityNow, prefersReducedMotion, promote, startTogether, translateYOf } from "./dom";
import { peekPress, takePress } from "./source";
import { useSheetMorph, type SheetLayout, type SheetMorph, type SheetMorphOptions } from "./useSheetMorph";

/**
 * La fiche du bureau relaie l'aperçu au lieu de repartir de l'affiche (DECISIONS.md §61).
 *
 * Au bureau, l'aperçu du haut montre déjà le visuel et le logo du titre survolé. Faire grandir
 * l'affiche jusqu'à la fiche reconstruisait donc, sous les yeux, le fond qui était déjà là — « au
 * survol on a déjà la bannière, et au clic la fiche zoome en affichant la même bannière, c'est
 * perturbant » (Louis, 10/10/2026, sur la 8.31.2). Netflix et l'Apple TV gardent le fond et ne
 * changent que le contenu ; c'est ce que fait ce module :
 *
 * - le fond ne bouge pas : celui de la fiche fond par-dessus celui de l'aperçu (250 ms) — les deux
 *   cadrages diffèrent (l'aperçu est calé en haut et masqué), un fondu plutôt qu'un saut ;
 * - le logo de l'aperçu glisse jusqu'à sa place dans la fiche et prend sa taille — c'est le logo de
 *   la fiche lui-même, parti de la boîte de l'aperçu (une transformation, échantillonnée) ;
 * - le texte de l'aperçu s'efface vite, les rangées descendent un peu en s'effaçant, et le contenu
 *   de la fiche arrive d'un bloc quand le logo est presque posé ;
 * - la fermeture fait exactement l'inverse, et se laisse interrompre comme celle du téléphone.
 *
 * Le téléphone et l'iPad, eux, n'ont pas d'aperçu au survol : ils gardent l'affiche qui devient la
 * fiche (`useSheetMorph`). Le choix se fait au montage, une fois, par `useSheetTransition`.
 *
 * Même règles de fond que le trajet : rien que des transformations et des opacités, des calques
 * promus le temps du mouvement, des images clés échantillonnées une fois, aucun rendu React pendant
 * le mouvement, aucune image téléchargée pour animer.
 */

/** Le fondu du fond de la fiche, à l'ouverture comme à la fermeture. */
export const BACKDROP_FADE_MS = 250;
/** Le texte de l'aperçu s'efface avant que la fiche arrive. */
export const HERO_OUT_MS = 120;
/** Le texte de l'aperçu revient quand le logo a presque rejoint sa place. */
export const HERO_IN_MS = 140;
/** Ce que descendent les rangées en s'effaçant sous la fiche. */
export const ROWS_DROP_PX = 32;
/** La fermeture coupée par une ouverture : l'image de la copie s'efface en ceci. */
export const CUT_FADE_MS = 80;

type Entry = "continuity" | "fade" | "none";

const canAnimate = () => typeof Element !== "undefined" && typeof Element.prototype.animate === "function";
const LINEAR = (duration: number, fill: FillMode = "both"): KeyframeAnimationOptions => ({ duration, easing: "linear", fill });

/** L'accueil du bureau, et ses deux volets que la fiche fait céder. */
function homeParts(given?: HTMLElement | null): { home: HTMLElement | null; hero: HTMLElement | null; rows: HTMLElement | null } {
  const home = given ?? (typeof document === "undefined" ? null : document.querySelector<HTMLElement>("[data-sheet-home]"));
  return {
    home,
    hero: home?.querySelector<HTMLElement>("[data-sheet-hero]") ?? null,
    rows: home?.querySelector<HTMLElement>("[data-sheet-rows]") ?? null,
  };
}

/** Une autre fiche est-elle déjà ouverte ? Seule la première relaie l'accueil ; les suivantes passent devant une fiche. */
function otherSheetsOpen(root: HTMLElement): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-sheet-morph-root]")).some((el) => el !== root && el.style.visibility !== "hidden");
}

/** Le logo de l'aperçu, s'il montre ce titre : même image, à l'écran. */
function heroLogoFor(hero: HTMLElement | null, logo: HTMLImageElement | null): HTMLImageElement | null {
  if (!hero || !logo) return null;
  const src = logo.currentSrc || logo.src;
  if (!src) return null;
  const match = Array.from(hero.querySelectorAll<HTMLImageElement>("img")).find((img) => (img.currentSrc || img.src) === src);
  if (!match) return null;
  const r = match.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? match : null;
}

/** Le logo de la fiche : la première image de sa colonne. */
function sheetLogo(root: HTMLElement): HTMLImageElement | null {
  return root.querySelector<HTMLImageElement>("[data-sheet-content] img");
}

/** La transformation (origine en haut à gauche) qui pose la boîte `at` sur la boîte `from`. */
export function boxTransform(from: Box, at: Box): { tx: number; ty: number; sx: number; sy: number } {
  return { tx: from.x - at.x, ty: from.y - at.y, sx: at.w > 0 ? from.w / at.w : 1, sy: at.h > 0 ? from.h / at.h : 1 };
}

const tfCss = (t: { tx: number; ty: number; sx: number; sy: number }) =>
  `translate(${t.tx.toFixed(2)}px, ${t.ty.toFixed(2)}px) scale(${t.sx.toFixed(5)}, ${t.sy.toFixed(5)})`;

/** Les images clés du logo : de la boîte `from` à la boîte `to`, rapportées à sa boîte posée `at`. */
export function logoTrack(from: Box, to: Box, at: Box, motion: Motion): Keyframe[] {
  const a = boxTransform(from, at);
  const b = boxTransform(to, at);
  return sampleMotion(motion).map(({ offset, q }) => ({
    offset,
    transform: tfCss({ tx: lerp(a.tx, b.tx, q), ty: lerp(a.ty, b.ty, q), sx: lerp(a.sx, b.sx, q), sy: lerp(a.sy, b.sy, q) }),
  }));
}

/** Ce que l'accueil montre à l'instant : l'opacité de l'aperçu, la descente et l'opacité des rangées. */
type HomeState = { hero: number; rowsY: number; rows: number };

function homeNow(hero: HTMLElement | null, rows: HTMLElement | null): HomeState {
  return {
    hero: hero ? opacityNow(hero) : 1,
    rowsY: rows ? translateYOf(getComputedStyle(rows).transform) : 0,
    rows: rows ? opacityNow(rows) : 1,
  };
}

/** Les animations de l'accueil — une seule paire à la fois, quelle que soit la fiche qui la mène. */
const homeAnims: { list: Animation[] } = { list: [] };

function cancelHome(): void {
  for (const a of homeAnims.list.splice(0)) a.cancel();
}

/** Une fermeture en vol : de quoi la couper pour une autre ouverture, ou la retourner. */
type Flight = {
  control: Element | null;
  /** Le logo de la copie où il en est — l'ouverture qui la retourne repart de là. */
  logoBox: () => Box | null;
  cut: () => void;
};
const flights = new Set<Flight>();

/** Avant toute lecture d'une ouverture : les fermetures en vol se figent, l'accueil garde son point. */
function freezeHome(): void {
  for (const a of homeAnims.list) (a as Partial<Animation>).pause?.();
}

function decideEntry(o: SheetMorphOptions, off: boolean): Entry {
  if (off || typeof window === "undefined" || !canAnimate() || !o.active || o.revealed || !peekPress()) return "none";
  if (prefersReducedMotion()) return "fade";
  return "continuity";
}

/** Crée une animation en pause, la range, la rend. */
function paused(list: Animation[], el: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  const a = el?.animate(frames, options) ?? null;
  if (!a) return null;
  (a as Partial<Animation>).pause?.();
  list.push(a);
  return a;
}

/**
 * Le crochet de la continuité : mêmes options que `useSheetMorph`, et rien du tout quand `off`.
 */
export function useDesktopContinuity(opts: SheetMorphOptions & { off?: boolean; homeRef?: RefObject<HTMLElement | null> }): SheetMorph {
  const [entry] = useState<Entry>(() => decideEntry(opts, !!opts.off));
  const optsRef = useRef(opts);
  useLayoutEffect(() => {
    optsRef.current = opts;
  });

  const st = useRef<{
    anims: Animation[];
    restore: (() => void)[];
    timers: number[];
    cancelStart: (() => void) | null;
    unpromote: (() => void) | null;
    ownsHome: boolean;
    closing: boolean;
    closeAt: number;
    mountedAt: number;
    control: Element | null;
    layer: HTMLElement | null;
  }>({ anims: [], restore: [], timers: [], cancelStart: null, unpromote: null, ownsHome: false, closing: false, closeAt: 0, mountedAt: 0, control: null, layer: null });

  // L'ouverture, une fois, au montage.
  useLayoutEffect(() => {
    const root = opts.rootRef.current;
    if (!root || optsRef.current.off) return;
    const s = st.current;
    root.setAttribute("data-sheet-morph-root", "");
    const o = optsRef.current;
    // L'appui qui a ouvert la fiche est consommé ici : il ne doit pas servir à une fiche suivante.
    const source = !o.revealed && o.active ? takePress() : null;
    s.control = source?.control ?? s.control;
    if (entry === "continuity") openContinuity(root, source?.control ?? null);
    else if (entry === "fade") openFade(root);
    s.mountedAt = performance.now();
    return () => {
      if (s.closing) return;
      // Démontée par un retour (le bouton du navigateur) : la même fermeture que « Retour ».
      if (arrivedByBack() && optsRef.current.active && root.isConnected && canAnimate() && performance.now() - s.mountedAt > 100) {
        beginClose(root);
        return;
      }
      stopOpen();
      if (s.ownsHome) cancelHome();
    };
    // Une fois : la décision est prise au premier rendu, et tout le reste se lit dans des refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Une fiche qui a survécu à sa fermeture (un écran empilé par-dessus pendant la sortie)
  // redevient visible quand elle repasse au-dessus.
  useEffect(() => {
    const s = st.current;
    const root = opts.rootRef.current;
    if (!root || opts.off) return;
    if (opts.active && s.closing && !opts.leaving && performance.now() - s.closeAt > 1500) {
      root.style.visibility = "";
      s.closing = false;
    }
  }, [opts.active, opts.leaving, opts.rootRef, opts.off]);

  // La fermeture : au premier rendu où la fiche sort.
  useLayoutEffect(() => {
    if (!opts.leaving || st.current.closing || optsRef.current.off) return;
    const root = opts.rootRef.current;
    if (root) beginClose(root);
    // `beginClose` ne lit que des refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.leaving]);

  function stopOpen() {
    const s = st.current;
    s.cancelStart?.();
    s.cancelStart = null;
    for (const a of s.anims.splice(0)) a.cancel();
    for (const id of s.timers.splice(0)) clearSheetTimeout(id);
    for (const undo of s.restore.splice(0)) undo();
    s.unpromote?.();
    s.unpromote = null;
  }

  function hold(el: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    const before: Record<string, string> = {};
    for (const k of Object.keys(styles)) before[k] = (el.style as unknown as Record<string, string>)[k];
    Object.assign(el.style, styles);
    st.current.restore.push(() => Object.assign(el.style, before));
  }

  /** « Réduire les animations » : un fondu, rien qui se déplace. */
  function openFade(root: HTMLElement) {
    st.current.anims.push(root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN_MS, easing: "ease-out" }));
  }

  function openContinuity(root: HTMLElement, control: Element | null) {
    const s = st.current;
    const stage: Stage = { W: window.innerWidth, H: window.innerHeight };

    // 1. Une fermeture en vol est figée avant toute lecture : l'accueil garde son point, et le logo
    //    d'une fiche qu'on retourne repart d'où il en était.
    freezeHome();
    let logoFrom: Box | null = null;
    for (const f of Array.from(flights)) {
      if (!logoFrom && control && f.control === control) logoFrom = f.logoBox();
      f.cut();
    }

    // 2. Tout lire d'un coup.
    const { hero, rows } = otherSheetsOpen(root) ? { hero: null, rows: null } : homeParts(optsRef.current.homeRef?.current);
    const owns = !!(hero || rows);
    const from = homeNow(hero, rows);
    const photo = root.querySelector<HTMLElement>("[data-sheet-photo]");
    const veils = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-veil]"));
    const settle = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-settle]"));
    const column = root.querySelector<HTMLElement>("[data-sheet-content]");
    const logo = sheetLogo(root);
    const heroLogo = heroLogoFor(hero, logo);
    const logoAt = logo ? boxOf(logo) : null;
    logoFrom = logoFrom ?? (heroLogo ? boxOf(heroLogo) : null);
    const flying = !!(logo && logoAt && logoFrom && logoAt.w > 0);
    const logoChild = flying && column ? Array.from(column.children).find((c) => c.contains(logo)) ?? null : null;
    const block = [
      ...(column ? Array.from(column.children).filter((c): c is HTMLElement => c !== logoChild && c instanceof HTMLElement) : []),
      ...Array.from(root.querySelectorAll<HTMLElement>(":scope > button")),
    ];
    // Sans logo qui voyage, un trajet de référence : la colonne qui monterait de la descente des rangées.
    const colBox = column ? boxOf(column) : { x: 0, y: 0, w: stage.W, h: stage.H };
    const motion = flying
      ? appleOpenMotion(logoFrom as Box, logoAt as Box, stage, detectProfile())
      : appleOpenMotion({ ...colBox, y: colBox.y + ROWS_DROP_PX }, colBox, stage, detectProfile());
    const d = motion.duration;
    const samples = sampleMotion(motion);

    // 3. Écrire : la fiche transparente le temps que son fond arrive par-dessus celui de l'aperçu.
    hold(root, { backgroundColor: "transparent" });
    for (const el of settle) hold(el, { visibility: "hidden" });
    if (flying) hold(logo as HTMLElement, { transformOrigin: "0 0" });

    const anims = s.anims;
    for (const el of [photo, ...veils]) paused(anims, el, [{ opacity: 0 }, { opacity: 1 }], { duration: BACKDROP_FADE_MS, easing: "ease-out", fill: "backwards" });
    if (flying) paused(anims, logo, logoTrack(logoFrom as Box, logoAt as Box, logoAt as Box, motion), LINEAR(d, "backwards"));
    const revealAt = timeAt(samples, d, REVEAL_AT);
    for (const el of block)
      paused(anims, el, [{ opacity: 0, transform: `translateY(${REVEAL_RISE_PX}px)` }, { opacity: 1, transform: "none" }], {
        duration: REVEAL_MS,
        delay: revealAt,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "backwards",
      });
    const homeList: Animation[] = [];
    if (owns) {
      cancelHome();
      paused(homeList, hero, [{ opacity: from.hero }, { opacity: 0 }], { duration: HERO_OUT_MS, easing: "ease-out", fill: "both" });
      paused(
        homeList,
        rows,
        samples.map(({ offset, q }) => ({
          offset,
          opacity: lerp(from.rows, 0, smooth(0, 0.6, clamp(q, 0, 1))),
          transform: `translateY(${lerp(from.rowsY, ROWS_DROP_PX, q).toFixed(2)}px)`,
        })),
        LINEAR(d),
      );
      homeAnims.list = homeList;
      s.ownsHome = true;
    }
    s.unpromote = promote([photo, ...veils, flying ? (logo as HTMLElement) : null, ...block, hero, rows]);

    // 4. Le départ : le visuel décodé (il l'est d'ordinaire : c'est celui de l'aperçu), deux images
    //    de plus, et tout part sur la même.
    let cancelled = false;
    s.cancelStart = () => {
      cancelled = true;
    };
    const decoded = photo instanceof HTMLImageElement && photo.decode ? photo.decode().catch(() => undefined) : Promise.resolve();
    void Promise.race([decoded, new Promise<void>((ok) => sheetTimeout(() => ok(), 150))]).then(() => {
      if (cancelled) return;
      s.cancelStart = afterTwoFrames(() => {
        if (cancelled || s.closing) return;
        s.cancelStart = null;
        startTogether([...anims, ...homeList]);
        s.timers.push(sheetTimeout(() => settleOpen(photo), Math.max(d, BACKDROP_FADE_MS, revealAt + REVEAL_MS)));
      });
    });
  }

  /** L'arrivée : la fiche reprend son fond ; l'accueil reste cédé dessous (ses animations gardent leur fin). */
  function settleOpen(photo: HTMLElement | null) {
    const s = st.current;
    if (s.closing) return;
    // Encore dans le fondu d'arrivée de son image, le visuel serait à moitié transparent au relais.
    if (photo instanceof HTMLImageElement && photo.complete && photo.naturalWidth > 0) {
      photo.style.transition = "none";
      photo.style.opacity = "1";
    }
    for (const a of s.anims.splice(0)) a.cancel();
    for (const undo of s.restore.splice(0)) undo();
    s.unpromote?.();
    s.unpromote = null;
  }

  function beginClose(root: HTMLElement) {
    const s = st.current;
    const o = optsRef.current;
    s.closing = true;
    s.closeAt = performance.now();
    const owns = s.ownsHome && !otherSheetsOpen(root);
    const { hero, rows } = owns ? homeParts(optsRef.current.homeRef?.current) : { hero: null, rows: null };

    if (o.instantExit || !canAnimate()) {
      stopOpen();
      if (s.ownsHome) cancelHome();
      root.style.visibility = "hidden";
      return;
    }

    // 1. Tout lire d'où on en est, avant d'arrêter l'ouverture.
    freezeHome();
    const from = homeNow(hero, rows);
    const logo = sheetLogo(root);
    const logoNow = logo ? boxOf(logo) : null;
    const contentSel = "[data-sheet-content] > *, :scope > button";
    const contentNow = Array.from(root.querySelectorAll<HTMLElement>(contentSel)).map((el) => opacityNow(el));
    const backdropSel = "[data-sheet-photo], [data-sheet-veil]";
    const backdropNow = Array.from(root.querySelectorAll<HTMLElement>(backdropSel)).map((el) => opacityNow(el));

    // 2. L'ouverture s'arrête ; la fiche reprend son allure posée — c'est elle que la copie reproduit.
    stopOpen();
    const logoAt = logo ? boxOf(logo) : null;
    const heroLogo = heroLogoFor(hero, logo);
    const heroBox = heroLogo ? boxOf(heroLogo) : null;
    const reduced = prefersReducedMotion();
    const flying = !reduced && !!(logo && logoNow && logoAt && heroBox && logoAt.w > 0);

    // 3. La copie prend la place de la fiche, qui se cache et rend l'adresse aussitôt.
    const layer = document.createElement("div");
    layer.setAttribute("data-sheet-morph-layer", "");
    layer.setAttribute("aria-hidden", "true");
    Object.assign(layer.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: getComputedStyle(root).zIndex || "47" });
    root.parentNode?.insertBefore(layer, root);
    s.layer = layer;
    const copy = root.cloneNode(true) as HTMLElement;
    copy.classList.add("sheet-morph-clone");
    copy.removeAttribute("data-sheet-morph-root");
    copy.setAttribute("aria-hidden", "true");
    copy.inert = true;
    for (const el of Array.from(copy.querySelectorAll("video, audio, iframe"))) el.remove();
    for (const el of Array.from(copy.querySelectorAll("[id]"))) el.removeAttribute("id");
    Object.assign(copy.style, { pointerEvents: "none", visibility: "visible", transition: "none", backgroundColor: "transparent" });
    layer.appendChild(copy);
    // Le défilement de la fiche, sinon la copie repartirait en haut.
    const walkA = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const walkB = document.createTreeWalker(copy, NodeFilter.SHOW_ELEMENT);
    for (let a: Node | null = walkA.currentNode, b: Node | null = walkB.currentNode; a && b; a = walkA.nextNode(), b = walkB.nextNode()) {
      const ea = a as HTMLElement;
      if (ea.scrollTop || ea.scrollLeft) {
        (b as HTMLElement).scrollTop = ea.scrollTop;
        (b as HTMLElement).scrollLeft = ea.scrollLeft;
      }
    }
    for (const el of Array.from(copy.querySelectorAll<HTMLElement>("[data-sheet-settle]"))) el.style.visibility = "hidden";
    root.style.visibility = "hidden";
    s.timers.push(
      sheetTimeout(() => {
        if (root.isConnected && optsRef.current.active) {
          root.style.visibility = "";
          s.closing = false;
        }
      }, 1500),
    );

    const copyLogo = sheetLogo(copy);
    const copyContent = Array.from(copy.querySelectorAll<HTMLElement>(contentSel));
    const copyBackdrop = Array.from(copy.querySelectorAll<HTMLElement>(backdropSel));
    const logoChild = flying && copyLogo ? copyContent.find((c) => c.contains(copyLogo) && c !== copyLogo) ?? null : null;
    copyContent.forEach((el, i) => (el.style.opacity = String(contentNow[i] ?? 1)));
    copyBackdrop.forEach((el, i) => (el.style.opacity = String(backdropNow[i] ?? 1)));

    const stage: Stage = { W: window.innerWidth, H: window.innerHeight };
    const motion = flying
      ? appleCloseMotion(logoNow as Box, heroBox as Box, stage, detectProfile())
      : appleCloseMotion({ x: 0, y: 0, w: stage.W, h: stage.H }, { x: 0, y: ROWS_DROP_PX, w: stage.W, h: stage.H }, stage, detectProfile());
    const d = reduced ? FADE_OUT_MS : Math.max(motion.duration, BACKDROP_FADE_MS);
    const samples = sampleMotion(motion);

    const anims: Animation[] = [];
    const go = (el: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions) => paused(anims, el, frames, options);
    if (reduced) {
      go(copy, [{ opacity: 1 }, { opacity: 0 }], { duration: FADE_OUT_MS, easing: "ease-in", fill: "both" });
    } else {
      copyContent.forEach((el, i) => {
        if (el === logoChild || el === copyLogo) return;
        const f = contentNow[i] ?? 1;
        go(el, [{ opacity: f }, { opacity: 0 }], { duration: f > 0 ? CONTENT_OUT_MS : 1, easing: "ease-in", fill: "both" });
      });
      copyBackdrop.forEach((el, i) => {
        const f = backdropNow[i] ?? 1;
        go(el, [{ opacity: f }, { opacity: 0 }], { duration: BACKDROP_FADE_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "both" });
      });
      if (flying && copyLogo) {
        copyLogo.style.transformOrigin = "0 0";
        go(copyLogo, logoTrack(logoNow as Box, heroBox as Box, logoAt as Box, motion), LINEAR(motion.duration));
      }
    }
    const homeList: Animation[] = [];
    if (owns) {
      cancelHome();
      // Le texte de l'aperçu revient quand le logo a presque rejoint sa place : il y retrouve le sien.
      const heroAt = reduced ? 0 : flying ? timeAt(samples, motion.duration, REVEAL_AT) : 0;
      paused(homeList, hero, [{ opacity: from.hero }, { opacity: 1 }], { duration: reduced ? FADE_OUT_MS : HERO_IN_MS, delay: heroAt, easing: "ease-out", fill: "both" });
      paused(
        homeList,
        rows,
        reduced
          ? [{ opacity: from.rows, transform: `translateY(${from.rowsY}px)` }, { opacity: 1, transform: "none" }]
          : samples.map(({ offset, q }) => ({
              offset,
              opacity: lerp(from.rows, 1, smooth(0.1, 0.9, clamp(q, 0, 1))),
              transform: `translateY(${lerp(from.rowsY, 0, q).toFixed(2)}px)`,
            })),
        reduced ? { duration: FADE_OUT_MS, easing: "ease-out", fill: "both" } : LINEAR(motion.duration),
      );
      homeAnims.list = homeList;
    }
    const unpromote = promote([copy, copyLogo, ...copyBackdrop, hero, rows]);
    startTogether([...anims, ...homeList]);

    const timers: number[] = [];
    const finish = () => {
      flights.delete(flight);
      for (const id of timers.splice(0)) clearSheetTimeout(id);
      for (const a of anims) a.cancel();
      unpromote();
      layer.remove();
      // L'accueil est revenu à son allure : ses animations, finies sur cette allure, s'en vont.
      if (owns && homeAnims.list === homeList) cancelHome();
    };
    const flight: Flight = {
      control: s.control,
      logoBox: () => (copyLogo ? boxOf(copyLogo) : null),
      cut: () => {
        flights.delete(flight);
        for (const id of timers.splice(0)) clearSheetTimeout(id);
        for (const a of anims) (a as Partial<Animation>).pause?.();
        unpromote();
        const fade = copy.animate([{ opacity: opacityNow(copy) }, { opacity: 0 }], { duration: CUT_FADE_MS, easing: "ease-out", fill: "both" });
        fade.onfinish = () => layer.remove();
      },
    };
    flights.add(flight);
    timers.push(sheetTimeout(finish, d));
  }

  // Les fiches du bureau ne diffèrent rien sous la ligne de flottaison : elles sont posées d'emblée.
  return { handlesEntry: entry !== "none", settled: true };
}

/**
 * La transition d'une fiche de titre, choisie au montage : la continuité du fond sur un ordinateur
 * (souris, aperçu au survol), l'affiche qui devient la fiche sur le téléphone et l'iPad. Les deux
 * crochets sont appelés à chaque rendu — l'ordre des crochets ne change jamais —, l'un des deux ne
 * fait rien.
 */
export function useSheetTransition(opts: SheetMorphOptions & { layout: SheetLayout }): SheetMorph {
  const [continuity] = useState(() => opts.layout === "desktop" && detectProfile() === "desktop");
  const morph = useSheetMorph({ ...opts, off: continuity });
  const cont = useDesktopContinuity({ ...opts, off: !continuity });
  return continuity ? cont : morph;
}

/** Pour les tests : les fermetures en vol, et de quoi repartir d'une page propre. */
export const desktopContinuityForTests = {
  flights: () => flights.size,
  reset: () => {
    flights.clear();
    cancelHome();
  },
};
