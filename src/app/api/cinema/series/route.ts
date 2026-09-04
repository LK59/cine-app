import { NextRequest, NextResponse } from "next/server";
import { cachedSeries, cachedJellyfinSeries, cachedJellyfinSeriesAdmin, findJellyfinSeriesByTvdb } from "@/lib/server-cache";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { posterUrl, backdropUrl, tmdbResize } from "@/lib/images";
import { getTitleLogo } from "@/lib/title-logo";
import { getImdbRating } from "@/lib/imdb-rating";
import { recentlyAddedRail, top10Rail } from "@/lib/cinemaRails";
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
  // Same role as the movie payload's own field — the "Nouveau" badge and the recently-added rail.
  addedAt: string | null;
}

export interface CinemaSeriesPayload {
  genres: string[];
  rows: Record<string, CinemaSeries[]>;
  spotlight: CinemaSeries[];
  recentlyAdded: CinemaSeries[];
  top10: CinemaSeries[];
}

// Mirrors /api/cinema/movies/route.ts exactly (see its own comments for the reasoning behind
// each choice — bulk-included logo/rating, jellyfin-match-required filtering, genre rows +
// spotlight) — the one real difference is IMDb rating: Radarr resolves that for movies itself
// (Skyhook, free), but Sonarr doesn't for series, hence the extra getImdbRating() call here
// (OMDb-backed, 24h persistently cached — same helper the dashboard route already uses for its
// own "recently added series" rail).
async function toCinemaSeries(s: SonarrSeries, jellyfinItemId: string): Promise<CinemaSeries> {
  // Independent lookups (different upstreams, different cache keys) — run concurrently rather
  // than one after the other, halving the cold-cache latency per series that hasn't been seen
  // by either cache before (steady state is unaffected either way, both are cache reads then).
  const [logoUrl, imdbRating] = await Promise.all([
    getTitleLogo(s.tmdbId ?? 0, "series"),
    s.tmdbId ? getImdbRating(s.tmdbId, "series") : Promise.resolve(null),
  ]);
  return {
    sonarrId: s.id,
    jellyfinItemId,
    tvdbId: s.tvdbId,
    tmdbId: s.tmdbId ?? null,
    title: s.title,
    year: s.year,
    posterUrl: posterUrl(s.images, "thumb"),
    backdropUrl: tmdbResize(backdropUrl(s.images, "full"), "w1280"),
    logoUrl,
    overview: s.overview ?? null,
    imdbRating,
    genres: s.genres ?? [],
    addedAt: s.added ?? null,
  };
}

// Library-only, same as movies: every item returned here must already have at least one
// downloaded episode AND a resolved Jellyfin match — a series with neither isn't playable, so
// it's skipped entirely rather than shown inert. Season/episode-level Cinema Mode (browsing what
// episodes actually exist) is a separate route — this one is just the browse grid.

/**
 * La bibliothèque de la personne connectée, et non celle de l'administrateur — voir la note
 * jumelle dans la route des films.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  const [series, jellyfinSeries] = await Promise.all([
    cachedSeries(),
    session?.jfId ? cachedJellyfinSeries(session.jfId) : cachedJellyfinSeriesAdmin(),
  ]);

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

  const payload: CinemaSeriesPayload = {
    genres: [...genreSet].sort(),
    rows,
    spotlight,
    recentlyAdded: recentlyAddedRail(cinemaSeries),
    top10: top10Rail(cinemaSeries),
  };
  return NextResponse.json(payload);
}
