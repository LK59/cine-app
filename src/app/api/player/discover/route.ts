import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { withCache, TTL, getProviderIdCI } from "@/lib/server-cache";
import { playableLibrary } from "@/lib/playerLibrary";
import { jellyfin } from "@/lib/clients/jellyfin";
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
 * Combien de films récemment regardés servent de graine aux recommandations.
 *
 * Trois, et pas huit comme la page dédiée : chaque graine coûte un appel TMDB, et une rangée n'a
 * de place que pour vingt-quatre affiches de toute façon. Au-delà, on paierait des appels pour
 * des titres qui ne seraient jamais affichés.
 */
const SEED_COUNT = 3;

/**
 * Les recommandations de la personne, à partir de ce qu'elle a regardé en dernier.
 *
 * Même principe que la page « Recommandations » du côté gestion, en plus court : Jellyfin donne
 * les derniers films joués (triés par date de lecture, ce que les listes ordinaires ne font pas),
 * TMDB dit ce qui leur ressemble. Sans compte Jellyfin il n'y a pas d'historique, donc pas de
 * rangée — et c'est mieux qu'une rangée générique déguisée en recommandation personnelle.
 */
async function recommendedFor(
  userId: string | null,
  tmdb: ReturnType<typeof createTmdbClient>,
  locale: string
): Promise<{ id: number; title: string; year: number | null; posterPath: string | null }[]> {
  if (!userId) return [];
  return withCache(`player:reco:${userId}:${locale}`, TTL.MEDIUM, async () => {
    const played = await jellyfin.getRecentlyPlayed(userId, "Movie", SEED_COUNT).catch(() => null);
    const seeds = (played?.Items ?? [])
      .map((item) => Number(getProviderIdCI(item.ProviderIds as Record<string, string> | undefined, "tmdb") ?? 0))
      .filter((id) => id > 0);
    if (seeds.length === 0) return [];

    const batches = await Promise.allSettled(seeds.map((id) => tmdb.movieRecommendations(id)));
    const seen = new Set<number>(seeds);
    const out: { id: number; title: string; year: number | null; posterPath: string | null }[] = [];
    // Entrelacé plutôt que concaténé : trois films d'affilée tirés de la même graine donnent
    // l'impression d'une rangée qui n'a qu'une idée.
    const lists = batches.map((b) => (b.status === "fulfilled" ? b.value.results : []));
    for (let i = 0; out.length < ROW_SIZE && lists.some((l) => i < l.length); i++) {
      for (const list of lists) {
        const r = list[i];
        if (!r || seen.has(r.id) || !r.poster_path || r.vote_average <= 6) continue;
        seen.add(r.id);
        out.push({
          id: r.id,
          title: r.title,
          year: r.release_date ? Number.parseInt(r.release_date.slice(0, 4), 10) || null : null,
          posterPath: r.poster_path,
        });
        if (out.length >= ROW_SIZE) break;
      }
    }
    return out;
  });
}

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
    const [movies, tv, lib, recommended] = await Promise.all([
      withCache(`tmdb:trending:movie:${locale}`, TTL.LONG, () => tmdb.trendingMovies()).catch(() => ({ results: [] })),
      withCache(`tmdb:trending:tv:${locale}`, TTL.LONG, () => tmdb.trendingTv()).catch(() => ({ results: [] })),
      playableLibrary(),
      recommendedFor(session.jfId ?? null, tmdb, locale).catch(() => []),
    ]);

    // Seulement ce qui est ouvrable : un titre surveillé sans fichier doit porter la pastille et
    // mener à sa fiche TMDB, pas à une fiche de bibliothèque qui n'existe pas.
    const movieLibrary = new Map([...lib.movies].map(([tmdbId, m]) => [tmdbId, m.id]));
    const tvLibrary = new Map([...lib.series].map(([tmdbId, s]) => [tmdbId, s.id]));

    const rows: DiscoveryRow[] = [
      {
        key: "recommended",
        items: recommended.map((r): DiscoveryItem => ({
          tmdbId: r.id,
          type: "movie",
          title: r.title,
          year: r.year,
          poster: r.posterPath ? `${TMDB_IMAGE_BASE}/w342${r.posterPath}` : null,
          libraryId: movieLibrary.get(r.id) ?? null,
        })),
      },
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
