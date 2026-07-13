import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient, tmdb, TMDB_IMAGE_BASE, type TmdbMovie, type TmdbTv } from "@/lib/clients/tmdb";
import { cachedMovies, cachedSeries, withCache, TTL } from "@/lib/server-cache";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { LOCALE_COOKIE, type Locale } from "@/lib/i18n";

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
  adventure: ["aventure", "aventures", "adventure", "aventura", "aventuras"],
  animation: ["animation", "anime", "animacion", "animación"],
  comedy: ["comedie", "comédie", "humour", "drole", "drôle", "comedy", "comedia"],
  crime: ["crime", "policier", "policiers", "gangster", "mafia", "crimen"],
  documentary: ["documentaire", "docu", "documentary", "documental"],
  drama: ["drame", "drama"],
  family: ["famille", "familial", "family", "familia"],
  fantasy: ["fantastique", "fantasy", "fantasia", "fantasía"],
  history: ["histoire", "historique", "history", "historical", "historia", "historico", "histórico"],
  horror: ["horreur", "epouvante", "épouvante", "horror", "terror"],
  music: ["musique", "musical", "music", "musica", "música"],
  mystery: ["mystere", "mystère", "enquete", "enquête", "mystery", "misterio"],
  romance: ["romance", "romantique", "amour", "romantic", "romantico", "romántico"],
  sciencefiction: ["science fiction", "sci fi", "sf", "anticipation", "science-fiction", "ciencia ficcion", "ciencia ficción"],
  thriller: ["thriller", "suspense", "suspenso"],
  tvmovie: ["telefilm", "téléfilm", "tv movie"],
  war: ["guerre", "militaire", "war", "guerra"],
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

const STOPWORDS_FR = new Set(["de", "du", "des", "le", "la", "les", "un", "une", "et", "avec", "par"]);
const STOPWORDS_EN = new Set(["the", "a", "an", "of", "with", "by", "and", "in", "on"]);
const STOPWORDS_ES = new Set(["el", "la", "los", "las", "un", "una", "de", "del", "con", "por", "y", "en"]);
const STOPWORDS_DE = new Set(["der", "die", "das", "ein", "eine", "mit", "von", "und", "im", "in", "am"]);
const STOPWORDS = STOPWORDS_FR;

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

function titleMatchScore(title: string, query: string): number {
  const titleNorm = normalize(title);
  const queryNorm = normalize(query);
  if (!titleNorm || !queryNorm) return 0;
  if (titleNorm === queryNorm) return 100;
  if (titleNorm.startsWith(queryNorm)) return 90;
  if (titleNorm.includes(queryNorm)) return 75;
  const words = queryNorm.split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  if (words.length > 1 && words.every((w) => titleNorm.includes(w))) return 60;
  return 0;
}

function splitPeople(value: string, locale: Locale = "fr"): string[] {
  const stopwords = locale === "en" ? STOPWORDS_EN : locale === "es" ? STOPWORDS_ES : locale === "de" ? STOPWORDS_DE : STOPWORDS_FR;
  const splitPattern = locale === "en"
    ? /\s+(?:and|with)\s+|[,/&+]/i
    : locale === "es"
      ? /\s+(?:y|con)\s+|[,/&+]/i
      : locale === "de"
        ? /\s+(?:und|mit)\s+|[,/&+]/i
        : /\s+(?:et|avec)\s+|[,/&+]/i;
  const noiseWords = locale === "en"
    ? /\b(movie|movies|series|show|shows|of|with|by)\b/gi
    : locale === "es"
      ? /\b(pelicula|peliculas|serie|series|con|por|de)\b/gi
      : locale === "de"
        ? /\b(film|filme|serie|serien|mit|von|und)\b/gi
        : /\b(film|films|serie|series|série|séries|de|du|des|avec|par)\b/gi;

  return value
    .split(splitPattern)
    .map((p) => p.replace(noiseWords, " ").replace(/\s+/g, " ").trim())
    .filter((p) => {
      const normalized = normalize(p);
      const words = normalized.split(/\s+/).filter((w) => w && !stopwords.has(w));
      return PERSON_NAME_HINTS.includes(normalized) || words.length >= 2;
    });
}

