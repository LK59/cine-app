"use client";

import { HeroBackdrop } from "@/components/cinema/HeroBackdrop";
import { useMissingTitleNotice } from "@/lib/useMissingTitleNotice";
import { ActionSheet } from "@/components/ActionSheet";
import { useLongPress } from "@/lib/useLongPress";
import { useRemoveFromResume } from "@/lib/useRemoveFromResume";
import { CATALOGUE_FLIP, useFlipGrid } from "@/lib/useFlipGrid";
import { continueOrder, type ContinueEntry } from "@/lib/continueOrder";
import { ROW_CONTAINMENT } from "@/lib/rowContainment";
import { continueHeroTitles, continueTargets, heroSource, myListGoesLate, spotlightRowItems } from "@/lib/homeLayout";
import { useHomeLayout } from "@/lib/useHomeLayout";
import useSWR from "swr";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Play, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { fetcher, liveFeedOptions, NEXT_UP_KEY, RESUME_KEY, MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY, nothingToShowYet, catalogueErrorView } from "@/lib/swr";
import { cinemaFetcher } from "@/lib/cinemaPayload";
import { leaveCinema } from "@/lib/leaveCinema";
import { unresolvedSheetRequest, useRepairUnresolvedSheet } from "@/lib/useRepairUnresolvedSheet";
import { top10Label, genreLabel } from "@/lib/top10Label";
import { useCinemaRoute, useRouteBehind, sheetIsBehind, readCinemaRoute, cinemaNavigate, cinemaClose, openLibraryTitle } from "@/lib/cinemaRoute";
import { openDiscoveryItem, openResumeTarget, openSimilarTitle, openTitle } from "@/lib/cinemaOpen";
import { closeUncoversGrid, coversGrid, gridCardInFocus, gridIsTop } from "@/lib/cinemaGridTop";
import { uniqueById } from "@/lib/cinemaRails";
import { formatContinueCaption, heroContinueFacts } from "@/lib/cinemaContinueLabel";
import { BACKDROP_MASK } from "@/lib/cinemaBackdropMask";
import { useWarmSeriesCatalogue } from "@/lib/useWarmSeriesCatalogue";
import { errorMessage } from "@/lib/upstreamError";
import { heroKindFor, type HeroFocus } from "@/lib/cinemaHeroKind";
import { useTvGridNav } from "@/lib/useTvGridNav";
import { usePlayback } from "@/components/PlaybackProvider";
import { PosterImage } from "@/components/PosterImage";
import { CinemaHero, HeroBannerControls } from "@/components/cinema/CinemaHero";
import { CinemaRow } from "@/components/cinema/CinemaRow";
import { CinemaBrowseSheet } from "@/components/cinema/CinemaBrowseSheet";
import { BROWSE_ALL, browseSheetKey } from "@/lib/cinemaBrowse";
import { useExitDelay } from "@/lib/useExitDelay";
import { useIsTouch } from "@/lib/useIsMobile";
import { useCentredCard } from "@/lib/useCentredCard";

/** La durée de l'animation de sortie de la grille — celle de `--animate-fade-out`. */
/**
 * La part de l'écran que prend la bannière — pour le vrai écran *et* pour son squelette.
 *
 * 44 % et non 50 % : la première page doit montrer la bannière, la rangée « À la une » *entière*,
 * puis le titre de « Reprendre » et le haut de ses affiches — c'est ce qui dit qu'on peut
 * descendre. Six points de hauteur suffisent à l'obtenir.
 *
 * Une seule valeur pour les deux : le squelette était resté à 50 % quand l'écran est passé à 44,
 * si bien qu'à chaque chargement à froid toutes les rangées remontaient d'un coup au moment où le
 * contenu remplaçait le squelette (relevé le 23/09/2026).
 */
const HERO_BASIS = "44%";

const BROWSE_EXIT_MS = 200;
import { CinemaCard } from "@/components/cinema/CinemaCard";
import { CinemaSeriesCard } from "@/components/cinema/CinemaSeriesCard";
import { CinemaMovieDetail } from "@/components/cinema/CinemaMovieDetail";
import { CinemaSeriesHero } from "@/components/cinema/CinemaSeriesHero";
import { CinemaSeriesRow } from "@/components/cinema/CinemaSeriesRow";
import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import { CinemaModeToggle } from "@/components/cinema/CinemaModeToggle";
import { CinemaBrowseAllButton } from "@/components/cinema/CinemaBrowseAllButton";
import { CinemaTop10Row } from "@/components/cinema/CinemaTop10Row";
import { CinemaDiscoveryRow } from "@/components/cinema/CinemaDiscoveryRow";
import { useCinemaMyList, useCinemaMyListPending } from "@/lib/useCinemaMyList";
import { CinemaSkeletonCards, isRowPending } from "@/components/cinema/CinemaRowSkeleton";
import { heroOffscreen, heroSignature, resolveHeroCarousel, upcomingImages, useDecodeAhead, useHeroOrder } from "@/lib/heroCarousel";
import { CinemaShortcutsGuide } from "@/components/cinema/CinemaShortcutsGuide";
import { useT } from "@/components/TranslationProvider";
import type { CinemaMoviesPayload, CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeriesPayload, CinemaSeries } from "@/app/api/cinema/series/route";
import type { CinemaNextUpPayload, CinemaNextUpItem } from "@/app/api/cinema/next-up/route";
import type { PlayerDiscoverPayload, DiscoveryItem } from "@/app/api/player/discover/route";
import { prefetchImages, prefetchInChunks, warmUpUrls } from "@/lib/cinemaWarmup";
import { useDecodeRowsAhead } from "@/lib/useDecodeAhead";
import { tabPaneProps, useKeptTabs, useTabScrollMemory } from "@/lib/keptTabs";
import { useFreshPersonalLists } from "@/lib/freshLists";
import { heroInfoKey, preloadHeroInfo } from "@/lib/useHeroInfo";
import { ProgressFill } from "@/components/cinema/ProgressFill";
import { feedResumeAt } from "@/lib/sheetFacts";
import { usePlaySeriesNextEpisode } from "@/lib/playSeriesNextEpisode";
import { guidedScrollClass, useGuidedScroll } from "@/lib/guidedScroll";

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
  /** Quand il a été lu pour la dernière fois — l'ordre de la rangée (`continueOrder`). */
  lastPlayedAt?: string | null;
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

// Continue-watching items come from Jellyfin's own resume/next-up feeds (via the dashboard resume
// payload for movies, and /api/cinema/next-up for series — see that route's own doc comment), not
// the /api/cinema/movies|series library data — they don't carry backdrop/genres/overview, so they
// don't participate in the hero-focus mechanic, just thumbnail + progress + direct play. Still
// wired into the same data-tv-* grid so keyboard/arrow navigation covers it seamlessly with the
// genre rows below. Shared between the Films and Séries tabs (each with its own data source and
// row key) — the card itself doesn't care which.
/** Une carte de « Reprendre » : un film du flux de reprise, ou l'épisode qui attend une série. */
type ResumeEntry = ContinueEntry<CinemaResumeItem, CinemaNextUpItem>;

/** La vignette d'un film en cours — derrière la session, d'où `unoptimized` plus bas. */
function resumeThumbnail(item: CinemaResumeItem): string | null {
  return item.imageTag ? `/api/jellyfin/image?itemId=${item.id}&tag=${item.imageTag}` : null;
}

/** Ce qu'une carte de « Reprendre » affiche, film ou épisode. */
function continueCardFacts(entry: ResumeEntry) {
  if (entry.kind === "movie") {
    const item = entry.item;
    return {
      title: item.name,
      thumbnailUrl: resumeThumbnail(item),
      progress: item.progress,
      resumeTicks: item.positionTicks,
      runtimeTicks: item.runtimeTicks,
      seasonNumber: null,
      episodeNumber: null,
    };
  }
  const item = entry.item;
  return {
    title: item.title,
    thumbnailUrl: item.thumbnailUrl,
    progress: item.resumeTicks && item.runtimeTicks ? Math.min((item.resumeTicks / item.runtimeTicks) * 100, 99) : 0,
    resumeTicks: item.resumeTicks,
    runtimeTicks: item.runtimeTicks,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
  };
}

