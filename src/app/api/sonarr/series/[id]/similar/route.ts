import { NextRequest, NextResponse } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { createTmdbClient, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { withCache, cachedSeries } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export interface SimilarSeries {
  tmdbId: number;
  sonarrId: number | null;
  title: string;
  year: number | null;
  posterPath: string | null;
  voteAverage: number;
  inLibrary: boolean;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const tmdb = createTmdbClient(getTmdbLocale(req.cookies.get("cine-lang")?.value));
  const id = Number(params.id);
  if (!tmdb.isEnabled()) return NextResponse.json({ items: [] });

  const series = await sonarr.getSeriesById(id).catch(() => null);
  if (!series) return NextResponse.json({ error: "Série introuvable" }, { status: 404 });

  const tmdbId = series.tmdbId;
  if (!tmdbId) return NextResponse.json({ items: [] });

  const items = await withCache<SimilarSeries[]>(`similar:series:${tmdbId}`, 6 * 60 * 60_000, async () => {
    const [recs, library] = await Promise.all([
      tmdb.tvRecommendations(tmdbId).catch(() => ({ results: [] })),
      cachedSeries().catch(() => []),
    ]);
    const byTmdbId = new Map(library.map((s) => [s.tmdbId ?? -1, s.id]));

    return (recs.results ?? [])
      .filter((r) => r.poster_path)
      .slice(0, 18)
      .map((r) => {
        const sonarrId = byTmdbId.get(r.id) ?? null;
        return {
          tmdbId: r.id,
          sonarrId: sonarrId ?? null,
          title: r.name ?? "",
          year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
          posterPath: r.poster_path ? `${TMDB_IMAGE_BASE}/w342${r.poster_path}` : null,
          voteAverage: r.vote_average ?? 0,
          inLibrary: sonarrId !== null,
        };
      });
  });

  return NextResponse.json({ items });
}
