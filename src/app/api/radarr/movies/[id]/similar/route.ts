import { NextRequest, NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { createTmdbClient, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { withCache, cachedMovies } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export interface SimilarMovie {
  tmdbId: number;
  radarrId: number | null;
  title: string;
  year: number | null;
  posterPath: string | null;
  voteAverage: number;
  inLibrary: boolean;
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const tmdb = createTmdbClient(getTmdbLocale(req.cookies.get("cine-lang")?.value));
  const id = Number(params.id);
  if (!tmdb.isEnabled()) return NextResponse.json({ items: [] });

  const movie = await radarr.getMovie(id).catch(() => null);
  if (!movie) return NextResponse.json({ error: "Film introuvable" }, { status: 404 });

  const items = await withCache<SimilarMovie[]>(`similar:movie:${movie.tmdbId}`, 6 * 60 * 60_000, async () => {
    const [recs, library] = await Promise.all([
      tmdb.movieRecommendations(movie.tmdbId).catch(() => ({ results: [] })),
      cachedMovies().catch(() => []),
    ]);
    const byTmdbId = new Map(library.map((m) => [m.tmdbId, m.id]));

    return (recs.results ?? [])
      .filter((r) => r.poster_path)
      .slice(0, 18)
      .map((r) => {
        const radarrId = byTmdbId.get(r.id) ?? null;
        return {
          tmdbId: r.id,
          radarrId: radarrId ?? null,
          title: r.title ?? "",
          year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
          posterPath: r.poster_path ? `${TMDB_IMAGE_BASE}/w342${r.poster_path}` : null,
          voteAverage: r.vote_average ?? 0,
          inLibrary: radarrId !== null,
        };
      });
  });

  return NextResponse.json({ items });
}
