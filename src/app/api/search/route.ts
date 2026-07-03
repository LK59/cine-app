import { NextRequest, NextResponse } from "next/server";
import { tmdb, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { cachedMovies, cachedSeries, withCache, TTL } from "@/lib/server-cache";

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
}

export interface SearchResponse {
  library: UnifiedSearchResult[];
  tmdb: UnifiedSearchResult[];
  persons: PersonResult[];
}

// ─── Fuzzy scoring for server-side person search ──────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").trim();
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const type = req.nextUrl.searchParams.get("type") as "movie" | "series" | "all" | null ?? "all";

  if (q.length < 2) return NextResponse.json({ library: [], tmdb: [], persons: [] } satisfies SearchResponse);
  if (!tmdb.isEnabled()) return NextResponse.json({ library: [], tmdb: [], persons: [] } satisfies SearchResponse);

  const cacheKey = `search:${type}:${q}`;

  const result = await withCache<SearchResponse>(cacheKey, TTL.MEDIUM, async () => {
    const searchMovie = type === "all" || type === "movie";
    const searchSeries = type === "all" || type === "series";

    const [movies, series, multiResults, personResults] = await Promise.all([
      cachedMovies().catch(() => []),
      cachedSeries().catch(() => []),
      tmdb.searchMulti(q).catch(() => ({ results: [] })),
      tmdb.searchPerson(q).catch(() => ({ results: [] })),
    ]);

    // Build lookup maps
    const radarrByTmdb = new Map(movies.map((m) => [m.tmdbId, m.id]));
    const sonarrByTmdb = new Map(series.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, s.id]));

    const library: UnifiedSearchResult[] = [];
    const tmdbNotInLib: UnifiedSearchResult[] = [];

    for (const item of multiResults.results.slice(0, 30)) {
      if (item.media_type === "person") continue;

      const isMovie = item.media_type === "movie";
      if (isMovie && !searchMovie) continue;
      if (!isMovie && !searchSeries) continue;

      const tmdbId = item.id;
      const title = item.title ?? item.name ?? "";
      const dateStr = item.release_date ?? item.first_air_date ?? "";
      const year = dateStr ? Number(dateStr.split("-")[0]) : null;
      const posterPath = item.poster_path
        ? `${TMDB_IMAGE_BASE}/w342${item.poster_path}`
        : null;

      const radarrId = radarrByTmdb.get(tmdbId) ?? null;
      const sonarrId = sonarrByTmdb.get(tmdbId) ?? null;
      const inLibrary = radarrId !== null || sonarrId !== null;

      const entry: UnifiedSearchResult = {
        tmdbId,
        title,
        year,
        posterPath,
        type: isMovie ? "movie" : "series",
        overview: item.overview ?? "",
        rating: item.vote_average ?? 0,
        radarrId,
        sonarrId,
        inLibrary,
        sources: inLibrary
          ? ([radarrId ? "radarr" : null, sonarrId ? "sonarr" : null].filter(Boolean) as UnifiedSearchResult["sources"])
          : ["tmdb"],
      };

      if (inLibrary) library.push(entry);
      else tmdbNotInLib.push(entry);
    }

    // Persons
    const persons: PersonResult[] = personResults.results.slice(0, 5).map((p) => ({
      id: p.id,
      name: p.name,
      profilePath: p.profile_path ? `${TMDB_IMAGE_BASE}/w185${p.profile_path}` : null,
      department: p.known_for_department ?? "",
      knownFor: p.known_for?.slice(0, 3).map((k) => k.title ?? k.name ?? "").filter(Boolean) ?? [],
    }));

    return { library, tmdb: tmdbNotInLib, persons };
  });

  return NextResponse.json(result);
}
