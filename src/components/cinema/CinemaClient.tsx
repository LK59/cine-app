"use client";

import useSWR from "swr";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { fetcher } from "@/lib/swr";
import { leaveCinema } from "@/lib/leaveCinema";
import { useCinemaRoute, useRouteBehind, cinemaNavigate, cinemaClose, openLibraryTitle } from "@/lib/cinemaRoute";
import { uniqueById } from "@/lib/cinemaRails";
import { formatContinueLabel } from "@/lib/cinemaContinueLabel";
import { BACKDROP_MASK } from "@/lib/cinemaBackdropMask";
import { useTvGridNav } from "@/lib/useTvGridNav";
import { usePlayback } from "@/components/PlaybackProvider";
import { PosterImage } from "@/components/PosterImage";
import { CinemaHero } from "@/components/cinema/CinemaHero";
import { CinemaRow } from "@/components/cinema/CinemaRow";
import { CinemaBrowseSheet } from "@/components/cinema/CinemaBrowseSheet";
import { BROWSE_ALL } from "@/lib/cinemaBrowse";
import { useExitDelay } from "@/lib/useExitDelay";

/** La durée de l'animation de sortie de la grille — celle de `--animate-fade-out`. */
const BROWSE_EXIT_MS = 200;
import { CinemaSpotlight } from "@/components/cinema/CinemaSpotlight";
import { CinemaCard } from "@/components/cinema/CinemaCard";
import { CinemaSeriesCard } from "@/components/cinema/CinemaSeriesCard";
import { CinemaMovieDetail } from "@/components/cinema/CinemaMovieDetail";
import { CinemaSeriesHero } from "@/components/cinema/CinemaSeriesHero";
import { CinemaSeriesRow } from "@/components/cinema/CinemaSeriesRow";
import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import { CinemaModeToggle } from "@/components/cinema/CinemaModeToggle";
import { CinemaTop10Row } from "@/components/cinema/CinemaTop10Row";
import { CinemaDiscoveryRow } from "@/components/cinema/CinemaDiscoveryRow";
import { useCinemaMyList } from "@/lib/useCinemaMyList";
import { useRotatingIndex } from "@/lib/useRotatingIndex";
import { CinemaShortcutsGuide } from "@/components/cinema/CinemaShortcutsGuide";
import { useT } from "@/components/TranslationProvider";
import type { CinemaMoviesPayload, CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeriesPayload, CinemaSeries } from "@/app/api/cinema/series/route";
import type { CinemaNextUpPayload } from "@/app/api/cinema/next-up/route";
import type { PlayerDiscoverPayload, DiscoveryItem } from "@/app/api/player/discover/route";

// The lightweight resume feed — /api/dashboard also carries these, but only alongside a full
// sweep of every service, the torrent client and disk stats, which is a lot of upstream work to
// wait on just to draw one row.
interface CinemaResumeItem {
  id: string;
  name: string;
  type: string;
  progress: number;
  positionTicks: number;
  runtimeTicks: number;
  imageTag: string | null;
  /** `/radarr/12` ou `/sonarr/34` — ce qui relie une reprise à sa fiche. */
  cinemaHref: string | null;
}

const TV_NAV_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-ink";

// w-24→xl:w-36 (96px→144px), down from the original w-40/sm:w-48 (160/192px) fixed pair — that
// fixed size overflowed the row on anything shorter than a large desktop window, pushing the row
// label itself off (above) the visible area. Shared between ContinueCard and CinemaCard so both
// grids stay visually aligned.
const CARD_WIDTH = "w-24 sm:w-28 md:w-32 lg:w-36";

// Same edge-fade mask as CinemaRow/CinemaSeriesRow (see their own doc comment) — the Continue
// Watching row is hand-rolled here rather than going through either of those (it renders
// ContinueCard, not CinemaCard/CinemaSeriesCard), so it needs its own copy of the same treatment.
// How many curated rails can sit above the genre rows (Continue, Top 10, Recently added, My
// list). Only used as the genre rows' entrance-animation offset, which caps at 6 anyway — an
// exact count per tab would buy nothing visible.
const RAIL_COUNT = 5;

const EDGE_FADE = {
  maskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
  WebkitMaskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
};

// Continue-watching cards are noticeably wider than genre-row posters (landscape source image,
// and there's a label chip to fit beneath) — a distinct width from CARD_WIDTH, not a smaller
// version of the same one.
const CONTINUE_CARD_WIDTH = "w-32 sm:w-40 md:w-48 lg:w-56";

// Backdrop/logo warm-up budget. This used to queue EVERY title in the library at once — on a
// ~800-title library that's ~1600 image requests fired in one burst, which saturates the
// browser's own per-host connection pool and makes the visible poster images (the ones actually
// on screen) queue behind them. Only what's reachable within a few keypresses is worth
// pre-warming; anything further out is a cold fetch that the backdrop's own 150ms debounce and
// the browser cache already cover well enough.
const PREFETCH_PER_ROW = 8;
const PREFETCH_LIMIT = 120;
const PREFETCH_CHUNK = 6;
const PREFETCH_CHUNK_DELAY_MS = 300;

