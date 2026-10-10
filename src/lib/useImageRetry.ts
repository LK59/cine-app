"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { forgetImage, probeImage, reportImageFailure, settleRetry, type RetryEntry } from "@/lib/imageRetry";

/**
 * Le branchement d'une image sur le registre des nouveaux essais (`imageRetry.ts`).
 *
 * Deux façons de réessayer, selon ce que l'image montre en échec :
 * - `element` : l'élément reste dans le document, son repli dessous (l'affiche et son carré gris,
 *   les couches de la bannière d'accueil) ; un essai le remonte (`retryKey` à poser en `key`), ce
 *   qui redemande la même adresse, et son `onLoad` / `onError` disent comment ça s'est passé ;
 * - `probe` : le repli remplace l'élément (le logo cède au titre écrit, la bannière au fond uni) ;
 *   un essai recharge l'adresse hors du document, et l'élément revient seulement une fois l'image en
 *   cache.
 *
 * `failed` : à montrer le repli. `recovered` : l'image est arrivée après un échec — l'appelant la
 * fait paraître en fondu (`image-retry-in`), puisqu'elle remplace un repli déjà visible.
 */
export function useImageRetry(
  src: string | null | undefined,
  options: { mode?: "element" | "probe"; player?: boolean } = {}
): {
  failed: boolean;
  recovered: boolean;
  retryKey: number;
  onError: () => void;
  onLoad: () => void;
  track: (el: Element | null) => void;
} {
  const mode = options.mode ?? "element";
  const player = options.player ?? false;
  const [state, setState] = useState({ src, failed: false, recovered: false, key: 0 });
  // Une autre adresse est une autre image : rien de l'échec de la précédente ne la concerne.
  if (state.src !== src) setState({ src, failed: false, recovered: false, key: 0 });

  const entryRef = useRef<RetryEntry | null>(null);
  const srcRef = useRef(src);
  const observed = useRef<Element | null>(null);
  useEffect(() => {
    srcRef.current = src;
    const entry: RetryEntry = {
      player,
      retry: () => {
        if (mode === "element") {
          setState((s) => (s.src === src ? { ...s, key: s.key + 1 } : s));
          return;
        }
        const current = srcRef.current;
        if (!current) {
          settleRetry(entry, false);
          return;
        }
        probeImage(current, (ok) => {
          settleRetry(entry, ok);
          if (ok) setState((s) => (s.src === current ? { ...s, failed: false, recovered: true } : s));
        });
      },
    };
    entryRef.current = entry;
    // L'élément a pu être posé avant cet effet (les `ref` passent d'abord) : il suit la nouvelle entrée.
    if (observed.current) observe(observed.current, entry);
    return () => {
      forgetImage(entry);
      if (entryRef.current === entry) entryRef.current = null;
    };
  }, [src, mode, player]);

  const onError = useCallback(() => {
    const entry = entryRef.current;
    setState((s) => (s.failed ? s : { ...s, failed: true }));
    if (entry) reportImageFailure(entry);
  }, []);

  const onLoad = useCallback(() => {
    const entry = entryRef.current;
    if (entry) settleRetry(entry, true);
    setState((s) => (s.failed ? { ...s, failed: false, recovered: true } : s));
  }, []);

  // À l'écran ou non : les images visibles réessaient d'abord. Un observateur pour toutes.
  const track = useCallback((el: Element | null) => {
    if (observed.current) unobserve(observed.current);
    observed.current = el;
    if (el && entryRef.current) observe(el, entryRef.current);
  }, []);

  return { failed: state.failed, recovered: state.recovered, retryKey: state.key, onError, onLoad, track };
}

let observer: IntersectionObserver | null = null;
const watched = new Map<Element, RetryEntry>();

function observe(el: Element, entry: RetryEntry): void {
  if (typeof IntersectionObserver === "undefined") return;
  observer ??= new IntersectionObserver((records) => {
    for (const record of records) {
      const target = watched.get(record.target);
      if (target) target.visible = record.isIntersecting;
    }
  });
  watched.set(el, entry);
  observer.observe(el);
}

function unobserve(el: Element): void {
  watched.delete(el);
  observer?.unobserve(el);
}
