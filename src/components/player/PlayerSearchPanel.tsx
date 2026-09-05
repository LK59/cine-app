"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Search as SearchIcon } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { cinemaNavigate, openLibraryTitle } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";
import { PlayerPanelFrame } from "./PlayerPanelFrame";
import { PlayerResultCard } from "./PlayerResultCard";
import type { SearchResponse, UnifiedSearchResult, PersonResult } from "@/app/api/search/route";

type Filter = "all" | "movie" | "series" | "person";

const MIN_QUERY = 2;
const DEBOUNCE_MS = 260;

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
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [requested, setFilter] = useState<Filter>("all");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const term = query.trim();
    const timer = setTimeout(() => setDebounced(term.length >= MIN_QUERY ? term : ""), DEBOUNCE_MS);
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
                  className={filter === key ? "chip chip-on" : "chip"}
                >
                  {label}
                  <span className="ml-1.5 tabular-nums opacity-60">{counts[key]}</span>
                </button>
              );
            })}
          </div>
        )}

        {!debounced && (
          <p className="mt-10 text-sm text-slate-500">{t("player.search.hint")}</p>
        )}

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
