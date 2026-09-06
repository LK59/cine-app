"use client";

import useSWR from "swr";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, Menu, Play, Plus, Search } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useCinemaRoute, useRouteBehind, cinemaNavigate, cinemaClose, openLibraryTitle } from "@/lib/cinemaRoute";
import { uniqueById } from "@/lib/cinemaRails";
import { BROWSE_ALL } from "@/lib/cinemaBrowse";
import { useExitDelay } from "@/lib/useExitDelay";
import { CinemaBrowseSheet } from "@/components/cinema/CinemaBrowseSheet";
import { useIsShortViewport } from "@/lib/useIsMobile";
import { playSeriesNextEpisode } from "@/lib/playSeriesNextEpisode";
import { formatContinueLabel } from "@/lib/cinemaContinueLabel";
import { usePlayback } from "@/components/PlaybackProvider";
import { PosterImage } from "@/components/PosterImage";
import { CinemaNewBadge } from "@/components/cinema/CinemaNewBadge";
import { CinemaTop10Card } from "@/components/cinema/CinemaTop10Card";
import { useCinemaMyList } from "@/lib/useCinemaMyList";
import { useT } from "@/components/TranslationProvider";
import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import { CinemaMobileHero } from "@/components/cinema/mobile/CinemaMobileHero";
import type { CinemaMoviesPayload, CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeriesPayload, CinemaSeries } from "@/app/api/cinema/series/route";
import type { PlayerDiscoverPayload, DiscoveryItem } from "@/app/api/player/discover/route";
import type { CinemaNextUpPayload } from "@/app/api/cinema/next-up/route";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";

// Roughly a third of a phone's width, so a row always shows "two and a bit" posters — the visual
// cue that it scrolls, without a card so small the artwork stops being readable.
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

const POSTER_WIDTH = "w-28 sm:w-32";
const CONTINUE_WIDTH = "w-44 sm:w-48";
// A phone row is flicked through, not traversed — past a couple of dozen cards nobody is
// scrolling horizontally any further, and every extra card is DOM and decoded artwork the
// browser carries for the whole session.
const ROW_ITEM_LIMIT = 24;

/** La durée de l'animation de sortie de la grille — celle de `--animate-fade-out`. */
const BROWSE_EXIT_MS = 200;

// The phone counterpart to CinemaClient. Deliberately a separate component rather than responsive
// classes on that one: the desktop screen is a split-pane, keyboard-driven, hover-preview design
// (a hero that follows focus, arrow-key grid nav, a dwell-triggered trailer) — none of which has
// a meaning on touch. This is the Netflix-mobile shape instead: one scrolling column, a poster
// hero with its actions inline, and rows you flick through. Desktop is untouched.
/**
 * Les deux charges utiles n'identifient pas leurs éléments de la même façon ; chaque rangée a
 * simplement besoin d'*un* identifiant stable.
 *
 * Hors du composant : c'est une fonction pure, et la recréer à chaque rendu suffisait à défaire
 * la mémoïsation de toutes les rangées auxquelles elle est passée.
 */
function itemId(item: CinemaMovie | CinemaSeries): number {
  return "radarrId" in item ? item.radarrId : item.sonarrId;
}

