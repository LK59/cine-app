import { NextRequest, NextResponse } from "next/server";
import { tmdb } from "@/lib/clients/tmdb";
import { cachedMovies } from "@/lib/server-cache";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const collectionId = Number(params.id);
  if (!collectionId) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  if (!tmdb.isEnabled()) return NextResponse.json({ parts: [] });

  return withErrorHandling(async () => {
    const [collection, movies] = await Promise.all([
      tmdb.getCollection(collectionId),
      cachedMovies().catch(() => []),
    ]);

    const movieByTmdb = new Map(movies.map((m) => [m.tmdbId, m.id]));

    const parts = [...collection.parts]
      .sort((a, b) => (a.release_date ?? "").localeCompare(b.release_date ?? ""))
      .map((p) => {
        const libraryId = movieByTmdb.get(p.id);
        return {
          tmdbId: p.id,
          title: p.title,
          year: p.release_date ? new Date(p.release_date).getFullYear() : null,
          posterPath: p.poster_path,
          voteAverage: p.vote_average,
          inLibrary: Boolean(libraryId),
          libraryHref: libraryId ? `/radarr/${libraryId}` : null,
        };
      });

    return { name: collection.name, overview: collection.overview, parts };
  });
}
