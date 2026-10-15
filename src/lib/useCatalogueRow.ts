"use client";

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { prefersReducedMotion } from "@/lib/reducedMotion";
import { rowsDelayMs } from "@/lib/heroCarousel";
import { CATALOGUE_FLIP, useFlipGrid } from "@/lib/useFlipGrid";

/**
 * Une rangée d'affiches du catalogue quand ses titres changent sous les yeux — pour toutes les
 * rangées des deux accueils (15/10/2026, DECISIONS.md §96).
 *
 * Le catalogue se relit désormais au retour au premier plan (`useCatalogueRefresh`) : un film arrive
 * dans « Ajouts récents » et dans son genre, un autre quitte la bibliothèque. Ce qui existait déjà
 * (`useFlipGrid`, `CATALOGUE_FLIP`) fait glisser les voisines et poser une carte qui arrive ; il
 * manquait deux choses, décidées ici une fois :
 *
 *  - **une carte qui part s'efface sur place** (opacité et échelle, `CATALOGUE_LEAVE_MS`), sans
 *    pointeur ni focus, puis ses voisines glissent dans le trou — la règle de « Reprendre » (§86,
 *    `withLeaving`), sur la même écriture du placement (`interleaveLeaving`) ;
 *  - **rien ne bouge sous la main** : une rangée qu'on fait défiler, qu'on touche, que la souris
 *    survole ou qui tient le focus (clavier, télécommande) garde ce qu'elle montre. Sa mise à jour
 *    attend qu'elle soit au repos (`ROW_REST_MS` après le dernier défilement), puis se joue avec les
 *    mêmes animations.
 *
 * « Réduire les animations » : la rangée est remplacée telle quelle, sans effacement ni glissement —
 * mais toujours pas sous la main.
 */

/** La durée de l'effacement d'une carte qui part — celle de « Reprendre » (`continue-leave`). */
export const CATALOGUE_LEAVE_MS = 220;
/** Sans défilement depuis tout ce temps, la rangée est au repos. */
export const ROW_REST_MS = 300;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * La liste à dessiner : `next`, plus les éléments de `before` qui n'y sont plus, chacun laissé après
 * la dernière voisine qui le précédait et est toujours là — ou en tête, s'il n'y en a pas. Une seule
 * écriture de ce placement, pour « Reprendre » (`withLeaving`) et les rangées du catalogue.
 */
export function interleaveLeaving<T, L = T>(
  before: readonly T[],
  next: readonly T[],
  keyOf: (item: T) => string,
  mark: (item: T) => L = (item) => item as unknown as L
): (T | L)[] {
  const present = new Set(next.map(keyOf));
  const after = new Map<string | null, L[]>();
  let anchor: string | null = null;
  for (const item of before) {
    const key = keyOf(item);
    if (present.has(key)) {
      anchor = key;
      continue;
    }
    const list = after.get(anchor) ?? [];
    list.push(mark(item));
    after.set(anchor, list);
  }
  if (after.size === 0) return [...next];
  const out: (T | L)[] = [...(after.get(null) ?? [])];
  for (const item of next) {
    out.push(item);
    out.push(...(after.get(keyOf(item)) ?? []));
  }
  return out;
}

/**
 * Le rang de chaque carte d'un classement dessiné (`shown`) : compté sur les cartes qui restent — une
 * carte qui part garde le rang de la place qu'elle quitte, le temps de s'effacer.
 */
export function catalogueRanks<T>(shown: readonly T[], leaving: ReadonlySet<string>, keyOf: (item: T) => string): number[] {
  const ranks: number[] = [];
  let staying = 0;
  for (const item of shown) {
    if (leaving.has(keyOf(item))) ranks.push(staying + 1);
    else ranks.push(++staying);
  }
  return ranks;
}

// ─── La rangée au repos ────────────────────────────────────────────────────────────────────────

interface RestStore {
  busy: boolean;
  /** Une mise à jour attend le repos : alors seulement, un changement d'état redessine la rangée. */
  wanted: boolean;
  listeners: Set<() => void>;
}

