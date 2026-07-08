import { NextRequest, NextResponse } from "next/server";
import { tmdb, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { cachedMovies, cachedSeries, withCache, TTL } from "@/lib/server-cache";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

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

// ─── Natural query parsing ────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface NaturalQuery {
  enabled: boolean;
  mediaType: "movie" | "series" | "all";
  genreName: string | null;
  castNames: string[];
  directorNames: string[];
}

const GENRE_ALIASES: Record<string, string[]> = {
  action: ["action"],
  adventure: ["aventure", "aventures", "adventure"],
  animation: ["animation", "anime"],
  comedy: ["comedie", "comédie", "humour", "drole", "drôle"],
  crime: ["crime", "policier", "policiers", "gangster", "mafia"],
  documentary: ["documentaire", "docu"],
  drama: ["drame", "drama"],
  family: ["famille", "familial"],
  fantasy: ["fantastique", "fantasy"],
  history: ["histoire", "historique"],
  horror: ["horreur", "epouvante", "épouvante"],
  music: ["musique", "musical"],
  mystery: ["mystere", "mystère", "enquete", "enquête"],
  romance: ["romance", "romantique", "amour"],
  sciencefiction: ["science fiction", "sci fi", "sf", "anticipation"],
  thriller: ["thriller", "suspense"],
  tvmovie: ["telefilm", "téléfilm"],
  war: ["guerre", "militaire"],
  western: ["western"],
};

const PERSON_NAME_HINTS = [
  "clara galle",
  "nuno gallego",
  "christopher nolan",
  "leonardo dicaprio",
  "emma watson",
  "hans zimmer",
  "brad pitt",
  "tom cruise",
  "margot robbie",
  "christian bale",
  "cillian murphy",
  "anne hathaway",
  "matt damon",
  "ryan gosling",
  "scarlett johansson",
  "denis villeneuve",
  "quentin tarantino",
  "steven spielberg",
  "martin scorsese",
];

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function correctPersonName(name: string): string {
  const n = normalize(name);
  let best = n;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const hint of PERSON_NAME_HINTS) {
    const distance = editDistance(n, hint);
    const limit = hint.length <= 10 ? 1 : 2;
    if (distance <= limit && distance < bestDistance) {
      best = hint;
      bestDistance = distance;
    }
  }
  return best;
}

function splitPeople(value: string): string[] {
  return value
    .split(/\s+(?:et|avec)\s+|[,/&+]/i)
    .map((p) => p.replace(/\b(film|films|serie|series|série|séries|de|du|des|avec|par)\b/gi, " ").replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 2);
}

function extractPeople(q: string, patterns: RegExp[]): { names: string[]; rest: string } {
  const names: string[] = [];
  let rest = q;
  for (const pattern of patterns) {
    rest = rest.replace(pattern, (_full, raw: string) => {
      names.push(...splitPeople(raw));
      return " ";
    });
  }
  return { names, rest: rest.replace(/\s+/g, " ").trim() };
}

