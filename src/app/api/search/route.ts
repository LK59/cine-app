import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient, tmdb, TMDB_IMAGE_BASE, type TmdbMovie, type TmdbTv, type TmdbMultiResult } from "@/lib/clients/tmdb";
import { cachedMovies, cachedSeries, withCache, withPersistentCache, TTL } from "@/lib/server-cache";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { LOCALE_COOKIE, getTmdbLocale, type Locale } from "@/lib/i18n";
import {
  normalize,
  correctPersonName,
  bestTitleMatchScore,
  GENRE_ALIASES,
  parseNaturalQuery,
  parseNaturalQueryEN,
  parseNaturalQueryES,
  parseNaturalQueryDE,
  type NaturalQuery,
} from "@/lib/search-natural-query";

export const dynamic = "force-dynamic";

export interface UnifiedSearchResult {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  type: "movie" | "series";
  overview: string;
  rating: number;
  // Local library status
  radarrId: number | null;
  sonarrId: number | null;
  inLibrary: boolean;
  /**
   * Dans la bibliothèque *et* regardable : un film avec son fichier, une série avec au moins un
   * épisode — la règle de `playableLibrary`. Un titre que Radarr suit sans l'avoir encore (un film
   * en salle) est `inLibrary` sans l'être : le cinéma ouvrait sa fiche de bibliothèque, qui ne le
   * trouvait pas dans le catalogue et se refermait aussitôt (L'Odyssée, 24/09/2026). La gestion,
   * elle, continue de le traiter comme un titre suivi.
   */
  available: boolean;
  // Provenance badges
  sources: Array<"radarr" | "sonarr" | "tmdb">;
}

export interface PersonResult {
  id: number;
  name: string;
  profilePath: string | null;
  department: string;
  knownFor: string[];
  libraryCount: number;
  libraryTitles: string[];
}

export interface SearchResponse {
  library: UnifiedSearchResult[];
  tmdb: UnifiedSearchResult[];
  persons: PersonResult[];
  debug?: SearchDebug;
}

export interface SearchDebug {
  query: string;
  normalizedQuery: string;
  type: "movie" | "series" | "all";
  natural: NaturalQuery & { movieGenreId: number | null; tvGenreId: number | null; castIds: number[]; directorIds: number[] };
  personQuery: string;
  results: Record<string, string[]>;
}

async function resolvePersonIds(names: string[]): Promise<number[]> {
  const found = await Promise.all(
    names.map(async (name) => {
      const corrected = correctPersonName(name);
      const primary = await tmdb.searchPerson(corrected).catch(() => ({ results: [] }));
      if (primary.results[0]?.id) return primary.results[0].id;
      if (corrected !== name) {
        const fallback = await tmdb.searchPerson(name).catch(() => ({ results: [] }));
        return fallback.results[0]?.id ?? null;
      }
      return null;
    })
  );
  return found.filter((id): id is number => Boolean(id));
}

function resolveGenreIds(name: string | null, movieGenres: { id: number; name: string }[], tvGenres: { id: number; name: string }[]) {
  if (!name) return null;
  const aliases = GENRE_ALIASES[name] ?? [name];
  const normalizedAliases = aliases.map(normalize);
  const findId = (genres: { id: number; name: string }[]) =>
    genres.find((g) => {
      const normalized = normalize(g.name);
      return normalizedAliases.some((a) => normalized.includes(a) || a.includes(normalized));
    })?.id ?? null;
  return { movie: findId(movieGenres), tv: findId(tvGenres) };
}

function makeEntry(
  item: { id: number; title?: string; name?: string; poster_path?: string | null; release_date?: string; first_air_date?: string; vote_average?: number; overview?: string },
  mediaType: "movie" | "series",
  radarrByTmdb: Map<number, number>,
  sonarrByTmdb: Map<number, number>,
  source: "tmdb" | "radarr" | "sonarr" = "tmdb",
  playable?: Set<string>,
): UnifiedSearchResult {
  const title = item.title ?? item.name ?? "";
  const dateStr = item.release_date ?? item.first_air_date ?? "";
  const radarrId = mediaType === "movie" ? radarrByTmdb.get(item.id) ?? null : null;
  const sonarrId = mediaType === "series" ? sonarrByTmdb.get(item.id) ?? null : null;
  const inLibrary = radarrId !== null || sonarrId !== null;
  return {
    tmdbId: item.id,
    title,
    year: dateStr ? Number(dateStr.split("-")[0]) : null,
    posterPath: item.poster_path ? `${TMDB_IMAGE_BASE}/w342${item.poster_path}` : null,
    type: mediaType,
    overview: item.overview ?? "",
    rating: item.vote_average ?? 0,
    radarrId,
    sonarrId,
    inLibrary,
    available:
      (radarrId !== null && (playable?.has(`movie:${radarrId}`) ?? false)) ||
      (sonarrId !== null && (playable?.has(`series:${sonarrId}`) ?? false)),
    sources: inLibrary ? [source === "tmdb" ? (mediaType === "movie" ? "radarr" : "sonarr") : source] : ["tmdb"],
  };
}

