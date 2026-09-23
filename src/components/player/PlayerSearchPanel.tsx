"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { Search as SearchIcon, X } from "lucide-react";
import { MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY } from "@/lib/swr";
import { useSearchResults } from "@/lib/useSearchResults";
import { cinemaFetcher } from "@/lib/cinemaPayload";
import { cinemaNavigate, openLibraryTitle } from "@/lib/cinemaRoute";
import { useLocale, useT } from "@/components/TranslationProvider";
import { recentSearches, rememberSearch, forgetSearches } from "@/lib/recentSearches";
import { onSearchFocusRequest } from "@/lib/searchFocus";
import { searchCinemaLibrary } from "@/lib/cinemaSearch";
import { uniqueById } from "@/lib/cinemaRails";
import type { CinemaMoviesPayload } from "@/app/api/cinema/movies/route";
import type { CinemaSeriesPayload } from "@/app/api/cinema/series/route";
import { PlayerPanelFrame } from "./PlayerPanelFrame";
import { PlayerResultCard } from "./PlayerResultCard";
import type { PersonResult } from "@/app/api/search/route";

type Filter = "all" | "movie" | "series" | "person";

/**
 * Un résultat, d'où qu'il vienne.
 *
 * Les deux moteurs ne rendent pas la même chose — l'un des entrées de catalogue, l'autre des
 * fiches TMDB — mais la grille, elle, n'affiche qu'une sorte de carte. Une seule forme ici, et le
 * reste de l'écran ignore lequel des deux a trouvé quoi.
 */
interface Entry {
  key: string;
  kind: "movie" | "series";
  title: string;
  year: number | null;
  poster: string | null;
  /** L'identifiant Radarr/Sonarr quand on l'a — c'est lui qui ouvre une fiche jouable. */
  libraryId: number | null;
  tmdbId: number | null;
}

const MIN_QUERY = 2;

/**
 * Combien de titres la bibliothèque peut mettre devant.
 *
 * Deux lettres suffisent à en faire correspondre beaucoup, et une grille de quarante affiches
 * n'aide personne : passé la vingtaine, ce n'est plus une prédiction mais une liste. Ce qui reste
 * vient du serveur, derrière.
 */
const MAX_LOCAL = 24;
/**
 * L'attente avant d'interroger le serveur.
 *
 * Deux cent soixante millisecondes s'ajoutaient aux cent cinquante que met la recherche à
 * répondre, et l'ensemble se sentait. Mesuré sur le serveur : `/api/search` rend en 140 à 280 ms,
 * cache compris — l'attente n'a donc pas à protéger grand-chose, et cent cinquante suffisent à ne
 * pas envoyer une requête par lettre.
 */
const DEBOUNCE_MS = 150;

/**
 * Le temps d'arrêt au bout duquel une recherche est retenue.
 *
 * Deux secondes, et non les cent cinquante millisecondes de l'affichage : on ne retient pas une
 * frappe, on retient une intention. Une recherche menée jusqu'à l'ouverture d'un résultat est
 * retenue tout de suite, sans attendre — voir `openTitle`.
 */
const REMEMBER_MS = 2000;

/**
 * Ce qu'on avait tapé la dernière fois, retenu pour la durée de la visite.
 *
 * Ouvrir un titre trouvé par la recherche garde le panneau monté dessous, donc la requête y
 * survit déjà — mais pas si l'on repasse par l'accueil entre-temps, et pas si le panneau se
 * remonte pour une raison ou une autre. Hors du composant, elle survit à tout, et retrouver sa
 * recherche en revenant dessus est ce qu'on attend d'une recherche.
 *
 * Volontairement en mémoire et non dans l'adresse : la requête change à chaque frappe, et
 * l'écrire dans l'historique remplirait le bouton retour de lettres.
 */
let lastQuery = "";

/** Oublie la recherche mémorisée. N'existe que pour repartir d'une page blanche dans les tests. */
export function forgetSearchQuery() {
  lastQuery = "";
}

