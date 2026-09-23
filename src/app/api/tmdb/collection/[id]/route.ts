import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { cachedMovies } from "@/lib/server-cache";
import { withErrorHandling } from "@/lib/api-helpers";
import { withPersistentCache } from "@/lib/server-cache";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const locale = getTmdbLocale(req.cookies.get("cine-lang")?.value);
  const tmdb = createTmdbClient(locale);
  const collectionId = Number(params.id);
  if (!collectionId) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  if (!tmdb.isEnabled()) return NextResponse.json({ parts: [] });

  return withErrorHandling(async () => {
    const [collection, movies] = await Promise.all([
      // Une semaine, sur disque : une saga ne change pas de films d'un jour à l'autre. La réponse de
      // TMDB seule — ce qui est dans la bibliothèque est recalculé à chaque fois.
      withPersistentCache(`tmdb:collection:${locale}:${collectionId}`, 7 * 24 * 3600_000, () => tmdb.getCollection(collectionId)),
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
