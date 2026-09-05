"use client";

import { useSyncExternalStore } from "react";

// Which Cinema Mode layer is open, expressed in the URL so the browser's own Back and Forward —
// and the phone's edge-swipe, which is the same thing — step through the screens instead of
// leaving Cinema Mode entirely.
//
// Two deliberate choices:
//
// 1. The state lives in the URL *hash*, not in query params. Which sheet is open is pure client
//    state — no server data is keyed by it — and a query param change is a route change to
//    Next's App Router: a network round-trip before an overlay that is already fully loaded can
//    appear. A hash change is invisible to the router, so opening a sheet stays instant and
//    works offline, while back/forward and deep links behave identically either way.
//
//    (This also sidestepped an RSC fetch failure that plagued this route for months. That is
//    fixed and verified now — but the reasoning above is why the hash stays regardless.)
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
  /** « Ma liste » — les cinq segments, ouverts depuis le rail. */
  list: boolean;
  /** « Compte » — réglages et déconnexion, ouverts depuis le rail. */
  account: boolean;
  /** Une fiche de titre absent de la bibliothèque, identifiée par son id TMDB. */
  discover: number | null;
  /** Le type de `discover` — une fiche TMDB n'a pas d'id Radarr/Sonarr pour le déduire. */
  discoverType: "movie" | "series";
  /** Une fiche personne, identifiée par son id TMDB. */
  person: number | null;
  /**
   * Le tiroir de navigation, sur téléphone.
   *
   * Dans l'URL, contrairement au rail du bureau qui n'est qu'un survol : sur Android, le geste de
   * retour doit refermer le tiroir plutôt que quitter l'écran, et c'est l'historique qui le
   * permet — gratuitement, puisque tout le reste passe déjà par là.
   */
  menu: boolean;
}

const EMPTY: CinemaRoute = {
  tab: "movies",
  film: null,
  serie: null,
  episodes: false,
  search: false,
  list: false,
  account: false,
  discover: null,
  discoverType: "movie",
  person: null,
  menu: false,
};

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
    list: params.get("liste") === "1",
    account: params.get("compte") === "1",
    discover: readNumber(params, "decouverte"),
    discoverType: params.get("type") === "series" ? "series" : "movie",
    person: readNumber(params, "personne"),
    menu: params.get("menu") === "1",
  };
}

function serialize(route: CinemaRoute): string {
  const params = new URLSearchParams();
  if (route.tab === "series") params.set("tab", "series");
  if (route.film) params.set("film", String(route.film));
  if (route.serie) params.set("serie", String(route.serie));
  if (route.episodes) params.set("episodes", "1");
  if (route.search) params.set("recherche", "1");
  if (route.list) params.set("liste", "1");
  if (route.account) params.set("compte", "1");
  if (route.discover) {
    params.set("decouverte", String(route.discover));
    if (route.discoverType === "series") params.set("type", "series");
  }
  if (route.person) params.set("personne", String(route.person));
  if (route.menu) params.set("menu", "1");
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

/**
 * Ouvrir la fiche d'un titre de la bibliothèque.
 *
 * L'onglet fait partie de l'adresse, et il doit suivre : les deux écrans (films et séries) sont
 * distincts, chacun ne sait résoudre que son propre identifiant. Ouvrir une série alors que
 * l'onglet est resté sur « Films » ne résolvait donc rien du tout — la fiche ne s'ouvrait pas, et
 * comme le geste refermait au passage l'écran d'où l'on venait, on se retrouvait brutalement sur
 * l'accueil. C'était le cas de tous les liens partant de Ma liste, de la recherche et des fiches
 * personnes, où l'on clique par nature sur des titres des deux sortes.
 *
 * `extra` sert à emporter ce qui doit changer en même temps — jamais à refermer l'écran d'origine :
 * la recherche et Ma liste restent ouvertes *sous* la fiche, pour qu'un retour y ramène avec la
 * requête et l'onglet intacts.
 */
export function openLibraryTitle(
  type: "movie" | "series",
  libraryId: number,
  extra: Partial<CinemaRoute> = {}
): void {
  cinemaNavigate(
    type === "series"
      ? { ...extra, tab: "series", serie: libraryId, film: null }
      : { ...extra, tab: "movies", film: libraryId, serie: null }
  );
}

// Closing a layer. Stepping back is what keeps Forward meaningful and avoids piling up an entry
// per open/close; but with nothing of ours behind (a deep link straight into a title), back would
// leave the app, so that case rewrites the current entry instead.
export function cinemaClose(fallback: Partial<CinemaRoute>): void {
  if (typeof window === "undefined") return;
  if (currentDepth() > 0) window.history.back();
  else cinemaNavigate(fallback, "replace");
}