// memo'd, et ses rappels reçoivent l'entrée plutôt que d'être écrits en ligne par carte
// (08/10/2026) : c'était la seule rangée de l'accueil sans `memo`, et chaque survol, chaque tour
// de la bannière redessinaient toutes ses cartes et leur appui long — elle est pourtant la première.
const ContinueCard = memo(function ContinueCard({
  entry,
  rowKey,
  index,
  onOpen,
  onFocus,
  onMenu,
}: {
  entry: ResumeEntry;
  rowKey: string;
  index: number;
  /**
   * Ouvre la fiche du titre. Une reprise menait directement à la lecture : un clic, et le film
   * démarrait — sans moyen de regarder d'abord de quoi il s'agissait, ni de repartir du début.
   * La fiche porte les deux, et « Reprendre » y est la première ligne.
   */
  onOpen: (entry: ResumeEntry) => void;
  /**
   * Ce que la bannière doit montrer quand cette carte est désignée.
   *
   * Ces cartes n'y participaient pas : leur charge utile — la file de reprise de Jellyfin — ne
   * porte ni fond, ni genres, ni synopsis, donc il n'y avait rien à afficher. Mais le titre,
   * lui, est dans la bibliothèque déjà chargée : il suffit de l'y retrouver. Sans quoi la
   * bannière garde le titre précédent pendant qu'on parcourt la rangée, et annonce autre chose
   * que ce qu'on désigne.
   */
  onFocus: (entry: ResumeEntry) => void;
  /**
   * Le menu de la carte — « Retirer de Reprendre » —, au clic droit, à la touche menu du clavier
   * ou à l'appui long d'un doigt (tablette). Absent pour un épisode : « À suivre » ne se retire pas
   * d'une série sans la marquer vue.
   */
  onMenu?: (entry: ResumeEntry) => void;
}) {
  const t = useT();
  const menu = useLongPress(onMenu ? () => onMenu(entry) : undefined);
  const { title, thumbnailUrl, progress, resumeTicks, runtimeTicks, seasonNumber, episodeNumber } = continueCardFacts(entry);
  const focus = () => onFocus(entry);
  return (
    <button
      type="button"
      data-tv-card
      data-tv-row={rowKey}
      data-tv-col={index}
      {...menu}
      onClick={() => onOpen(entry)}
      onFocus={focus}
      onMouseEnter={focus}
      // Ni loupe ni sélection sous un doigt qui appuie longuement : c'est le geste du menu.
      className={`group relative ${CONTINUE_CARD_WIDTH} shrink-0 select-none overflow-visible rounded-lg text-left transition-transform duration-200 [-webkit-touch-callout:none] hover:z-10 hover:scale-105 focus-visible:z-10 focus-visible:scale-105 ${TV_NAV_RING}`}
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
          <ProgressFill percent={progress} />
        </div>
      </div>
      <p className="mt-1.5 truncate text-xs font-medium text-white">{title}</p>
      {/* text-xs, not an arbitrary text-[11px] — arbitrary-value Tailwind classes don't make it
          into this project's production CSS bundle (see CinemaClient's z-index note for the same
          pitfall hit before). */}
      <span className="mt-1 block w-fit max-w-full truncate rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-muted">
        {formatContinueCaption(t, resumeTicks, runtimeTicks, seasonNumber, episodeNumber)}
      </span>
    </button>
  );
});

// Loaded via next/dynamic({ssr:false}) from page.tsx — same escape hatch this codebase already
// uses for PlayerHostLazy/GlobalSearchLazy. This page is 100% client-fetched (SWR, no data
// during SSR) and was hitting an unrecoverable hydration mismatch (React #418) that left the
// whole content area blank with no error surfaced anywhere (not even a wrapping error boundary —
// hydration failures at the root hydrate() call happen outside a boundary's reach). Disabling SSR
// for this page sidesteps the whole class of problem: nothing to mismatch against since there's
// no server-rendered HTML for it at all.

/** La clé de « Voir tout » qui ouvre « Ma liste » plutôt qu'une grille complète. */
const SEE_ALL_LIST = "__ma-liste__";

// Hors du composant : stables, pour que la bannière ne relance rien à chaque rendu.
const movieHeroKey = (m: CinemaMovie) => `f${m.radarrId}`;
const seriesHeroKey = (s: CinemaSeries) => `s${s.sonarrId}`;
// De même pour les rangées mémoïsées et la grille complète : une flèche écrite en ligne est neuve à
// chaque rendu, et défaisait leur `memo` à chaque survol (08/10/2026).
const movieId = (m: CinemaMovie) => m.radarrId;
const seriesId = (s: CinemaSeries) => s.sonarrId;
const titleId = (item: CinemaMovie | CinemaSeries) => ("radarrId" in item ? item.radarrId : item.sonarrId);
const titlePoster = (item: CinemaMovie | CinemaSeries) => item.posterUrl;
/**
 * La sorte de la bannière, notée sans rendu inutile : la même valeur rend l'état précédent, et React
 * n'a rien à redessiner. Un objet neuf à chaque survol redessinait tout l'écran pour rien.
 */
const heroFocusAt =
  (tab: HeroFocus["tab"], kind: HeroFocus["kind"]) =>
  (previous: HeroFocus | null): HeroFocus =>
    previous?.tab === tab && previous.kind === kind ? previous : { tab, kind };
/**
 * The backdrop specifically (not the hero's own title/synopsis text, which still updates
 * instantly) is debounced before it's allowed to (re)trigger its crossfade — animating a fresh
 * <img> on every single focus event during fast arrow-key scrubbing across a row is exactly
 * what produced the backdrop "ghosting"/persisting-into-each-other bug (rapid, overlapping
 * restarts of the same opacity keyframe). Settling briefly before committing to a new backdrop
 * keeps the nice crossfade for a deliberate selection without resurrecting that. The key travels
 * WITH the src (not read from the live key at render time) — otherwise the <img>'s key would jump
 * ahead of its own (still-debouncing) src, remounting/restarting the crossfade before the new
 * backdrop was even the one committed, which is exactly the same bug again.
 *
 * Un composant à lui (08/10/2026) : l'attente vivait dans l'état de `CinemaClient`, si bien que
 * chaque survol et chaque tour de la bannière redessinaient tout l'écran une seconde fois, 150 ms
 * plus tard, pour une seule image. Et rien n'est écrit quand le titre retenu n'a pas changé.
 */
function DebouncedHeroBackdrop({ src, heroKey }: { src: string | null; heroKey: string | null }) {
  const [shown, setShown] = useState({ src, heroKey });
  useEffect(() => {
    // Never commit an empty hero: switching to a tab whose data is still loading momentarily has
    // nothing to show, and blanking the backdrop for it drops the whole screen to flat slate for
    // as long as the fetch takes. Holding the previous image until a real replacement exists
    // makes the switch read as a crossfade rather than a blackout.
    if (heroKey === null) return;
    const timer = setTimeout(
      () => setShown((previous) => (previous.heroKey === heroKey && previous.src === src ? previous : { src, heroKey })),
      150
    );
    return () => clearTimeout(timer);
  }, [src, heroKey]);
  return <HeroBackdrop src={shown.heroKey !== null ? shown.src : null} id={shown.heroKey} mask={BACKDROP_MASK} />;
}

