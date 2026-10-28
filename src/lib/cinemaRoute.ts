"use client";

import { useSyncExternalStore } from "react";
import { withoutPlayerEntry } from "@/lib/playerHistory";

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
  /**
   * L'activité des comptes (administrateur) : `1` pour la vue d'ensemble, `compte:<id>`,
   * `seance:<id>`, `journaux` ou `journaux:<filtres>` — voir `components/activity/nav.ts`. Un
   * écran par valeur, pour que le retour remonte de la séance à la fiche, puis à la vue
   * d'ensemble, puis au panneau Compte d'où l'on est parti.
   */
  activity: string | null;
  /**
   * « Signaler un problème » : `nouveau`, `liste`, `brouillon:<id>` ou l'identifiant d'un
   * signalement. Ouvert depuis le panneau Compte, qu'il remplace, comme l'activité.
   */
  report: string | null;
  /**
   * « Nouveautés » (DECISIONS.md §73) : `1` pour la page, `corrections:<id>` pour y arriver sur la
   * liste « Optimisations et corrections de bugs » d'une page — c'est où mène « Voir plus » depuis
   * la fenêtre. Ouvert depuis le panneau Compte, qu'il remplace, comme l'activité.
   */
  news: string | null;
  /**
   * Les téléchargements hors ligne de l'appareil (bêta, DECISIONS.md §109) : un écran poussé depuis
   * le rond à côté de « Tous les films / Toutes les séries », comme la grille complète — il recouvre
   * l'accueil, une fiche passe par-dessus, et Retour y ramène. Ce n'est pas un onglet de la barre :
   * l'onglet allumé reste l'Accueil, et en ouvrir un le referme.
   */
  downloads: boolean;
  /**
   * Les livres (option, DECISIONS.md §127), troisième catégorie de la bascule : un mode posé sur
   * l'accueil (`#livres=1`), pas un onglet — `tab` garde films ou séries, que tout le cinéma lit.
   * Facultatif et absent par défaut : l'adresse et la route d'une installation sans livres ne
   * changent pas. Ignoré quand l'option est coupée (`useBooksMode`).
   */
  books?: boolean;
}

/**
 * Un écran poussé depuis le Compte — activité, signalement, Nouveautés — est ouvert.
 *
 * Ils remplacent le panneau Compte (`account` retiré de l'adresse), et chaque endroit qui demande
 * « quelque chose recouvre-t-il la grille ? » devait les énumérer un par un : un oubli laissait les
 * flèches piloter des affiches invisibles (chasse aux défauts du 25/09/2026). Une seule liste, ici.
 */
export function accountScreenOpen(route: Pick<CinemaRoute, "activity" | "report" | "news">): boolean {
  return route.activity !== null || route.report !== null || route.news !== null;
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
  activity: null,
  report: null,
  news: null,
  downloads: false,
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
  /**
   * La personne recouverte, s'il s'agit d'elle.
   *
   * Elle peut coexister avec `film` / `serie` : une personne ouverte depuis un film laisse le film
   * dans l'adresse, et l'entrée décrit alors l'acteur *posé sur* ce film. Voir `personBehind`.
   *
   * C'était le défaut structurel de la fiche personne : elle ne faisait pas partie de la pile. Une
   * fiche de titre recouverte est redessinée dessous à partir de cette référence (voir
   * `behindSelected` dans CinemaMobileClient), et c'est ce qui rend l'empilement des « titres
   * similaires » net — on tire la carte du dessus, celle du dessous est déjà là. La personne, elle,
   * n'était nommée nulle part : il n'y avait donc rien à dessiner sous le film, et la sortie
   * découvrait l'écran de recherche, deux crans plus bas.
   */
  person: number | null;
  /**
   * Le cran où chacune de ces fiches a été ouverte — voir `SheetOrigins`. Absent d'une entrée
   * écrite avant le 12/10/2026 : lu alors comme `UNKNOWN_ORIGIN`.
   */
  origins?: SheetOrigins;
}

