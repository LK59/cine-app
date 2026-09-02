"use client";

import { useSyncExternalStore } from "react";

// Which Cinema Mode layer is open, expressed in the URL so the browser's own Back and Forward —
// and the phone's edge-swipe, which is the same thing — step through the screens instead of
// leaving Cinema Mode entirely.
//
// Two deliberate choices:
//
// 1. The state lives in the URL *hash*, not in query params. Changing a query param is a route
//    change to Next's App Router, which fetches the target route's RSC payload — the exact
//    request that was observed failing at transport level in production (see Sidebar's comment
//    on the Cinema entry link, and lib/leaveCinema). A hash change is invisible to the router:
//    no fetch, nothing to fail, and back/forward and deep links all still work.
//
// 2. It's a plain external store over the History API rather than Next's useSearchParams, for
//    the same reason — and because useSyncExternalStore gives every consumer (the browse client,
//    the detail sheets) the same value without threading props through three levels.
export interface CinemaRoute {
  tab: "movies" | "series";
  film: number | null;
  serie: number | null;
  /** The season/episode browser, opened from a series sheet. */
  episodes: boolean;
  search: boolean;
}

const EMPTY: CinemaRoute = { tab: "movies", film: null, serie: null, episodes: false, search: false };

// How many entries this session has pushed. Kept in history.state so a close can tell "I opened
// this, stepping back is right" from "someone deep-linked straight here, there is nothing of ours
// behind" — where stepping back would leave the app entirely.
const DEPTH_KEY = "cinemaDepth";

function readNumber(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parse(hash: string): CinemaRoute {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return {
    tab: params.get("tab") === "series" ? "series" : "movies",
    film: readNumber(params, "film"),
    serie: readNumber(params, "serie"),
    episodes: params.get("episodes") === "1",
    search: params.get("recherche") === "1",
  };
}

function serialize(route: CinemaRoute): string {
  const params = new URLSearchParams();
  if (route.tab === "series") params.set("tab", "series");
  if (route.film) params.set("film", String(route.film));
  if (route.serie) params.set("serie", String(route.serie));
  if (route.episodes) params.set("episodes", "1");
  if (route.search) params.set("recherche", "1");
  const query = params.toString();
  return query ? `#${query}` : "";
}

// useSyncExternalStore requires a stable snapshot identity between changes, so the parsed object
// is cached against the hash it came from — re-parsing on every render would hand React a new
// object each time and loop.
let cachedHash: string | null = null;
let cachedRoute: CinemaRoute = EMPTY;

function getSnapshot(): CinemaRoute {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parse(hash);
  }
  return cachedRoute;
}

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // popstate covers Back/Forward over entries we pushed; hashchange covers a hash edited in the
  // address bar or a same-page link. Both end up re-reading location, so a duplicate is harmless.
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("hashchange", onChange);
  };
}

export function useCinemaRoute(): CinemaRoute {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

function currentDepth(): number {
  const state = window.history.state as Record<string, unknown> | null;
  const depth = state?.[DEPTH_KEY];
  return typeof depth === "number" ? depth : 0;
}

// `push` for opening a screen (Back should close it); `replace` for changing something about the
// screen you're already on, like the Films/Séries tab — a filter shouldn't cost a Back press.
export function cinemaNavigate(patch: Partial<CinemaRoute>, mode: "push" | "replace" = "push"): void {
  if (typeof window === "undefined") return;
  const next = { ...getSnapshot(), ...patch };
  const url = `${window.location.pathname}${window.location.search}${serialize(next)}`;
  const depth = currentDepth();
  // Spread whatever Next put in history.state rather than replacing it — its router reads its own
  // keys back on popstate.
  const state = { ...(window.history.state ?? {}), [DEPTH_KEY]: mode === "push" ? depth + 1 : depth };
  if (mode === "push") window.history.pushState(state, "", url);
  else window.history.replaceState(state, "", url);
  emit();
}

// Closing a layer. Stepping back is what keeps Forward meaningful and avoids piling up an entry
// per open/close; but with nothing of ours behind (a deep link straight into a title), back would
// leave the app, so that case rewrites the current entry instead.
export function cinemaClose(fallback: Partial<CinemaRoute>): void {
  if (typeof window === "undefined") return;
  if (currentDepth() > 0) window.history.back();
  else cinemaNavigate(fallback, "replace");
}
