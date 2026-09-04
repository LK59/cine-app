import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { cachedMovies, cachedSeries, withCache, TTL } from "@/lib/server-cache";
import { getTmdbLocale, LOCALE_COOKIE } from "@/lib/i18n";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { withErrorHandling } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export interface DiscoveryItem {
  tmdbId: number;
  type: "movie" | "series";
  title: string;
  year: number | null;
  poster: string | null;
  /** L'identifiant de la fiche cinéma quand on l'a déjà — sinon la fiche TMDB s'ouvre. */
  libraryId: number | null;
}

export interface DiscoveryRow {
  key: string;
  items: DiscoveryItem[];
}

export interface PlayerDiscoverPayload {
  rows: DiscoveryRow[];
}

const ROW_SIZE = 24;

/**
 * Découverte et recommandations, en lignes.
 *
 * Elles étaient deux pages entières côté gestion. Ici ce sont des rangées : dans une interface
 * qui n'est déjà faite que de rangées, ça ne coûte presque rien et ça évite deux entrées de plus
 * dans le rail — dont personne n'a besoin pour savoir ce qu'il a envie de regarder.
 *
 * Ce qui est déjà là ouvre sa fiche, ce qui ne l'est pas ouvre la fiche TMDB avec « Demander ».
 * Rien ne distingue les deux à part une pastille : c'est un seul catalogue, dont une partie est
 * immédiate et l'autre demande un peu de patience.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const locale = getTmdbLocale(req.cookies.get(LOCALE_COOKIE)?.value);
  const tmdb = createTmdbClient(locale);
  if (!tmdb.isEnabled()) return NextResponse.json({ rows: [] } satisfies PlayerDiscoverPayload);

  return withErrorHandling(async () => {
    // Les tendances sont les mêmes pour tout le monde et changent une fois par semaine : un cache
    // partagé évite de refaire l'appel pour chaque personne qui ouvre l'accueil.
    const [movies, tv, library, seriesLibrary] = await Promise.all([
      withCache(`tmdb:trending:movie:${locale}`, TTL.LONG, () => tmdb.trendingMovies()).catch(() => ({ results: [] })),
      withCache(`tmdb:trending:tv:${locale}`, TTL.LONG, () => tmdb.trendingTv()).catch(() => ({ results: [] })),
      cachedMovies().catch(() => []),
      cachedSeries().catch(() => []),
    ]);

    const movieLibrary = new Map(library.map((m) => [m.tmdbId, m.id]));
    const tvLibrary = new Map(seriesLibrary.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, s.id]));

    const rows: DiscoveryRow[] = [
      {
        key: "trendingMovies",
        items: movies.results.slice(0, ROW_SIZE).map((m): DiscoveryItem => ({
          tmdbId: m.id,
          type: "movie",
          title: m.title,
          year: m.release_date ? Number.parseInt(m.release_date.slice(0, 4), 10) || null : null,
          poster: m.poster_path ? `${TMDB_IMAGE_BASE}/w342${m.poster_path}` : null,
          libraryId: movieLibrary.get(m.id) ?? null,
        })),
      },
      {
        key: "trendingSeries",
        items: tv.results.slice(0, ROW_SIZE).map((s): DiscoveryItem => ({
          tmdbId: s.id,
          type: "series",
          title: s.name,
          year: s.first_air_date ? Number.parseInt(s.first_air_date.slice(0, 4), 10) || null : null,
          poster: s.poster_path ? `${TMDB_IMAGE_BASE}/w342${s.poster_path}` : null,
          libraryId: tvLibrary.get(s.id) ?? null,
        })),
      },
    ].filter((row) => row.items.length > 0);

    return { rows } satisfies PlayerDiscoverPayload;
  }, "player-discover");
}