/**
 * Le cran de la pile (la profondeur d'historique) où chaque fiche affichée a été **ouverte**
 * (DECISIONS.md §74).
 *
 * C'est l'identité d'une fiche, et l'identifiant du titre ou de la personne n'y suffit pas : la
 * même actrice ouverte depuis une série (cran 2) puis rouverte depuis un de ses films (cran 4) est
 * deux fiches, deux entrées de la pile. Rendues sous la même clé React, elles partageaient une
 * instance — donc l'état d'un geste : refermée au doigt au cran 4, la carte restait jetée hors de
 * l'écran et transparente aux pointeurs, et c'est dans cet état qu'elle redevenait la fiche du
 * dessus au cran 2. Un écran sombre, une série inerte dessous, plus rien ne répondait (iPhone,
 * 8.45.0).
 *
 * Le cran d'ouverture, et non le cran courant : une fiche de bibliothèque recouverte par une
 * personne ou une fiche TMDB reste *la même* fiche (elle est encore dans l'adresse, l'entrée
 * suivante ne fait que poser quelque chose dessus), et doit garder son instance, son défilement et
 * sa rangée de titres similaires. Une fiche est ouverte quand l'appel le dit (le champ est écrit
 * par la navigation) ; sinon elle hérite du cran de l'entrée d'où l'on part.
 */
export interface SheetOrigins {
  title: number | null;
  person: number | null;
  discover: number | null;
}

/**
 * Le cran d'une fiche dont l'entrée ne dit rien (lien direct, entrée d'avant le 12/10/2026).
 *
 * Le même pour toutes : deux fiches du même titre sans cran connu gardent alors la même clé, ce qui
 * est exactement le comportement d'avant — rien ne change pour un historique déjà écrit.
 */
const UNKNOWN_ORIGIN = 0;

/** La clé React d'une fiche personne : la personne *et* son entrée dans la pile. */
export function personSheetKey(tmdbId: number, origin: number | null | undefined): string {
  return `person:${tmdbId}@${origin ?? UNKNOWN_ORIGIN}`;
}

/** La clé React d'une fiche de bibliothèque. Le type compte : un film et une série peuvent partager un numéro. */
export function titleSheetKey(type: "movie" | "movies" | "series", id: number, origin: number | null | undefined): string {
  return `${type === "series" ? "series" : "movie"}:${id}@${origin ?? UNKNOWN_ORIGIN}`;
}

/** La clé React d'une fiche découverte. */
export function discoverSheetKey(type: "movie" | "series", tmdbId: number, origin: number | null | undefined): string {
  return `${type}:${tmdbId}@${origin ?? UNKNOWN_ORIGIN}`;
}

/** Les crans de l'entrée recouverte, connus ou non. */
export function behindOrigins(behind: SheetRef | null): SheetOrigins {
  return behind?.origins ?? { title: UNKNOWN_ORIGIN, person: UNKNOWN_ORIGIN, discover: UNKNOWN_ORIGIN };
}

/**
 * L'entrée recouverte montre-t-elle **la même fiche** de bibliothèque que l'entrée courante ?
 *
 * Même titre et même cran d'ouverture : c'est la fiche encore dans l'adresse sous une fiche TMDB ou
 * personne — la dessiner « dessous » en ferait deux fois la même. Même titre mais ouvert à un autre
 * cran (série → actrice → la même série) : deux fiches, la recouverte est bien dessous.
 */
export function behindIsSameTitleSheet(
  behind: SheetRef | null,
  route: Pick<CinemaRoute, "film" | "serie">,
  origins: SheetOrigins
): boolean {
  if (behind === null) return false;
  const sameTitle =
    (route.film !== null && behind.film === route.film) || (route.serie !== null && behind.serie === route.serie);
  return sameTitle && behindOrigins(behind).title === origins.title;
}

/**
 * La fiche personne que l'entrée courante recouvre, quand c'est d'elle qu'on vient.
 *
 * Y compris quand cette personne était elle-même posée sur un film (`film` **et** `person` dans
 * l'entrée) : c'est le cas ordinaire d'une cascade film → acteur → film, et c'est exactement
 * l'écran qu'on doit retrouver en tirant le second film vers le bas — l'acteur, sur le premier.
 * La règle d'avant (« une entrée recouvre un titre *ou* une personne ») n'y voyait que le film :
 * on découvrait le film A, puis la carte de l'acteur surgissait d'un coup à la fin du retour.
 * La pile du téléphone redessine déjà le film sous elle (`behindSelected`) ; la personne se pose
 * entre les deux — même plan 47 que le film recouvert, montée après lui, donc au-dessus.
 */