// Fires the prefetches a few at a time instead of all at once, and hands back a cancel function
// so a data refresh (or unmount) doesn't leave a queue running for a list that no longer applies.
function prefetchImages(urls: string[]): () => void {
  let cancelled = false;
  let index = 0;
  let timer: ReturnType<typeof setTimeout>;

  function pump() {
    if (cancelled) return;
    for (let n = 0; n < PREFETCH_CHUNK && index < urls.length; n++, index++) {
      Object.assign(new Image(), { src: urls[index] });
    }
    if (index < urls.length) timer = setTimeout(pump, PREFETCH_CHUNK_DELAY_MS);
  }

  // Deferred by a beat so it doesn't compete with the initial screen's own critical images.
  timer = setTimeout(pump, 400);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

// Spotlight first (that's what the hero opens on), then the head of each row — the cards you can
// actually reach before scrolling. Deduped, capped, backdrop+logo per title.
function warmUpUrls<T>(
  spotlight: T[],
  rows: Record<string, T[]>,
  id: (item: T) => number,
  urlsOf: (item: T) => (string | null)[]
): string[] {
  const seen = new Set<number>();
  const urls: string[] = [];
  const push = (item: T) => {
    if (urls.length >= PREFETCH_LIMIT || seen.has(id(item))) return;
    seen.add(id(item));
    for (const url of urlsOf(item)) if (url) urls.push(url);
  };
  for (const item of spotlight) push(item);
  for (const list of Object.values(rows)) for (const item of list.slice(0, PREFETCH_PER_ROW)) push(item);
  return urls;
}

// Continue-watching items come from Jellyfin's own resume/next-up feeds (via the dashboard resume
// payload for movies, and /api/cinema/next-up for series — see that route's own doc comment), not
// the /api/cinema/movies|series library data — they don't carry backdrop/genres/overview, so they
// don't participate in the hero-focus mechanic, just thumbnail + progress + direct play. Still
// wired into the same data-tv-* grid so keyboard/arrow navigation covers it seamlessly with the
// genre rows below. Shared between the Films and Séries tabs (each with its own data source and
// row key) — the card itself doesn't care which.
function ContinueCard({
  itemId,
  title,
  thumbnailUrl,
  progress,
  resumeTicks,
  runtimeTicks,
  seasonNumber,
  episodeNumber,
  rowKey,
  index,
  onOpen,
  onFocus,
}: {
  itemId: string;
  title: string;
  thumbnailUrl: string | null;
  progress: number;
  resumeTicks: number | null;
  runtimeTicks: number | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  rowKey: string;
  index: number;
  /**
   * Ouvre la fiche du titre. Une reprise menait directement à la lecture : un clic, et le film
   * démarrait — sans moyen de regarder d'abord de quoi il s'agissait, ni de repartir du début.
   * La fiche porte les deux, et « Reprendre » y est la première ligne.
   */
  onOpen: () => void;
  /**
   * Ce que la bannière doit montrer quand cette carte est désignée.
   *
   * Ces cartes n'y participaient pas : leur charge utile — la file de reprise de Jellyfin — ne
   * porte ni fond, ni genres, ni synopsis, donc il n'y avait rien à afficher. Mais le titre,
   * lui, est dans la bibliothèque déjà chargée : il suffit de l'y retrouver. Sans quoi la
   * bannière garde le titre précédent pendant qu'on parcourt la rangée, et annonce autre chose
   * que ce qu'on désigne.
   */
  onFocus: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      data-tv-card
      data-tv-row={rowKey}
      data-tv-col={index}
      onClick={onOpen}
      onFocus={onFocus}
      onMouseEnter={onFocus}
      className={`group relative ${CONTINUE_CARD_WIDTH} shrink-0 overflow-visible rounded-lg text-left transition-transform duration-200 hover:z-10 hover:scale-105 focus-visible:z-10 focus-visible:scale-105 ${TV_NAV_RING}`}
    >
      <div className="relative overflow-hidden rounded-lg">
        <PosterImage
          src={thumbnailUrl}
          alt={title}
          aspectRatio="aspect-video"
          // Auth-gated route — Next's image optimizer proxies through an internal request that
          // doesn't forward cookies, so it 400s there. Same reasoning as DashboardClient's
          // identical resume-card image (see PosterImage's own doc comment).
          unoptimized
        />
        {/* The "round button" — a plain, always-partly-visible play affordance centered on the
            thumbnail (not hover-only: a TV remote user arrowing onto this card never hovers). */}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white opacity-90 backdrop-blur-xs transition-transform duration-200 group-hover:scale-110 group-focus-visible:scale-110">
            <Play size={16} fill="currentColor" />
          </span>
        </span>
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
          <div className="h-full bg-accent-500" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <p className="mt-1.5 truncate text-xs font-medium text-white/90">{title}</p>
      {/* text-xs, not an arbitrary text-[11px] — arbitrary-value Tailwind classes don't make it
          into this project's production CSS bundle (see CinemaClient's z-index note for the same
          pitfall hit before). */}
      <span className="mt-1 block w-fit max-w-full truncate rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-white/70">
        {formatContinueLabel(t, resumeTicks, runtimeTicks, seasonNumber, episodeNumber)}
      </span>
    </button>
  );
}

// Loaded via next/dynamic({ssr:false}) from page.tsx — same escape hatch this codebase already
// uses for PlayerHostLazy/GlobalSearchLazy. This page is 100% client-fetched (SWR, no data
// during SSR) and was hitting an unrecoverable hydration mismatch (React #418) that left the
// whole content area blank with no error surfaced anywhere (not even a wrapping error boundary —
// hydration failures at the root hydrate() call happen outside a boundary's reach). Disabling SSR
// for this page sidesteps the whole class of problem: nothing to mismatch against since there's
// no server-rendered HTML for it at all.
export function CinemaClient() {
  const t = useT();

  // Films/Séries — default left/movies, matching what's asked for. Series data is fetched lazily
  // (SWR key is null until this is actually "series") rather than always alongside movies: the
  // series route does its own per-title logo+rating fetching on a cold cache, same cost as the
  // movies one, and movies must keep loading exactly as fast as before regardless of whether the
  // user ever touches the series tab.
  // Every open layer lives in the URL hash instead of in local state, so the browser's Back and
  // Forward (and a phone's edge-swipe, which is the same thing) walk the screens rather than
  // leaving Cinema Mode — see lib/cinemaRoute for why the hash and not query params.
  const route = useCinemaRoute();
  const mediaType = route.tab;
  // "replace": the tab is a filter on the screen you're already on, not a screen of its own —
  // Back from a title should return to the grid, not undo a tab switch.
  const setMediaType = useCallback((tab: "movies" | "series") => cinemaNavigate({ tab }, "replace"), []);

  const { data: movies, error: moviesError, isLoading: moviesLoading } = useSWR<CinemaMoviesPayload>(
    "/api/cinema/movies",
    fetcher
  );
  const { data: series, error: seriesError, isLoading: seriesLoading } = useSWR<CinemaSeriesPayload>(
    mediaType === "series" ? "/api/cinema/series" : null,
    fetcher
  );
  const { data: resume } = useSWR<{ items: CinemaResumeItem[] }>("/api/jellyfin/resume", fetcher);
  // "Ma liste": the watchlist entries that are actually in the library, so every card on that
  // rail is playable (see the hook).
  const myListMovies = useCinemaMyList("movie", movies);
  const myListSeries = useCinemaMyList("series", series);
  const resumeMovies = (resume?.items ?? []).filter((r) => r.type === "Movie");

  // Id -> item, so a URL carrying a title id can be resolved back to the item the sheet needs.
  // Every list in the payload is unioned: the rows map alone omits anything with no genre.
  const moviesById = useMemo(() => {
    const all = uniqueById(
      [...(movies?.spotlight ?? []), ...Object.values(movies?.rows ?? {}).flat()],
      (m) => m.radarrId
    );
    return new Map(all.map((m) => [m.radarrId, m]));
  }, [movies]);
  const seriesById = useMemo(() => {
    const all = uniqueById(
      [...(series?.spotlight ?? []), ...Object.values(series?.rows ?? {}).flat()],
      (x) => x.sonarrId
    );
    return new Map(all.map((x) => [x.sonarrId, x]));
  }, [series]);

  /**
   * Toute la bibliothèque de l'onglet courant, une fois chacune — voir la grille complète.
   *
   * Typée en union plutôt qu'en `CinemaMovie[] | CinemaSeries[]` : la grille ne lit que ce que les
   * deux ont en commun, et deux tableaux distincts obligeraient à la dupliquer pour rien.
   */
  const catalogue = useMemo<(CinemaMovie | CinemaSeries)[]>(
    () => (mediaType === "series" ? [...seriesById.values()] : [...moviesById.values()]),
    [mediaType, moviesById, seriesById]
  );
  // Series' own Continue Watching row — lazy for the same reason `series` itself is (see above).
  const { data: nextUp } = useSWR<CinemaNextUpPayload>(mediaType === "series" ? "/api/cinema/next-up" : null, fetcher);
  const continueSeries = nextUp?.items ?? [];

  // Warms the browser's own image cache for the backdrops/logos reachable within a few keypresses
  // (see warmUpUrls/prefetchImages above for the budget and why it's capped) — without it, the
  // FIRST time focus lands on a title its backdrop/logo is a cold network fetch, which read as "a
  // second of nothing, then the picture just pops in" (backdrops) or a visible flash before the
  // text fallback kicked in (logos).
  useEffect(() => {
    if (!movies) return;
    return prefetchImages(
      warmUpUrls(movies.spotlight, movies.rows, (m) => m.radarrId, (m) => [m.backdropUrl, m.logoUrl])
    );
  }, [movies]);

  // Same warm-up, series side — fires once series data actually loads (i.e. only after the user
  // has switched to that tab at least once), not on the initial movies-only load.
  useEffect(() => {
    if (!series) return;
    return prefetchImages(
      warmUpUrls(series.spotlight, series.rows, (s) => s.sonarrId, (s) => [s.backdropUrl, s.logoUrl])
    );
  }, [series]);

  const [focusedItem, setFocusedItem] = useState<CinemaMovie | null>(null);

  // Les rangées de découverte, tout en bas : chargées comme le reste, mais elles ne bloquent
  // rien — la page est déjà utilisable sans elles, et TMDB est le seul appel de cet écran qui
  // sorte de la maison.
  const { data: discovery } = useSWR<PlayerDiscoverPayload>("/api/player/discover", fetcher, {
    revalidateOnFocus: false,
  });

  // Un titre de découverte mène à sa fiche quand on l'a, à la fiche TMDB sinon — où « Lire » est
  // devenu « Demander ». Un seul chemin, quel que soit le côté de la frontière.
  // Le focus d'une rangée de découverte rend la main au carrousel : voir CinemaDiscoveryRow.
  const clearFocus = useCallback(() => setFocusedItem(null), []);

  const openDiscovery = useCallback((item: DiscoveryItem) => {
    if (item.libraryId !== null) {
      openLibraryTitle(item.type, item.libraryId);
      return;
    }
    cinemaNavigate({ discover: item.tmdbId, discoverType: item.type });
  }, []);
  // Which sheet is open is read back out of the URL, not held here: that's what makes Back close
  // it. Until the payload has loaded (a cold deep link into a title) the lookup simply finds
  // nothing and the sheet opens as soon as the data lands.
  const selectedItem = route.film !== null ? moviesById.get(route.film) ?? null : null;
  // Before you touch anything, the hero cycles through the latest arrivals instead of sitting on
  // one fixed pick — the same carousel (and the same 8s cadence) as the dashboard's own hero.
  // The moment a card takes focus it wins and the rotation stops: this pane's job from then on
  // is to preview whatever you're pointing at.
  // Le « spotlight » plutôt que « récemment ajouté » : ce dernier a sa propre rangée plus bas, et
  // les mêmes huit titres deux fois de suite ne font pas deux sections.
  const movieCarousel = (movies?.spotlight?.length ? movies.spotlight : movies?.recentlyAdded ?? []).slice(0, 8);
  const [movieCarouselIndex, setMovieCarouselIndex] = useRotatingIndex(movieCarousel.length, focusedItem !== null);
  const heroItem = focusedItem ?? movieCarousel[movieCarouselIndex] ?? null;
  /**
   * La barre allumée est celle du titre que la bannière montre — pas celle de la rotation.
   *
   * Les deux se séparent dès qu'une carte est désignée ailleurs : la bannière suit le survol, la
   * rotation continue de compter dans son coin, et les barres annonçaient alors un titre que
   * personne n'avait sous les yeux. Aucune barre n'est allumée quand la bannière montre un titre
   * qui n'est pas dans cette rangée — dire « le quatrième » d'une rangée où il ne figure pas
   * serait pire que ne rien dire.
   */
  const movieSpotlightIndex = heroItem ? movieCarousel.findIndex((m) => m.radarrId === heroItem.radarrId) : -1;

  // Series' own parallel focus/selection state — kept entirely separate from the movie state
  // above (not touched) so each tab remembers its own position independently when you switch
  // back and forth, same as Netflix's own Movies/TV Shows toggle.
  const [seriesFocusedItem, setSeriesFocusedItem] = useState<CinemaSeries | null>(null);
  const clearSeriesFocus = useCallback(() => setSeriesFocusedItem(null), []);
  const seriesSelectedItem = route.serie !== null ? seriesById.get(route.serie) ?? null : null;
  const seriesCarousel = (series?.spotlight?.length ? series.spotlight : series?.recentlyAdded ?? []).slice(0, 8);
  const [seriesCarouselIndex, setSeriesCarouselIndex] = useRotatingIndex(seriesCarousel.length, seriesFocusedItem !== null);
  const seriesHeroItem = seriesFocusedItem ?? seriesCarousel[seriesCarouselIndex] ?? null;
  const seriesSpotlightIndex = seriesHeroItem
    ? seriesCarousel.findIndex((sh) => sh.sonarrId === seriesHeroItem.sonarrId)
    : -1;

  // Whichever tab is actually showing drives the shared background wash below — a plain union,
  // not a new abstraction, since all it needs is backdropUrl + a stable id to key the crossfade.
  const activeHeroItem = mediaType === "movies" ? heroItem : seriesHeroItem;
  const activeHeroKey = activeHeroItem ? (mediaType === "movies" ? (activeHeroItem as CinemaMovie).radarrId : (activeHeroItem as CinemaSeries).sonarrId) : null;

  // The backdrop specifically (not the hero's own title/synopsis text, which still updates
  // instantly) is debounced before it's allowed to (re)trigger its crossfade — animating a fresh
  // <img> on every single focus event during fast arrow-key scrubbing across a row is exactly
  // what produced the backdrop "ghosting"/persisting-into-each-other bug (rapid, overlapping
  // restarts of the same opacity keyframe). Settling briefly before committing to a new backdrop
  // keeps the nice crossfade for a deliberate selection without resurrecting that. The key travels
  // WITH the item (not read from the live activeHeroKey at render time) — otherwise the <img>'s
  // key would jump ahead of its own (still-debouncing) src, remounting/restarting the crossfade
  // before the new backdrop was even the one committed, which is exactly the same bug again.
  const [debouncedHero, setDebouncedHero] = useState<{ item: typeof activeHeroItem; key: number | null }>({
    item: activeHeroItem,
    key: activeHeroKey,
  });
  useEffect(() => {
    // Never commit an empty hero: switching to a tab whose data is still loading momentarily has
    // nothing to show, and blanking the backdrop for it drops the whole screen to flat slate for
    // as long as the fetch takes. Holding the previous image until a real replacement exists
    // makes the switch read as a crossfade rather than a blackout.
    if (!activeHeroItem) return;
    const timer = setTimeout(() => setDebouncedHero({ item: activeHeroItem, key: activeHeroKey }), 150);
    return () => clearTimeout(timer);
  }, [activeHeroItem, activeHeroKey]);
  const debouncedHeroItem = debouncedHero.item;
  const debouncedHeroKey = debouncedHero.key;

  // Whatever card was focused (mouse click also focuses a <button> natively) right before
  // CinemaMovieDetail opened — restored on close so arrow-nav resumes exactly where the user
  // left it instead of snapping back to the first card (useTvGridNav treats "nothing focused"
  // as "start over").
  const lastFocusedCard = useRef<HTMLElement | null>(null);
  const rowsPaneRef = useRef<HTMLDivElement>(null);

  // Paused while the detail overlay owns Up/Down/Escape for its own vertical menu (see the
  // hook's own doc comment) AND while the player is open. The player closes CinemaMovieDetail
  // the moment Lecture actually starts (see CinemaMovieDetail's own note), which flips
  // selectedItem back to null — without this second condition that alone was enough to
  // re-arm this hook's own global arrow-key listener underneath the player: pressing Right on a
  // player control it didn't recognize hit useTvGridNav's "nothing focused yet" branch, which
  // jumps straight to the first poster card in the (still fully mounted, just hidden) browse
  // grid — then Enter on THAT opened a completely different title's detail sheet.
  const playback = usePlayback();

  const router = useRouter();
  const searchOpen = route.search;
  const setSearchOpen = useCallback(
    (open: boolean) => (open ? cinemaNavigate({ search: true }) : cinemaClose({ search: false })),
    []
  );

  // "full" specifically, not "closed" — a minimized (mini) player is a small floating widget;
  // browsing the grid underneath it should still work normally, only a full-screen player
  // actively capturing the keyboard needs this stepping aside. Both selectedItem and
  // seriesSelectedItem gate this now — either detail sheet owns the keyboard the same way.
  // Les flèches ne pilotent la grille que lorsqu'elle est l'écran du dessus : un panneau du rail
  // (recherche, Ma liste, compte) la recouvre, et sans cette garde on déplaçait le focus dans des
  // affiches invisibles pendant qu'on lisait autre chose.
  const panelOpen = searchOpen || route.list || route.account;
  /** Une fiche TMDB ou une fiche personne est ouverte par-dessus celles de la bibliothèque. */
  const sheetAbove = route.discover !== null || route.person !== null;
  useTvGridNav(selectedItem === null && seriesSelectedItem === null && playback.mode !== "full" && !panelOpen);

  // "/" opens the search from anywhere on the browse screen — the shortcut every media UI has,
  // and the reason the button itself can stay a small icon rather than a full-width field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || panelOpen) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (selectedItem || seriesSelectedItem || playback.mode === "full") return;
      e.preventDefault();
      setSearchOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, selectedItem, seriesSelectedItem, playback.mode, setSearchOpen]);

  // All four are useCallback'd for one specific reason: the row components below are memo'd, and
  // a fresh function identity on every render would defeat that entirely — the rows (and every
  // card in them, which on a large library is thousands of nodes) would re-render on every single
  // arrow keypress, since focus changes re-render this component by design.
  const openDetail = useCallback((item: CinemaMovie) => {
    lastFocusedCard.current = document.activeElement as HTMLElement;
    cinemaNavigate({ film: item.radarrId, serie: null });
  }, []);

  /**
   * Ouvrir la fiche depuis une carte de reprise.
   *
   * Le lien vers la bibliothèque est déjà porté par la charge utile (`/radarr/12`, `/sonarr/34`) :
   * il n'y a donc rien à retrouver, seulement à ouvrir. Un titre que la bibliothèque ne connaît
   * pas — présent dans Jellyfin mais pas dans Radarr ni Sonarr — n'a pas de fiche : on lit,
   * plutôt que de laisser un bouton mort.
   */
  /**
   * On arrive sur la première rangée.
   *
   * Le panneau est en `snap-mandatory` : au chargement, le navigateur cale sur le point
   * d'accroche le plus proche, qui selon la hauteur de la fenêtre pouvait être le Top 10 plutôt
   * que la première rangée. Remis en haut explicitement, à l'arrivée comme à chaque changement
   * d'onglet — où la liste des rangées change entièrement et où rester à mi-hauteur n'a aucun
   * sens. `instant`, sinon l'accrochage tranche avant que le défilement doux ait fini.
   */
  useEffect(() => {
    rowsPaneRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [mediaType]);

  /** Le film de la bibliothèque désigné par un lien de reprise, s'il y est. */
  const matchRadarr = useCallback(
    (href: string | null) => {
      const film = href?.match(/^\/radarr\/(\d+)$/);
      return film ? moviesById.get(Number(film[1])) : undefined;
    },
    [moviesById]
  );

  const openResume = useCallback(
    (href: string | null, play: () => void) => {
      lastFocusedCard.current = document.activeElement as HTMLElement;
      const film = href?.match(/^\/radarr\/(\d+)$/);
      if (film) return cinemaNavigate({ film: Number(film[1]), serie: null });
      const serie = href?.match(/^\/sonarr\/(\d+)$/);
      if (serie) return cinemaNavigate({ serie: Number(serie[1]), film: null });
      play();
    },
    []
  );

  const closeDetail = useCallback(() => {
    cinemaClose({ film: null, episodes: false });
    // The card is still in the DOM (the browse screen never unmounts under the overlay) but
    // isn't focused yet the instant this runs — the overlay's own focused button is still
    // mid-unmount. One frame later it's safe to move focus back.
    requestAnimationFrame(() => lastFocusedCard.current?.focus());
  }, []);

  const openSeriesDetail = useCallback((item: CinemaSeries) => {
    lastFocusedCard.current = document.activeElement as HTMLElement;
    cinemaNavigate({ serie: item.sonarrId, film: null });
  }, []);

  const closeSeriesDetail = useCallback(() => {
    cinemaClose({ serie: null, episodes: false });
    requestAnimationFrame(() => lastFocusedCard.current?.focus());
  }, []);

  /**
   * La pile de fiches.
   *
   * Ouvrir un titre depuis « Titres similaires » n'échangeait que le sujet d'une fiche unique :
   * en revenant, le composant remontait le titre de départ de zéro, et sa rangée de titres
   * similaires se reconstruisait sous les yeux. La fiche recouverte reste donc montée, dessous
   * et inerte, et le retour la retrouve telle qu'on l'avait laissée.
   *
   * `useRouteBehind` dit ce que l'entrée d'historique courante recouvre — la seule façon de le
   * savoir après un rechargement, où rien de ce qui précède n'est monté.
   *
   * Un seul tableau, et une clé par titre : deux emplacements distincts feraient glisser la
   * fiche du dessous d'un cran au retour, donc la démonteraient — exactement ce qu'on évite ici.
   */
  /** La grille sort comme elle est entrée — voir la note jumelle de l'écran téléphone. */
  const browseExit = useExitDelay(route.browse !== null, BROWSE_EXIT_MS);
  const [lastBrowse, setLastBrowse] = useState<string | null>(route.browse);
  if (route.browse !== null && route.browse !== lastBrowse) setLastBrowse(route.browse);

  const noop = useCallback(() => {}, []);
  const behind = useRouteBehind();
  const movieStack = useMemo(() => {
    if (!selectedItem) return [];
    const under =
      behind && behind.tab === "movies" && behind.film !== null && behind.film !== route.film
        ? moviesById.get(behind.film) ?? null
        : null;
    return under ? [under, selectedItem] : [selectedItem];
  }, [selectedItem, behind, moviesById, route.film]);
  const seriesStack = useMemo(() => {
    if (!seriesSelectedItem) return [];
    const under =
      behind && behind.tab === "series" && behind.serie !== null && behind.serie !== route.serie
        ? seriesById.get(behind.serie) ?? null
        : null;
    return under ? [under, seriesSelectedItem] : [seriesSelectedItem];
  }, [seriesSelectedItem, behind, seriesById, route.serie]);

  // Goes through leaveCinema rather than a bare router.push: playback has to survive the exit
  // (see the helper), and its fallback covers a click landing mid-redeploy.
  const exitButton = (
    <button onClick={() => leaveCinema(router)} className="btn-primary">
      {t("cinema.standardMode")}
    </button>
  );

  // z-index as inline style, not a Tailwind class (arbitrary-value classes weren't making it
  // into the production CSS bundle — see CinemaHero's note on the height fix). Cinema Mode is
  // conceptually just page content (it only uses `fixed` for its own split-screen layout
  // trick), so it belongs BELOW the app's real overlays, not above them — 45 sits above
  // MobileNav (z-40) but below Modal/GlobalSearch (z-50), ActionSheet (z-60), TrailerModal/
  // UpdateBanner (z-70), and critically PlayerHost (z-80): with the old z-200, pressing Lecture
  // started playback (audio, Chrome's media-session UI) entirely behind this screen's opaque
  // background — the player was rendering, just invisible under a higher layer. CinemaMovieDetail
  // sits at 46, just above this.
  const zLayer = { zIndex: 45 };

  // The actual bug, found by comparing rendered outerHTML against the DOM: `fixed inset-0` only
  // pins to the viewport when NO ancestor has a non-`none` transform. The (dashboard) layout
  // wraps every page in PageTransition, whose fade-in-up keyframes end on `transform:
  // translateY(0)` with fill-mode `both` — that's a non-none transform value, retained forever,
  // so it permanently makes PageTransition's wrapper div the containing block for our fixed
  // layer instead of the viewport. The fixed div then collapses inside that zero-size ancestor:
  // fully populated in the DOM (title, backdrop, rows all present, confirmed via outerHTML) but
  // invisible. Portaling straight to document.body — same escape hatch already used by
  // Modal/TrailerModal/PlayerHost/ActionSheet — sidesteps the containing-block issue entirely.
  if (moviesLoading) {
    // A skeleton in the shape of the real screen, not a centred spinner: the layout it resolves
    // into is already on screen, so the load reads as content filling in rather than a blank
    // screen swapping for a full one.
    return createPortal(
      <div className="fixed inset-0 flex animate-fade-in flex-col overflow-hidden bg-ink" style={{ ...zLayer, paddingLeft: "var(--player-rail, 0px)" }}>
        <div className="relative min-h-0 shrink grow-0" style={{ flexBasis: "50%" }}>
          <div className="flex h-full max-w-2xl flex-col justify-end gap-4 px-8 pb-10 sm:px-12">
            <div className="skeleton h-12 w-72 rounded-lg sm:h-16" />
            <div className="skeleton h-4 w-48 rounded" />
            <div className="skeleton h-4 w-full max-w-xl rounded" />
            <div className="skeleton h-4 w-2/3 max-w-md rounded" />
          </div>
        </div>
        <div className="min-h-80 flex-1 pt-6">
          <div className="mb-2 px-8 sm:px-12">
            <div className="skeleton h-4 w-28 rounded" />
          </div>
          <div className="flex gap-3 px-8 pb-4 pt-3 sm:px-12" style={EDGE_FADE}>
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className={`skeleton ${CARD_WIDTH} aspect-2/3 shrink-0 rounded-lg`} />
            ))}
          </div>
        </div>
      </div>,
      document.body
    );
  }

  if (moviesError) {
    return createPortal(
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-ink p-8 text-center" style={{ ...zLayer, paddingLeft: "var(--player-rail, 0px)" }}>
        <p className="max-w-sm text-sm text-red-400">{moviesError.message || t("common.unknown")}</p>
        {exitButton}
      </div>,
      document.body
    );
  }

  if (movies && movies.spotlight.length === 0) {
    return createPortal(
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-ink p-8 text-center" style={{ ...zLayer, paddingLeft: "var(--player-rail, 0px)" }}>
        <p className="max-w-sm text-sm text-slate-400">{t("cinema.empty")}</p>
        {exitButton}
      </div>,
      document.body
    );
  }

  return createPortal(
    // `--player-rail` est posée par PlayerShell : la bande repliée du rail est réservée ici,
    // parce qu'un écran porté dans document.body n'hérite d'aucun padding de la coquille.
    <div className="fixed inset-0 animate-fade-in overflow-hidden bg-ink" style={{ ...zLayer, paddingLeft: "var(--player-rail, 0px)" }}>
      {/* La sortie et la loupe ont quitté les coins de l'écran : elles sont dans le rail, à
          gauche, avec le reste de la navigation. Deux boutons flottants de moins par-dessus les
          affiches, et un seul endroit où l'on va chercher où aller. */}

      <CinemaModeToggle mode={mediaType} onChange={setMediaType} />
      <CinemaShortcutsGuide />

      {/* La recherche est rendue par la coquille du lecteur (PlayerShell), pas ici : c'est le
          même moteur que la recherche globale, elle trouve aussi les personnes et les titres
          qu'on ne possède pas encore, et elle doit donc exister partout, pas seulement sur la
          grille. `searchOpen` reste lu plus haut pour suspendre la navigation aux flèches et la
          bande-annonce pendant qu'elle est ouverte. */}

      {/* One continuous ambient background for the WHOLE screen, not scoped to the hero pane —
          a sharp copy of the focused item's backdrop (masked, fading out by ~72% of the full
          screen height) sits over a blurred+darkened duplicate that spans the full height, so
          wherever the sharp one has faded away the wash keeps going (blurred, dim) instead of
          hitting a hard edge right at the rows pane. Both panes below render on top of this with
          transparent backgrounds — the only thing they visually share is this backdrop, not any
          overlapping text/labels (an earlier -mt-16 overlap trick pulled row labels into literal
          collision with the hero's own synopsis/cast line). */}
      <div className="absolute inset-0 overflow-hidden">
        {debouncedHeroItem?.backdropUrl && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={`blur-${debouncedHeroKey}`}
              src={debouncedHeroItem.backdropUrl}
              alt=""
              className="absolute inset-0 h-full w-full scale-110 animate-fade-in object-cover object-top blur-2xl"
            />
            <div className="absolute inset-0 bg-ink/55" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={debouncedHeroKey}
              src={debouncedHeroItem.backdropUrl}
              alt=""
              className="absolute inset-0 h-full w-full animate-fade-in object-cover object-top"
              style={{ maskImage: BACKDROP_MASK, WebkitMaskImage: BACKDROP_MASK }}
            />
            {/* Takes over from the still image above once its own dwell timer + confirmed
                "now playing" state clear — same mask, same role, later in DOM order so it
                naturally paints on top (see the z-index note elsewhere in this file for that
                convention) with no z-index of its own needed. The image never unmounts
                underneath it: nothing to do if there's no trailer, or before it's ready.
                Unmounted outright (not just hidden) whenever something opaque is over it: a
                detail sheet or the real player. Hiding alone would leave a YouTube player running
                behind a full-screen overlay — burning CPU on frames nobody sees, and, if the user
                had unmuted the preview, still audible underneath the film they just started. */}
            {/* La bande-annonce de fond est désactivée sur grand écran, à la demande.
                
                Retirée d'ici plutôt que mise en pause : c'est ce qui garantit que l'API YouTube
                n'est jamais chargée et qu'aucune image n'est décodée pour un fond que personne ne
                regardait. Le visuel du titre reste, et c'est lui que la page est venue montrer.
                
                Tout ce qui l'alimentait — la clé de la bande-annonce remontée par la bannière, le
                calcul de sa suspension — a disparu avec elle ; il faudra le refaire pour la
                rallumer, et ce sera plus propre que de garder un composant mort en réserve. */}
          </>
        )}
        <div className="absolute inset-0 bg-linear-to-r from-ink/85 via-ink/35 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-1/4 bg-linear-to-b from-transparent to-ink" />
      </div>

      {/* Split-screen TV layout: the top pane is a live, non-scrolling preview of whatever card
          has focus (never scrolls away — that's the "sticky" ask) and the bottom pane is its own
          independently scrolling region for the rows. Two panes, not one scroller with a sticky
          hero, so the preview never has to fight scroll position math.
          No z-index here (was z-10, same as the exit button above) — that tied both at the same
          stacking level, and since this wrapper comes LATER in DOM order, it silently won the
          tie and sat on top of the button in that corner (transparent there, but still catching
          every click aimed at it) — the exact same bug CinemaMovieDetail's own back button had.
          DOM order alone already paints this correctly above the backgroundlayer right before it
          (that one has no z-index either), so nothing here needs to compete with the fixed
          buttons at all. */}
      <div className="relative flex h-full flex-col">
        {/* flex-basis 50% via inline style (arbitrary-value classes don't make it into the
            production CSS bundle — see the z-index note above), grow-0 (never grows past 50% on
            a tall screen) shrink (free to shrink below it) — paired with the rows pane's own
            min-h-80 below, the browser's own flex algorithm does the rest: on a short viewport
            (a 13" laptop, say) where 50% + one full row wouldn't both fit, ALL the give comes
            from this pane shrinking, never from the row's guaranteed minimum. No resize
            listener needed — this is exactly what flex-shrink + a sibling's min-height is for. */}
        {/* Keyed by mediaType, not by the focused item — CinemaHero/CinemaSeriesHero already
            update their own text instantly as focus moves across cards WITHIN a tab (see
            CinemaHero's own doc comment on why that's deliberate, not debounced); this key only
            changes on an actual Films/Séries switch, so the crossfade plays once per tab flip,
            not on every arrow-key scrub. */}
        {/* 44 % et non 50 % : la première page doit montrer la bannière, la rangée « À la une »
            *entière*, puis le titre de « Reprendre » et le haut de ses affiches — c'est ce qui
            dit qu'on peut descendre. Six points de hauteur suffisent à l'obtenir. */}
        <div key={mediaType} className="relative min-h-0 shrink grow-0 animate-fade-in" style={{ flexBasis: "44%" }}>
          {mediaType === "movies"
            ? heroItem && <CinemaHero item={heroItem} />
            : seriesHeroItem && <CinemaSeriesHero item={seriesHeroItem} />}
        </div>

        {/* min-h-80 (320px): comfortably fits one full row — label, a card at its largest
            breakpoint size, and the hover/focus scale-up room — so there's always at least one
            complete row on screen no matter how short the viewport is (see the hero pane's own
            note above).
            snap-y/snap-mandatory, back after two failed attempts at a hand-rolled JS equivalent
            (nearest-edge, then "which row have I entered" + scrollend) — both eventually landed
            wrong in some scroll direction or another (a half-visible row peeking in, a label
            scrolled just out of view). Native scroll-snap is the browser's own well-tested
            implementation and is unconditionally reliable about where it comes to rest; the
            tradeoff, honestly, is that a plain (non-inertial) mouse wheel can feel like it snaps
            one row per notch rather than gliding — a known, inherent trait of mandatory snap with
            discrete wheel input, not something further JS here fixed better than the browser
            itself. Reliability was the explicit priority over that. */}
        <div
          ref={rowsPaneRef}
          className="scrollbar-thin relative min-h-80 flex-1 snap-y snap-mandatory scroll-smooth overflow-y-auto pb-16 pt-6"
        >
          {/* Keyed by mediaType so switching Films/Séries crossfades the whole rows pane in
              instead of hard-cutting between them — only the ENTERING side needs an animation
              here (the old content just vanishes underneath it, same instant swap as before,
              but it reads fine masked by the new content fading in over it at this duration).
              Opacity-only, no transform — this wraps every row below, so a transform here would
              hit the exact same containing-block pitfall as everywhere else in Cinema Mode if any
              of them ever grew a position:fixed descendant (see globals.css's own note). */}
          <div key={mediaType} className="animate-fade-in">
          {mediaType === "movies" ? (
            <>
              {/* Première rangée, et celle que la bannière suit — voir CinemaSpotlight. */}
              <CinemaSpotlight
                label={t("cinema.spotlight")}
                count={movieCarousel.length}
                activeIndex={movieSpotlightIndex}
                onPick={(i) => {
                  // La bannière doit repartir sur la rotation : tant qu'une carte est retenue,
                  // c'est elle qui commande, et les barres ne changeraient rien à l'écran.
                  setFocusedItem(null);
                  setMovieCarouselIndex(i);
                }}
              >
                {movieCarousel.map((item, i) => (
                  <CinemaCard
                    key={item.radarrId}
                    item={item}
                    index={i}
                    rowKey="spotlight-movies"
                    widthClassName={CARD_WIDTH}
                    onFocusItem={setFocusedItem}
                    onSelectItem={openDetail}
                    showNewBadge={false}
                  />
                ))}
              </CinemaSpotlight>

              {resumeMovies.length > 0 && (
                <div data-tv-rowroot className="mb-6 animate-fade-in-up snap-start">
                  <h2 className="mb-2 px-8 text-sm font-medium text-white/70 sm:px-12">{t("cinema.continueWatching")}</h2>
                  <div className="scrollbar-thin flex scroll-smooth gap-3 overflow-x-auto overflow-y-hidden px-8 pb-4 pt-3 sm:px-12" style={EDGE_FADE}>
                    {resumeMovies.map((item, i) => (
                      <ContinueCard
                        key={item.id}
                        itemId={item.id}
                        title={item.name}
                        thumbnailUrl={item.imageTag ? `/api/jellyfin/image?itemId=${item.id}&tag=${item.imageTag}` : null}
                        progress={item.progress}
                        resumeTicks={item.positionTicks}
                        runtimeTicks={item.runtimeTicks}
                        rowKey="continue-movies"
                        index={i}
                        onFocus={() => {
                          const inLibrary = matchRadarr(item.cinemaHref);
                          if (inLibrary) setFocusedItem(inLibrary);
                        }}
                        onOpen={() =>
                          openResume(item.cinemaHref, () =>
                            playback.play({
                              itemId: item.id,
                              title: item.name,
                              resumeAt: item.positionTicks > 0 ? item.positionTicks / 10_000_000 : undefined,
                            })
                          )
                        }
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* The curated rails, ahead of the alphabetical genre rows: what's best, what just
                  arrived, what you saved. A library sorted A→Z is a catalogue; these three are
                  what make it read as a home screen. Each one hides itself when empty. */}
              {movies && (
                <CinemaTop10Row
                  label={t("cinema.top10")}
                  rowKey="top10-movies"
                  rowIndex={resumeMovies.length > 0 ? 2 : 1}
                  items={movies.top10}
                  idOf={(m) => m.radarrId}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={setFocusedItem}
                  onSelectItem={openDetail}
                />
              )}

              {movies && (
                <CinemaRow
                  label={t("cinema.recentlyAdded")}
                  rowKey="recent-movies"
                  showNewBadge={false}
                  rowIndex={RAIL_COUNT}
                  items={movies.recentlyAdded}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={setFocusedItem}
                  onSelectItem={openDetail}
                />
              )}

              <CinemaRow
                label={t("cinema.myList")}
                rowKey="mylist-movies"
                rowIndex={RAIL_COUNT}
                items={myListMovies}
                cardWidthClassName={CARD_WIDTH}
                onSeeAll={() => cinemaNavigate({ list: true })}
                onFocusItem={setFocusedItem}
                onSelectItem={openDetail}
              />

              {movies?.genres.map((genre, i) => (
                <CinemaRow
                  key={genre}
                  label={genre}
                  rowKey={`genre-${genre}`}
                  rowIndex={i + RAIL_COUNT}
                  items={movies.rows[genre] ?? []}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={setFocusedItem}
                  onSelectItem={openDetail}
                  onSeeAll={() => cinemaNavigate({ browse: genre })}
                />
              ))}

              {discovery?.rows
                .filter((row) => row.key === "recommended" || row.key === "trendingMovies")
                .map((row) => (
                  <CinemaDiscoveryRow
                    key={row.key}
                    label={t(`cinema.discovery.${row.key}`)}
                    rowKey={row.key}
                    rowIndex={RAIL_COUNT}
                    items={row.items}
                    cardWidthClassName={CARD_WIDTH}
                    missingLabel={t("player.notInLibrary")}
                    onFocusItem={clearFocus}
                    onSelectItem={openDiscovery}
                  />
                ))}

              {/* Le bout des rangées : toute la bibliothèque, triable et filtrable. C'est la
                  sortie de quelqu'un qui a tout parcouru sans rien trouver. */}
              <div className="mb-10 mt-4 px-8 sm:px-12">
                <button type="button" onClick={() => cinemaNavigate({ browse: BROWSE_ALL })} className="btn btn-ghost">
                  {t(`player.browse.all.${mediaType}`)}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Inline states, not a full-screen early return like movies' own loading/error/
                  empty branches above — those replace the WHOLE screen before the toggle even
                  exists yet (fine, since movies always load first); series loads lazily after
                  the toggle is already up, so its own states have to render inside the same
                  chrome instead of hiding the toggle that got you here. */}
              <CinemaSpotlight
                label={t("cinema.spotlight")}
                count={seriesCarousel.length}
                activeIndex={seriesSpotlightIndex}
                onPick={(i) => {
                  setSeriesFocusedItem(null);
                  setSeriesCarouselIndex(i);
                }}
              >
                {seriesCarousel.map((item, i) => (
                  <CinemaSeriesCard
                    key={item.sonarrId}
                    item={item}
                    index={i}
                    rowKey="spotlight-series"
                    widthClassName={CARD_WIDTH}
                    onFocusItem={setSeriesFocusedItem}
                    onSelectItem={openSeriesDetail}
                    showNewBadge={false}
                  />
                ))}
              </CinemaSpotlight>

              {continueSeries.length > 0 && (
                <div data-tv-rowroot className="mb-6 animate-fade-in-up snap-start">
                  <h2 className="mb-2 px-8 text-sm font-medium text-white/70 sm:px-12">{t("cinema.continueWatching")}</h2>
                  <div className="scrollbar-thin flex scroll-smooth gap-3 overflow-x-auto overflow-y-hidden px-8 pb-4 pt-3 sm:px-12" style={EDGE_FADE}>
                    {continueSeries.map((item, i) => (
                      <ContinueCard
                        key={item.jellyfinItemId}
                        itemId={item.jellyfinItemId}
                        title={item.title}
                        thumbnailUrl={item.thumbnailUrl}
                        progress={
                          item.resumeTicks && item.runtimeTicks ? Math.min((item.resumeTicks / item.runtimeTicks) * 100, 99) : 0
                        }
                        resumeTicks={item.resumeTicks}
                        runtimeTicks={item.runtimeTicks}
                        seasonNumber={item.seasonNumber}
                        episodeNumber={item.episodeNumber}
                        rowKey="continue-series"
                        index={i}
                        onFocus={() => {
                          const inLibrary = item.sonarrId ? seriesById.get(item.sonarrId) : undefined;
                          if (inLibrary) setSeriesFocusedItem(inLibrary);
                        }}
                        onOpen={() =>
                          openResume(item.sonarrId ? `/sonarr/${item.sonarrId}` : null, () =>
                            playback.play({
                              itemId: item.jellyfinItemId,
                              title: item.title,
                              resumeAt:
                                item.resumeTicks && item.resumeTicks > 0 ? item.resumeTicks / 10_000_000 : undefined,
                            })
                          )
                        }
                      />
                    ))}
                  </div>
                </div>
              )}

              {seriesLoading && (
                <div className="flex justify-center pt-12">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                </div>
              )}
              {seriesError && (
                <p className="px-8 text-sm text-red-400 sm:px-12">{seriesError.message || t("common.unknown")}</p>
              )}
              {series && series.spotlight.length === 0 && (
                <p className="px-8 text-sm text-slate-400 sm:px-12">{t("cinema.empty")}</p>
              )}
              {/* Same three rails as the movies tab — see its own note above. */}
              {series && (
                <CinemaTop10Row
                  label={t("cinema.top10")}
                  rowKey="top10-series"
                  rowIndex={continueSeries.length > 0 ? 1 : 0}
                  items={series.top10}
                  idOf={(x) => x.sonarrId}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={setSeriesFocusedItem}
                  onSelectItem={openSeriesDetail}
                />
              )}

              {series && (
                <CinemaSeriesRow
                  label={t("cinema.recentlyAdded")}
                  rowKey="recent-series"
                  showNewBadge={false}
                  rowIndex={RAIL_COUNT}
                  items={series.recentlyAdded}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={setSeriesFocusedItem}
                  onSelectItem={openSeriesDetail}
                />
              )}

              <CinemaSeriesRow
                label={t("cinema.myList")}
                rowKey="mylist-series"
                rowIndex={RAIL_COUNT}
                items={myListSeries}
                cardWidthClassName={CARD_WIDTH}
                onSeeAll={() => cinemaNavigate({ list: true })}
                onFocusItem={setSeriesFocusedItem}
                onSelectItem={openSeriesDetail}
              />

              {series?.genres.map((genre, i) => (
                <CinemaSeriesRow
                  key={genre}
                  label={genre}
                  rowKey={`genre-${genre}`}
                  rowIndex={i + RAIL_COUNT}
                  items={series.rows[genre] ?? []}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={setSeriesFocusedItem}
                  onSelectItem={openSeriesDetail}
                  onSeeAll={() => cinemaNavigate({ browse: genre })}
                />
              ))}

              {discovery?.rows
                .filter((row) => row.key === "trendingSeries")
                .map((row) => (
                  <CinemaDiscoveryRow
                    key={row.key}
                    label={t(`cinema.discovery.${row.key}`)}
                    rowKey={row.key}
                    rowIndex={RAIL_COUNT}
                    items={row.items}
                    cardWidthClassName={CARD_WIDTH}
                    missingLabel={t("player.notInLibrary")}
                    onFocusItem={clearSeriesFocus}
                    onSelectItem={openDiscovery}
                  />
                ))}

              {/* Voir la note jumelle côté films. */}
              <div className="mb-10 mt-4 px-8 sm:px-12">
                <button type="button" onClick={() => cinemaNavigate({ browse: BROWSE_ALL })} className="btn btn-ghost">
                  {t(`player.browse.all.${mediaType}`)}
                </button>
              </div>
            </>
          )}
          </div>
        </div>
      </div>

      {/* Effacées tant qu'une fiche TMDB ou une fiche personne est ouverte par-dessus : elles
          partagent le même plan, et deux fiches montées ensemble écoutent Échap toutes les deux.
          L'adresse les garde, le retour les rouvre. */}
      {/* La grille complète, sur l'onglet courant. Elle vit au même niveau que les panneaux du
          rail : le retour ramène aux rangées, à l'endroit où on les avait laissées. */}
      {browseExit.render && lastBrowse !== null && catalogue.length > 0 && (
        <CinemaBrowseSheet
          leaving={browseExit.leaving}
          genre={lastBrowse}
          mediaType={mediaType}
          items={catalogue}
          genres={(mediaType === "series" ? series?.genres : movies?.genres) ?? []}
          idOf={(item) => ("radarrId" in item ? item.radarrId : item.sonarrId)}
          posterOf={(item) => item.posterUrl}
          libraryIdOf={(item) => ("radarrId" in item ? item.radarrId : item.sonarrId)}
        />
      )}

      {!sheetAbove &&
        movieStack.map((film, i) => {
          const top = i === movieStack.length - 1;
          return (
            <CinemaMovieDetail
              key={film.radarrId}
              item={film}
              underneath={!top}
              onClose={top ? closeDetail : noop}
              onSelectSimilar={openDetail}
            />
          );
        })}
      {!sheetAbove &&
        seriesStack.map((serie, i) => {
          const top = i === seriesStack.length - 1;
          return (
            <CinemaSeriesDetail
              key={serie.sonarrId}
              item={serie}
              underneath={!top}
              onClose={top ? closeSeriesDetail : noop}
              onSelectSimilar={openSeriesDetail}
            />
          );
        })}
    </div>,
    document.body
  );
}