function parseNaturalQuery(raw: string, forcedType: "movie" | "series" | "all"): NaturalQuery {
  let q = normalize(raw);
  const detectedType =
    /\b(film|films|movie|movies)\b/.test(q) ? "movie"
    : /\b(serie|series|série|séries|tv|show)\b/.test(q) ? "series"
    : forcedType;

  q = q.replace(/\b(film|films|movie|movies|serie|series|série|séries|tv|show)\b/g, " ");

  let genreName: string | null = null;
  for (const [canonical, aliases] of Object.entries(GENRE_ALIASES)) {
    const hit = aliases.find((alias) => new RegExp(`\\b${normalize(alias).replace(/\s+/g, "\\s+")}\\b`).test(q));
    if (hit) {
      genreName = canonical;
      q = q.replace(new RegExp(`\\b${normalize(hit).replace(/\s+/g, "\\s+")}\\b`, "g"), " ");
      break;
    }
  }

  const cast = extractPeople(q, [
    /\b(?:avec|joue(?: avec)?|joué par|jouee par|jouée par|acteur|actrice|casting)\s+(.+?)(?=\s+\b(?:realise|réalisé|realisee|réalisée|par|de)\b|$)/gi,
  ]);
  q = cast.rest;

  const director = extractPeople(q, [
    /\b(?:realise par|réalisé par|realisee par|réalisée par|realisateur|réalisateur|realisation|réalisation|par)\s+(.+)$/gi,
    /\bde\s+([a-z][a-z ]{2,})$/gi,
  ]);
  q = director.rest;

  const enabled = Boolean(genreName || cast.names.length || director.names.length || detectedType !== forcedType);
  return {
    enabled,
    mediaType: detectedType,
    genreName,
    castNames: [...new Set(cast.names.map(normalize))],
    directorNames: [...new Set(director.names.map(normalize))],
  };
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

function debugKey(entry: Pick<UnifiedSearchResult, "type" | "tmdbId">) {
  return `${entry.type}:${entry.tmdbId}`;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const type = req.nextUrl.searchParams.get("type") as "movie" | "series" | "all" | null ?? "all";
  const wantsDebug = req.nextUrl.searchParams.get("debug") === "1";
  const session = wantsDebug ? await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value) : null;
  const includeDebug = session?.role === "admin";

  if (q.length < 2) return NextResponse.json({ library: [], tmdb: [], persons: [] } satisfies SearchResponse);
  if (!tmdb.isEnabled()) return NextResponse.json({ library: [], tmdb: [], persons: [] } satisfies SearchResponse);

  const cacheKey = `search:v3:${includeDebug ? "debug" : "normal"}:${type}:${q}`;

  const result = await withCache<SearchResponse>(cacheKey, TTL.MEDIUM, async () => {
    const searchMovie = type === "all" || type === "movie";
    const searchSeries = type === "all" || type === "series";
    const natural = parseNaturalQuery(q, type);

    const personQuery = correctPersonName(q);

    const [movies, series, multiResults, personResults] = await Promise.all([
      cachedMovies().catch(() => []),
      cachedSeries().catch(() => []),
      tmdb.searchMulti(q).catch(() => ({ results: [] })),
      tmdb.searchPerson(personQuery).catch(() => ({ results: [] })),
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
        tmdb.movieGenres().catch(() => ({ genres: [] })),
        tmdb.tvGenres().catch(() => ({ genres: [] })),
      ]);
      castIds = resolvedCastIds;
      directorIds = resolvedDirectorIds;
      genreIds = resolveGenreIds(natural.genreName, movieGenres.genres, tvGenres.genres);
      const discoverCalls: Promise<{ results: any[] }>[] = [];

      if (searchMovie && natural.mediaType !== "series") {
        discoverCalls.push(tmdb.discover({
          mediaType: "movie",
          genreId: genreIds?.movie ?? undefined,
          castIds,
          crewIds: directorIds,
        }));
      }
      if (searchSeries && natural.mediaType !== "movie") {
        discoverCalls.push(tmdb.discover({
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
          const entry = makeEntry(item, mediaType, radarrByTmdb, sonarrByTmdb);
          addResult(
            entry,
            `natural: discover ${mediaType}; genre=${natural.genreName ?? "none"}; cast=${natural.castNames.join(",") || "none"} -> ${castIds.join(",") || "none"}; director=${natural.directorNames.join(",") || "none"} -> ${directorIds.join(",") || "none"}`
          );
        }
      }
    }

    for (const item of multiResults.results.slice(0, 30)) {
      if (item.media_type === "person") continue;

      const isMovie = item.media_type === "movie";
      if (isMovie && !searchMovie) continue;
      if (!isMovie && !searchSeries) continue;

      addResult(makeEntry(item, isMovie ? "movie" : "series", radarrByTmdb, sonarrByTmdb), "tmdb: searchMulti fallback");
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
