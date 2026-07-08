import { NextResponse } from "next/server";
import { tmdb, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { withCache, cachedMovies, cachedSeries } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export interface PeopleStat {
  name: string;
  count: number;
  photoUrl: string | null;
  tmdbId: number;
}

export interface PeopleStats {
  topActors: PeopleStat[];
  topDirectors: PeopleStat[];
}

interface CreditsResult {
  created_by?: { id: number; name: string; profile_path?: string | null }[];
  credits?: {
    cast?: { id: number; name: string; profile_path?: string | null }[];
    crew?: { id: number; name: string; job: string; profile_path?: string | null }[];
  };
}

export async function GET() {
  if (!tmdb.isEnabled()) return NextResponse.json({ topActors: [], topDirectors: [] } satisfies PeopleStats);

  const data = await withCache<PeopleStats>("stats:people:v5", 6 * 3600_000, async () => {
    const [movies, series] = await Promise.all([
      cachedMovies().catch(() => []),
      cachedSeries().catch(() => []),
    ]);

    const eligibleMovies = movies.filter((m) => m.tmdbId && m.hasFile);
    const eligibleSeries = series.filter((s) => s.tmdbId && (s.statistics?.episodeFileCount ?? 0) > 0);

    // Fetch credits for movies and series in parallel (cached per item for 7 days)
    const [movieResults, seriesResults] = await Promise.all([
      Promise.allSettled(
        eligibleMovies.map((m) =>
          withCache(`credits:movie:${m.tmdbId}`, 7 * 24 * 3600_000, () =>
            tmdb.getMovie(m.tmdbId).catch(() => null)
          )
        )
      ),
      Promise.allSettled(
        eligibleSeries.map((s) =>
          withCache(`credits:tv:${s.tmdbId}`, 7 * 24 * 3600_000, () =>
            tmdb.getTv(s.tmdbId!).catch(() => null)
          )
        )
      ),
    ]);

    const actorCount = new Map<number, { name: string; count: number; photoUrl: string | null }>();
    const directorCount = new Map<number, { name: string; count: number; photoUrl: string | null }>();

    function addDirector(id: number, name: string, profilePath?: string | null) {
      const existing = directorCount.get(id);
      if (existing) existing.count++;
      else directorCount.set(id, {
        name,
        count: 1,
        photoUrl: profilePath ? `${TMDB_IMAGE_BASE}/w185${profilePath}` : null,
      });
    }

    function processCredits(result: PromiseSettledResult<CreditsResult | null>) {
      if (result.status !== "fulfilled" || !result.value) return;
      const credits = result.value.credits;

      for (const actor of (credits?.cast ?? []).slice(0, 50)) {
        const existing = actorCount.get(actor.id);
        if (existing) existing.count++;
        else actorCount.set(actor.id, {
          name: actor.name,
          count: 1,
          photoUrl: actor.profile_path ? `${TMDB_IMAGE_BASE}/w185${actor.profile_path}` : null,
        });
      }

      for (const creator of result.value.created_by ?? []) {
        addDirector(creator.id, creator.name, creator.profile_path);
      }

      for (const crew of credits?.crew ?? []) {
        if (crew.job !== "Director") continue;
        addDirector(crew.id, crew.name, crew.profile_path);
      }
    }

    for (const r of movieResults) processCredits(r as PromiseSettledResult<CreditsResult | null>);
    for (const r of seriesResults) processCredits(r as PromiseSettledResult<CreditsResult | null>);

    const topActors: PeopleStat[] = [...actorCount.entries()]
      .map(([id, v]) => ({ tmdbId: id, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    const topDirectors: PeopleStat[] = [...directorCount.entries()]
      .map(([id, v]) => ({ tmdbId: id, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    return { topActors, topDirectors };
  });

  return NextResponse.json(data);
}