function makePersonCreditEntry(
  item: { id: number; title?: string; name?: string; poster_path?: string | null; release_date?: string; first_air_date?: string; vote_average?: number },
  mediaType: "movie" | "series",
  radarrByTmdb: Map<number, number>,
  sonarrByTmdb: Map<number, number>,
  playable?: Set<string>,
): UnifiedSearchResult {
  return makeEntry({ ...item, overview: "" }, mediaType, radarrByTmdb, sonarrByTmdb, "tmdb", playable);
}

function debugKey(entry: Pick<UnifiedSearchResult, "type" | "tmdbId">) {
  return `${entry.type}:${entry.tmdbId}`;
}

function hasAll(ids: Set<number>, required: number[]) {
  return required.every((id) => ids.has(id));
}

async function matchesNaturalPeople(mediaType: "movie" | "series", tmdbId: number, castIds: number[], directorIds: number[]) {
  if (castIds.length === 0 && directorIds.length === 0) return true;

  // The fallback lives outside the cache call: a transient TMDB failure must not get cached as
  // "this title doesn't match the cast/director filter" for 7 days — better to just retry next
  // time. Persisted to disk too, so it survives a redeploy (see findSharedSeriesByCast above).
  const details = await withPersistentCache<TmdbMovie | TmdbTv>(
    `search:credits-check:${mediaType}:${tmdbId}`,
    7 * 24 * 3600_000,
    () => (mediaType === "movie" ? tmdb.getMovie(tmdbId) : tmdb.getTv(tmdbId))
  ).catch(() => null);
  if (!details) return false;

  const credits = details.credits;
  const cast = new Set((credits?.cast ?? []).map((p) => p.id));
  if (!hasAll(cast, castIds)) return false;

  const crewDirectors = new Set((credits?.crew ?? []).filter((p) => p.job === "Director").map((p) => p.id));
  const creators = new Set("created_by" in details ? (details.created_by ?? []).map((p) => p.id) : []);
  const directorsAndCreators = new Set([...crewDirectors, ...creators]);
  return hasAll(directorsAndCreators, directorIds);
}