export function personBehind(behind: SheetRef | null): number | null {
  if (behind === null) return null;
  return behind.person;
}

/** Un titre, une personne : quelque chose est ouvert par-dessus la grille. */
function hasSheet(route: CinemaRoute): boolean {
  return route.film !== null || route.serie !== null || route.discover !== null || route.person !== null;
}

/** La fiche que cette route affiche, réduite à ce qu'il faut pour la retrouver. */
function sheetRef(route: CinemaRoute, origins: SheetOrigins): SheetRef | null {
  if (route.film === null && route.serie === null && route.person === null) return null;
  return { film: route.film, serie: route.serie, tab: route.tab, person: route.person, origins };
}

/** Ce qui identifie la fiche de chaque étage dans une route — `null` quand l'étage est vide. */
function sheetValues(route: CinemaRoute): Record<keyof SheetOrigins, string | null> {
  return {
    title: route.film !== null ? `f${route.film}` : route.serie !== null ? `s${route.serie}` : null,
    person: route.person !== null ? String(route.person) : null,
    discover: route.discover !== null ? `${route.discoverType}:${route.discover}` : null,
  };
}

/** L'appel nomme-t-il une fiche à cet étage — c'est-à-dire en ouvre-t-il une ? */
function patchOpens(patch: Partial<CinemaRoute>, floor: keyof SheetOrigins): boolean {
  if (floor === "title") return (patch.film ?? null) !== null || (patch.serie ?? null) !== null;
  if (floor === "person") return (patch.person ?? null) !== null;
  return (patch.discover ?? null) !== null;
}

/**
 * Les crans de la route qu'on écrit, à partir de ceux de l'entrée d'où l'on part.
 *
 * Une fiche nommée par un `push` est ouverte à ce cran-ci, même si elle était déjà affichée sous
 * un autre étage — c'est le cas même du défaut : rouvrir une personne ou une série qui est déjà
 * dans la pile empile une **nouvelle** fiche, avec sa propre clé, et le retour retrouve l'ancienne
 * intacte. Un `replace` qui la renomme à l'identique ne l'ouvre pas.
 */
function nextOrigins(
  current: CinemaRoute,
  next: CinemaRoute,
  patch: Partial<CinemaRoute>,
  from: SheetOrigins,
  depth: number,
  mode: "push" | "replace"
): SheetOrigins {
  const was = sheetValues(current);
  const now = sheetValues(next);
  const floor = (f: keyof SheetOrigins): number | null => {
    if (now[f] === null) return null;
    const opened = patchOpens(patch, f) && (mode === "push" || now[f] !== was[f]);
    if (opened || now[f] !== was[f]) return depth;
    return from[f] ?? UNKNOWN_ORIGIN;
  };
  return { title: floor("title"), person: floor("person"), discover: floor("discover") };
}

