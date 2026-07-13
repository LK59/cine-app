import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const tmdb = createTmdbClient(getTmdbLocale(req.cookies.get("cine-lang")?.value));
  const personId = Number(params.id);
  if (!personId) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  if (!tmdb.isEnabled()) return NextResponse.json({ credits: [] });

  return withErrorHandling(async () => {
    const [personFr, { cast }, movies, series] = await Promise.all([
      tmdb.getPersonDetails(personId).catch(() => null),
      tmdb.getPersonCredits(personId),
      cachedMovies().catch(() => []),
      cachedSeries().catch(() => []),
    ]);

    // If TMDB has no French biography, fall back to English
    const person =
      personFr?.biography
        ? personFr
        : await tmdb.getPersonDetails(personId).catch(() => personFr);

    const movieByTmdb = new Map(movies.map((m) => [m.tmdbId, m.id]));
    const seriesByTmdb = new Map(series.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, s.id]));

    // Deduplicate (same title can appear as multiple roles), keep highest popularity
    const seen = new Map<string, (typeof cast)[0]>();
    for (const c of cast) {
      const key = `${c.media_type}:${c.id}`;
      const existing = seen.get(key);
      if (!existing || c.popularity > existing.popularity) seen.set(key, c);
    }

    const credits = [...seen.values()]
      .map((c) => {
        const isMovie = c.media_type === "movie";
        const libraryId = isMovie ? movieByTmdb.get(c.id) : seriesByTmdb.get(c.id);
        return {
          tmdbId: c.id,
          title: (isMovie ? c.title : c.name) ?? "",
          year: new Date((isMovie ? c.release_date : c.first_air_date) ?? "").getFullYear() || null,
          posterPath: c.poster_path,
          mediaType: c.media_type,
          character: c.character,
          voteAverage: c.vote_average,
          inLibrary: Boolean(libraryId),
          libraryHref: libraryId
            ? isMovie ? `/radarr/${libraryId}` : `/sonarr/${libraryId}`
            : null,
        };
      })
      .sort((a, b) => {
        if (a.inLibrary !== b.inLibrary) return a.inLibrary ? -1 : 1;
        return b.voteAverage - a.voteAverage;
      });

    return {
      credits,
      name: personFr?.name ?? null,
      profilePath: personFr?.profile_path ?? null,
      biography: person?.biography ?? null,
      birthday: person?.birthday ?? null,
      deathday: person?.deathday ?? null,
      placeOfBirth: person?.place_of_birth ?? null,
      knownFor: person?.known_for_department ?? null,
    };
  });
}
