import { NextRequest, NextResponse } from "next/server";
import { cachedMovies, cachedJellyfinMovies, cachedJellyfinMoviesAdmin, findJellyfinMovieByTmdb } from "@/lib/server-cache";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { posterUrl, backdropUrl, tmdbResize } from "@/lib/images";
import { getTitleArt } from "@/lib/title-art";
import { recentlyAddedRail, top10Rail } from "@/lib/cinemaRails";
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
  /**
   * L'affiche sans le titre imprimé dessus, quand TMDB en a une.
   *
   * Elle ne remplace l'affiche ordinaire que là où l'on pose déjà notre propre logo par-dessus —
   * la bannière du téléphone. Ailleurs (les rangées), le titre écrit sur l'affiche est justement
   * ce qui permet de la reconnaître, et on garde l'affiche ordinaire.
   */
  posterTextlessUrl: string | null;
  overview: string | null;
  imdbRating: string | null;
  genres: string[];
  // Drives the "Nouveau" badge and the "Récemment ajoutés" rail. Null when Radarr has no real
  // date for it (its "never" sentinel included — see lib/cinemaRails).
  addedAt: string | null;
}

export interface CinemaMoviesPayload {
  genres: string[];
  rows: Record<string, CinemaMovie[]>;
  spotlight: CinemaMovie[];
  // Curated rails, computed here so the movie and series screens can't drift apart on what they
  // mean (see lib/cinemaRails for each one's definition).
  recentlyAdded: CinemaMovie[];
  top10: CinemaMovie[];
}

// Bulk-included here (like poster/backdrop already were) rather than fetched per-item on focus
// — Cinema Mode's whole hero/detail idea is an instant title treatment, not a spinner-then-swap.
// getTitleLogo() is persistently cached 7 days per title (same cache the per-item
// /api/radarr/movies/[id]/info route already populates), so only the very first request after a
// cold cache pays the full TMDB round-trip for the whole library at once — every request after
// that, including this one, is cache reads only.
async function toCinemaMovie(m: RadarrMovie, jellyfinItemId: string): Promise<CinemaMovie> {
  // Le logo et l'affiche sans texte viennent de la même réponse TMDB et de la même entrée de
  // cache : la seconde ne coûte donc pas un appel de plus.
  const art = await getTitleArt(m.tmdbId, "movie");
  return {
    radarrId: m.id,
    jellyfinItemId,
    tmdbId: m.tmdbId,
    title: m.title,
    year: m.year,
    posterUrl: posterUrl(m.images, "thumb"),
    backdropUrl: tmdbResize(backdropUrl(m.images, "full"), "w1280"),
    logoUrl: art.logoUrl,
    posterTextlessUrl: art.posterTextlessUrl,
    overview: m.overview ?? null,
    // Radarr already resolves this itself at add/refresh time (Skyhook) — free, no
    // OMDb/TMDB round trip needed, same field fetchHero() in the dashboard route uses.
    imdbRating: m.ratings?.imdb?.value != null ? m.ratings.imdb.value.toFixed(1) : null,
    genres: m.genres ?? [],
    addedAt: m.added ?? null,
  };
}

// Cinema Mode is library-only and movies-only for now (series + their own season/episode
// screen are a follow-up) — every item returned here must already be playable, so items
// without a resolved Jellyfin match are skipped entirely rather than shown inert.

/**
 * La bibliothèque de la personne connectée, et non celle de l'administrateur.
 *
 * Ces deux routes lisaient `cachedJellyfin*Admin()`, c'est-à-dire la vue d'un compte qui voit
 * tout. Tant que toutes les bibliothèques sont ouvertes à tout le monde, ça ne se voit pas ; le
 * jour où l'une est restreinte, la personne verrait les titres au catalogue et se prendrait un
 * refus au moment de lancer la lecture — un défaut silencieux, jusqu'à ce qu'il ne le soit plus.
 *
 * La vue administrateur reste le repli pour la connexion locale, qui n'a pas de compte Jellyfin
 * associé et n'aurait donc aucune bibliothèque à consulter.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  const [movies, jellyfinMovies] = await Promise.all([
    cachedMovies(),
    session?.jfId ? cachedJellyfinMovies(session.jfId) : cachedJellyfinMoviesAdmin(),
  ]);

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

  const payload: CinemaMoviesPayload = {
    genres: [...genreSet].sort(),
    rows,
    spotlight,
    recentlyAdded: recentlyAddedRail(cinemaMovies),
    top10: top10Rail(cinemaMovies),
  };
  return NextResponse.json(payload);
}