async function findSharedSeriesByCast(castIds: number[]) {
  if (castIds.length === 0) return [];

  // The fallback lives outside the cache call: a transient TMDB failure must not get cached as
  // "this person has no credits" for 7 days — better to just retry next time. Persisted to disk
  // too, so it survives a redeploy instead of refetching every actor again from scratch.
  const creditLists = await Promise.all(
    castIds.map((id) =>
      withPersistentCache(`search:person-credits:${id}`, 7 * 24 * 3600_000, () => tmdb.getPersonCredits(id)).catch(
        () => ({ cast: [] })
      )
    )
  );

  const [first, ...rest] = creditLists;
  const candidates = new Map(
    first.cast
      .filter((c) => c.media_type === "tv")
      .map((c) => [c.id, c])
  );

  for (const credits of rest) {
    const ids = new Set(credits.cast.filter((c) => c.media_type === "tv").map((c) => c.id));
    for (const id of [...candidates.keys()]) {
      if (!ids.has(id)) candidates.delete(id);
    }
  }

  return [...candidates.values()].sort((a, b) => b.popularity - a.popularity);
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const type = req.nextUrl.searchParams.get("type") as "movie" | "series" | "all" | null ?? "all";
  const wantsDebug = req.nextUrl.searchParams.get("debug") === "1";
  const session = wantsDebug ? await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value) : null;
  const includeDebug = session?.role === "admin";
  const rawLang = req.cookies.get(LOCALE_COOKIE)?.value ?? "";
  const locale: Locale = (rawLang === "en" || rawLang === "es" || rawLang === "de") ? rawLang : "fr";
  // The module-level `tmdb` singleton is fixed to fr-FR; build a client that
  // actually matches the site's locale, plus an English one for title fallback
  // ("the hunt" typed in English should still find "La Chasse").
  const tmdbLocale = getTmdbLocale(locale);
  const tmdbPrimary = tmdbLocale === "fr-FR" ? tmdb : createTmdbClient(tmdbLocale);
  const tmdbEn = tmdbLocale === "en-US" ? tmdbPrimary : createTmdbClient("en-US");

  if (q.length < 2) return NextResponse.json({ library: [], tmdb: [], persons: [] } satisfies SearchResponse);
  if (!tmdbPrimary.isEnabled()) return NextResponse.json({ library: [], tmdb: [], persons: [] } satisfies SearchResponse);

  const cacheKey = `search:v10:${includeDebug ? "debug" : "normal"}:${locale}:${type}:${q}`;

  const result = await withCache<SearchResponse>(cacheKey, TTL.MEDIUM, async () => {
    const searchMovie = type === "all" || type === "movie";
    const searchSeries = type === "all" || type === "series";
    const natural = locale === "en" ? parseNaturalQueryEN(q, type)
                 : locale === "es" ? parseNaturalQueryES(q, type)
                 : locale === "de" ? parseNaturalQueryDE(q, type)
                 : parseNaturalQuery(q, type);
    const allowMovieResults = searchMovie && natural.mediaType !== "series";
    const allowSeriesResults = searchSeries && natural.mediaType !== "movie";

    const personQuery = correctPersonName(q);

    const [movies, series, multiResults, multiResultsEn, personResults] = await Promise.all([
      cachedMovies().catch(() => []),
      cachedSeries().catch(() => []),
      tmdbPrimary.searchMulti(q).catch(() => ({ results: [] })),
      tmdbEn === tmdbPrimary ? Promise.resolve({ results: [] }) : tmdbEn.searchMulti(q).catch(() => ({ results: [] })),
      tmdbPrimary.searchPerson(personQuery).catch(() => ({ results: [] })),
    ]);

    // Build lookup maps
    const radarrByTmdb = new Map(movies.map((m) => [m.tmdbId, m.id]));
    const sonarrByTmdb = new Map(series.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, s.id]));
    const playable = new Set<string>([
      ...movies.filter((m) => m.hasFile).map((m) => `movie:${m.id}`),
      ...series.filter((s) => (s.statistics?.episodeFileCount ?? 0) > 0).map((s) => `series:${s.id}`),
    ]);

    const library: UnifiedSearchResult[] = [];
    const tmdbNotInLib: UnifiedSearchResult[] = [];
    const seenResults = new Set<string>();
    const resultDebug: Record<string, string[]> = {};

    const addDebug = (entry: UnifiedSearchResult, reason: string) => {
      if (!includeDebug) return;
      const key = debugKey(entry);
      resultDebug[key] = [...(resultDebug[key] ?? []), reason];
    };

    function addResult(entry: UnifiedSearchResult, reason: string) {
      const key = `${entry.type}:${entry.tmdbId}`;
      if (seenResults.has(key)) {
        addDebug(entry, reason);
        return;
      }
      seenResults.add(key);
      addDebug(entry, reason);
      if (entry.inLibrary) library.push(entry);
      else tmdbNotInLib.push(entry);
    }

    let castIds: number[] = [];
    let directorIds: number[] = [];
    let genreIds: { movie: number | null; tv: number | null } | null = null;

    if (natural.enabled) {
      const [resolvedCastIds, resolvedDirectorIds, movieGenres, tvGenres] = await Promise.all([
        resolvePersonIds(natural.castNames),
        resolvePersonIds(natural.directorNames),
        tmdbPrimary.movieGenres().catch(() => ({ genres: [] })),
        tmdbPrimary.tvGenres().catch(() => ({ genres: [] })),
      ]);
      castIds = resolvedCastIds;
      directorIds = resolvedDirectorIds;
      genreIds = resolveGenreIds(natural.genreName, movieGenres.genres, tvGenres.genres);
      const discoverCalls: Promise<{ results: any[] }>[] = [];
      const missingCast = natural.castNames.length > 0 && castIds.length === 0;
      const missingDirector = natural.directorNames.length > 0 && directorIds.length === 0;

      if (!missingCast && !missingDirector && allowMovieResults) {
        discoverCalls.push(tmdbPrimary.discover({
          mediaType: "movie",
          genreId: genreIds?.movie ?? undefined,
          castIds,
          crewIds: directorIds,
        }));
      }
      if (!missingCast && !missingDirector && allowSeriesResults) {
        discoverCalls.push(tmdbPrimary.discover({
          mediaType: "tv",
          genreId: genreIds?.tv ?? undefined,
          castIds,
          crewIds: directorIds,
        }));
      }

      const discovered = await Promise.allSettled(discoverCalls);
      for (const batch of discovered) {
        if (batch.status !== "fulfilled") continue;
        for (const item of batch.value.results.slice(0, 30)) {
          const mediaType = "title" in item ? "movie" : "series";
          const personMatch = await matchesNaturalPeople(mediaType, item.id, castIds, directorIds);
          const entry = makeEntry(item, mediaType, radarrByTmdb, sonarrByTmdb, "tmdb", playable);
          if (!personMatch) {
            addDebug(
              entry,
              `natural: rejected by credits check; required cast=${castIds.join(",") || "none"}; director=${directorIds.join(",") || "none"}`
            );
            continue;
          }
          addResult(
            entry,
            `natural: discover ${mediaType}; credits verified; genre=${natural.genreName ?? "none"}; cast=${natural.castNames.join(",") || "none"} -> ${castIds.join(",") || "none"}; director=${natural.directorNames.join(",") || "none"} -> ${directorIds.join(",") || "none"}`
          );
        }
      }

      if (!missingCast && castIds.length > 0 && directorIds.length === 0 && allowSeriesResults) {
        const sharedSeries = await findSharedSeriesByCast(castIds);
        for (const item of sharedSeries.slice(0, 30)) {
          if (genreIds?.tv) {
            // Same rule as matchesNaturalPeople above: don't let a transient TMDB failure get
            // cached as "wrong genre" for 7 days.
            const details = await withPersistentCache<TmdbTv>(
              `search:genre-check:series:${item.id}`,
              7 * 24 * 3600_000,
              () => tmdb.getTv(item.id)
            ).catch(() => null);
            if (!details?.genres?.some((g) => g.id === genreIds?.tv)) continue;
          }
          const entry = makePersonCreditEntry(item, "series", radarrByTmdb, sonarrByTmdb, playable);
          addResult(
            entry,
            `natural: person credits intersection series; genre=${natural.genreName ?? "none"}; cast=${natural.castNames.join(",") || "none"} -> ${castIds.join(",") || "none"}`
          );
        }
      }
    }

    // Merge the site-locale and English searchMulti results so a query typed
    // in either language can match (e.g. "the hunt" ~ "La Chasse"), then rank
    // by best title match across locales/original title, TMDb popularity as tiebreak.
    const enResultKey = (item: TmdbMultiResult) => `${item.media_type}:${item.id}`;
    const enTitleByKey = new Map(
      multiResultsEn.results.map((item) => [enResultKey(item), item.title ?? item.name])
    );
    const mergedMulti = new Map<string, TmdbMultiResult>();
    for (const item of [...multiResults.results, ...multiResultsEn.results]) {
      if (item.media_type === "person") continue;
      const key = enResultKey(item);
      if (!mergedMulti.has(key)) mergedMulti.set(key, item);
    }

    const rankedMulti = [...mergedMulti.values()].sort((a, b) => {
      const diff =
        bestTitleMatchScore([b.title ?? b.name, b.original_title ?? b.original_name, enTitleByKey.get(enResultKey(b))], q) -
        bestTitleMatchScore([a.title ?? a.name, a.original_title ?? a.original_name, enTitleByKey.get(enResultKey(a))], q);
      return diff !== 0 ? diff : (b.popularity ?? 0) - (a.popularity ?? 0);
    });

    for (const item of rankedMulti.slice(0, 30)) {
      const isMovie = item.media_type === "movie";
      if (isMovie && !allowMovieResults) continue;
      if (!isMovie && !allowSeriesResults) continue;

      const entry = makeEntry(item, isMovie ? "movie" : "series", radarrByTmdb, sonarrByTmdb, "tmdb", playable);
      const score = bestTitleMatchScore(
        [item.title ?? item.name, item.original_title ?? item.original_name, enTitleByKey.get(enResultKey(item))],
        q
      );
      if (score < 55) {
        addDebug(entry, `tmdb: rejected searchMulti title score ${score}`);
        continue;
      }
      addResult(entry, `tmdb: searchMulti fallback; title score ${score}`);
    }

    /**
     * Les personnes — et d'abord celles qui veulent dire quelque chose ici.
     *
     * TMDB rend les homonymes dans son propre ordre de popularité mondiale, ce qui donnait, pour
     * « Hann », cinq inconnus sans photo poussant vers le bas le seul film qu'on possédait
     * vraiment. Or il n'y a qu'une question qui vaille sur cet écran : *est-ce que je peux
     * regarder quelque chose de cette personne ce soir ?*
     *
     * Deux corrections, et elles vont ensemble.
     *
     * 1. **Le décompte était faux.** Il ne regardait que les cinq titres « connus pour » de TMDB,
     *    donc un acteur présent dans douze films d'ici n'en affichait jamais plus de trois. On lit
     *    maintenant sa filmographie complète, croisée avec Radarr et Sonarr — c'est le nombre que
     *    la carte annonce, et il est vrai.
     * 2. **Le classement suit ce décompte**, et qui n'a ni titre ici ni même un visage ne figure
     *    plus du tout : un nom seul, sur un écran de recherche, n'est pas un résultat.
     *
     * Le coût est borné : cinq filmographies au plus, en parallèle, et gardées sur disque une
     * semaine — le même cache persistant que la recherche par casting utilise déjà, donc un foyer
     * qui cherche toujours les mêmes acteurs cesse très vite d'appeler TMDB. L'échec reste hors du
     * cache : une panne passagère ne doit pas se figer en « cette personne n'a rien ici ».
     */
    const candidates = personResults.results.slice(0, 8);
    const credits = await Promise.all(
      candidates.map((p) =>
        withPersistentCache(`search:person-credits:${p.id}`, 7 * 24 * 3600_000, () => tmdb.getPersonCredits(p.id))
          .catch(() => null)
      )
    );

    const scored = candidates.map((p, i) => {
      const knownForItems = p.known_for?.slice(0, 5) ?? [];
      const owned = (credits[i]?.cast ?? []).filter((c) =>
        c.media_type === "tv" ? sonarrByTmdb.has(c.id) : radarrByTmdb.has(c.id)
      );
      // Le repli quand TMDB n'a pas répondu : l'ancien décompte, sous-évalué mais jamais faux
      // dans l'autre sens — mieux vaut annoncer moins que d'effacer une personne qu'on possède.
      const fallback = knownForItems.filter((k) => radarrByTmdb.has(k.id) || sonarrByTmdb.has(k.id));
      const libraryItems = credits[i] ? owned : fallback;
      const titles = [...new Map(libraryItems.map((k) => [k.id, (k as { title?: string; name?: string }).title ?? (k as { title?: string; name?: string }).name ?? ""])).values()].filter(Boolean);
      return {
        person: {
          id: p.id,
          name: p.name,
          profilePath: p.profile_path ? `${TMDB_IMAGE_BASE}/w185${p.profile_path}` : null,
          department: p.known_for_department ?? "",
          knownFor: knownForItems.map((k: { title?: string; name?: string }) => k.title ?? k.name ?? "").filter(Boolean),
          libraryCount: titles.length,
          libraryTitles: titles.slice(0, 3),
        } satisfies PersonResult,
        rank: i,
      };
    });

    const persons: PersonResult[] = scored
      .filter(({ person }) => person.libraryCount > 0 || person.profilePath !== null)
      .sort((a, b) => (b.person.libraryCount - a.person.libraryCount) || (a.rank - b.rank))
      .slice(0, 5)
      .map(({ person }) => person);

    const debug = includeDebug
      ? {
          query: q,
          normalizedQuery: normalize(q),
          type,
          natural: {
            ...natural,
            movieGenreId: genreIds?.movie ?? null,
            tvGenreId: genreIds?.tv ?? null,
            castIds,
            directorIds,
          },
          personQuery,
          results: resultDebug,
        }
      : undefined;

    return { library, tmdb: tmdbNotInLib, persons, debug };
  });

  return NextResponse.json(result);
}
