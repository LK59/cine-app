import { NextResponse } from "next/server";
import { cachedMovies, cachedJellyfinMoviesAdmin, findJellyfinMovieByTmdb } from "@/lib/server-cache";
import { posterUrl, backdropUrl } from "@/lib/images";
import type { RadarrMovie } from "@/lib/clients/radarr";

export interface CinemaMovie {
  radarrId: number;
  jellyfinItemId: string;
  tmdbId: number;
  title: string;
  year: number;
  posterUrl: string | null;
  backdropUrl: string | null;
  overview: string | null;
  imdbRating: string | null;
  genres: string[];
}

export interface CinemaMoviesPayload {
  genres: string[];
  rows: Record<string, CinemaMovie[]>;
  spotlight: CinemaMovie[];
}

function toCinemaMovie(m: RadarrMovie, jellyfinItemId: string): CinemaMovie {
  return {
    radarrId: m.id,
    jellyfinItemId,
    tmdbId: m.tmdbId,
    title: m.title,
    year: m.year,
    posterUrl: posterUrl(m.images, "full"),
    backdropUrl: backdropUrl(m.images, "full"),
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
  const byRadarrId = new Map<number, CinemaMovie>();
  const rows: Record<string, CinemaMovie[]> = {};
  const genreSet = new Set<string>();

  for (const m of downloaded) {
    const jfItem = findJellyfinMovieByTmdb(jellyfinMovies, m.tmdbId, m.title, m.year, m.imdbId ?? null);
    if (!jfItem) continue;

    const cinemaMovie = toCinemaMovie(m, jfItem.Id);
    byRadarrId.set(m.id, cinemaMovie);
    for (const g of m.genres ?? []) {
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
