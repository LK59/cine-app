import { NextResponse } from "next/server";
import { tmdb, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { withCache, cachedMovies } from "@/lib/server-cache";

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

export async function GET() {
  if (!tmdb.isEnabled()) return NextResponse.json({ topActors: [], topDirectors: [] } satisfies PeopleStats);

  const data = await withCache<PeopleStats>("stats:people", 6 * 3600_000, async () => {
    const movies = (await cachedMovies().catch(() => [])).filter((m) => m.tmdbId && m.hasFile).slice(0, 40);

    const results = await Promise.allSettled(
      movies.map((m) =>
        withCache(`movie-credits:${m.tmdbId}`, 7 * 24 * 3600_000, () =>
          tmdb.getMovie(m.tmdbId).catch(() => null)
        )
      )
    );

    const actorCount = new Map<number, { name: string; count: number; photoUrl: string | null }>();
    const directorCount = new Map<number, { name: string; count: number; photoUrl: string | null }>();

    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const details = r.value as { credits?: { cast?: { id: number; name: string; profile_path?: string | null }[]; crew?: { id: number; name: string; job: string; profile_path?: string | null }[] } };
      const credits = details.credits;
      if (!credits) continue;

      for (const actor of (credits.cast ?? []).slice(0, 10)) {
        const existing = actorCount.get(actor.id);
        if (existing) existing.count++;
        else actorCount.set(actor.id, {
          name: actor.name,
          count: 1,
          photoUrl: actor.profile_path ? `${TMDB_IMAGE_BASE}/w185${actor.profile_path}` : null,
        });
      }

      for (const crew of credits.crew ?? []) {
        if (crew.job !== "Director") continue;
        const existing = directorCount.get(crew.id);
        if (existing) existing.count++;
        else directorCount.set(crew.id, {
          name: crew.name,
          count: 1,
          photoUrl: crew.profile_path ? `${TMDB_IMAGE_BASE}/w185${crew.profile_path}` : null,
        });
      }
    }

    const topActors: PeopleStat[] = [...actorCount.entries()]
      .map(([id, v]) => ({ tmdbId: id, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topDirectors: PeopleStat[] = [...directorCount.entries()]
      .map(([id, v]) => ({ tmdbId: id, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return { topActors, topDirectors };
  });

  return NextResponse.json(data);
}
