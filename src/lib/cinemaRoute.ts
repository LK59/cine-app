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
   * La grille complète : un nom de genre, ou `*` pour toute la bibliothèque.
   *
   * Dans l'adresse comme le reste, pour que le retour ramène à la rangée d'où l'on vient et
   * qu'une grille de genre se partage et se retrouve.
   */
  browse: string | null;
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
  browse: null,
};

// How many entries this session has pushed. Kept in history.state so a close can tell "I opened
// this, stepping back is right" from "someone deep-linked straight here, there is nothing of ours
// behind" — where stepping back would leave the app entirely.
const DEPTH_KEY = "cinemaDepth";

/**
 * Y avait-il déjà une fiche ouverte quand cette entrée a été empilée ?
 *
 * C'est la seule chose que l'historique ne dit pas de lui-même, et dont on a besoin pour fermer
 * proprement : revenir d'une fiche vers *une autre fiche* ne doit pas jouer d'animation de
 * sortie. Sinon l'écran du dessus s'efface, découvre l'accueil pendant deux dixièmes de seconde,
 * et la fiche précédente entre par-dessus — on lisait donc « Film 2 → Accueil → Film 1 » là où il
 * ne s'est rien passé d'autre qu'un retour.
 */
const BEHIND_KEY = "cinemaSheetBehind";

/** Ce qu'une entrée recouvre : de quoi le redessiner, pas seulement savoir qu'il existe. */
export interface SheetRef {
  film: number | null;
  serie: number | null;
  tab: "movies" | "series";
}

/** Un titre, une personne : quelque chose est ouvert par-dessus la grille. */
function hasSheet(route: CinemaRoute): boolean {
  return route.film !== null || route.serie !== null || route.discover !== null || route.person !== null;
}

/** La fiche que cette route affiche, réduite à ce qu'il faut pour la retrouver. */
function sheetRef(route: CinemaRoute): SheetRef | null {
  if (route.film === null && route.serie === null) return null;
  return { film: route.film, serie: route.serie, tab: route.tab };
}

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
    browse: params.get("parcourir"),
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
  if (route.browse) params.set("parcourir", route.browse);
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

/**
 * Est-on arrivé ici par un retour en arrière ?
 *
 * Un écran qui se monte parce qu'on revient dessus ne doit pas rejouer son animation d'ouverture :
 * il n'ouvre rien, il se découvre. Sans cette distinction, fermer Film 2 donnait l'impression que
 * Film 1 se rouvrait, alors qu'il n'avait jamais été fermé pour de bon.
 *
 * L'écouteur est posé au chargement du module, donc avant ceux que React installe au montage des
 * composants : les écouteurs `popstate` se déclenchent dans leur ordre d'inscription, et le
 * drapeau est donc déjà à jour quand l'arbre se redessine. Il est remis à zéro à l'image suivante,
 * pour ne concerner que les montages provoqués par ce retour-là.
 */
let cameBack = false;

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    cameBack = true;
    requestAnimationFrame(() => {
      cameBack = false;
    });
  });
}

/** À lire une seule fois, au montage : voir `cameBack`. */
export function arrivedByBack(): boolean {
  return cameBack;
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

function readBehind(): SheetRef | boolean {
  const value = (window.history.state as Record<string, unknown> | null)?.[BEHIND_KEY];
  return (value as SheetRef | boolean) ?? false;
}

function readSheetBehind(): boolean {
  return Boolean(readBehind());
}

/**
 * Y a-t-il une fiche sous celle-ci, demandé au moment où on le demande.
 *
 * La version crochet sert au rendu ; celle-ci sert aux gestes. Un rappel qui se déclenche sur un
 * clic doit lire l'état du clic, pas celui du rendu qui l'a créé — et surtout pas obliger le
 * rappel à dépendre d'une valeur de rendu, ce qui redessinerait mille cartes à chaque ouverture
 * de fiche.
 */
export function sheetIsBehind(): boolean {
  return typeof window !== "undefined" && readSheetBehind();
}

// useSyncExternalStore exige une identité stable entre deux changements : l'objet lu dans
// history.state est recréé à chaque lecture, donc on le met en cache contre son propre contenu.
let cachedBehindKey: string | null = null;
let cachedBehind: SheetRef | null = null;

function readBehindSheet(): SheetRef | null {
  const value = readBehind();
  const next = typeof value === "object" && value !== null ? value : null;
  const key = next ? `${next.film}:${next.serie}:${next.tab}` : "";
  if (key !== cachedBehindKey) {
    cachedBehindKey = key;
    cachedBehind = next;
  }
  return cachedBehind;
}

/**
 * La fiche que l'écran courant recouvre, quand il y en a une.
 *
 * Elle sert à la dessiner *dessous* pendant qu'on tire la fiche du dessus vers le bas : sans
 * elle, le geste découvrait la grille, et la fiche précédente n'apparaissait qu'une fois
 * l'animation terminée — on voyait donc le fond au milieu d'un mouvement qui, lui, disait qu'on
 * remontait d'un cran.
 */
export function useRouteBehind(): SheetRef | null {
  return useSyncExternalStore(subscribe, readBehindSheet, () => null);
}

/**
 * Vrai quand fermer l'écran courant en découvrira un autre du même genre.
 *
 * Les fiches s'en servent pour supprimer leur animation de sortie dans ce cas précis : le retour
 * est alors instantané, et l'échange se fait dans un seul rendu — l'ancienne fiche s'en va et la
 * précédente apparaît au même moment, sans que l'accueil n'apparaisse entre les deux.
 */
export function useSheetBehind(): boolean {
  return useSyncExternalStore(subscribe, readSheetBehind, () => false);
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
  const state = {
    ...(window.history.state ?? {}),
    [DEPTH_KEY]: mode === "push" ? depth + 1 : depth,
    // Ce qu'on laisse derrière soi, retenu au moment où on l'empile — la seule occasion de le
    // savoir. Un `replace` ne change pas ce qui est en dessous, donc il garde la valeur en place.
    [BEHIND_KEY]:
      mode === "push"
        ? hasSheet(getSnapshot())
          ? sheetRef(getSnapshot()) ?? true
          : false
        : (window.history.state?.[BEHIND_KEY] ?? false),
  };
  // Une navigation volontaire n'est jamais un retour : le drapeau retombe avant que qui que ce
  // soit ne se monte.
  cameBack = false;
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
