import { NextRequest, NextResponse } from "next/server";
import { omdb } from "@/lib/clients/omdb";
import { getImdbRating, getImdbRatingByTvdb } from "@/lib/imdb-rating";
import { kvCacheDb } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { createRateLimiter } from "@/lib/rateLimiter";

export const dynamic = "force-dynamic";

/**
 * La plus longue liste qu'un écran demande : la page Sonarr triée par note envoie tout le
 * catalogue filtré (140 séries le 26/09/2026), la liste « À voir » du tableau de bord treize
 * titres au plus. Large marge pour que la bibliothèque grandisse.
 */
const MAX_ITEMS = 500;

/**
 * Les notes encore inconnues qu'une seule demande peut aller chercher (08/10/2026).
 *
 * Chacune coûte un appel TMDB puis un appel OMDb, et OMDb en accorde mille par jour à toute
 * l'installation : une demande de cinq cents identifiants jamais vus en brûlait la moitié, et un
 * échec d'OMDb suspend les notes de tout le monde une heure. Au-delà, la note manque cette fois-ci
 * et arrive aux demandes suivantes — un écran n'en affiche de toute façon que quelques dizaines.
 */
const MAX_UNKNOWN = 50;
/** Une semaine, comme `imdb-rating.ts` : une note plus vieille sera redemandée. */
const RATING_TTL_MS = 7 * 24 * 3600_000;
/** Par compte : un écran redemande ses notes à l'ouverture, pas en boucle. */
const ratingsRateLimit = createRateLimiter(30, 60_000);

function ratingKey(item: { mediaType: "movie" | "series" | "tvdb"; id: number }): string {
  return item.mediaType === "tvdb" ? `imdb:rating:tvdb:${item.id}` : `imdb:rating:${item.mediaType}:${item.id}`;
}

function knownRating(key: string): boolean {
  try {
    const row = kvCacheDb.get(key);
    return !!row && Date.now() - row.fetchedAt < RATING_TTL_MS;
  } catch {
    return false;
  }
}

// GET /api/watchlist/ratings?items=movie:123,series:456,...
// Returns { "movie:123": "7.4", "series:456": "8.1", ... }
export async function GET(req: NextRequest) {
  if (!omdb.isEnabled()) return NextResponse.json({});

  const raw = req.nextUrl.searchParams.get("items") ?? "";
  if (!raw) return NextResponse.json({});

  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!ratingsRateLimit(session?.u ?? "anonyme")) {
    return NextResponse.json({ error: "Trop de demandes" }, { status: 429, headers: { "Retry-After": "60" } });
  }

  // `tvdb:` is the third kind, and the one Sonarr forces: it has no TMDB id of its own.
  // Dédoublonnée et bornée : chaque note inconnue coûte un appel TMDB puis OMDb (1 000 par jour
  // pour OMDb), et rien ne bornait la liste — une seule adresse à 10 000 identifiants inventés
  // épuisait le quota de la journée (26/09/2026). Au-delà de la borne, la liste est tronquée
  // plutôt que refusée : les notes manquantes s'affichent simplement sans badge.
  const items = [...new Set(raw.split(","))]
    .slice(0, MAX_ITEMS)
    .map((s) => {
      const [type, id] = s.split(":");
      return { key: s, mediaType: type as "movie" | "series" | "tvdb", id: Number(id) };
    })
    .filter((i) => i.id && (i.mediaType === "movie" || i.mediaType === "series" || i.mediaType === "tvdb"));

  const result: Record<string, string | null> = {};

  // All resolved concurrently — each call is individually cached so no stampede risk
  let unknown = 0;
  const ratings = await Promise.all(
    items.map((item) => {
      if (!knownRating(ratingKey(item)) && ++unknown > MAX_UNKNOWN) return Promise.resolve(null);
      return item.mediaType === "tvdb" ? getImdbRatingByTvdb(item.id) : getImdbRating(item.id, item.mediaType);
    })
  );
  items.forEach((item, i) => { result[item.key] = ratings[i]; });

  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
