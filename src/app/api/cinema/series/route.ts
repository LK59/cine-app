import { NextResponse } from "next/server";
import { cachedSeries, cachedJellyfinSeriesAdmin, findJellyfinSeriesByTvdb } from "@/lib/server-cache";
import { posterUrl, backdropUrl } from "@/lib/images";
import { getTitleLogo } from "@/lib/title-logo";
import { getImdbRating } from "@/lib/imdb-rating";
import type { SonarrSeries } from "@/lib/clients/sonarr";

export interface CinemaSeries {
  sonarrId: number;
  jellyfinItemId: string;
  tvdbId: number;
  tmdbId: number | null;
  title: string;
  year: number;
  posterUrl: string | null;
  backdropUrl: string | null;
  logoUrl: string | null;
  overview: string | null;
  imdbRating: string | null;
  genres: string[];
}

export interface CinemaSeriesPayload {
  genres: string[];
  rows: Record<string, CinemaSeries[]>;
  spotlight: CinemaSeries[];
}

// Mirrors /api/cinema/movies/route.ts exactly (see its own comments for the reasoning behind
// each choice — bulk-included logo/rating, jellyfin-match-required filtering, genre rows +
// spotlight) — the one real difference is IMDb rating: Radarr resolves that for movies itself
// (Skyhook, free), but Sonarr doesn't for series, hence the extra getImdbRating() call here
// (OMDb-backed, 24h persistently cached — same helper the dashboard route already uses for its
// own "recently added series" rail).
async function toCinemaSeries(s: SonarrSeries, jellyfinItemId: string): Promise<CinemaSeries> {
  return {
    sonarrId: s.id,
    jellyfinItemId,
    tvdbId: s.tvdbId,
    tmdbId: s.tmdbId ?? null,
    title: s.title,
    year: s.year,
    posterUrl: posterUrl(s.images, "full"),
    backdropUrl: backdropUrl(s.images, "full"),
    logoUrl: await getTitleLogo(s.tmdbId ?? 0, "series"),
    overview: s.overview ?? null,
    imdbRating: s.tmdbId ? await getImdbRating(s.tmdbId, "series") : null,
    genres: s.genres ?? [],
  };
}

// Library-only, same as movies: every item returned here must already have at least one
// downloaded episode AND a resolved Jellyfin match — a series with neither isn't playable, so
// it's skipped entirely rather than shown inert. Season/episode-level Cinema Mode (browsing what
// episodes actually exist) is a separate route — this one is just the browse grid.
export async function GET() {
  const [series, jellyfinSeries] = await Promise.all([cachedSeries(), cachedJellyfinSeriesAdmin()]);

  const downloaded = series.filter((s) => (s.statistics?.episodeFileCount ?? 0) > 0);
  const matched = downloaded
    .map((s) => ({ s, jfItem: findJellyfinSeriesByTvdb(jellyfinSeries, s.tvdbId, s.title, s.year) }))
    .filter((x): x is { s: SonarrSeries; jfItem: NonNullable<typeof x.jfItem> } => x.jfItem !== null);

  const cinemaSeries = await Promise.all(matched.map(({ s, jfItem }) => toCinemaSeries(s, jfItem.Id)));

  const bySonarrId = new Map<number, CinemaSeries>();
  const rows: Record<string, CinemaSeries[]> = {};
  const genreSet = new Set<string>();

  for (const cs of cinemaSeries) {
    bySonarrId.set(cs.sonarrId, cs);
    for (const g of cs.genres) {
      genreSet.add(g);
      (rows[g] ??= []).push(cs);
    }
  }

  const spotlight = downloaded
    .filter((s) => bySonarrId.has(s.id) && s.added && s.added !== "0001-01-01T00:00:00Z")
    .sort((a, b) => new Date(b.added!).getTime() - new Date(a.added!).getTime())
    .slice(0, 10)
    .map((s) => bySonarrId.get(s.id)!);

  const payload: CinemaSeriesPayload = { genres: [...genreSet].sort(), rows, spotlight };
  return NextResponse.json(payload);
}