/**
 * La recherche du lecteur.
 *
 * Elle interroge exactement le même moteur que la recherche de la gestion — `/api/search`, avec
 * sa lecture du langage naturel (« les films de Nolan », « série policière »), sa tolérance aux
 * fautes et sa reconnaissance des noms de personnes. Ce qui change tient en deux points, et ce
 * sont ceux qui font l'interface end-user :
 *
 * 1. **Une seule grille.** Pas de section « bibliothèque » puis de section « TMDB » : on cherche
 *    un titre, pas un emplacement. Ce qui n'est pas là porte une pastille et s'ouvre sur une
 *    fiche où « Lire » est devenu « Demander ».
 * 2. **Aucun nom d'outil.** Ni Radarr, ni Sonarr, ni TMDB nulle part — « Film », « Série »,
 *    « Personne », et c'est tout ce qu'il y a à savoir.
 *
 * Les filtres n'apparaissent qu'une fois qu'il y a des résultats : choisir un type *avant*
 * d'avoir cherché oblige à savoir ce qu'on cherche, et la moitié du temps on ne sait pas si le
 * titre qu'on a en tête est un film ou une série.
 */
export function PlayerSearchPanel({ leaving, replaced, fromTab }: { leaving?: boolean; replaced?: boolean; fromTab?: boolean }) {
  const t = useT();
  const [query, setQuery] = useState(lastQuery);
  const [debounced, setDebounced] = useState(lastQuery.length >= MIN_QUERY ? lastQuery : "");
  const [requested, setFilter] = useState<Filter>("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  /**
   * Passer du champ aux résultats sans toucher la souris.
   *
   * Les flèches parcourent déjà la grille (`usePanelArrowNav`), mais elles se taisent tant qu'on
   * écrit — et c'est la bonne règle, sans quoi elles voleraient le curseur du champ. Restait donc
   * un pas manquant, exactement là où il compte : on ne pouvait *entrer* dans les résultats qu'à
   * la tabulation, case par case, en passant d'abord par les filtres.
   *
   * La première carte, et seulement elle : les filtres sont eux aussi marqués `data-nav-item`,
   * mais ils précèdent la grille dans le document. On cherche donc à l'intérieur de la grille.
   */
  function enterResults(): boolean {
    const first = gridRef.current?.querySelector<HTMLElement>("[data-nav-item]");
    if (!first) return false;
    first.focus();
    return true;
  }

  /**
   * Le clavier n'arrive que si on le demande.
   *
   * Ce panneau prenait le focus à son montage, donc toucher l'onglet ouvrait le clavier — et
   * parcourir les quatre onglets au pouce le faisait surgir puis disparaître au passage. La
   * recherche s'ouvre maintenant comme n'importe quel écran : on y voit ses dernières requêtes,
   * et rien ne se lève tant qu'on n'a pas visé le champ ou réappuyé sur l'onglet.
   *
   * Le curseur va à la fin de ce qui est déjà là, pas devant : on revient pour continuer, ou pour
   * effacer d'un geste, jamais pour taper au milieu.
   */
  useEffect(
    () =>
      onSearchFocusRequest(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }),
    []
  );

  useEffect(() => {
    const term = query.trim();
    lastQuery = term;
    const timer = setTimeout(() => setDebounced(term.length >= MIN_QUERY ? term : ""), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  /**
   * Retenir une recherche est un geste bien plus lent que la chercher.
   *
   * Cent cinquante millisecondes, c'est le bon délai pour *afficher* des résultats — c'est ce qui
   * rend la frappe vivante. C'était le mauvais pour *retenir* : quiconque hésite une seconde au
   * milieu d'un nom laissait une ligne pour chaque hésitation. Trois pour « Ryan gosling ».
   *
   * D'où un second minuteur, bien plus long : une vraie pause, pas un souffle entre deux lettres.
   * `rememberSearch` se charge du reste — une frappe en cours ne laisse plus qu'une seule ligne,
   * la plus complète.
   */
  useEffect(() => {
    const term = query.trim();
    if (term.length < MIN_QUERY) return;
    const timer = setTimeout(() => rememberSearch(term), REMEMBER_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Une erreur efface les résultats d'une frappe précédente au lieu de les laisser passer pour
  // ceux de celle-ci — voir `useSearchResults`.
  const { data, isLoading, failed } = useSearchResults(
    debounced ? `/api/search?q=${encodeURIComponent(debounced)}` : null
  );

  /**
   * La bibliothèque, cherchée sur place — et c'est elle qui devine.
   *
   * `/api/search` interroge TMDB, dont le moteur veut un titre à peu près entier : « hann » lui
   * rend les deux obscurités qui s'appellent littéralement « Hann », et pas Hannibal, qu'on
   * possède pourtant. Une demi-frappe n'est pas une faute de frappe, c'est un début de mot, et
   * aucune tolérance à l'orthographe ne remplace un préfixe.
   *
   * Or la réponse est déjà là : le catalogue est en mémoire — l'accueil l'a chargé, et le
   * réchauffage a fait le reste pour les séries. `searchCinemaLibrary` est le moteur que la
   * recherche du mode cinéma utilise déjà, préfixe compris (`titleMatchScore` donne 90 à un titre
   * qui commence par ce qu'on tape), avec le même langage naturel et la même tolérance aux fautes.
   * Il tournait sur un seul des deux écrans de recherche ; c'est exactement la divergence que
   * CLAUDE.md décrit, et le remède est de partager la fonction, pas de réécrire la règle.
   *
   * Zéro réseau, zéro attente : ces résultats-là s'affichent à la lettre tapée, pendant que le
   * serveur cherche ce qu'on ne possède pas. Et ils passent devant, ce qui est doublement juste —
   * ils sont plus pertinents, et on peut les lancer tout de suite.
   */
  const { locale } = useLocale();
  const { data: moviesPayload } = useSWR<CinemaMoviesPayload>(MOVIES_CATALOGUE_KEY, cinemaFetcher);
  const { data: seriesPayload } = useSWR<CinemaSeriesPayload>(SERIES_CATALOGUE_KEY, cinemaFetcher);
  const allMovies = useMemo(
    () => uniqueById([...(moviesPayload?.spotlight ?? []), ...Object.values(moviesPayload?.rows ?? {}).flat()], (m) => m.radarrId),
    [moviesPayload]
  );
  const allSeries = useMemo(
    () => uniqueById([...(seriesPayload?.spotlight ?? []), ...Object.values(seriesPayload?.rows ?? {}).flat()], (s) => s.sonarrId),
    [seriesPayload]
  );

  // Ce qui est tapé à l'instant, et non ce que le serveur a eu le temps d'apprendre : la
  // bibliothèque répond sans attendre les cent cinquante millisecondes de l'autre moteur.
  const typed = query.trim();
  const searching = typed.length >= MIN_QUERY;

  const local: Entry[] = useMemo(() => {
    if (!searching) return [];
    return searchCinemaLibrary(typed, allMovies, allSeries, locale)
      .slice(0, MAX_LOCAL)
      .map((r) =>
        r.kind === "movie"
          ? { key: `movie-${r.item.radarrId}`, kind: "movie" as const, title: r.item.title, year: r.item.year, poster: r.item.posterUrl, libraryId: r.item.radarrId, tmdbId: r.item.tmdbId }
          : { key: `series-${r.item.sonarrId}`, kind: "series" as const, title: r.item.title, year: r.item.year, poster: r.item.posterUrl, libraryId: r.item.sonarrId, tmdbId: r.item.tmdbId }
      );
  }, [searching, typed, allMovies, allSeries, locale]);

  /**
   * Les deux moteurs mis bout à bout, sans jamais montrer deux fois le même titre.
   *
   * Le serveur ignore ce que la bibliothèque vient de trouver : un titre possédé ressortira des
   * deux côtés. On le reconnaît à son identifiant TMDB ou à celui de Radarr/Sonarr — le premier
   * suffit presque toujours, le second rattrape les séries que Sonarr connaît sans TMDB.
   */
  const titles: Entry[] = useMemo(() => {
    const server = [...(data?.library ?? []), ...(data?.tmdb ?? [])];
    const seen = new Set<string>();
    for (const e of local) {
      if (e.tmdbId !== null) seen.add(`${e.kind}:tmdb:${e.tmdbId}`);
      seen.add(`${e.kind}:lib:${e.libraryId}`);
    }
    const extra: Entry[] = [];
    for (const r of server) {
      const libraryId = r.type === "movie" ? r.radarrId : r.sonarrId;
      if (seen.has(`${r.type}:tmdb:${r.tmdbId}`)) continue;
      if (libraryId !== null && seen.has(`${r.type}:lib:${libraryId}`)) continue;
      extra.push({
        key: `${r.type}-${r.tmdbId}`,
        kind: r.type,
        title: r.title,
        year: r.year,
        poster: r.posterPath,
        libraryId,
        tmdbId: r.tmdbId,
      });
    }
    return [...local, ...extra];
  }, [local, data]);

  const persons: PersonResult[] = useMemo(() => data?.persons ?? [], [data]);

  const counts = useMemo(
    () => ({
      all: titles.length + persons.length,
      movie: titles.filter((r) => r.kind === "movie").length,
      series: titles.filter((r) => r.kind === "series").length,
      person: persons.length,
    }),
    [titles, persons]
  );

  // Un filtre qui ne correspond plus à rien laisserait une grille vide sans que rien ne
  // l'explique. Déduit au rendu plutôt que corrigé dans un effet : c'est la même règle, mais elle
  // s'applique sur la frame où le résultat change, sans rendu en cascade.
  const filter: Filter = requested !== "all" && counts[requested] === 0 ? "all" : requested;

  // Rien tant qu'il n'y a rien de cherché. `keepPreviousData` garde les derniers résultats quand
  // la clé change — ce qui est ce qu'on veut en tapant, et pas du tout ce qu'on veut quand on
  // efface : le champ redevenait vide, l'invitation réapparaissait, et la grille précédente
  // restait affichée dessous.
  const shownTitles = !searching || filter === "person" ? [] : titles.filter((r) => filter === "all" || r.kind === filter);
  const shownPersons = searching && (filter === "all" || filter === "person") ? persons : [];
  /**
   * « Rien trouvé » ne se dit qu'une fois la réponse connue.
   *
   * La bibliothèque répond à la lettre, le serveur cent cinquante millisecondes plus tard : entre
   * les deux, une recherche sans résultat local aurait affiché « aucun résultat » puis les
   * résultats. La condition attend donc que le serveur ait répondu pour *cette* frappe-là.
   *
   * Et jamais sur un échec : « rien trouvé » affirme quelque chose qu'on ne sait pas. Un échec
   * dit qu'il en est un (`failed`), même quand la bibliothèque, elle, a trouvé de quoi remplir
   * la grille — la moitié qui manque doit se voir.
   */
  const empty = searching && debounced === typed && !isLoading && !failed && counts.all === 0;
  const unreachable = searching && debounced === typed && failed;

  // La fiche s'ouvre par-dessus la recherche, qui reste montée dessous : le retour du navigateur
  // ramène sur les résultats, avec la requête tapée et le filtre choisi — au lieu de renvoyer à
  // l'accueil comme si l'on n'avait rien cherché.
  function openTitle(entry: Entry) {
    // Ouvrir un résultat est la preuve qu'on cherchait bien ça : on retient sans attendre le
    // minuteur, et la recherche est de toute façon complète à cet instant.
    rememberSearch(typed);
    if (entry.libraryId !== null) openLibraryTitle(entry.kind, entry.libraryId);
    else if (entry.tmdbId !== null) cinemaNavigate({ discover: entry.tmdbId, discoverType: entry.kind });
  }

  const FILTERS: { key: Filter; label: string }[] = [
    { key: "all", label: t("player.search.filterAll") },
    { key: "movie", label: t("player.kind.moviePlural") },
    { key: "series", label: t("player.kind.seriesPlural") },
    { key: "person", label: t("player.kind.personPlural") },
  ];

  return (
    <PlayerPanelFrame title={t("player.nav.search")} leaving={leaving} replaced={replaced} fromTab={fromTab}>
      <div className="mx-auto w-full max-w-5xl">
        <div className="relative">
          <SearchIcon size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            /* Valider, et descendre dans ce qu'on a trouvé.
               Le champ n'est dans aucun formulaire : la loupe du clavier ne faisait rien du tout,
               alors qu'elle est le geste par lequel on *termine* une recherche au pouce. Elle
               retient maintenant sans attendre le minuteur, et le focus part sur la première
               carte — ce qui range le clavier par la même occasion, lui qui recouvrait la moitié
               des résultats qu'on venait de demander.
               La flèche du bas fait le même trajet sans rien valider : c'est le geste du clavier
               d'ordinateur, et il manquait — voir `enterResults`. Rien à relancer dans les deux
               cas, les résultats sont déjà là. */
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== "ArrowDown") return;
              e.preventDefault();
              if (e.key === "Enter") rememberSearch(typed);
              if (!enterResults()) inputRef.current?.blur();
            }}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            placeholder={t("player.search.placeholder")}
            aria-label={t("player.nav.search")}
            className="search-no-native-clear w-full rounded-2xl border border-white/10 bg-white/5 py-4 pl-12 pr-12 text-base text-white placeholder:text-slate-500 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          />
          {/* Effacer sans viser la touche retour arrière trente fois.
              `type="search"` dessine bien une croix native, mais pas sur iOS — et c'est
              précisément là qu'enchaîner des recherches au pouce est le plus pénible. Celle-ci est
              la même que la recherche cinéma affiche déjà : deux champs pour un même geste
              devaient s'effacer pareil. La croix native, elle, est masquée ici
              (`search-no-native-clear`) : sur Chrome les deux se superposaient.

              La cible fait toute la hauteur du champ plutôt que la taille de l'icône : un doigt ne
              vise pas seize pixels. Et le champ reprend le focus, sinon effacer ferme le clavier
              et il faut retoucher l'écran pour retaper. */}
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label={t("common.clear")}
              className="absolute right-0 top-0 flex h-full w-12 items-center justify-center text-slate-500 transition-colors hover:text-white"
            >
              <X size={18} />
            </button>
          )}
        </div>

        {searching && counts.all > 0 && (
          <div className="mt-5 flex flex-wrap gap-2">
            {FILTERS.map(({ key, label }) => {
              if (key !== "all" && counts[key] === 0) return null;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  aria-pressed={filter === key}
                  data-nav-item
                  className={filter === key ? "chip chip-on" : "chip"}
                >
                  {label}
                  <span className="ml-1.5 tabular-nums opacity-60">{counts[key]}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* L'écran d'avant la frappe.
            Il ne portait qu'une phrase grise, au moment précis où quelqu'un cherche sans savoir
            quoi. Il porte maintenant ses propres recherches — on cherche souvent deux fois la
            même chose — et ce qui vient d'arriver dans la bibliothèque, qui est la réponse la
            plus fréquente à « quoi de neuf ». */}
        {!searching && <SearchStart onPick={setQuery} />}

        {empty && (
          <p className="mt-10 text-sm text-slate-400">{t("player.search.noResults", { query: typed })}</p>
        )}

        {unreachable && (
          <p role="alert" className="mt-6 text-sm text-amber-300/90">{t("player.search.failed")}</p>
        )}

        {(shownTitles.length > 0 || shownPersons.length > 0) && (
          <div ref={gridRef} className="player-grid mt-6 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {shownTitles.map((r) => (
              <PlayerResultCard
                key={r.key}
                kind={r.kind}
                title={r.title}
                subtitle={r.year ? String(r.year) : null}
                poster={r.poster}
                missing={r.libraryId === null}
                onOpen={() => openTitle(r)}
              />
            ))}
            {shownPersons.map((p) => (
              <PlayerResultCard
                key={`person-${p.id}`}
                kind="person"
                title={p.name}
                subtitle={p.libraryCount > 0 ? t("player.search.personTitles", { n: p.libraryCount }) : null}
                poster={p.profilePath}
                onOpen={() => {
                  // Même raison que pour un titre : ouvrir une fiche prouve l'intention.
                  rememberSearch(typed);
                  cinemaNavigate({ person: p.id });
                }}
              />
            ))}
          </div>
        )}

        {isLoading && searching && (
          <div className="mt-10 flex justify-center">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          </div>
        )}
      </div>
    </PlayerPanelFrame>
  );
}


/**
 * Ce qu'on montre avant qu'on tape.
 *
 * Deux choses seulement, et les deux existent déjà : les dernières recherches de la personne, et
 * les derniers titres arrivés. Rien de nouveau n'est demandé au serveur — le catalogue est lu
 * dans le cache, comme partout ailleurs dans cet écran.
 */
function SearchStart({ onPick }: { onPick: (query: string) => void }) {
  const t = useT();
  /**
   * Les dernières recherches, lues une fois.
   *
   * Le stockage local n'existe pas côté serveur, et le relire à chaque rendu donnerait une liste
   * instable. `useSyncExternalStore` avec un abonnement vide dit exactement ça : une valeur qui ne
   * change pas d'elle-même, un instantané pour le serveur, et rien à poser dans un effet.
   *
   * L'effacement passe donc par un état à part plutôt que par une relecture.
   */
  const stored = useSyncExternalStore(subscribeNothing, recentSearches, emptyList);
  const [forgotten, setForgotten] = useState(false);
  const recent = forgotten ? [] : stored;

  const { data: movies } = useSWR<CinemaMoviesPayload>(MOVIES_CATALOGUE_KEY, cinemaFetcher, {
    revalidateOnMount: false,
    revalidateIfStale: false,
    revalidateOnFocus: false,
  });
  const fresh = (movies?.recentlyAdded ?? []).slice(0, 12);

  return (
    <div className="mt-8 space-y-8">
      {recent.length > 0 && (
        <section>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-white">{t("player.search.recent")}</h2>
            <button
              type="button"
              onClick={() => {
                forgetSearches();
                setForgotten(true);
              }}
              className="shrink-0 text-xs text-slate-500 transition-colors hover:text-white"
            >
              {t("player.search.forget")}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recent.map((query) => (
              <button key={query} type="button" onClick={() => onPick(query)} data-nav-item className="chip">
                <SearchIcon size={13} />
                {query}
              </button>
            ))}
          </div>
        </section>
      )}

      {fresh.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-white">{t("cinema.recentlyAdded")}</h2>
          <div className="player-grid grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {fresh.map((movie) => (
              <PlayerResultCard
                key={movie.radarrId}
                kind="movie"
                title={movie.title}
                subtitle={movie.year ? String(movie.year) : null}
                poster={movie.posterUrl}
                onOpen={() => openLibraryTitle("movie", movie.radarrId)}
              />
            ))}
          </div>
        </section>
      )}

      {recent.length === 0 && fresh.length === 0 && (
        <p className="text-sm text-slate-500">{t("player.search.hint")}</p>
      )}
    </div>
  );
}


/** Les recherches retenues ne changent pas toutes seules : il n'y a rien à écouter. */
function subscribeNothing(): () => void {
  return () => {};
}

/** L'instantané du serveur, où le stockage local n'existe pas. Constant, comme React l'exige. */
const NOTHING_YET: string[] = [];
function emptyList(): string[] {
  return NOTHING_YET;
}