export function CinemaMobileClient() {
  const t = useT();
  const playback = usePlayback();
  // Same URL-backed layers as the desktop client, which is what makes the phone's back-swipe
  // close a sheet instead of leaving Cinema Mode — see lib/cinemaRoute.
  const route = useCinemaRoute();
  const mediaType = route.tab;
  const setMediaType = (tab: "movies" | "series") => cinemaNavigate({ tab }, "replace");
  const searchOpen = route.search;
  const setSearchOpen = (open: boolean) =>
    open ? cinemaNavigate({ search: true }) : cinemaClose({ search: false });
  const short = useIsShortViewport();
  // Les mêmes rangées de découverte que sur grand écran, en bas de page — voir la route.
  const { data: discovery } = useSWR<PlayerDiscoverPayload>("/api/player/discover", fetcher, {
    revalidateOnFocus: false,
  });

  const openDiscovery = useCallback((item: DiscoveryItem) => {
    if (item.libraryId !== null) {
      openLibraryTitle(item.type, item.libraryId);
      return;
    }
    cinemaNavigate({ discover: item.tmdbId, discoverType: item.type });
  }, []);

  const { data: movies, error: moviesError, isLoading: moviesLoading } = useSWR<CinemaMoviesPayload>(
    "/api/cinema/movies",
    fetcher
  );
  // Series (and its Continue Watching feed) stay unfetched until the tab is actually opened —
  // same lazy contract as desktop, and more valuable here where the connection may be mobile data.
  const { data: series, isLoading: seriesLoading } = useSWR<CinemaSeriesPayload>(
    mediaType === "series" ? "/api/cinema/series" : null,
    fetcher
  );
  const { data: nextUp } = useSWR<CinemaNextUpPayload>(mediaType === "series" ? "/api/cinema/next-up" : null, fetcher);
  const { data: resume } = useSWR<{ items: CinemaResumeItem[] }>("/api/jellyfin/resume", fetcher);

  const resumeMovies = (resume?.items ?? []).filter((r) => r.type === "Movie");
  const continueSeries = nextUp?.items ?? [];
  const isSeries = mediaType === "series";
  const payload = isSeries ? series : movies;

  // The open sheet is read back out of the URL rather than held in state — that's what lets the
  // back-swipe close it. Nothing resolves until the payload is in, so a cold deep link simply
  // opens the sheet the moment the data lands.
  // L'index ne dépend que de la charge utile ; la recherche, elle, ne dépend que de l'adresse.
  //
  // Les deux étaient dans le même `useMemo`, donc ouvrir ou fermer un écran — n'importe lequel —
  // aplatissait un millier d'éléments et reconstruisait l'index à chaque fois. C'est exactement le
  // genre de travail qui se paie en à-coups sur un téléphone, pour un résultat identique.
  const byId = useMemo(() => {
    if (!payload) return null;
    const all = uniqueById(
      [...payload.spotlight, ...Object.values(payload.rows).flat()],
      (item: CinemaMovie | CinemaSeries) => ("radarrId" in item ? item.radarrId : item.sonarrId)
    );
    return new Map(all.map((item) => [itemId(item), item] as const));
  }, [payload]);

  /**
   * Toute la bibliothèque de l'onglet courant, une fois chacune.
   *
   * La charge utile répète un titre une fois par genre : l'index ci-dessus en tient déjà la
   * version dédoublonnée, il n'y a donc rien de plus à calculer que de le lire comme une liste.
   */
  const catalogue = useMemo(() => (byId ? [...byId.values()] : []), [byId]);

  const selected = useMemo(() => {
    const id = isSeries ? route.serie : route.film;
    if (id === null || !byId) return null;
    const item = byId.get(id);
    return item ? { item, mediaType } : null;
  }, [isSeries, route.serie, route.film, byId, mediaType]);

  /**
   * La fiche que celle du dessus recouvre.
   *
   * Sans elle, tirer une fiche ouverte depuis « Titres similaires » découvrait la grille : la
   * précédente n'apparaissait qu'une fois l'animation terminée, alors que tout le geste dit qu'on
   * remonte d'un cran. Elle est dessinée dessous, inerte, et ne coûte rien à charger — ses
   * données sont encore dans le cache de SWR, elle en revient.
   *
   * Elle n'est rendue que si son onglet est celui qu'on affiche : les deux écrans ont chacun leur
   * charge utile, et celle de l'autre onglet n'est pas forcément chargée.
   */
  /**
   * La grille sort comme elle est entrée.
   *
   * Elle s'ouvrait en glissant et disparaissait d'un coup : c'est l'adresse qui commande, et
   * l'adresse change avant le composant. `useExitDelay` la garde montée le temps de l'animation,
   * et `lastBrowse` retient le genre qu'elle montrait — sinon elle se viderait de son titre et de
   * ses affiches avant de s'en aller.
   */
  const browseExit = useExitDelay(route.browse !== null, BROWSE_EXIT_MS);
  const [lastBrowse, setLastBrowse] = useState<string | null>(route.browse);
  if (route.browse !== null && route.browse !== lastBrowse) setLastBrowse(route.browse);

  const noop = useCallback(() => {}, []);
  const closeSheet = useCallback(() => cinemaClose({ film: null, serie: null }), []);
  const behind = useRouteBehind();
  const behindSelected = useMemo(() => {
    if (!behind || !byId || !selected) return null;
    if (behind.tab !== mediaType) return null;
    const id = isSeries ? behind.serie : behind.film;
    if (id === null) return null;
    const item = byId.get(id);
    return item ? { item, mediaType } : null;
  }, [behind, byId, selected, isSeries, mediaType]);

  /** La pile, du dessous vers le dessus. Une seule fiche la plupart du temps. */
  const stack = useMemo(
    () => (selected ? (behindSelected ? [behindSelected, selected] : [selected]) : []),
    [selected, behindSelected]
  );
  // Same rail as desktop: watchlist ∩ library, so every card is playable (see the hook).
  const myListMovies = useCinemaMyList("movie", movies);
  const myListSeries = useCinemaMyList("series", series);
  // A rotating carousel of the latest arrivals rather than a single fixed pick — same idea and
  // same cadence as the dashboard's own hero, kept in this screen's own visual language (poster
  // key art, Lire / Plus d'infos). L'index et la rotation vivent dans CinemaMobileHero : ils ne
  // regardent que lui, et les y laisser faisait redessiner tout cet écran à chaque changement.
  // Une liste par onglet, et les deux bannières restent montées — voir plus bas.
  //
  // `useMemo` : sans lui, une nouvelle référence de tableau à chaque rendu de cet écran défaisait
  // la mémoïsation de la bannière, qu'on avait justement extraite pour qu'elle ne se redessine
  // pas au moindre battement.
  const heroMovies = useMemo(
    () => (movies?.recentlyAdded?.length ? movies.recentlyAdded : movies?.spotlight ?? []).slice(0, 8),
    [movies]
  );
  const heroSeries = useMemo(
    () => (series?.recentlyAdded?.length ? series.recentlyAdded : series?.spotlight ?? []).slice(0, 8),
    [series]
  );
  const myList = isSeries ? myListSeries : myListMovies;

  const openDetail = useCallback((item: CinemaMovie | CinemaSeries, type: "movies" | "series") => {
    cinemaNavigate(
      type === "series"
        ? { tab: "series", serie: (item as CinemaSeries).sonarrId, film: null }
        : { tab: "movies", film: (item as CinemaMovie).radarrId, serie: null }
    );
  }, []);

  /**
   * Une reprise ouvre la fiche, comme sur le bureau.
   *
   * Elle lançait la lecture au premier appui : pas moyen de regarder de quoi il s'agit, ni de
   * repartir du début. La fiche porte les deux, et « Reprendre » y est la première ligne.
   */
  const openResume = useCallback((href: string | null, play: () => void) => {
    const film = href?.match(/^\/radarr\/(\d+)$/);
    if (film) return cinemaNavigate({ tab: "movies", film: Number(film[1]), serie: null });
    const serie = href?.match(/^\/sonarr\/(\d+)$/);
    if (serie) return cinemaNavigate({ tab: "series", serie: Number(serie[1]), film: null });
    play();
  }, []);

  /**
   * La piste suit le doigt.
   *
   * Il n'y avait que les barres — atteignables, mais minuscules, et personne ne les vise sur un
   * téléphone. Et un balayage qui remplace l'affiche d'un coup, sans que rien ne bouge sous le
   * doigt, se sent comme un raccourci clavier, pas comme un carrousel.
   */
  /**
   * Deux fonctions stables, pour que la bannière reste mémoïsée.
   *
   * Une fonction recréée à chaque rendu du parent annulerait la mémoïsation : la bannière se
   * redessinerait à chaque battement de l'écran d'accueil, ce que l'extraction visait justement
   * à éviter.
   */
  const playHero = useCallback(
    (item: CinemaMovie | CinemaSeries) => {
      // Un identifiant de série ne se lit pas tel quel : il faut d'abord résoudre son prochain
      // épisode (voir playSeriesNextEpisode).
      if ("sonarrId" in item) playSeriesNextEpisode(playback, item);
      else playback.play({ itemId: item.jellyfinItemId, title: item.title });
    },
    [playback]
  );

  const openHero = useCallback(
    (item: CinemaMovie | CinemaSeries) => openDetail(item, "sonarrId" in item ? "series" : "movies"),
    [openDetail]
  );


  if (typeof document === "undefined") return null;

  const loading = moviesLoading || (isSeries && seriesLoading && !series);

  // app-viewport instead of inset-0's implicit height: in an installed PWA that resolves to the
  // real screen, where the viewport iOS lays the app out in at first is short — see the note in
  // globals.css.
  return createPortal(
    // `safe-x` : couché, l'encoche et la Dynamic Island mordent sur le bord gauche de l'écran
    // (`viewport-fit=cover` laisse le contenu passer dessous). Le menu et la première affiche de
    // chaque rangée s'y cachaient.
    <div className="app-viewport safe-x fixed inset-x-0 top-0 flex animate-fade-in flex-col overflow-hidden bg-ink" style={{ zIndex: 45 }}>
      {/* Sticky chrome: le menu à gauche, les deux onglets de bibliothèque en pastilles. */}
      {/* The safe-area inset alone puts this flush against the status bar, which iOS then dims
          and blurs over in a standalone PWA — the pills came out half-hidden. An explicit gap on
          top of the inset keeps them clear of it. No backdrop-blur either: a blurred layer that
          content scrolls under is one of the most reliable ways to make scrolling stutter on
          iOS, and a solid bar reads the same here. */}
      <header
        className={`flex shrink-0 items-center gap-3 bg-ink px-4 ${short ? "pb-2" : "pb-3"}`}
        // Couché, l'écran fait ~390 px de haut : la barre en prenait un sixième avant la
        // première affiche.
        style={{ paddingTop: `calc(env(safe-area-inset-top, 0px) + ${short ? "0.6rem" : "1.25rem"})` }}
      >
        {/* Le menu remplace la flèche de sortie : un seul bouton dans ce coin, qui mène à tout —
            l'accueil, la recherche, les listes, le compte, et la gestion tout en bas. La sortie
            n'a pas disparu, elle a juste cessé d'être la seule chose qu'on pouvait faire d'ici. */}
        <button
          type="button"
          onClick={() => cinemaNavigate({ menu: true })}
          aria-label={t("player.nav.label")}
          className="btn btn-ghost btn-icon h-9 w-9 shrink-0"
        >
          <Menu size={18} />
        </button>
        <div className="flex gap-2">
          {(["movies", "series"] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setMediaType(type)}
              className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                mediaType === type
                  ? "border-white bg-white text-ink font-medium"
                  : "border-white/25 text-white/80"
              }`}
            >
              {t(type === "movies" ? "cinema.moviesTab" : "cinema.seriesTab")}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label={t("cinema.search")}
          className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white active:scale-95"
        >
          <Search size={18} />
        </button>
      </header>

      {/* La recherche est rendue par la coquille du lecteur : c'est le moteur global, celui qui
          trouve aussi les personnes et les titres qu'on n'a pas encore. `searchOpen` reste lu
          ci-dessous pour mettre la bande-annonce en pause pendant qu'elle est ouverte. */}

      <div className="flex-1 overflow-y-auto overscroll-contain pb-12">
        {loading && (
          <div className="px-4 pt-2">
            <div className="skeleton aspect-2/3 w-full rounded-2xl" />
            <div className="skeleton mt-6 h-4 w-32 rounded" />
            <div className="mt-3 flex gap-3">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className={`skeleton ${POSTER_WIDTH} aspect-2/3 shrink-0 rounded-lg`} />
              ))}
            </div>
          </div>
        )}

        {moviesError && <p className="px-4 pt-6 text-sm text-red-400">{moviesError.message || t("common.unknown")}</p>}
        {!loading && payload && payload.spotlight.length === 0 && (
          <p className="px-4 pt-6 text-sm text-slate-400">{t("cinema.empty")}</p>
        )}

        {/* Hero: portrait key art with the title treatment and its two actions inline, the shape
            Netflix leads its own phone home screen with.

            Sideways, that shape doesn't fit: a full-width 2:3 poster is roughly twice the height
            of a landscape phone, so the art was cropped to a sliver and the title and buttons sat
            below the fold — the "broken banner". The same pieces laid out as a row (small poster,
            text and actions beside it) stay entirely on screen at any landscape height. The rows
            underneath are untouched in both orientations. */}
        {/* Deux bannières montées en permanence, celle de l'onglet inactif simplement cachée.
            Une seule instance partagée faisait défiler les films et les séries au même rythme, sur
            la même position ; une `key` par onglet les aurait séparées mais en repartant de zéro à
            chaque aller-retour. Montées toutes les deux, chacune garde son index — et le `paused`
            arrête son minuteur pendant qu'on regarde l'autre : le défilement reprend là où il en
            était.

            Ça ne coûte rien tant qu'on n'a pas ouvert l'onglet Séries : sa charge utile est
            différée, donc sa liste est vide et la bannière ne rend rien.

            `hidden` plutôt qu'un démontage : les affiches déjà chargées le restent, le retour est
            instantané, et rien n'est peint pendant ce temps. */}
        {([
          ["movies", heroMovies],
          ["series", heroSeries],
        ] as const).map(([tab, items]) => (
          <div key={tab} hidden={mediaType !== tab}>
            <CinemaMobileHero
              items={items}
              // En pause dès qu'un écran la recouvre — l'autre onglet, les panneaux du rail, une
              // fiche : laisser une bande-annonce tourner derrière consomme des données mobiles
              // pour une image que personne ne voit.
              paused={
                mediaType !== tab || selected !== null || searchOpen || route.list || route.account || route.menu
              }
              short={short}
              onPlay={playHero}
              onOpen={openHero}
            />
          </div>
        ))}

        {/* Continue watching — landscape stills with a progress bar and the same resume wording
            the desktop cards use. */}
        {!isSeries && resumeMovies.length > 0 && (
          <MobileRow label={t("cinema.continueWatching")}>
            {resumeMovies.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() =>
                  openResume(entry.cinemaHref, () =>
                    playback.play({
                      itemId: entry.id,
                      title: entry.name,
                      resumeAt: entry.positionTicks > 0 ? entry.positionTicks / 10_000_000 : undefined,
                    })
                  )
                }
                className={`${CONTINUE_WIDTH} shrink-0 text-left active:scale-95`}
              >
                <div className="relative overflow-hidden rounded-lg">
                  <PosterImage
                    src={entry.imageTag ? `/api/jellyfin/image?itemId=${entry.id}&tag=${entry.imageTag}` : null}
                    alt={entry.name}
                    aspectRatio="aspect-video"
                    unoptimized
                    subtle
                  />
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-xs">
                      <Play size={16} fill="currentColor" />
                    </span>
                  </span>
                  <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
                    <div className="h-full bg-accent-500" style={{ width: `${entry.progress}%` }} />
                  </div>
                </div>
                <p className="mt-1.5 truncate text-xs font-medium text-white/90">{entry.name}</p>
                <p className="truncate text-xs text-white/50">
                  {formatContinueLabel(t, entry.positionTicks, entry.runtimeTicks)}
                </p>
              </button>
            ))}
          </MobileRow>
        )}

        {isSeries && continueSeries.length > 0 && (
          <MobileRow label={t("cinema.continueWatching")}>
            {continueSeries.map((entry) => (
              <button
                key={entry.jellyfinItemId}
                type="button"
                // La rangée des séries était restée sur la lecture directe quand celle des films
                // est passée à la fiche : deux rangées voisines, deux gestes différents.
                onClick={() =>
                  openResume(entry.sonarrId ? `/sonarr/${entry.sonarrId}` : null, () =>
                    playback.play({
                      itemId: entry.jellyfinItemId,
                      title: entry.title,
                      resumeAt: entry.resumeTicks ? entry.resumeTicks / 10_000_000 : undefined,
                    })
                  )
                }
                className={`${CONTINUE_WIDTH} shrink-0 text-left active:scale-95`}
              >
                <div className="relative overflow-hidden rounded-lg">
                  <PosterImage src={entry.thumbnailUrl} alt={entry.title} aspectRatio="aspect-video" unoptimized subtle />
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-xs">
                      <Play size={16} fill="currentColor" />
                    </span>
                  </span>
                  {entry.resumeTicks && entry.runtimeTicks ? (
                    <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
                      <div
                        className="h-full bg-accent-500"
                        style={{ width: `${Math.min((entry.resumeTicks / entry.runtimeTicks) * 100, 99)}%` }}
                      />
                    </div>
                  ) : null}
                </div>
                <p className="mt-1.5 truncate text-xs font-medium text-white/90">{entry.title}</p>
                <p className="truncate text-xs text-white/50">
                  {formatContinueLabel(t, entry.resumeTicks, entry.runtimeTicks, entry.seasonNumber, entry.episodeNumber)}
                </p>
              </button>
            ))}
          </MobileRow>
        )}

        {/* The curated rails, ahead of the genre rows — same three as desktop, same definitions
            (see lib/cinemaRails). Each hides itself when it has nothing to show. */}
        {payload && payload.top10.length > 0 && (
          <MobileRow label={t("cinema.top10")}>
            {payload.top10.map((item, i) => (
              <CinemaTop10Card
                key={itemId(item)}
                rank={i + 1}
                title={item.title}
                posterUrl={item.posterUrl}
                addedAt={item.addedAt}
                widthClassName={POSTER_WIDTH}
                showNewBadge={false}
                numberFontSize="4.5rem"
                onSelectItem={() => openHero(item)}
              />
            ))}
          </MobileRow>
        )}

        <PosterRow label={t("cinema.recentlyAdded")} items={payload?.recentlyAdded ?? []} itemId={itemId} onSelect={openHero} showNewBadge={false} />
        <PosterRow label={t("cinema.myList")} items={myList} itemId={itemId} onSelect={openHero} />

        {(discovery?.rows ?? [])
          .filter((row) =>
            mediaType === "movies" ? row.key !== "trendingSeries" : row.key === "trendingSeries"
          )
          .map((row) => (
            <DiscoveryRow
              key={row.key}
              label={t(`cinema.discovery.${row.key}`)}
              items={row.items}
              missingLabel={t("player.notInLibrary")}
              onSelect={openDiscovery}
            />
          ))}

        {payload?.genres.map((genre) => {
          const all = payload.rows[genre] ?? [];
          const items = all.slice(0, ROW_ITEM_LIMIT);
          if (items.length === 0) return null;
          return (
            <PosterRow
              key={genre}
              label={genre}
              items={items}
              itemId={itemId}
              onSelect={openHero}
              // Seulement quand il y a plus à voir : un « voir tout » sur une rangée déjà entière
              // promet une suite qui n'existe pas.
              onSeeAll={all.length > items.length ? () => cinemaNavigate({ browse: genre }) : undefined}
            />
          );
        })}

        {/* Le bout de la page : toute la bibliothèque, filtrable. C'est la sortie de secours de
            quelqu'un qui a fait défiler jusqu'ici sans rien trouver. */}
        {payload && (
          <div className="mt-8 px-4 pb-4">
            <button
              type="button"
              onClick={() => cinemaNavigate({ browse: BROWSE_ALL })}
              className="btn btn-ghost w-full justify-center py-3"
            >
              {t(`player.browse.all.${mediaType}`)}
            </button>
          </div>
        )}
      </div>

      {/* La pile des fiches, rendue comme une liste et non comme deux blocs séparés.
          
          C'est la clé qui fait tout : une fiche gardée dans la liste garde son instance, donc son
          défilement, sa saison choisie, tout ce qu'elle tenait. Quand la fiche du dessus se ferme,
          la liste passe de [F1, F2] à [F1] — React reconnaît F1 par sa clé, ne le remonte pas, et
          se contente de lui rendre le dessus. On revenait sinon en haut de la page à chaque fois,
          alors que les titres similaires sont tout en bas.

          Une clé par titre reste indispensable : sans elle, ouvrir un titre similaire changerait
          les propriétés de la fiche courante plutôt que d'en ouvrir une — le contenu se
          remplacerait sur place, sans animation, en gardant l'état du geste de fermeture de la
          précédente. */}
      {browseExit.render && lastBrowse !== null && payload && (
        <CinemaBrowseSheet
          leaving={browseExit.leaving}
          genre={lastBrowse}
          mediaType={mediaType}
          items={catalogue}
          genres={payload.genres}
          idOf={itemId}
          posterOf={(item) => item.posterUrl}
          libraryIdOf={itemId}
        />
      )}

      {route.discover === null &&
        route.person === null &&
        stack.map((entry, i) => {
          const top = i === stack.length - 1;
          return (
            <CinemaMobileDetail
              key={itemId(entry.item)}
              item={entry.item}
              mediaType={entry.mediaType}
              underneath={!top}
              onClose={top ? closeSheet : noop}
              // Passée même dessous : la rangée « Titres similaires » n'est rendue que si elle
              // existe, et la retirer la démontait — on revenait sur une fiche intacte dont la
              // rangée, elle, se reconstruisait. La fiche du dessous est inerte, personne ne
              // peut la déclencher.
              onSelectSimilar={(next) => openDetail(next, entry.mediaType)}
            />
          );
        })}
    </div>,
    document.body
  );
}

// Full-bleed horizontal scroller: the label keeps the page's padding, the track itself runs to
// both edges so a row reads as continuing past the screen rather than stopping inside a gutter.
//
// content-visibility lets the browser skip layout and paint entirely for rows that are off
// screen — with a dozen-plus rows of artwork that's the difference between scrolling the whole
// document and scrolling the two rows you can actually see. contain-intrinsic-size gives it a
// placeholder height so the scrollbar doesn't jump around as rows render; `auto` there means it
// remembers each row's real height once measured.
const ROW_CONTAINMENT = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 210px",
} as React.CSSProperties;

// One rail of posters — the shape every mobile row except Continue Watching and Top 10 uses.
// Generic over the item type so the movie and series tabs share it; returns nothing when empty,
// which is what lets the curated rails be dropped in unconditionally above.
/**
 * Mémoïsées, et c'est ce qui rend la navigation fluide.
 *
 * Cet écran s'abonne à l'adresse : ouvrir un panneau, en fermer un, ouvrir une fiche le redessine
 * entièrement. Sans mémoïsation, chaque passage d'un écran à l'autre reparcourait toutes les
 * rangées et toutes leurs affiches — d'où les à-coups. Leurs entrées sont maintenant stables
 * (`items` vient de la charge utile SWR, `itemId` est hors composant, les rappels sont
 * `useCallback`), donc React saute simplement le sous-arbre.
 */
function PosterRowInner<T extends { title: string; posterUrl: string | null; addedAt: string | null }>({
  label,
  items,
  itemId,
  onSelect,
  onSeeAll,
  showNewBadge = true,
}: {
  label: string;
  items: T[];
  itemId: (item: T) => number;
  onSelect: (item: T) => void;
  /** Ouvre la grille complète de cette rangée. Absent sur les rangées qui sont déjà complètes. */
  onSeeAll?: () => void;
  showNewBadge?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <MobileRow label={label} onSeeAll={onSeeAll}>
      {items.map((item) => (
        <button
          key={itemId(item)}
          type="button"
          onClick={() => onSelect(item)}
          className={`${POSTER_WIDTH} relative shrink-0 overflow-hidden rounded-lg transition-transform active:scale-95`}
        >
          <PosterImage src={item.posterUrl} alt={item.title} subtle unoptimized sizes="(max-width: 640px) 112px, 128px" />
          {showNewBadge && <CinemaNewBadge addedAt={item.addedAt} />}
        </button>
      ))}
    </MobileRow>
  );
}

// `memo` perd la généricité de la fonction ; le cast la rend aux appelants sans rien changer à
// l'exécution.
const PosterRow = memo(PosterRowInner) as typeof PosterRowInner;

/**
 * Une rangée de découverte : les mêmes affiches, avec une pastille sur ce qu'on n'a pas encore.
 * Ce qui est là ouvre sa fiche, le reste ouvre la fiche TMDB, où « Lire » est devenu
 * « Demander » — un seul catalogue, une seule grammaire.
 */
const DiscoveryRow = memo(function DiscoveryRow({
  label,
  items,
  missingLabel,
  onSelect,
}: {
  label: string;
  items: DiscoveryItem[];
  missingLabel: string;
  onSelect: (item: DiscoveryItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <MobileRow label={label}>
      {items.map((item) => (
        <button
          key={`${item.type}-${item.tmdbId}`}
          type="button"
          onClick={() => onSelect(item)}
          className={`${POSTER_WIDTH} relative shrink-0 overflow-hidden rounded-lg transition-transform active:scale-95`}
        >
          <PosterImage src={item.poster} alt={item.title} subtle unoptimized sizes="(max-width: 640px) 112px, 128px" />
          {item.libraryId === null && (
            <span
              aria-label={missingLabel}
              className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white/80"
            >
              <Plus size={12} />
            </span>
          )}
        </button>
      ))}
    </MobileRow>
  );
});

function MobileRow({
  label,
  onSeeAll,
  children,
}: {
  label: string;
  onSeeAll?: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    // `mt-6` debout, `mt-4` couché : sur ~390 px de haut, six rems entre chaque rangée font qu'on
    // ne voit jamais deux rangées à la fois.
    <section className="mt-6 [@media(max-height:500px)]:mt-4" style={ROW_CONTAINMENT}>
      {/* « Voir tout » posé à côté du titre plutôt qu'au bout du défilement : une rangée s'arrête
          à vingt-quatre affiches, et il fallait faire glisser vingt-quatre fois pour découvrir
          qu'il y avait une suite. Ici il se voit avant qu'on commence. */}
      <div className="mb-2 flex items-baseline justify-between gap-3 px-4 [@media(max-height:500px)]:mb-1.5">
        <h2 className="min-w-0 truncate text-sm font-semibold text-white">{label}</h2>
        {onSeeAll && (
          <button
            type="button"
            onClick={onSeeAll}
            className="shrink-0 text-xs font-medium text-slate-400 transition-colors active:text-white"
          >
            {t("player.browse.seeAll")}
          </button>
        )}
      </div>
      <div className="scrollbar-thin flex gap-3 overflow-x-auto overflow-y-hidden px-4 pb-1">{children}</div>
    </section>
  );
}
