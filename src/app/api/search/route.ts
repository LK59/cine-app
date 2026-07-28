import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient, tmdb, TMDB_IMAGE_BASE, type TmdbMovie, type TmdbTv, type TmdbMultiResult } from "@/lib/clients/tmdb";
import { cachedMovies, cachedSeries, withCache, TTL } from "@/lib/server-cache";
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
    sources: inLibrary ? [source === "tmdb" ? (mediaType === "movie" ? "radarr" : "sonarr") : source] : ["tmdb"],
  };
}

function makePersonCreditEntry(
  item: { id: number; title?: string; name?: string; poster_path?: string | null; release_date?: string; first_air_date?: string; vote_average?: number },
  mediaType: "movie" | "series",
  radarrByTmdb: Map<number, number>,
  sonarrByTmdb: Map<number, number>,
): UnifiedSearchResult {
  return makeEntry({ ...item, overview: "" }, mediaType, radarrByTmdb, sonarrByTmdb);
}

function debugKey(entry: Pick<UnifiedSearchResult, "type" | "tmdbId">) {
  return `${entry.type}:${entry.tmdbId}`;
}

function hasAll(ids: Set<number>, required: number[]) {
  return required.every((id) => ids.has(id));
}

async function matchesNaturalPeople(mediaType: "movie" | "series", tmdbId: number, castIds: number[], directorIds: number[]) {
  if (castIds.length === 0 && directorIds.length === 0) return true;

  const details = await withCache<TmdbMovie | TmdbTv | null>(`search:credits-check:${mediaType}:${tmdbId}`, 7 * 24 * 3600_000, () =>
    mediaType === "movie"
      ? tmdb.getMovie(tmdbId).catch(() => null)
      : tmdb.getTv(tmdbId).catch(() => null)
  );
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

  // The fallback lives outside withCache: a transient TMDB failure must not get cached as
  // "this person has no credits" for 7 days — better to just retry next time.
  const creditLists = await Promise.all(
    castIds.map((id) =>
      withCache(`search:person-credits:${id}`, 7 * 24 * 3600_000, () => tmdb.getPersonCredits(id)).catch(
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

  const cacheKey = `search:v9:${includeDebug ? "debug" : "normal"}:${locale}:${type}:${q}`;

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
          const entry = makeEntry(item, mediaType, radarrByTmdb, sonarrByTmdb);
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
            const details = await withCache<TmdbTv | null>(`search:genre-check:series:${item.id}`, 7 * 24 * 3600_000, () =>
              tmdb.getTv(item.id).catch(() => null)
            );
            if (!details?.genres?.some((g) => g.id === genreIds?.tv)) continue;
          }
          const entry = makePersonCreditEntry(item, "series", radarrByTmdb, sonarrByTmdb);
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

      const entry = makeEntry(item, isMovie ? "movie" : "series", radarrByTmdb, sonarrByTmdb);
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

    // Persons
    const persons: PersonResult[] = personResults.results.slice(0, 5).map((p) => {
      const knownForItems = p.known_for?.slice(0, 5) ?? [];
      const libraryKnown = knownForItems.filter((k: { id: number }) => radarrByTmdb.has(k.id) || sonarrByTmdb.has(k.id));
      return {
        id: p.id,
        name: p.name,
        profilePath: p.profile_path ? `${TMDB_IMAGE_BASE}/w185${p.profile_path}` : null,
        department: p.known_for_department ?? "",
        knownFor: knownForItems.map((k: { title?: string; name?: string }) => k.title ?? k.name ?? "").filter(Boolean),
        libraryCount: libraryKnown.length,
        libraryTitles: libraryKnown.slice(0, 3).map((k: { title?: string; name?: string }) => k.title ?? k.name ?? "").filter(Boolean),
      };
    });

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