/** Le focus vient-il du clavier ? Un navigateur qui ne connaît pas `:focus-visible` répond oui. */
function focusFromKeyboard(target: EventTarget): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** La même, sur l'onglet affiché à l'instant du geste — lu dans l'adresse. */
const heroFocusOn = (kind: HeroFocus["kind"]) => heroFocusAt(readCinemaRoute().tab, kind);
/** Ce que la bannière du bureau affiche d'un titre : son fond et son logo, décodés d'avance. */
const heroImagesOf = (item: { backdropUrl: string | null; logoUrl: string | null }) => [item.backdropUrl, item.logoUrl];
export function CinemaClient() {
  // Le calage sur une rangée ou une page entière, réglable par appareil (`guidedScroll.ts`).
  const guidedScroll = useGuidedScroll();
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

  // Paused while the detail overlay owns Up/Down/Escape for its own vertical menu (see the
  // hook's own doc comment) AND while the player is open. The player closes CinemaMovieDetail
  // the moment Lecture actually starts (see CinemaMovieDetail's own note), which flips
  // selectedItem back to null — without this second condition that alone was enough to
  // re-arm this hook's own global arrow-key listener underneath the player: pressing Right on a
  // player control it didn't recognize hit useTvGridNav's "nothing focused yet" branch, which
  // jumps straight to the first poster card in the (still fully mounted, just hidden) browse
  // grid — then Enter on THAT opened a completely different title's detail sheet.
  const playback = usePlayback();
  /**
   * La grille est-elle l'écran du dessus ? Une seule réponse pour tout ce qui en dépend ici — les
   * flèches, la carte centrée, « / », `inert`, la rotation des bannières, le focus rendu en
   * refermant. Voir `gridIsTop` pour les conditions qui divergeaient avant elle.
   */
  // Le menu d'un film de « Reprendre » — voir `onMenu` sur ContinueCard. Il compte dans « la
  // grille est-elle dessus ? » : ouvert, il la recouvre, et elle ne devait plus écouter les
  // flèches ni Entrée derrière lui (23/09/2026).
  const [resumeMenu, setResumeMenu] = useState<{ id: string; title: string; poster: string | null } | null>(null);
  const gridOnTop = gridIsTop(route, playback.mode) && resumeMenu === null;
  // "replace": the tab is a filter on the screen you're already on, not a screen of its own —
  // Back from a title should return to the grid, not undo a tab switch.
  /**
   * Changer d'onglet referme ce qui était ouvert — comme sur téléphone.
   *
   * Ici les fiches se choisissent par `route.film` et `route.serie` sans passer par l'onglet : une
   * valeur oubliée dans l'adresse rouvrait donc sa fiche quel que soit l'onglet affiché. Le défaut
   * existait avant le chantier du téléphone ; il se corrige au même endroit et pour la même
   * raison, et la même garantie s'applique — la fiche recouvre le sélecteur, donc on ne peut pas
   * changer d'onglet en ayant quelque chose à refermer.
   */
  const setMediaType = useCallback(
    (tab: "movies" | "series") => cinemaNavigate({ tab, film: null, serie: null }, "replace"),
    []
  );

  const { data: movies, error: moviesError, isLoading: moviesLoading, isValidating: moviesValidating } = useSWR<CinemaMoviesPayload>(
    MOVIES_CATALOGUE_KEY,
    cinemaFetcher
  );
  /**
   * Différé, sauf quand une série est visée — la même règle que sur téléphone.
   *
   * `openResume` ouvre ici une série sans changer d'onglet, et la fiche se choisit par
   * `route.serie` : sans son catalogue, l'appui ne trouvait rien et ne faisait rien. Il fallait
   * être passé par l'onglet Séries, qui le met en cache. Le défaut est antérieur au chantier du
   * téléphone — il attendait simplement que quelqu'un ouvre une série depuis l'autre onglet.
   */
  // Les films sont là : on peut préparer les séries sans rien retarder, et la clé ci-dessous
  // s'y abonne dès que c'est prêt — sans quoi le cache serait rempli pour personne.
  const seriesWarmed = useWarmSeriesCatalogue(movies !== undefined);
  const { data: series, error: seriesError, isLoading: seriesLoading, isValidating: seriesValidating } = useSWR<CinemaSeriesPayload>(
    mediaType === "series" || route.serie !== null || seriesWarmed ? SERIES_CATALOGUE_KEY : null,
    cinemaFetcher
  );
  // Les films sont là : on peut préparer les séries sans rien retarder. Voir le crochet.

  /** Le catalogue de l'onglet affiché est-il arrivé ? Voir la remise à zéro du volet.*/
  const catalogueReady = mediaType === "series" ? series !== undefined : movies !== undefined;

  const { data: resume, error: resumeError } = useSWR<{ items: CinemaResumeItem[] }>(RESUME_KEY, fetcher, liveFeedOptions);
  // "Ma liste": the watchlist entries that are actually in the library, so every card on that
  // rail is playable (see the hook).
  const myListMovies = useCinemaMyList("movie", movies);
  const myListSeries = useCinemaMyList("series", series);
  // Mémoïsé, comme toute la chaîne qui en part (Reprendre, la bannière des reprises, « À la une ») :
  // recalculée à chaque rendu, elle rendait des tableaux neufs à chaque survol et à chaque tour de la
  // bannière, et défaisait le `memo` des rangées qu'elle nourrit (08/10/2026).
  const resumeMovies = useMemo(() => (resume?.items ?? []).filter((r) => r.type === "Movie"), [resume]);

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
  // Une fiche demandée que le catalogue (relu au réseau) n'a pas : un message plutôt que rien.
  useMissingTitleNotice({
    film: route.film,
    serie: route.serie,
    movies: movies && !moviesValidating ? moviesById : null,
    series: series && !seriesValidating ? seriesById : null,
  });

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
  /**
   * « À suivre » ne dépend plus de l'onglet : sa rangée est commune aux deux (voir `continueRow`).
   */
  const { data: nextUp, error: nextUpError } = useSWR<CinemaNextUpPayload>(NEXT_UP_KEY, fetcher, liveFeedOptions);
  const continueSeries = useMemo(() => nextUp?.items ?? [], [nextUp]);
  // « Voir tout », une seule fonction stable pour toutes les rangées — voir `onSeeAll` dans CinemaRow.
  const openSeeAll = useCallback(
    (key: string) => cinemaNavigate(key === SEE_ALL_LIST ? { list: true } : { browse: key }),
    []
  );

  const hasContinue = resumeMovies.length > 0 || continueSeries.length > 0;

  // « Retirer de Reprendre » : le geste lui-même — voir `useRemoveFromResume`. Les voisines
  // glissent jusqu'à leur place quand une carte part. Le menu, lui, est déclaré plus haut.
  const removeFromResume = useRemoveFromResume();
  const continueTrack = useRef<HTMLDivElement>(null);
  // Avec les options du catalogue : à l'arrivée des données fraîches, le film fini sur la télé
  // quitte la rangée et celui qu'on reprend remonte en tête, en glissant — voir `CATALOGUE_FLIP`.
  // Le dernier lu d'abord, films et épisodes mêlés — la même fonction que le téléphone (DECISIONS § 33).
  // Un titre qui remonte glisse à sa place (`useFlipGrid`).
  const continueEntries = useMemo(() => continueOrder(resumeMovies, continueSeries), [resumeMovies, continueSeries]);
  useFlipGrid(continueTrack, continueEntries.map((entry) => entry.key), CATALOGUE_FLIP);
  // La place tenue tant que l'une des deux réponses n'est pas arrivée — voir `CinemaSkeletonCards`.
  const continuePending = !hasContinue && (isRowPending(resume, resumeError) || isRowPending(nextUp, nextUpError));
  const myListPending = useCinemaMyListPending();
  const homeLayout = useHomeLayout();

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

  /**
   * Et les synopsis de la bannière, pour les mêmes titres et dans le même ordre : la rotation
   * d'abord, puis ce qu'on atteint en quelques appuis. Le logo et le visuel arrivaient avec le
   * catalogue, le synopsis une seconde après ; demandé d'avance, il arrive avec eux (23/09/2026).
   * Voir `useHeroInfo`, qui le rend sans attendre quand il est déjà là.
   */
  useEffect(() => {
    if (!movies) return;
    return prefetchInChunks(
      warmUpUrls(movies.spotlight, movies.rows, (m) => m.radarrId, (m) => [m.tmdbId ? heroInfoKey("movie", m.tmdbId) : null]),
      preloadHeroInfo
    );
  }, [movies]);
  useEffect(() => {
    if (!series) return;
    return prefetchInChunks(
      warmUpUrls(series.spotlight, series.rows, (s) => s.sonarrId, (s) => [s.tmdbId ? heroInfoKey("series", s.tmdbId) : null]),
      preloadHeroInfo
    );
  }, [series]);

  /**
   * De quelle sorte est le titre que la bannière montre.
   *
   * Elle suivait l'onglet, ce qui suffisait tant qu'un onglet ne montrait que sa propre sorte.
   * « Reprendre » est désormais commun aux deux : sur l'onglet Films, survoler la carte d'une
   * série laissait la bannière sur le dernier film — elle annonçait autre chose que ce qu'on
   * désignait, c'est-à-dire exactement le défaut que le survol de ces cartes existe pour éviter.
   *
   * Rangé avec l'onglet où le choix a été fait, plutôt que remis à zéro par un effet : changer
   * d'onglet redonne ainsi sa sorte par défaut sans qu'un rendu supplémentaire ne l'efface, et
   * sans écrire d'état depuis un effet.
   */
  const [heroFocus, setHeroFocus] = useState<HeroFocus | null>(null);
  const [focusedItem, setFocusedItem] = useState<CinemaMovie | null>(null);
  /**
   * Le clavier est dans la bannière (« Lire », « Plus d'infos ») : elle ne tourne plus (08/10/2026).
   * Elle tournait sous le focus — on visait « Lire », et le minuteur changeait le titre juste avant
   * Entrée. Le clavier seulement (`:focus-visible`) : un clic de souris qui laisse le focus sur un
   * bouton n'a pas à figer la bannière jusqu'au clic suivant.
   */
  const [bannerEngaged, setBannerEngaged] = useState(false);

  // Les rangées de découverte, tout en bas : chargées comme le reste, mais elles ne bloquent
  // rien — la page est déjà utilisable sans elles, et TMDB est le seul appel de cet écran qui
  // sorte de la maison.
  const { data: discovery } = useSWR<PlayerDiscoverPayload>("/api/player/discover", fetcher, {
    revalidateOnFocus: false,
  });

  // Un titre de découverte mène à sa fiche quand on l'a, à la fiche TMDB sinon — où « Lire » est
  // devenu « Demander ». Un seul chemin, quel que soit le côté de la frontière.
  // Le focus d'une rangée de découverte rend la main au carrousel : voir CinemaDiscoveryRow.
  const clearFocus = useCallback(() => {
    setFocusedItem(null);
    setHeroFocus(heroFocusAt("movies", "movies"));
  }, []);

  // Voir `cinemaOpen` : cette décision était écrite ici *et* sur le téléphone, mot pour mot.
  const openDiscovery = useCallback((item: DiscoveryItem) => openDiscoveryItem(item), []);
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
  const movieSpotlightOfficial = useMemo(
    () => (movies?.spotlight?.length ? movies.spotlight : movies?.recentlyAdded ?? []).slice(0, 8),
    [movies]
  );
  // La disposition choisie par l'exploitant (DECISIONS.md §52) : la bannière peut montrer
  // Reprendre / À suivre, et « À la une » descend alors à la place de Reprendre. Même décision que
  // le téléphone, dans `homeLayout.ts`.
  const continuingTitles = useMemo(
    () => continueHeroTitles(continueEntries, (id) => moviesById.get(id), (id) => seriesById.get(id)),
    [continueEntries, moviesById, seriesById]
  );
  const continueHero = homeLayout.continueHero;
  const movieHero = useMemo(
    () => heroSource(continueHero, movieSpotlightOfficial, continuingTitles.movies, movieHeroKey),
    [continueHero, movieSpotlightOfficial, continuingTitles]
  );
  // « À la une » descendue sous la bannière des reprises — mémoïsée : neuve à chaque rendu, elle
  // redessinait sa rangée et ses cartes à chaque survol.
  const movieSpotlightRow = useMemo(
    () => spotlightRowItems([movies?.spotlight ?? [], movies?.recentlyAdded ?? []], movieHero.shown, movieHeroKey),
    [movies, movieHero]
  );
  const movieCarouselOfficial = movieHero.items;
  // Arrêtée aussi tant que la grille est recouverte. La bannière tournait sous les fiches et les
  // panneaux, invisible, et chaque tour redessinait tout cet écran — fiches ouvertes comprises,
  // dont la fenêtre du synopsis reprenait alors le focus toutes les huit secondes (voir
  // `CinemaDetailModal`).
  // Et elle suit le titre qu'elle montre quand les données fraîches remplacent celles du cache :
  // le film à l'écran y reste, une nouveauté vient au passage suivant, et l'ordre officiel revient
  // dès qu'elle quitte l'écran — voir `useHeroCarousel`, commun avec le téléphone.
  // Le hook ne reçoit que des valeurs primitives — voir `useHeroOrder`.
  const [movieOrderIndex, setMovieCarouselIndex, movieOrder] = useHeroOrder(
    heroSignature(movieCarouselOfficial.map(movieHeroKey)),
    // L'onglet caché garde sa place, en pause : revenir sur Films retrouve le titre qu'on y avait
    // laissé (08/10/2026) — voir `heroOffscreen`.
    focusedItem !== null || !gridOnTop || mediaType !== "movies" || bannerEngaged,
    heroOffscreen("movies", route, playback.mode),
    movieHero.continuing ? "continue" : "spotlight"
  );
  // Un titre à l'écran qui vient de sortir de la liste reste à l'écran : retrouvé dans le catalogue.
  const { items: movieCarousel, index: movieCarouselIndex } = resolveHeroCarousel(
    movieOrder,
    movieOrderIndex,
    movieCarouselOfficial,
    movieHeroKey,
    (key) => moviesById.get(Number(key.slice(1)))
  );
  useDecodeAhead(upcomingImages(movieCarousel, movieCarouselIndex, heroImagesOf));
  const heroItem = focusedItem ?? movieCarousel[movieCarouselIndex] ?? null;

  // Series' own parallel focus/selection state — kept entirely separate from the movie state
  // above (not touched) so each tab remembers its own position independently when you switch
  // back and forth, same as Netflix's own Movies/TV Shows toggle.
  const [seriesFocusedItem, setSeriesFocusedItem] = useState<CinemaSeries | null>(null);
  const clearSeriesFocus = useCallback(() => {
    setSeriesFocusedItem(null);
    setHeroFocus(heroFocusAt("series", "series"));
  }, []);
  const heroKind = heroKindFor(heroFocus, mediaType);
  const seriesSelectedItem = route.serie !== null ? seriesById.get(route.serie) ?? null : null;

  // Le même filet que sur téléphone : une adresse qui ne mène à aucune fiche s'efface. Le rail
  // étant permanent ici, le symptôme visible y est moindre — mais l'adresse est fausse des deux
  // côtés, et un correctif posé d'un seul est un demi-correctif.
  // Avant de conclure, il relit une fois le catalogue du titre demandé : un titre importé pendant
  // la séance n'est pas dans celui qu'on tient — voir le crochet.
  useRepairUnresolvedSheet(
    unresolvedSheetRequest(route.film, route.serie),
    selectedItem !== null || seriesSelectedItem !== null,
    // Celui du titre demandé, et lui seul : exiger les deux catalogues rendait ce filet inerte
    // tant que celui des séries n'était pas chargé, c'est-à-dire dans le cas le plus courant.
    route.film !== null ? moviesById.size > 0 : seriesById.size > 0,
    route.film !== null ? MOVIES_CATALOGUE_KEY : SERIES_CATALOGUE_KEY
  );
  const seriesSpotlightOfficial = useMemo(
    () => (series?.spotlight?.length ? series.spotlight : series?.recentlyAdded ?? []).slice(0, 8),
    [series]
  );
  const seriesHero = useMemo(
    () => heroSource(continueHero, seriesSpotlightOfficial, continuingTitles.series, seriesHeroKey),
    [continueHero, seriesSpotlightOfficial, continuingTitles]
  );
  const seriesSpotlightRow = useMemo(
    () => spotlightRowItems([series?.spotlight ?? [], series?.recentlyAdded ?? []], seriesHero.shown, seriesHeroKey),
    [series, seriesHero]
  );
  const seriesCarouselOfficial = seriesHero.items;
  const [seriesOrderIndex, setSeriesCarouselIndex, seriesOrder] = useHeroOrder(
    heroSignature(seriesCarouselOfficial.map(seriesHeroKey)),
    seriesFocusedItem !== null || !gridOnTop || mediaType !== "series" || bannerEngaged,
    heroOffscreen("series", route, playback.mode),
    seriesHero.continuing ? "continue" : "spotlight"
  );
  const { items: seriesCarousel, index: seriesCarouselIndex } = resolveHeroCarousel(
    seriesOrder,
    seriesOrderIndex,
    seriesCarouselOfficial,
    seriesHeroKey,
    (key) => seriesById.get(Number(key.slice(1)))
  );
  useDecodeAhead(upcomingImages(seriesCarousel, seriesCarouselIndex, heroImagesOf));
  const seriesHeroItem = seriesFocusedItem ?? seriesCarousel[seriesCarouselIndex] ?? null;
  /**
   * Le bouton de la bannière Reprendre / À suivre (DECISIONS.md §52) : la reprise du film montré,
   * ou l'épisode qui attend la série montrée, avec ce qui reste — les mêmes lectures que les cartes
   * de la rangée qu'elle remplace. Rien sur la bannière d'origine, qui n'est qu'un aperçu.
   */
  const heroTargets = useMemo(() => continueTargets(continueEntries), [continueEntries]);
  const heroResume = movieHero.continuing && heroItem ? heroTargets.movies.get(heroItem.radarrId) : undefined;
  const movieHeroAction = heroResume
    ? {
        ...heroContinueFacts(t, heroResume.positionTicks, heroResume.runtimeTicks),
        onPlay: () => playback.play({ itemId: heroResume.id, title: heroResume.name, resumeAt: feedResumeAt(heroResume.positionTicks, RESUME_KEY) }),
      }
    : null;
  const heroEpisode = seriesHero.continuing && seriesHeroItem ? heroTargets.series.get(seriesHeroItem.sonarrId) : undefined;
  const seriesHeroAction = heroEpisode
    ? {
        ...heroContinueFacts(t, heroEpisode.resumeTicks, heroEpisode.runtimeTicks, heroEpisode.seasonNumber, heroEpisode.episodeNumber),
        onPlay: () => playback.play({ itemId: heroEpisode.jellyfinItemId, title: heroEpisode.title, resumeAt: feedResumeAt(heroEpisode.resumeTicks, NEXT_UP_KEY) }),
      }
    : null;
  /**
   * Lire depuis la bannière des nouveautés (08/10/2026) : un film à la position dont le serveur se
   * souvient — lue dans Reprendre quand elle y est, sinon absente, ce qui laisse le serveur décider
   * (`resumeAt`, CLAUDE.md) ; une série, son prochain épisode (`usePlaySeriesNextEpisode`, comme
   * la bannière du téléphone).
   */
  const playSeries = usePlaySeriesNextEpisode(playback);
  const playMovieFromBanner = (item: CinemaMovie) => {
    const entry = (resume?.items ?? []).find((r) => r.id === item.jellyfinItemId);
    playback.play({ itemId: item.jellyfinItemId, title: item.title, resumeAt: resume === undefined ? undefined : feedResumeAt(entry?.positionTicks, RESUME_KEY) });
  };
  /**
   * « ‹ À la une » : l'aperçu d'une affiche cède la place aux nouveautés, en fondu (le titre se
   * remonte, l'image de fond se fond). Atteinte au clavier, la pastille laisse le focus sur « Lire »,
   * qui prend sa place.
   */
  // Les deux aperçus s'effacent : sur l'onglet Films, survoler un épisode de Reprendre prête la
  // bannière à une série — le retour va aux nouveautés de l'onglet affiché, quelle que soit la sorte.
  const backToSpotlight = () => {
    const fromKeyboard = document.activeElement?.getAttribute("data-tv-escape-up") === "hero";
    setFocusedItem(null);
    setSeriesFocusedItem(null);
    setHeroFocus({ tab: mediaType, kind: mediaType });
    if (fromKeyboard) requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-tv-escape-up="hero"]')?.focus());
  };

  /**
   * Désigner un titre, et dire du même geste ce que la bannière doit montrer.
   *
   * Tous les survols passent par ces deux-là : si un seul écrivait la sélection sans la sorte, la
   * bannière resterait bloquée sur la précédente. La sorte n'est notée que pour un titre réel —
   * une rangée qui efface la sélection ne doit pas faire basculer la bannière vers une sorte dont
   * le catalogue n'est peut-être pas encore arrivé, ce qui la laisserait vide.
   */
  /**
   * L'onglet est lu au moment du geste, dans l'adresse, et non pris dans la portée (08/10/2026) :
   * dépendre de `mediaType` changeait ces deux rappels à chaque bascule Films / Séries, et défaisait
   * le `memo` de toutes les rangées des deux onglets gardés — tout ce que `keptTabs` existe pour
   * laisser intact. `setFocus` rend l'état inchangé quand rien ne change, ce qui épargne un rendu
   * de tout l'écran à chaque survol d'une carte déjà désignée.
   */
  // Une affiche désignée remplace les commandes de la bannière par l'aperçu : retirées alors qu'elles
  // avaient le focus, elles ne reçoivent pas toujours de `blur`, et la bannière serait restée figée
  // au retour sur les nouveautés.
  const focusMovie = useCallback((item: CinemaMovie | null) => {
    setFocusedItem(item);
    if (item) {
      setHeroFocus(heroFocusOn("movies"));
      setBannerEngaged(false);
    }
  }, []);
  const focusSeries = useCallback((item: CinemaSeries | null) => {
    setSeriesFocusedItem(item);
    if (item) {
      setHeroFocus(heroFocusOn("series"));
      setBannerEngaged(false);
    }
  }, []);

  // Vrai dès le premier changement d'onglet, et pour de bon : voir le panneau des rangées.
  // Retenu pendant le rendu, comme ailleurs dans ce fichier, et non dans un effet.
  const [tabSwitched, setTabSwitched] = useState(false);
  const [seenMediaType, setSeenMediaType] = useState(mediaType);
  if (mediaType !== seenMediaType) {
    setSeenMediaType(mediaType);
    setTabSwitched(true);
  }
  // L'onglet quitté reste monté, caché et inerte : au retour, rien n'est reconstruit. Voir
  // `keptTabs.ts`. Le fondu du changement d'onglet ne joue que sur le volet affiché.
  const keptTabs = useKeptTabs(mediaType);
  const tabPane = (tab: "movies" | "series") =>
    tabPaneProps(tab, mediaType, tabSwitched ? "animate-fade-in rows-switched" : undefined);

  // Whichever tab is actually showing drives the shared background wash below — a plain union,
  // not a new abstraction, since all it needs is backdropUrl + a stable id to key the crossfade.
  const activeHeroItem = heroKind === "movies" ? heroItem : seriesHeroItem;
  // Le trait de la bannière se remplit quand son minuteur compte — les mêmes conditions que la
  // pause passée à `useHeroOrder` (l'aperçu d'une affiche n'a pas de trait).
  const movieBannerRunning = gridOnTop && mediaType === "movies" && !bannerEngaged;
  const seriesBannerRunning = gridOnTop && mediaType === "series" && !bannerEngaged;
  // La clé avec sa sorte (`f12`, `s12`) : le film 12 et la série 12 ne sont pas le même titre, et
  // une clé nue gardait l'image du premier en passant au second (08/10/2026).
  const activeHeroKey =
    heroKind === "movies" ? (heroItem ? movieHeroKey(heroItem) : null) : seriesHeroItem ? seriesHeroKey(seriesHeroItem) : null;

  // Whatever card was focused (mouse click also focuses a <button> natively) right before
  // CinemaMovieDetail opened — restored on close so arrow-nav resumes exactly where the user
  // left it instead of snapping back to the first card (useTvGridNav treats "nothing focused"
  // as "start over").
  const lastFocusedCard = useRef<HTMLElement | null>(null);
  const rowsPaneRef = useRef<HTMLDivElement>(null);
  const heroPaneRef = useRef<HTMLDivElement>(null);

  const router = useRouter();
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
  // affiches invisibles pendant qu'on lisait autre chose. La garde oubliait la grille complète et
  // les fiches TMDB — le même défaut, deux fois de plus. Voir `gridIsTop`.
  /** Une fiche TMDB ou une fiche personne est ouverte par-dessus celles de la bibliothèque. */
  const sheetAbove = route.discover !== null || route.person !== null;
  useTvGridNav(gridOnTop);

  /**
   * Au doigt, la carte arrêtée au centre prend la bannière — l'équivalent du survol.
   *
   * Même garde que la navigation aux flèches, et pour la même raison : ces deux-là posent le focus,
   * et rien ne doit le faire tant qu'un autre écran est au-dessus. La condition tactile en plus,
   * parce qu'une souris a déjà son propre chemin vers la bannière.
   */
  const touch = useIsTouch();
  useCentredCard(rowsPaneRef, touch && gridOnTop);
  // Les affiches des rangées décodées avant qu'on les atteigne — voir `useDecodeRowsAhead`. Le
  // panneau n'existe qu'une fois l'écran de chargement parti.
  useDecodeRowsAhead(rowsPaneRef, !nothingToShowYet(moviesLoading, movies));
  // Ma liste, la reprise et « À suivre » redemandés au retour et au changement d'onglet.
  useFreshPersonalLists(mediaType);

  // "/" opens the search from anywhere on the browse screen — the shortcut every media UI has,
  // and the reason the button itself can stay a small icon rather than a full-width field.
  useEffect(() => {
    // Même garde que les flèches : sous une fiche TMDB ou dans la grille complète, « / » ouvrait
    // la recherche *par-dessus*, et son retour ramenait à un écran qu'on n'avait pas quitté.
    if (!gridOnTop) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      e.preventDefault();
      setSearchOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gridOnTop, setSearchOpen]);

  // All four are useCallback'd for one specific reason: the row components below are memo'd, and
  // a fresh function identity on every render would defeat that entirely — the rows (and every
  // card in them, which on a large library is thousands of nodes) would re-render on every single
  // arrow keypress, since focus changes re-render this component by design.
  const rememberGridCard = useCallback(() => {
    // Seulement une carte de la grille — voir `gridCardInFocus`. Et rien plutôt qu'une ancienne :
    // Safari ne donne pas le focus à un bouton cliqué, et garder la carte d'un parcours au clavier
    // précédent ferait sauter la grille vers elle au retour.
    // Ou un bouton de la bannière (« Plus d'infos », le logo) : sans lui, fermer la fiche renvoyait
    // le focus sur la première carte de « Reprendre », qui faisait défiler les rangées et changeait
    // la bannière en aperçu d'un autre titre (08/10/2026). La rotation est arrêtée sous la fiche,
    // donc le bouton est encore là au retour.
    const active = document.activeElement;
    lastFocusedCard.current =
      gridCardInFocus(rowsPaneRef.current) ??
      (active instanceof HTMLElement && heroPaneRef.current?.contains(active) ? active : null);
  }, []);

  const openDetail = useCallback(
    (item: CinemaMovie) => {
      rememberGridCard();
      openTitle("movies", item.radarrId);
    },
    [rememberGridCard]
  );

  /**
   * Un titre similaire ou de la même saga, ouvert depuis une fiche.
   *
   * Pas `openDetail` : il n'y a aucune carte de la grille à retenir — le focus est dans la fiche —
   * et l'onglet ne doit pas bouger, sinon la fiche du dessous se démonte. Voir `openSimilarTitle`.
   */
  const openSimilarMovie = useCallback((item: CinemaMovie) => openSimilarTitle("movies", item.radarrId), []);
  const openSimilarSeries = useCallback((item: CinemaSeries) => openSimilarTitle("series", item.sonarrId), []);

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
  // Chaque onglet retrouve sa propre hauteur, et la première visite commence en haut — voir
  // `useTabScrollMemory`. Replacé une seconde fois quand le catalogue de l'onglet arrive :
  //
  // Le catalogue des séries est différé : en venant de « Films », l'onglet s'affiche vide, la
  // remise en place porte donc sur un volet qui ne contient rien, puis les rangées
  // apparaissent d'un coup sous un conteneur magnétique — et le navigateur, qui doit se
  // raccrocher à un point d'accroche après un changement de contenu, tombait sur le dernier :
  // on arrivait tout en bas de la page. Invisible en rechargeant *sur* l'onglet Séries, où le
  // catalogue est déjà là quand la remise en place a lieu — d'où un bug qui ne se voyait que
  // dans un sens.
  useTabScrollMemory(rowsPaneRef, mediaType, catalogueReady);

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
      // La carte d'où l'on part, retenue avant de partir : c'est ce qui rend le focus au bon
      // endroit en revenant, et c'est la seule chose que cet écran ajoute au geste commun.
      rememberGridCard();
      openResumeTarget(href, play);
    },
    [rememberGridCard]
  );

  // Les trois gestes d'une carte de « Reprendre », une fonction stable chacun pour toute la rangée —
  // voir `ContinueCard`.
  const play = playback.play;
  const focusContinue = useCallback(
    (entry: ResumeEntry) => {
      if (entry.kind === "movie") {
        const inLibrary = matchRadarr(entry.item.cinemaHref);
        if (inLibrary) focusMovie(inLibrary);
      } else {
        const inLibrary = entry.item.sonarrId ? seriesById.get(entry.item.sonarrId) : undefined;
        if (inLibrary) focusSeries(inLibrary);
      }
    },
    [matchRadarr, focusMovie, seriesById, focusSeries]
  );
  const openContinue = useCallback(
    (entry: ResumeEntry) => {
      if (entry.kind === "movie") {
        const item = entry.item;
        openResume(item.cinemaHref, () =>
          play({ itemId: item.id, title: item.name, resumeAt: feedResumeAt(item.positionTicks, RESUME_KEY) })
        );
      } else {
        const item = entry.item;
        openResume(item.sonarrId ? `/sonarr/${item.sonarrId}` : null, () =>
          play({ itemId: item.jellyfinItemId, title: item.title, resumeAt: feedResumeAt(item.resumeTicks, NEXT_UP_KEY) })
        );
      }
    },
    [openResume, play]
  );
  const openContinueMenu = useCallback((entry: ResumeEntry) => {
    if (entry.kind !== "movie") return;
    setResumeMenu({ id: entry.item.id, title: entry.item.name, poster: resumeThumbnail(entry.item) });
  }, []);

  /**
   * Le focus ne revient à la grille que si l'on y revient — et seulement *une fois* revenu.
   *
   * Fermer une fiche ouverte par-dessus une autre découvre la précédente, pas l'accueil : y
   * renvoyer le focus faisait défiler la grille *derrière* la fiche restée à l'écran, et le
   * mouvement se voyait à travers. Même chose pour une fiche ouverte depuis la recherche, « Ma
   * liste » ou la grille complète : c'est eux qu'on retrouve (voir `closeUncoversGrid`).
   *
   * Et la demande attend que la grille soit de nouveau l'écran du dessus, plutôt qu'une image :
   * refermer est une demande, pas un fait (`cinemaClose` passe par `history.back()`, l'adresse
   * change un tour plus tard), et tant qu'elle n'a pas changé la grille est `inert` — un
   * `focus()` y est ignoré sans bruit.
   */
  const restoreFocusOnReturn = useRef(false);
  /** Le retour vient du menu de « Reprendre » : la carte qui l'a ouvert a pu en être retirée. */
  const returnFromResumeMenu = useRef(false);
  // Le menu de « Reprendre » recouvre la grille comme une fiche : le focus y revient à sa fermeture.
  useEffect(() => {
    if (resumeMenu) {
      restoreFocusOnReturn.current = true;
      returnFromResumeMenu.current = true;
    }
  }, [resumeMenu]);
  useEffect(() => {
    if (!gridOnTop || !restoreFocusOnReturn.current) return;
    restoreFocusOnReturn.current = false;
    const fromMenu = returnFromResumeMenu.current;
    returnFromResumeMenu.current = false;
    const card = lastFocusedCard.current;
    if (card?.isConnected) card.focus();
    // La carte n'est plus là — retirée de « Reprendre » depuis son menu : le focus tombait sur la
    // page, et la flèche suivante repartait de la première carte de l'accueil. Il revient sur la
    // rangée. Seulement là : sans carte retenue (un clic sous Safari, qui ne donne pas le focus
    // au bouton cliqué), ce repli défilait jusqu'à « Reprendre » et changeait la bannière pour
    // un titre qu'on n'avait pas désigné (08/10/2026).
    else if (card?.hasAttribute("data-tv-card") || fromMenu) continueTrack.current?.querySelector<HTMLElement>("button")?.focus();
  }, [gridOnTop]);

  const closeDetail = useCallback(() => {
    restoreFocusOnReturn.current = closeUncoversGrid(readCinemaRoute(), sheetIsBehind());
    cinemaClose({ film: null, episodes: false });
  }, []);

  const openSeriesDetail = useCallback(
    (item: CinemaSeries) => {
      rememberGridCard();
      openTitle("series", item.sonarrId);
    },
    [rememberGridCard]
  );

  const closeSeriesDetail = useCallback(() => {
    // Voir `closeDetail` : la grille ne récupère le focus que si c'est elle qu'on découvre.
    restoreFocusOnReturn.current = closeUncoversGrid(readCinemaRoute(), sheetIsBehind());
    cinemaClose({ serie: null, episodes: false });
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
    // Sans condition sur l'onglet de l'entrée recouverte : un film ouvert depuis « Reprendre »
    // sur l'onglet Séries porte `tab=series`, et la fiche du dessous n'était alors jamais
    // redessinée — le retour la remontait de zéro. Le bureau résout par champ, pas par onglet.
    const under =
      behind && behind.film !== null && behind.film !== route.film
        ? moviesById.get(behind.film) ?? null
        : null;
    return under ? [under, selectedItem] : [selectedItem];
  }, [selectedItem, behind, moviesById, route.film]);
  const seriesStack = useMemo(() => {
    if (!seriesSelectedItem) return [];
    const under =
      behind && behind.serie !== null && behind.serie !== route.serie
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
  if (nothingToShowYet(moviesLoading, movies)) {
    // A skeleton in the shape of the real screen, not a centred spinner: the layout it resolves
    // into is already on screen, so the load reads as content filling in rather than a blank
    // screen swapping for a full one.
    return createPortal(
      <div className="fixed inset-0 flex animate-fade-in flex-col overflow-hidden bg-ink" style={{ ...zLayer, paddingLeft: "var(--player-rail, 0px)" }}>
        <div className="relative min-h-0 shrink grow-0" style={{ flexBasis: HERO_BASIS }}>
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

  // Tout l'écran seulement sans catalogue : une revalidation ratée, catalogue en main, garde
  // l'accueil et ses fiches sous une ligne d'erreur (voir `catalogueErrorView`).
  if (catalogueErrorView(moviesError, movies) === "plein") {
    return createPortal(
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-ink p-8 text-center" style={{ ...zLayer, paddingLeft: "var(--player-rail, 0px)" }}>
        <p className="max-w-sm text-sm text-danger">{errorMessage(moviesError, t, t("common.unknown"))}</p>
        {exitButton}
      </div>,
      document.body
    );
  }

  if (movies && movies.spotlight.length === 0) {
    return createPortal(
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-ink p-8 text-center" style={{ ...zLayer, paddingLeft: "var(--player-rail, 0px)" }}>
        <p className="max-w-sm text-sm text-muted">{t("cinema.empty")}</p>
        {exitButton}
      </div>,
      document.body
    );
  }

  /**
   * « Reprendre », une seule rangée, la même sur les deux onglets.
   *
   * Elle était scindée : les films sur l'onglet Films, les épisodes sur l'onglet Séries. Or
   * « Reprendre » ne décrit pas une catégorie du catalogue, mais l'endroit où l'on s'est arrêté —
   * et ce qu'on a laissé en cours hier soir n'est pas rangé par onglet dans la tête de personne.
   * Le film à moitié vu disparaissait donc derrière un onglet où l'on n'était pas. Le téléphone
   * les réunissait déjà ; c'est lui qui avait raison.
   *
   * Une seule définition, rendue par les deux branches, pour qu'elles ne puissent plus diverger.
   * Les indices se suivent d'une liste à l'autre : c'est une rangée, donc un seul parcours aux
   * flèches.
   */
  /**
   * La place de « Reprendre » pendant qu'elle arrive. Hors du parcours des flèches (pas de
   * `data-tv-rowroot`) : il n'y a encore rien à atteindre.
   */
  const continueSkeleton = continuePending && (
    <div className="mb-6 snap-start">
      <h2 className="mb-2 px-8 text-sm font-medium text-muted sm:px-12">{t("cinema.continueWatching")}</h2>
      <div className="flex gap-3 overflow-hidden px-8 pb-4 pt-3 sm:px-12">
        <CinemaSkeletonCards cardClassName={CONTINUE_CARD_WIDTH} shape="still" count={6} />
      </div>
    </div>
  );
  const myListSkeleton = myListPending && (
    <div className="mb-6 snap-start">
      <h2 className="mb-2 px-8 text-sm font-medium text-muted sm:px-12">{t("cinema.myList")}</h2>
      <div className="flex gap-3 overflow-hidden px-8 pb-4 pt-3 sm:px-12">
        <CinemaSkeletonCards cardClassName={CARD_WIDTH} shape="poster" count={10} />
      </div>
    </div>
  );

  // La rangée Reprendre / À suivre reste entière, même quand la bannière montre les reprises
  // (08/10/2026) : la bannière les présente une à une, par onglet ; la rangée les donne toutes d'un
  // coup, films et épisodes mêlés, le dernier lu d'abord — et c'est d'elle qu'on reprend vite.
  const rowEntries = continueEntries;
  const continueRow = rowEntries.length > 0 && (
    <div data-tv-rowroot className="mb-6 animate-fade-in-up snap-start" style={ROW_CONTAINMENT}>
      <h2 className="mb-2 px-8 text-sm font-medium text-muted sm:px-12">{t("cinema.continueWatching")}</h2>
      <div ref={continueTrack} className="scrollbar-thin flex scroll-smooth gap-3 overflow-x-auto overflow-y-hidden px-8 pb-4 pt-3 sm:px-12" style={EDGE_FADE}>
        {rowEntries.map((entry, i) => (
          <ContinueCard
            key={entry.key}
            entry={entry}
            rowKey="continue"
            index={i}
            // Un épisode n'a pas de menu : « À suivre » ne se retire pas sans marquer la série vue.
            onMenu={entry.kind === "movie" ? openContinueMenu : undefined}
            onFocus={focusContinue}
            onOpen={openContinue}
          />
        ))}
      </div>
    </div>
  );

  return createPortal(
    // `--player-rail` est posée par PlayerShell : la bande repliée du rail est réservée ici,
    // parce qu'un écran porté dans document.body n'hérite d'aucun padding de la coquille.
    <div className="fixed inset-0 animate-fade-in overflow-hidden bg-ink" style={{ ...zLayer, paddingLeft: "var(--player-rail, 0px)" }}>
      {/* La sortie et la loupe ont quitté les coins de l'écran : elles sont dans le rail, à
          gauche, avec le reste de la navigation. Deux boutons flottants de moins par-dessus les
          affiches, et un seul endroit où l'on va chercher où aller. */}

      <CinemaModeToggle mode={mediaType} onChange={setMediaType} />
      {/* « Tous les films / séries » en haut à droite, en rond comme sur téléphone (08/10/2026) ;
          l'aide du clavier se range à sa gauche. */}
      {homeLayout.browseButton && (
        <div className="fixed right-4 z-10" style={{ top: "max(1rem, env(safe-area-inset-top))" }}>
          <CinemaBrowseAllButton mediaType={mediaType} compact />
        </div>
      )}
      <CinemaShortcutsGuide besideButton={homeLayout.browseButton} />

      {/* La recherche est rendue par la coquille du lecteur (PlayerShell), pas ici : c'est le
          même moteur que la recherche globale, elle trouve aussi les personnes et les titres
          qu'on ne possède pas encore, et elle doit donc exister partout, pas seulement sur la
          grille. Ouverte, elle recouvre la grille et suspend tout ce qui en dépend ici — voir
          `gridIsTop`. */}

      {/* One continuous ambient background for the WHOLE screen, not scoped to the hero pane —
          a sharp copy of the focused item's backdrop (masked, fading out by ~72% of the full
          screen height) sits over a blurred+darkened duplicate that spans the full height, so
          wherever the sharp one has faded away the wash keeps going (blurred, dim) instead of
          hitting a hard edge right at the rows pane. Both panes below render on top of this with
          transparent backgrounds — the only thing they visually share is this backdrop, not any
          overlapping text/labels (an earlier -mt-16 overlap trick pulled row labels into literal
          collision with the hero's own synopsis/cast line). */}
      <div className="absolute inset-0 overflow-hidden">
        {/* Le visuel du titre retenu, en fondu enchaîné — voir `HeroBackdrop`. La bande-annonce
            de fond qui prenait le relais ici est désactivée sur grand écran, à la demande :
            retirée plutôt que mise en pause, ce qui garantit que l'API YouTube n'est jamais
            chargée ; il faudra refaire ce qui l'alimentait pour la rallumer. */}
        <DebouncedHeroBackdrop src={activeHeroItem?.backdropUrl ?? null} heroKey={activeHeroKey} />
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
      <div
        className="relative flex h-full flex-col"
        // Tout ce qui recouvre la grille la rend inerte : ni Tab, ni un clic égaré, ni un focus
        // programmé ne peuvent plus atteindre une affiche cachée. Pas sous le lecteur plein écran
        // — voir `gridIsTop` : la carte qui l'a lancé doit garder le focus pour le retour.
        inert={coversGrid(route)}
        /**
         * La molette agit partout, même sur l'aperçu du haut.
         *
         * L'écran a deux volets : l'aperçu, qui ne défile pas, et les rangées, qui défilent dans
         * leur propre zone. La molette ne faisait donc rien tant que la souris n'était pas
         * descendue dans la moitié basse — une zone morte qui occupe la moitié de l'écran, et
         * qu'on ne comprend pas quand on la rencontre.
         *
         * Renvoyé plutôt qu'imité : c'est le volet des rangées qui défile, avec son propre
         * alignement magnétique. Rien n'est recalculé ici, on lui passe la distance.
         *
         * Sans effet quand le geste vient déjà de l'intérieur des rangées — le navigateur y fait
         * son travail, et s'en mêler doublerait chaque cran. C'est aussi ce qui laisse les
         * rangées défiler horizontalement au trackpad : elles sont à l'intérieur.
         */
        onWheel={(event) => {
          const pane = rowsPaneRef.current;
          if (!pane || pane.contains(event.target as Node)) return;
          // Certaines souris comptent en lignes ou en pages plutôt qu'en pixels. Sans cette
          // conversion, un cran de molette déplaçait la vue de trois pixels.
          const step =
            event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pane.clientHeight : 1;
          pane.scrollBy({ top: event.deltaY * step, behavior: "auto" });
        }}
      >
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
        {/* La hauteur de la bannière : voir `HERO_BASIS`. */}
        <div
          key={mediaType}
          ref={heroPaneRef}
          className="relative min-h-0 shrink grow-0 animate-fade-in"
          style={{ flexBasis: HERO_BASIS }}
          // La bannière ne tourne plus sous le clavier — voir `bannerEngaged`.
          onFocusCapture={(e) => setBannerEngaged(focusFromKeyboard(e.target))}
          onBlurCapture={(e) => {
            if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setBannerEngaged(false);
          }}
        >
          {heroKind === "movies"
            ? heroItem && (
                <CinemaHero
                  item={heroItem}
                  onOpen={() => openDetail(heroItem)}
                  // La bannière des nouveautés porte ses commandes ; l'aperçu d'une affiche, la
                  // pastille qui y ramène (DECISIONS.md §52).
                  onBack={focusedItem !== null ? backToSpotlight : undefined}
                  banner={
                    focusedItem === null ? (
                      <HeroBannerControls
                        action={movieHeroAction}
                        onPlay={() => playMovieFromBanner(heroItem)}
                        onInfo={() => openDetail(heroItem)}
                        count={movieCarousel.length}
                        index={movieCarouselIndex}
                        running={movieBannerRunning}
                        // Le minuteur repart de zéro après chaque pause : le trait aussi, sinon il
                        // reprenait où il s'était arrêté et restait plein des secondes avant le tour.
                        runKey={`${movieCarouselIndex}:${movieBannerRunning}`}
                        onPick={setMovieCarouselIndex}
                      />
                    ) : undefined
                  }
                />
              )
            : seriesHeroItem && (
                <CinemaSeriesHero
                  item={seriesHeroItem}
                  onOpen={() => openSeriesDetail(seriesHeroItem)}
                  onBack={seriesFocusedItem !== null || mediaType !== "series" ? backToSpotlight : undefined}
                  banner={
                    seriesFocusedItem === null ? (
                      <HeroBannerControls
                        action={seriesHeroAction}
                        onPlay={() => void playSeries(seriesHeroItem)}
                        onInfo={() => openSeriesDetail(seriesHeroItem)}
                        count={seriesCarousel.length}
                        index={seriesCarouselIndex}
                        running={seriesBannerRunning}
                        runKey={`${seriesCarouselIndex}:${seriesBannerRunning}`}
                        onPick={setSeriesCarouselIndex}
                      />
                    ) : undefined
                  }
                />
              )}
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
          className={`scrollbar-thin relative min-h-80 flex-1 ${guidedScrollClass(guidedScroll)} scroll-smooth overflow-y-auto pb-16 pt-6`}
          // L'ancrage du défilement compense l'arrivée de contenu en déplaçant la vue : ici, ce
          // contenu arrive toujours *après* qu'on a décidé où l'on veut être. On le désactive.
          style={{ overflowAnchor: "none" }}
        >
          {/* Keyed by mediaType so switching Films/Séries crossfades the whole rows pane in
              instead of hard-cutting between them — only the ENTERING side needs an animation
              here (the old content just vanishes underneath it, same instant swap as before,
              but it reads fine masked by the new content fading in over it at this duration).
              Opacity-only, no transform — this wraps every row below, so a transform here would
              hit the exact same containing-block pitfall as everywhere else in Cinema Mode if any
              of them ever grew a position:fixed descendant (see globals.css's own note).
              Une animation à la fois (23/09/2026) : ce fondu et l'entrée échelonnée de chaque
              rangée jouaient ensemble, au premier affichage comme à chaque changement d'onglet —
              opacités multipliées, près d'une demi-seconde avant que l'écran se pose. Le premier
              affichage garde l'entrée des rangées, le changement d'onglet ce fondu seul
              (`rows-switched`, globals.css). */}
          {/* Un volet par onglet, gardé monté une fois visité : voir `tabPane`. */}
          {keptTabs.includes("movies") && (
            <div {...tabPane("movies")}>

              {/* L'ordre des rangées (08/10/2026, DECISIONS.md §52) : la bannière et sa rangée, « À la une »
                  quand la bannière montre les reprises, Reprendre / À suivre, Ma liste, le classement
                  du jour, les derniers ajouts, puis les genres. */}
              {movieHero.continuing && (
                <CinemaRow
                  label={t("cinema.spotlight")}
                  rowKey="spotlight-row-movies"
                  showNewBadge={false}
                  rowIndex={1}
                  // La sélection, complétée par les ajouts, sans ce que la bannière montre déjà.
                  items={movieSpotlightRow}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={focusMovie}
                  onSelectItem={openDetail}
                />
              )}

              {catalogueErrorView(moviesError, movies) === "ligne" && (
                <p className="px-8 text-sm text-danger sm:px-12">{errorMessage(moviesError, t, t("common.unknown"))}</p>
              )}

              {/* « Reprendre » n'existe qu'une fois, dans l'onglet affiché : c'est la même rangée
                  des deux côtés — films et épisodes mêlés, le dernier lu d'abord —, et sa piste porte
                  l'unique `continueTrack`. */}
              {mediaType === "movies" && continueSkeleton}
              {mediaType === "movies" && continueRow}

              {/* Deux titres au moins : à la deuxième place ; sinon sous les derniers ajouts —
                  `myListGoesLate`. */}
              {!myListGoesLate(myListMovies.length) && (
                <CinemaRow
                  label={t("cinema.myList")}
                  rowKey="mylist-movies"
                  rowIndex={RAIL_COUNT}
                  items={myListMovies}
                  cardWidthClassName={CARD_WIDTH}
                  onSeeAll={openSeeAll}
                  seeAllKey={SEE_ALL_LIST}
                  onFocusItem={focusMovie}
                  onSelectItem={openDetail}
                />
              )}

              {movies && (
                <CinemaTop10Row
                  label={top10Label(movies?.top10Theme ?? null, t)}
                  rowKey="top10-movies"
                  rowIndex={2}
                  items={movies.top10}
                  idOf={movieId}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={focusMovie}
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
                  // La grille complète, triée par date d'ajout — son ordre par défaut.
                  onSeeAll={openSeeAll}
                  seeAllKey={BROWSE_ALL}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={focusMovie}
                  onSelectItem={openDetail}
                />
              )}

              {/* Sa place pendant qu'elle arrive, en bas : une liste courte y descend, et le squelette
                  tenu en haut disparaissait en faisant remonter toutes les rangées (08/10/2026). */}
              {myListSkeleton}
              {myListGoesLate(myListMovies.length) && (
                <CinemaRow
                  label={t("cinema.myList")}
                  rowKey="mylist-movies"
                  rowIndex={RAIL_COUNT}
                  items={myListMovies}
                  cardWidthClassName={CARD_WIDTH}
                  onSeeAll={openSeeAll}
                  seeAllKey={SEE_ALL_LIST}
                  onFocusItem={focusMovie}
                  onSelectItem={openDetail}
                />
              )}

              {movies?.genres.map((genre, i) => (
                <CinemaRow
                  key={genre}
                  label={genreLabel(genre, t)}
                  rowKey={`genre-${genre}`}
                  rowIndex={i + RAIL_COUNT}
                  items={movies.rows[genre] ?? []}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={focusMovie}
                  onSelectItem={openDetail}
                  onSeeAll={openSeeAll}
                  seeAllKey={genre}
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
                  {t("player.browse.all.movies")}
                </button>
              </div>
            </div>
          )}
          {keptTabs.includes("series") && (
            <div {...tabPane("series")}>
              {/* Inline states, not a full-screen early return like movies' own loading/error/
                  empty branches above — those replace the WHOLE screen before the toggle even
                  exists yet (fine, since movies always load first); series loads lazily after
                  the toggle is already up, so its own states have to render inside the same
                  chrome instead of hiding the toggle that got you here. */}

              {/* Le même ordre que l'onglet Films — voir sa note. */}
              {seriesHero.continuing && (
                <CinemaSeriesRow
                  label={t("cinema.spotlight")}
                  rowKey="spotlight-row-series"
                  showNewBadge={false}
                  rowIndex={1}
                  items={seriesSpotlightRow}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={focusSeries}
                  onSelectItem={openSeriesDetail}
                />
              )}

              {nothingToShowYet(seriesLoading, series) && (
                <div className="flex justify-center pt-12">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                </div>
              )}
              {/* Une ligne dans les deux cas : le volet des séries vit dans l'écran des films. */}
              {catalogueErrorView(seriesError, series) !== null && (
                <p className="px-8 text-sm text-danger sm:px-12">{seriesError.message || t("common.unknown")}</p>
              )}
              {series && series.spotlight.length === 0 && (
                <p className="px-8 text-sm text-muted sm:px-12">{t("cinema.empty")}</p>
              )}

              {mediaType === "series" && continueSkeleton}
              {mediaType === "series" && continueRow}

              {/* Deux titres au moins : à la deuxième place ; sinon sous les derniers ajouts —
                  `myListGoesLate`. */}
              {!myListGoesLate(myListSeries.length) && (
                <CinemaSeriesRow
                  label={t("cinema.myList")}
                  rowKey="mylist-series"
                  rowIndex={RAIL_COUNT}
                  items={myListSeries}
                  cardWidthClassName={CARD_WIDTH}
                  onSeeAll={openSeeAll}
                  seeAllKey={SEE_ALL_LIST}
                  onFocusItem={focusSeries}
                  onSelectItem={openSeriesDetail}
                />
              )}

              {series && (
                <CinemaTop10Row
                  label={top10Label(series?.top10Theme ?? null, t)}
                  rowKey="top10-series"
                  rowIndex={2}
                  items={series.top10}
                  idOf={seriesId}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={focusSeries}
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
                  onSeeAll={openSeeAll}
                  seeAllKey={BROWSE_ALL}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={focusSeries}
                  onSelectItem={openSeriesDetail}
                />
              )}

              {/* Voir la note jumelle côté films. */}
              {myListSkeleton}
              {myListGoesLate(myListSeries.length) && (
                <CinemaSeriesRow
                  label={t("cinema.myList")}
                  rowKey="mylist-series"
                  rowIndex={RAIL_COUNT}
                  items={myListSeries}
                  cardWidthClassName={CARD_WIDTH}
                  onSeeAll={openSeeAll}
                  seeAllKey={SEE_ALL_LIST}
                  onFocusItem={focusSeries}
                  onSelectItem={openSeriesDetail}
                />
              )}

              {series?.genres.map((genre, i) => (
                <CinemaSeriesRow
                  key={genre}
                  label={genreLabel(genre, t)}
                  rowKey={`genre-${genre}`}
                  rowIndex={i + RAIL_COUNT}
                  items={series.rows[genre] ?? []}
                  cardWidthClassName={CARD_WIDTH}
                  onFocusItem={focusSeries}
                  onSelectItem={openSeriesDetail}
                  onSeeAll={openSeeAll}
                  seeAllKey={genre}
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
                  {t("player.browse.all.series")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Effacées tant qu'une fiche TMDB ou une fiche personne est ouverte par-dessus : elles
          partagent le même plan, et deux fiches montées ensemble écoutent Échap toutes les deux.
          L'adresse les garde, le retour les rouvre. */}
      {/* La grille complète, sur l'onglet courant. Elle vit au même niveau que les panneaux du
          rail : le retour ramène aux rangées, à l'endroit où on les avait laissées. */}
      {browseExit.render && lastBrowse !== null && catalogue.length > 0 && (
        <CinemaBrowseSheet
          // Une autre grille est un autre écran (règle 1 du cycle de vie des fiches) : sans clé,
          // rouvrir « Voir tout » sur un autre genre pendant la sortie de la précédente gardait
          // son filtre, son tri et sa décennie. Même clé sur le téléphone : `browseSheetKey`.
          key={browseSheetKey(mediaType, lastBrowse)}
          leaving={browseExit.leaving}
          genre={lastBrowse}
          mediaType={mediaType}
          items={catalogue}
          genres={(mediaType === "series" ? series?.genres : movies?.genres) ?? []}
          idOf={titleId}
          posterOf={titlePoster}
          libraryIdOf={titleId}
        />
      )}

      {movieStack.map((film, i) => {
          // Voir CinemaMobileClient : une fiche TMDB recouvre la pile sans la remplacer.
          const top = !sheetAbove && i === movieStack.length - 1;
          return (
            <CinemaMovieDetail
              key={film.radarrId}
              item={film}
              underneath={!top}
              onClose={top ? closeDetail : noop}
              onSelectSimilar={openSimilarMovie}
            />
          );
        })}
      {seriesStack.map((serie, i) => {
          const top = !sheetAbove && i === seriesStack.length - 1;
          return (
            <CinemaSeriesDetail
              key={serie.sonarrId}
              item={serie}
              underneath={!top}
              onClose={top ? closeSeriesDetail : noop}
              onSelectSimilar={openSimilarSeries}
            />
          );
        })}
      {/* Le menu d'un film de « Reprendre » — voir `onMenu` sur ContinueCard. */}
      <ActionSheet
        open={resumeMenu !== null}
        onClose={() => setResumeMenu(null)}
        title={resumeMenu?.title}
        poster={resumeMenu?.poster}
        actions={[
          {
            label: t("cinema.removeFromContinue"),
            icon: <X size={18} />,
            variant: "danger",
            onClick: () => {
              if (resumeMenu) void removeFromResume(resumeMenu.id);
            },
          },
        ]}
      />
    </div>,
    document.body
  );
}