function createRestStore(): RestStore {
  return { busy: false, wanted: false, listeners: new Set() };
}

function setBusy(store: RestStore, busy: boolean): void {
  if (store.busy === busy) return;
  store.busy = busy;
  // Défiler une rangée ne la redessine pas — sauf quand une mise à jour attend justement son repos.
  if (store.wanted) for (const listener of [...store.listeners]) listener();
}

function forgetBusy(store: RestStore): void {
  store.busy = false;
}

function wantRest(store: RestStore, wanted: boolean): void {
  store.wanted = wanted;
}

/**
 * La rangée est-elle sous la main ? Défilement récent, doigt posé, souris dessus, focus dedans.
 * Lu au rendu (`useSyncExternalStore`) ; ne redessine la rangée que lorsqu'une mise à jour l'attend.
 */
function useRowBusy(trackRef: RefObject<HTMLElement | null>, present: boolean, store: RestStore): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      store.listeners.add(onChange);
      const el = trackRef.current;
      if (!el) {
        return () => {
          store.listeners.delete(onChange);
        };
      }
      let pointerDown = false;
      let hover = false;
      let focused = el.contains(document.activeElement);
      let scrolling = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const update = () => setBusy(store, pointerDown || hover || focused || scrolling);
      const onScroll = () => {
        scrolling = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
          scrolling = false;
          update();
        }, ROW_REST_MS);
        update();
      };
      const onDown = () => {
        pointerDown = true;
        update();
      };
      const onUp = () => {
        if (!pointerDown) return;
        pointerDown = false;
        update();
      };
      const onEnter = (e: PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        hover = true;
        update();
      };
      const onLeave = () => {
        if (!hover) return;
        hover = false;
        update();
      };
      const onFocusIn = () => {
        focused = true;
        update();
      };
      const onFocusOut = (e: FocusEvent) => {
        focused = el.contains(e.relatedTarget as Node | null);
        update();
      };
      const passive = { passive: true } as const;
      el.addEventListener("scroll", onScroll, passive);
      el.addEventListener("pointerdown", onDown, passive);
      el.addEventListener("pointerenter", onEnter);
      el.addEventListener("pointerleave", onLeave);
      el.addEventListener("focusin", onFocusIn);
      el.addEventListener("focusout", onFocusOut);
      // Le doigt peut se lever hors de la rangée.
      window.addEventListener("pointerup", onUp, passive);
      window.addEventListener("pointercancel", onUp, passive);
      update();
      return () => {
        store.listeners.delete(onChange);
        clearTimeout(timer);
        el.removeEventListener("scroll", onScroll);
        el.removeEventListener("pointerdown", onDown);
        el.removeEventListener("pointerenter", onEnter);
        el.removeEventListener("pointerleave", onLeave);
        el.removeEventListener("focusin", onFocusIn);
        el.removeEventListener("focusout", onFocusOut);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        // Une piste détachée n'est plus sous la main de personne.
        forgetBusy(store);
      };
    },
    // `present` : la piste n'existe qu'une fois la rangée pourvue — s'y abonner à ce moment-là.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trackRef, store, present]
  );
  const getSnapshot = useCallback(() => store.busy, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

// ─── La rangée ─────────────────────────────────────────────────────────────────────────────────

interface Presence<T> {
  /** La liste d'où `shown` a été tiré. */
  source: readonly T[];
  shown: readonly T[];
  leaving: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function sameKeys<T>(a: readonly T[], b: readonly T[], keyOf: (item: T) => string): boolean {
  return a.length === b.length && a.every((item, i) => keyOf(item) === keyOf(b[i]));
}

export interface CatalogueRow<T> {
  /** Ce qu'il faut dessiner, dans l'ordre : la liste appliquée, et les cartes qui partent. */
  shown: readonly T[];
  /** Les clés des cartes en train de partir. */
  leaving: ReadonlySet<string>;
}

/**
 * `items` tels que la rangée doit les dessiner, et ses animations : voir le haut du module.
 * `keyOf` doit donner la même clé que le `key` React de chaque carte, enfants directs de la piste.
 */
export function useCatalogueRow<T>(trackRef: RefObject<HTMLElement | null>, items: readonly T[], keyOf: (item: T) => string): CatalogueRow<T> {
  const [store] = useState(createRestStore);
  const busy = useRowBusy(trackRef, items.length > 0, store);
  const [presence, setPresence] = useState<Presence<T>>(() => ({ source: items, shown: items, leaving: NONE }));

  // Ajusté pendant le rendu, comme « Reprendre » (§86) : un effet dessinerait d'abord la nouvelle
  // liste sans ses cartes partantes, puis avec — un clignotement.
  let current = presence;
  if (presence.source !== items && !sameItems(presence.source, items)) {
    if (sameKeys(presence.source, items, keyOf)) {
      // Les mêmes titres au même rang (une affiche, un synopsis mis à jour) : rien ne bouge, tout de suite.
      current = { source: items, shown: interleaveLeaving(presence.shown, items, keyOf), leaving: presence.leaving };
      setPresence(current);
    } else if (!busy) {
      const visible = presence.shown.filter((item) => !presence.leaving.has(keyOf(item)));
      const gone = visible.filter((item) => !items.some((next) => keyOf(next) === keyOf(item)));
      // Au-delà de ce que `CATALOGUE_FLIP` fait glisser, la rangée se remplace en fondu : des cartes
      // qui s'effaceraient une à une n'y auraient plus de sens.
      const animate = gone.length > 0 && gone.length <= (CATALOGUE_FLIP.maxChanged ?? 3) && !prefersReducedMotion();
      if (animate) {
        const leaving = new Set([...presence.leaving, ...gone.map(keyOf)]);
        const shown = interleaveLeaving(presence.shown, items, keyOf);
        current = { source: items, shown, leaving };
      } else {
        current = { source: items, shown: items, leaving: NONE };
      }
      setPresence(current);
    }
    // Sous la main : la rangée garde ce qu'elle montre, et attend son repos (`store.wanted`).
  }

  const pending = current.source !== items && !sameItems(current.source, items);
  useLayoutEffect(() => {
    wantRest(store, pending);
  }, [store, pending]);

  // Les cartes qui partent : effacées sur place, sans pointeur ni focus, puis retirées.
  const animations = useRef(new Map<string, { el: HTMLElement; animation: Animation | null }>());
  const leavingSignature = [...current.leaving].join("\u0000");
  const shownKeys = current.shown.map(keyOf);
  useLayoutEffect(() => {
    const track = trackRef.current;
    const running = animations.current;
    // Une carte revenue avant la fin de son effacement (ou déjà sortie) : rendue telle qu'elle était.
    for (const [key, { el, animation }] of running) {
      if (current.leaving.has(key)) continue;
      animation?.cancel();
      el.removeAttribute("inert");
      el.style.pointerEvents = "";
      running.delete(key);
    }
    if (!track || current.leaving.size === 0) return;
    const wait = Math.max(0, rowsDelayMs());
    const children = Array.from(track.children) as HTMLElement[];
    children.forEach((el, i) => {
      const key = shownKeys[i];
      if (key === undefined || !current.leaving.has(key) || running.has(key)) return;
      el.setAttribute("inert", "");
      el.style.pointerEvents = "none";
      const animation =
        typeof el.animate === "function"
          ? el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.92)" }], {
              duration: CATALOGUE_LEAVE_MS,
              easing: EASE,
              delay: wait,
              fill: "forwards",
            })
          : null;
      running.set(key, { el, animation });
    });
    const timer = setTimeout(() => {
      setPresence((p) => (p.leaving.size === 0 ? p : { source: p.source, shown: p.source, leaving: NONE }));
    }, wait + CATALOGUE_LEAVE_MS);
    return () => clearTimeout(timer);
    // La signature des partantes suffit : un rendu de plus ne relance pas l'effacement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leavingSignature, trackRef]);

  // Les voisines glissent, les arrivées se posent — la règle de toutes les rangées du catalogue.
  useFlipGrid(trackRef, shownKeys, CATALOGUE_FLIP);

  return { shown: current.shown, leaving: current.leaving };
}