function readNumber(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parse(hash: string): CinemaRoute {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const serie = readNumber(params, "serie");
  return {
    tab: params.get("tab") === "series" ? "series" : "movies",
    film: readNumber(params, "film"),
    serie,
    // Le panneau des épisodes n'existe que sur une série (DECISIONS.md §105) : sans elle, le drapeau
    // restait collé à l'adresse — la fermeture du téléphone ne le retirait pas (`#episodes=1` après
    // un Retour, ROBUSTESSE-8) —, et un iPad passé à la mise en page bureau aurait ouvert les épisodes
    // de la série suivante. Lu ici, il disparaît aussi de toute adresse réécrite.
    episodes: serie !== null && params.get("episodes") === "1",
    search: params.get("recherche") === "1",
    list: params.get("liste") === "1",
    account: params.get("compte") === "1",
    discover: readNumber(params, "decouverte"),
    discoverType: params.get("type") === "series" ? "series" : "movie",
    person: readNumber(params, "personne"),
    browse: params.get("parcourir"),
    activity: params.get("activite"),
    report: params.get("signalement"),
    news: params.get("nouveautes"),
    downloads: params.get("telechargements") === "1",
    // Seulement quand il est là : une route sans livres reste exactement ce qu'elle était.
    ...(params.get("livres") === "1" ? { books: true } : {}),
  };
}

function serialize(route: CinemaRoute): string {
  const params = new URLSearchParams();
  if (route.tab === "series") params.set("tab", "series");
  if (route.film) params.set("film", String(route.film));
  if (route.serie) params.set("serie", String(route.serie));
  // Jamais sans série — voir `parse` (DECISIONS.md §105).
  if (route.episodes && route.serie) params.set("episodes", "1");
  if (route.search) params.set("recherche", "1");
  if (route.list) params.set("liste", "1");
  if (route.account) params.set("compte", "1");
  if (route.discover) {
    params.set("decouverte", String(route.discover));
    if (route.discoverType === "series") params.set("type", "series");
  }
  if (route.person) params.set("personne", String(route.person));
  if (route.browse) params.set("parcourir", route.browse);
  if (route.activity) params.set("activite", route.activity);
  if (route.report) params.set("signalement", route.report);
  if (route.news) params.set("nouveautes", route.news);
  if (route.downloads) params.set("telechargements", "1");
  if (route.books) params.set("livres", "1");
  const query = params.toString();
  return query ? `#${query}` : "";
}

/**
 * Une adresse collée ou tapée, ramenée à une combinaison que l'application sait produire
 * (DECISIONS.md §105, ROBUSTESSE-8).
 *
 * Un seul onglet à la fois — Recherche, puis Ma liste, puis un écran poussé depuis le Compte, puis le
 * Compte : c'est l'ordre où `activePanel` les lit déjà (`#liste=1&compte=1&recherche=1` montrait le
 * Compte sous une pilule allumée sur Recherche). Un écran poussé (activité, signalement, Nouveautés)
 * remplace le Compte, comme quand on l'ouvre. Le reste — valeurs illisibles, paramètres inconnus,
 * `type` sans fiche découverte, `episodes` sans série — tombe déjà à la lecture et à l'écriture.
 */
export function normalizeRoute(route: CinemaRoute): CinemaRoute {
  const out = { ...route };
  // Les téléchargements s'ouvrent depuis l'accueil et tout onglet les referme (`openPanel`) : avec un
  // onglet dans la même adresse, c'est l'onglet qui reste.
  if (out.search || out.list || out.account || accountScreenOpen(out)) out.downloads = false;
  if (out.search) Object.assign(out, { list: false, account: false, activity: null, report: null, news: null });
  else if (out.list) Object.assign(out, { account: false, activity: null, report: null, news: null });
  else if (accountScreenOpen(out)) out.account = false;
  return out;
}

/** Les mêmes paramètres, dans n'importe quel ordre. */
function sameParams(a: string, b: string): boolean {
  const pairs = (h: string) => [...new URLSearchParams(h.replace(/^#/, "")).entries()].map(([k, v]) => `${k}=${v}`).sort().join("&");
  return pairs(a) === pairs(b);
}

/**
 * Réécrire sur place l'adresse d'une entrée que l'application n'a pas écrite elle-même.
 *
 * Seulement sur le cinéma (`/`), et seulement une entrée sans `cinemaDepth` — un lien direct, un
 * fragment tapé dans la barre d'adresse : une entrée que `cinemaNavigate` a écrite est cohérente par
 * construction, et la réécrire pourrait défaire un choix voulu (les Nouveautés ouvertes au lancement
 * par-dessus un panneau). Une adresse valide n'est jamais réécrite : l'ordre des paramètres ne compte
 * pas, seul ce qu'ils disent. `replaceState` : rien n'est empilé, et l'état de l'entrée (Next, la
 * pile des fiches) est gardé.
 */
export function normalizeArrivedAddress(): void {
  if (typeof window === "undefined" || window.location.pathname !== "/") return;
  const state = window.history.state as Record<string, unknown> | null;
  if (typeof state?.[DEPTH_KEY] === "number") return;
  const hash = window.location.hash;
  const canonical = serialize(normalizeRoute(parse(hash)));
  if (sameParams(hash, canonical)) return;
  window.history.replaceState(state, "", `${window.location.pathname}${window.location.search}${canonical}`);
  emit();
}

/**
 * L'activité est à l'administrateur : un autre compte qui y arrive par l'adresse la voit refermée,
 * au lieu d'un « Impossible de charger l'activité. Réessayer » qui ne peut jamais réussir (le proxy
 * refuse ses lectures). `isAdmin` : `undefined` tant que le rôle n'est pas connu — on attend.
 */
export function closeAdminOnlyScreens(isAdmin: boolean | undefined): void {
  if (typeof window === "undefined" || isAdmin !== false) return;
  if (getSnapshot().activity === null) return;
  cinemaNavigate({ activity: null }, "replace");
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
/** L'adresse dont une fiche est en train de sortir — voir `markSheetLeaving`. */
let leavingHash: string | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    leavingHash = null;
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

// Une adresse tapée dans la barre arrive par `hashchange` : nettoyée avant que les écrans abonnés ne
// la lisent (cet écouteur est posé au chargement du module, donc avant les leurs). L'arrivée par un
// lien direct est nettoyée au premier abonnement — voir `normalizeArrivedAddress`.
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => normalizeArrivedAddress());
}

function subscribe(onChange: () => void): () => void {
  // Dans `subscribe` et non au rendu : réécrire l'adresse est un effet, et useSyncExternalStore
  // relit l'instantané juste après l'abonnement.
  normalizeArrivedAddress();
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

/**
 * L'adresse lue au moment où on la demande — la version geste de `useCinemaRoute`.
 *
 * Même raison que `sheetIsBehind` : un rappel déclenché par un clic doit lire l'état du clic, et
 * le faire dépendre d'une valeur de rendu le recréerait à chaque navigation — ce qui redessinerait
 * les mille cartes mémoïsées qui le reçoivent.
 */
export function readCinemaRoute(): CinemaRoute {
  return typeof window === "undefined" ? EMPTY : getSnapshot();
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
  const o = next?.origins;
  const key = next ? `${next.film}:${next.serie}:${next.tab}:${next.person}:${o?.title}:${o?.person}:${o?.discover}` : "";
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

/** Les crans d'ouverture de l'entrée courante — voir `SheetOrigins`. */
const ORIGIN_KEY = "cinemaSheetOrigins";

function readOrigins(): SheetOrigins {
  const state = window.history.state as Record<string, unknown> | null;
  const value = state?.[ORIGIN_KEY] as Partial<SheetOrigins> | undefined;
  const route = getSnapshot();
  // Une fiche affichée sans cran connu (lien direct, entrée ancienne) : `UNKNOWN_ORIGIN`.
  const pick = (stored: number | null | undefined, shown: boolean) =>
    shown ? (typeof stored === "number" ? stored : UNKNOWN_ORIGIN) : null;
  return {
    title: pick(value?.title, route.film !== null || route.serie !== null),
    person: pick(value?.person, route.person !== null),
    discover: pick(value?.discover, route.discover !== null),
  };
}

let cachedOriginsKey: string | null = null;
let cachedOrigins: SheetOrigins = { title: null, person: null, discover: null };
const NO_ORIGINS: SheetOrigins = { title: null, person: null, discover: null };

function readOriginsSnapshot(): SheetOrigins {
  const next = readOrigins();
  const key = `${next.title}:${next.person}:${next.discover}`;
  if (key !== cachedOriginsKey) {
    cachedOriginsKey = key;
    cachedOrigins = next;
  }
  return cachedOrigins;
}

/** Les crans d'ouverture des fiches de l'entrée courante — de quoi leur donner leur clé. */
export function useSheetOrigins(): SheetOrigins {
  return useSyncExternalStore(subscribe, readOriginsSnapshot, () => NO_ORIGINS);
}

// `push` for opening a screen (Back should close it); `replace` for changing something about the
// screen you're already on, like the Films/Séries tab — a filter shouldn't cost a Back press.
export function cinemaNavigate(
  patch: Partial<CinemaRoute>,
  mode: "push" | "replace" = "push",
  options: { tabBase?: string } = {}
): void {
  if (typeof window === "undefined") return;
  if (backPending) {
    afterBack.push(() => cinemaNavigate(patch, mode, options));
    return;
  }
  const next = { ...getSnapshot(), ...patch };
  const serialized = serialize(next);
  /**
   * Empiler l'écran où l'on est déjà n'ouvre rien, et coûte un retour.
   *
   * Un doigt pressé appuie deux fois sur la même affiche avant que la fiche n'ait fini d'arriver,
   * et le second appui empilait une entrée identique : il fallait alors deux retours pour sortir
   * d'un écran qu'on n'avait ouvert qu'une fois, et le premier semblait ne rien faire. La barre du
   * bas s'en protège déjà pour ses propres boutons (voir `DOUBLE_FIRE_MS`) ; les affiches, les
   * rangées, les résultats de recherche et les titres similaires, non — et ils sont bien plus
   * nombreux. La garde est donc posée ici, où toutes les ouvertures passent.
   *
   * Comparé sur la forme sérialisée et non sur l'adresse : elle normalise l'ordre des champs, si
   * bien que deux routes identiques écrites différemment se reconnaissent quand même.
   *
   * Un `replace` n'est pas concerné : réécrire l'entrée courante avec la même valeur n'empile
   * rien, et le faire reste le moyen le plus simple de corriger `history.state`.
   */
  if (mode === "push" && serialized === serialize(getSnapshot())) return;
  const url = `${window.location.pathname}${window.location.search}${serialized}`;
  const depth = currentDepth();
  const current = getSnapshot();
  const origins = readOrigins();
  // Spread whatever Next put in history.state rather than replacing it — its router reads its own
  // keys back on popstate. Sauf le jeton du lecteur (`playerHistory.ts`) sur un `push` : une fiche
  // ouverte depuis l'écran de fin, par-dessus l'entrée du lecteur, n'est pas cette entrée — la
  // fermeture du lecteur, qui rend la sienne d'un `history.back()`, l'aurait refermée aussitôt.
  const base = (window.history.state ?? {}) as Record<string, unknown>;
  // L'entrée d'onglet (`TAB_BASE_KEY`, DECISIONS.md §103) ne se transmet pas : une fiche empilée
  // par-dessus un onglet n'est pas un onglet. Un `replace` la garde — c'est la même entrée.
  const pushed = mode === "push" ? withoutTabEntry(withoutPlayerEntry(base)) : base;
  const state = {
    ...pushed,
    ...(mode === "push" && options.tabBase !== undefined ? { [TAB_BASE_KEY]: options.tabBase } : {}),
    [DEPTH_KEY]: mode === "push" ? depth + 1 : depth,
    // Ce qu'on laisse derrière soi, retenu au moment où on l'empile — la seule occasion de le
    // savoir. Un `replace` ne change pas ce qui est en dessous, donc il garde la valeur en place.
    [BEHIND_KEY]:
      mode === "push"
        ? hasSheet(current)
          ? sheetRef(current, origins) ?? true
          : false
        : (window.history.state?.[BEHIND_KEY] ?? false),
    [ORIGIN_KEY]: nextOrigins(current, next, patch, origins, mode === "push" ? depth + 1 : depth, mode),
  };
  // Une navigation volontaire n'est jamais un retour : le drapeau retombe avant que qui que ce
  // soit ne se monte.
  cameBack = false;
  leavingHash = null;
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
 *
 * Les fiches personne et découverte se referment dans l'adresse — et c'est ce qui simplifie tout
 * le reste : tant que le film est ouvert, plus rien n'est ambigu, ni les permissions de l'écran du
 * dessus, ni qui écoute Échap, ni qui recouvre quoi.
 *
 * La personne n'en disparaît pas pour autant : l'entrée d'historique qu'on vient d'empiler la
 * nomme (voir `SheetRef.person`), et la coquille la **redessine dessous**, inerte, exactement
 * comme la pile des fiches de titre redessine celle qu'on recouvre. C'est ce qui donne aux
 * « titres similaires » leur empilement net, et c'est ce qui manquait ici : la personne n'était
 * nommée nulle part, il n'y avait donc rien sous le film, et la sortie découvrait l'écran de
 * recherche deux crans plus bas.
 */
export function openLibraryTitle(
  type: "movie" | "series",
  libraryId: number,
  extra: Partial<CinemaRoute> = {}
): void {
  const replaced = { person: null, discover: null };
  cinemaNavigate(
    type === "series"
      ? { ...replaced, ...extra, tab: "series", serie: libraryId, film: null }
      : { ...replaced, ...extra, tab: "movies", film: libraryId, serie: null }
  );
}

// Closing a layer. Stepping back is what keeps Forward meaningful and avoids piling up an entry
// per open/close; but with nothing of ours behind (a deep link straight into a title), back would
// leave the app, so that case rewrites the current entry instead.
/**
 * Un seul retour à la fois.
 *
 * `history.back()` ne fait rien tout de suite : il *programme* le retour, et `popstate` arrive au
 * tour de boucle suivant. Tant qu'il n'est pas arrivé, l'adresse n'a pas bougé — donc deux
 * fermetures parties dans la même image passent toutes les deux la garde de profondeur et
 * reculent de deux crans. Un seul geste emportait alors deux écrans, et depuis le premier de la
 * pile il faisait sortir du mode cinéma.
 *
 * Ce n'est pas théorique : deux panneaux sont montés ensemble pendant une bascule — celui qui
 * part et celui qui arrive — et chacun écoute Échap. Plutôt que de chasser les appelants un par
 * un, la porte elle-même ne s'ouvre qu'une fois.
 *
 * Le minuteur est une ceinture, pas la bretelle : `popstate` suit toujours un `back()` qui avait
 * quelque chose derrière lui. Mais un drapeau bloqué serait une application dont plus rien ne se
 * ferme, et c'est la seule panne qu'on ne veut absolument pas échanger contre celle-ci.
 */
let backPending = false;

/**
 * Les navigations demandées pendant ce retour, rejouées une fois arrivé (15/10/2026).
 *
 * Fermer une fiche puis toucher aussitôt « Séries » : le `replace` de l'onglet réécrivait l'entrée
 * de la fiche — celle dont on sortait —, puis le `popstate` du retour ramenait l'entrée d'en dessous
 * avec l'ancien onglet. L'appui était perdu, il fallait recliquer (relevé par Louis sur iPhone, à
 * condition d'aller vite). Un `push` dans la même fenêtre s'empilait sur la fiche, que le retour
 * retrouvait ensuite. Fermer est une demande, pas un fait : ce qui vient après attend qu'elle soit
 * faite, et s'applique à l'adresse où l'on est vraiment.
 */
let afterBack: (() => void)[] = [];

function settleBack(): void {
  backPending = false;
  const queued = afterBack;
  afterBack = [];
  for (const run of queued) run();
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => settleBack());
}

/**
 * Ce que referme un panneau quand il n'y a rien derrière lui (arrivée directe par un lien) : tous
 * les panneaux, la grille complète et l'activité. Une seule liste, pour que l'ajout d'un écran ne
 * laisse pas une fermeture l'oublier — l'activité, ajoutée le 24/09/2026, restait sinon affichée
 * après une croix.
 */
export const CLOSE_PANELS = { search: false, list: false, account: false, browse: null, activity: null, report: null, news: null, downloads: false } satisfies Partial<CinemaRoute>;

export function cinemaClose(fallback: Partial<CinemaRoute>): void {
  if (typeof window === "undefined") return;
  if (currentDepth() > 0) {
    if (backPending) return;
    backPending = true;
    setTimeout(() => {
      if (backPending) settleBack();
    }, 400);
    window.history.back();
  } else {
    cinemaNavigate(fallback, "replace");
  }
}

/**
 * Les onglets de la barre ne s'empilent pas (DECISIONS.md §103, ROBUSTESSE-14).
 *
 * Chaque appui sur Recherche, Ma liste, Compte ou Accueil empilait une entrée : dix changements
 * d'onglet, dix retours pour sortir, en repassant par chaque panneau et plusieurs fois par l'accueil
 * (passe de nuit du 15/10/2026). Comme une barre d'onglets native, désormais :
 *
 * - le premier onglet ouvert depuis l'écran du dessous (l'accueil, une grille, une fiche) empile
 *   **une** entrée — l'« entrée d'onglet », qui retient sous `TAB_BASE_KEY` l'adresse qu'elle
 *   recouvre ;
 * - passer d'un onglet à un autre **remplace** cette entrée ;
 * - « Accueil » (et la croix ou Échap d'un onglet) la rend par un retour quand ce qu'elle recouvre
 *   est déjà l'accueil — le même `cinemaClose`, donc un seul `history.back()` en vol ; sinon il la
 *   remplace par l'accueil.
 *
 * Le premier Retour depuis un onglet ramène donc à ce qu'il y avait avant le premier onglet. Les
 * fiches, les écrans poussés depuis le Compte (activité, signalements, Nouveautés) et le lecteur
 * continuent d'empiler : `cinemaNavigate` retire la marque de toute entrée qu'il empile.
 */
const TAB_BASE_KEY = "cinemaTabBase";

function withoutTabEntry(state: Record<string, unknown>): Record<string, unknown> {
  if (!(TAB_BASE_KEY in state)) return state;
  const rest = { ...state };
  delete rest[TAB_BASE_KEY];
  return rest;
}

/** L'adresse que recouvre l'entrée d'onglet courante, ou `null` si l'entrée n'en est pas une. */
function readTabBase(): string | null {
  const value = (window.history.state as Record<string, unknown> | null)?.[TAB_BASE_KEY];
  return typeof value === "string" ? value : null;
}

/** Ouvrir l'onglet que décrit `patch` — Recherche, Ma liste, Compte. Voir `TAB_BASE_KEY`. */
export function cinemaSwitchTab(patch: Partial<CinemaRoute>): void {
  if (typeof window === "undefined") return;
  // Pendant le retour d'une fermeture, la décision elle-même attend : lue maintenant, l'entrée
  // d'onglet serait celle de la fiche qui s'en va (voir `afterBack`).
  if (backPending) {
    afterBack.push(() => cinemaSwitchTab(patch));
    return;
  }
  if (readTabBase() !== null) cinemaNavigate(patch, "replace");
  else cinemaNavigate(patch, "push", { tabBase: serialize(getSnapshot()) });
}

/**
 * Revenir à l'accueil depuis la barre : `patch` referme tout. `alreadyHome` : rien à refermer, on
 * réécrit l'entrée sans rien empiler (comme avant).
 */
export function cinemaTabHome(patch: Partial<CinemaRoute>, alreadyHome: boolean): void {
  if (typeof window === "undefined") return;
  if (backPending) {
    afterBack.push(() => cinemaTabHome(patch, alreadyHome));
    return;
  }
  const tabBase = readTabBase();
  if (tabBase !== null) {
    // Ce que l'entrée recouvre, une fois refermé ce que l'accueil referme : si rien ne change, c'est
    // déjà l'accueil, et le retour y ramène sans rien empiler.
    const underIsHome = serialize({ ...parse(tabBase), ...patch }) === serialize(parse(tabBase));
    if (underIsHome && currentDepth() > 0) cinemaClose(patch);
    else cinemaNavigate(patch, "replace");
    return;
  }
  cinemaNavigate(patch, alreadyHome ? "replace" : "push");
}

/**
 * Une fiche a commencé à sortir : ce qu'elle recouvre peut déjà revenir.
 *
 * Refermer une fiche est une demande (voir `useDelayedClose`) : l'adresse garde le titre le temps
 * de l'animation de sortie, et ne change qu'à la fin. La barre du téléphone, qui s'efface tant
 * qu'une fiche est dans l'adresse, n'entamait donc son retour qu'après — deux mouvements bout à
 * bout, plus d'une demi-seconde en tout, là où la fiche et la barre peuvent bouger ensemble.
 *
 * Le signal est attaché à l'adresse de ce moment-là, et tombe au premier changement : une
 * navigation l'efface (`cinemaNavigate`, `popstate`), et la lecture le refuse si l'adresse a
 * bougé autrement. Rouvrir le même titre plus tard ne peut donc pas le retrouver debout.
 */
export function markSheetLeaving(): void {
  if (typeof window === "undefined") return;
  leavingHash = window.location.hash;
  emit();
}

function readSheetLeaving(): boolean {
  return leavingHash !== null && leavingHash === window.location.hash;
}

export function useSheetLeaving(): boolean {
  return useSyncExternalStore(subscribe, readSheetLeaving, () => false);
}
