"use client";

import { useSyncExternalStore } from "react";

/**
 * Ce que la page des livres montre, dans le fragment de l'adresse (DECISIONS.md §127) : `#livre=<id>`
 * pour la fiche, `#livre=<id>&lire` pour le lecteur par-dessus. Le même principe que le cinéma
 * (`cinemaRoute.ts`), écrit à part et en petit : la page des livres n'a ni onglets ni pile de fiches,
 * et l'option ne touche à rien de ce que le cinéma décide.
 *
 * Chaque ouverture empile une entrée d'historique : le bouton Retour d'Android, le geste de retour
 * d'iOS et Échap referment ce qui est au-dessus, dans l'ordre. Une adresse arrivée telle quelle (un
 * rechargement sur le lecteur) n'a rien d'empilé sous elle : la fermer remplace l'entrée au lieu de
 * quitter la page.
 */

export interface BookRoute {
  book: string | null;
  reading: boolean;
}

const DEPTH_KEY = "laternaBooksDepth";
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
    window.removeEventListener("hashchange", listener);
  };
}

const hashSnapshot = () => window.location.hash;
const serverSnapshot = () => "";

export function parseBookRoute(hash: string): BookRoute {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const book = params.get("livre");
  const id = book && /^[0-9a-f]{32}$/i.test(book) ? book.toLowerCase() : null;
  return { book: id, reading: id !== null && params.has("lire") };
}

export function bookRouteHash(route: BookRoute): string {
  if (!route.book) return "";
  return `#livre=${route.book}${route.reading ? "&lire" : ""}`;
}

export function useBookRoute(): BookRoute {
  const hash = useSyncExternalStore(subscribe, hashSnapshot, serverSnapshot);
  return parseBookRoute(hash);
}

function depth(): number {
  const value = (window.history.state as Record<string, unknown> | null)?.[DEPTH_KEY];
  return typeof value === "number" ? value : 0;
}

function write(route: BookRoute, mode: "push" | "replace", nextDepth: number): void {
  // L'état de Next est gardé tel quel : son routeur y lit le sien.
  const state = { ...((window.history.state ?? {}) as Record<string, unknown>), [DEPTH_KEY]: nextDepth };
  const url = `${window.location.pathname}${window.location.search}${bookRouteHash(route)}`;
  if (mode === "push") window.history.pushState(state, "", url);
  else window.history.replaceState(state, "", url);
  notify();
}

export function openBookRoute(route: BookRoute): void {
  write(route, "push", depth() + 1);
}

/** Referme ce qui est au-dessus : le lecteur, sinon la fiche. Un seul retour à la fois. */
let backInFlight = false;
export function closeBookRoute(): void {
  const current = parseBookRoute(window.location.hash);
  if (!current.book) return;
  if (depth() > 0) {
    if (backInFlight) return;
    backInFlight = true;
    const done = () => {
      backInFlight = false;
      window.removeEventListener("popstate", done);
    };
    window.addEventListener("popstate", done);
    window.history.back();
    return;
  }
  // Une fiche ouverte depuis l'accueil du cinéma (`?retour=1`, `BooksHome`) se referme sur lui, pas
  // sur la grille complète : on y était, on y revient — par l'historique quand on en vient vraiment.
  if (!current.reading && new URLSearchParams(window.location.search).get("retour") === "1") {
    let fromHome = false;
    try {
      fromHome = new URL(document.referrer).origin === window.location.origin;
    } catch {
      /* pas de provenance lisible */
    }
    if (fromHome) window.history.back();
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- un vrai chargement, exprès : l'accueil a sa propre politique de sécurité.
    else window.location.assign("/#livres=1");
    return;
  }
  write(current.reading ? { book: current.book, reading: false } : { book: null, reading: false }, "replace", 0);
}
