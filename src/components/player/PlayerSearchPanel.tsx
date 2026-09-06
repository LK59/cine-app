"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { Search as SearchIcon } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { cinemaNavigate, openLibraryTitle } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";
import { recentSearches, rememberSearch, forgetSearches } from "@/lib/recentSearches";
import type { CinemaMoviesPayload } from "@/app/api/cinema/movies/route";
import { PlayerPanelFrame } from "./PlayerPanelFrame";
import { PlayerResultCard } from "./PlayerResultCard";
import type { SearchResponse, UnifiedSearchResult, PersonResult } from "@/app/api/search/route";

type Filter = "all" | "movie" | "series" | "person";

const MIN_QUERY = 2;
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
export function PlayerSearchPanel({ leaving }: { leaving?: boolean }) {
  const t = useT();
  const [query, setQuery] = useState(lastQuery);
  const [debounced, setDebounced] = useState(lastQuery.length >= MIN_QUERY ? lastQuery : "");
  const [requested, setFilter] = useState<Filter>("all");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Le curseur à la fin de ce qui est déjà là, pas devant : on revient pour continuer, ou pour
    // effacer d'un geste, jamais pour taper au milieu.
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);

  useEffect(() => {
    const term = query.trim();
    lastQuery = term;
    const timer = setTimeout(() => {
      setDebounced(term.length >= MIN_QUERY ? term : "");
      // Retenue une fois la frappe calmée, jamais lettre à lettre : « i », « in », « int » ne
      // sont pas trois recherches.
      if (term.length >= MIN_QUERY) rememberSearch(term);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const { data, isLoading } = useSWR<SearchResponse>(
    debounced ? `/api/search?q=${encodeURIComponent(debounced)}` : null,
    fetcher,
    { keepPreviousData: true, revalidateOnFocus: false }
  );

  // Bibliothèque d'abord, puis le reste : à pertinence comparable, un titre qu'on peut lancer
  // tout de suite vaut mieux qu'un titre à demander. Le serveur a déjà trié chaque groupe.
  const titles: UnifiedSearchResult[] = useMemo(
    () => [...(data?.library ?? []), ...(data?.tmdb ?? [])],
    [data]
  );
  const persons: PersonResult[] = useMemo(() => data?.persons ?? [], [data]);

  const counts = useMemo(
    () => ({
      all: titles.length + persons.length,
      movie: titles.filter((r) => r.type === "movie").length,
      series: titles.filter((r) => r.type === "series").length,
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
  const shownTitles = !debounced || filter === "person" ? [] : titles.filter((r) => filter === "all" || r.type === filter);
  const shownPersons = debounced && (filter === "all" || filter === "person") ? persons : [];
  const empty = debounced && !isLoading && counts.all === 0;

  // La fiche s'ouvre par-dessus la recherche, qui reste montée dessous : le retour du navigateur
  // ramène sur les résultats, avec la requête tapée et le filtre choisi — au lieu de renvoyer à
  // l'accueil comme si l'on n'avait rien cherché.
  function openTitle(result: UnifiedSearchResult) {
    const libraryId = result.type === "movie" ? result.radarrId : result.sonarrId;
    if (libraryId) openLibraryTitle(result.type, libraryId);
    else cinemaNavigate({ discover: result.tmdbId, discoverType: result.type });
  }

  const FILTERS: { key: Filter; label: string }[] = [
    { key: "all", label: t("player.search.filterAll") },
    { key: "movie", label: t("player.kind.moviePlural") },
    { key: "series", label: t("player.kind.seriesPlural") },
    { key: "person", label: t("player.kind.personPlural") },
  ];

  return (
    <PlayerPanelFrame title={t("player.nav.search")} leaving={leaving}>
      <div className="mx-auto w-full max-w-5xl">
        <div className="relative">
          <SearchIcon size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            placeholder={t("player.search.placeholder")}
            aria-label={t("player.nav.search")}
            className="w-full rounded-2xl border border-white/10 bg-white/5 py-4 pl-12 pr-4 text-base text-white placeholder:text-slate-500 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          />
        </div>

        {debounced && counts.all > 0 && (
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
        {!debounced && <SearchStart onPick={setQuery} />}

        {empty && (
          <p className="mt-10 text-sm text-slate-400">{t("player.search.noResults", { query: debounced })}</p>
        )}

        {(shownTitles.length > 0 || shownPersons.length > 0) && (
          <div className="player-grid mt-6 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {shownTitles.map((r) => (
              <PlayerResultCard
                key={`${r.type}-${r.tmdbId}`}
                kind={r.type}
                title={r.title}
                subtitle={r.year ? String(r.year) : null}
                poster={r.posterPath}
                missing={!r.inLibrary}
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
                onOpen={() => cinemaNavigate({ person: p.id })}
              />
            ))}
          </div>
        )}

        {isLoading && debounced && (
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

  const { data: movies } = useSWR<CinemaMoviesPayload>("/api/cinema/movies", fetcher, {
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