function extractPeople(q: string, patterns: RegExp[], locale: Locale = "fr"): { names: string[]; rest: string } {
  const names: string[] = [];
  let rest = q;
  for (const pattern of patterns) {
    rest = rest.replace(pattern, (_full, raw: string) => {
      names.push(...splitPeople(raw, locale));
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

  const enabled = Boolean(genreName || cast.names.length || director.names.length);
  return {
    enabled,
    mediaType: detectedType,
    genreName,
    castNames: [...new Set(cast.names.map(normalize))],
    directorNames: [...new Set(director.names.map(normalize))],
  };
}

function parseNaturalQueryEN(raw: string, forcedType: "movie" | "series" | "all"): NaturalQuery {
  let q = normalize(raw);
  const detectedType =
    /\b(movie|movies|film|films)\b/.test(q) ? "movie"
    : /\b(series|show|shows|tv)\b/.test(q) ? "series"
    : forcedType;

  q = q.replace(/\b(movie|movies|film|films|series|show|shows|tv)\b/g, " ");

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
    /\b(?:with|starring|featuring|actor|actress|cast(?:ing)?)\s+(.+?)(?=\s+\b(?:directed by|director|by)\b|$)/gi,
  ], "en");
  q = cast.rest;

  const director = extractPeople(q, [
    /\b(?:directed by|director)\s+(.+)$/gi,
    /\bby\s+([a-z][a-z ]{2,})$/gi,
  ], "en");
  q = director.rest;

  const enabled = Boolean(genreName || cast.names.length || director.names.length);
  return {
    enabled,
    mediaType: detectedType,
    genreName,
    castNames: [...new Set(cast.names.map(normalize))],
    directorNames: [...new Set(director.names.map(normalize))],
  };
}

function parseNaturalQueryES(raw: string, forcedType: "movie" | "series" | "all"): NaturalQuery {
  let q = normalize(raw);
  const detectedType =
    /\b(pelicula|peliculas|film|films)\b/.test(q) ? "movie"
    : /\b(serie|series|programa|programas|show)\b/.test(q) ? "series"
    : forcedType;

  q = q.replace(/\b(pelicula|peliculas|film|films|serie|series|programa|programas|show)\b/g, " ");

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
    /\b(?:con|protagonizada por|protagonizado por|actriz|actor|reparto|elenco)\s+(.+?)(?=\s+\b(?:dirigida por|dirigido por|director|de)\b|$)/gi,
  ], "es");
  q = cast.rest;

  const director = extractPeople(q, [
    /\b(?:dirigida por|dirigido por|director(?:a)?)\s+(.+)$/gi,
    /\bde\s+([a-z][a-z ]{2,})$/gi,
  ], "es");
  q = director.rest;

  const enabled = Boolean(genreName || cast.names.length || director.names.length);
  return {
    enabled,
    mediaType: detectedType,
    genreName,
    castNames: [...new Set(cast.names.map(normalize))],
    directorNames: [...new Set(director.names.map(normalize))],
  };
}

function parseNaturalQueryDE(raw: string, forcedType: "movie" | "series" | "all"): NaturalQuery {
  let q = normalize(raw);
  const detectedType =
    /\b(film|filme|kinofilm|kinofilme)\b/.test(q) ? "movie"
    : /\b(serie|serien|show|sendung)\b/.test(q) ? "series"
    : forcedType;

  q = q.replace(/\b(film|filme|kinofilm|kinofilme|serie|serien|show|sendung)\b/g, " ");

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
    /\b(?:mit|starring|besetzung|schauspieler|schauspielerin)\s+(.+?)(?=\s+\b(?:regie|regisseur|von|gedreht von)\b|$)/gi,
  ], "de");
  q = cast.rest;

  const director = extractPeople(q, [
    /\b(?:regie von|regie:|gedreht von|regisseur|regisseurin)\s+(.+)$/gi,
    /\bvon\s+([a-z][a-z ]{2,})$/gi,
  ], "de");
  q = director.rest;

  const enabled = Boolean(genreName || cast.names.length || director.names.length);
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

  const creditLists = await Promise.all(
    castIds.map((id) =>
      withCache(`search:person-credits:${id}`, 7 * 24 * 3600_000, () =>
        tmdb.getPersonCredits(id).catch(() => ({ cast: [] }))
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

  if (q.length < 2) return NextResponse.json({ library: [], tmdb: [], persons: [] } satisfies SearchResponse);
  if (!tmdb.isEnabled()) return NextResponse.json({ library: [], tmdb: [], persons: [] } satisfies SearchResponse);

  const cacheKey = `search:v8:${includeDebug ? "debug" : "normal"}:${locale}:${type}:${q}`;

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
      const missingCast = natural.castNames.length > 0 && castIds.length === 0;
      const missingDirector = natural.directorNames.length > 0 && directorIds.length === 0;

      if (!missingCast && !missingDirector && allowMovieResults) {
        discoverCalls.push(tmdb.discover({
          mediaType: "movie",
          genreId: genreIds?.movie ?? undefined,
          castIds,
          crewIds: directorIds,
        }));
      }
      if (!missingCast && !missingDirector && allowSeriesResults) {
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

    for (const item of multiResults.results.slice(0, 30)) {
      if (item.media_type === "person") continue;

      const isMovie = item.media_type === "movie";
      if (isMovie && !allowMovieResults) continue;
      if (!isMovie && !allowSeriesResults) continue;

      const entry = makeEntry(item, isMovie ? "movie" : "series", radarrByTmdb, sonarrByTmdb);
      const score = titleMatchScore(entry.title, q);
      if (score < 75) {
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
