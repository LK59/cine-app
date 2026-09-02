import { NextResponse } from "next/server";
import { cachedMovies, cachedJellyfinMoviesAdmin, findJellyfinMovieByTmdb } from "@/lib/server-cache";
import { posterUrl, backdropUrl, tmdbResize } from "@/lib/images";
import { getTitleLogo } from "@/lib/title-logo";
import type { RadarrMovie } from "@/lib/clients/radarr";

export interface CinemaMovie {
  radarrId: number;
  jellyfinItemId: string;
  tmdbId: number;
  title: string;
  year: number;
  posterUrl: string | null;
  backdropUrl: string | null;
  logoUrl: string | null;
  overview: string | null;
  imdbRating: string | null;
  genres: string[];
}

export interface CinemaMoviesPayload {
  genres: string[];
  rows: Record<string, CinemaMovie[]>;
  spotlight: CinemaMovie[];
}

// Bulk-included here (like poster/backdrop already were) rather than fetched per-item on focus
// — Cinema Mode's whole hero/detail idea is an instant title treatment, not a spinner-then-swap.
// getTitleLogo() is persistently cached 7 days per title (same cache the per-item
// /api/radarr/movies/[id]/info route already populates), so only the very first request after a
// cold cache pays the full TMDB round-trip for the whole library at once — every request after
// that, including this one, is cache reads only.
async function toCinemaMovie(m: RadarrMovie, jellyfinItemId: string): Promise<CinemaMovie> {
  return {
    radarrId: m.id,
    jellyfinItemId,
    tmdbId: m.tmdbId,
    title: m.title,
    year: m.year,
    posterUrl: posterUrl(m.images, "thumb"),
    backdropUrl: tmdbResize(backdropUrl(m.images, "full"), "w1280"),
    logoUrl: await getTitleLogo(m.tmdbId, "movie"),
    overview: m.overview ?? null,
    // Radarr already resolves this itself at add/refresh time (Skyhook) — free, no
    // OMDb/TMDB round trip needed, same field fetchHero() in the dashboard route uses.
    imdbRating: m.ratings?.imdb?.value != null ? m.ratings.imdb.value.toFixed(1) : null,
    genres: m.genres ?? [],
  };
}

// Cinema Mode is library-only and movies-only for now (series + their own season/episode
// screen are a follow-up) — every item returned here must already be playable, so items
// without a resolved Jellyfin match are skipped entirely rather than shown inert.
export async function GET() {
  const [movies, jellyfinMovies] = await Promise.all([cachedMovies(), cachedJellyfinMoviesAdmin()]);

  const downloaded = movies.filter((m) => m.hasFile);
  const matched = downloaded
    .map((m) => ({ m, jfItem: findJellyfinMovieByTmdb(jellyfinMovies, m.tmdbId, m.title, m.year, m.imdbId ?? null) }))
    .filter((x): x is { m: RadarrMovie; jfItem: NonNullable<typeof x.jfItem> } => x.jfItem !== null);

  const cinemaMovies = await Promise.all(matched.map(({ m, jfItem }) => toCinemaMovie(m, jfItem.Id)));

  const byRadarrId = new Map<number, CinemaMovie>();
  const rows: Record<string, CinemaMovie[]> = {};
  const genreSet = new Set<string>();

  for (const cinemaMovie of cinemaMovies) {
    byRadarrId.set(cinemaMovie.radarrId, cinemaMovie);
    for (const g of cinemaMovie.genres) {
      genreSet.add(g);
      (rows[g] ??= []).push(cinemaMovie);
    }
  }

  const spotlight = downloaded
    .filter((m) => byRadarrId.has(m.id) && m.added && m.added !== "0001-01-01T00:00:00Z")
    .sort((a, b) => new Date(b.added!).getTime() - new Date(a.added!).getTime())
    .slice(0, 10)
    .map((m) => byRadarrId.get(m.id)!);

  const payload: CinemaMoviesPayload = { genres: [...genreSet].sort(), rows, spotlight };
  return NextResponse.json(payload);
}
