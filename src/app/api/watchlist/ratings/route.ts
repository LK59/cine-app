import { NextRequest, NextResponse } from "next/server";
import { omdb } from "@/lib/clients/omdb";
import { getImdbRating, getImdbRatingByTvdb } from "@/lib/imdb-rating";

export const dynamic = "force-dynamic";

/**
 * La plus longue liste qu'un écran demande : la page Sonarr triée par note envoie tout le
 * catalogue filtré (140 séries le 26/09/2026), la liste « À voir » du tableau de bord treize
 * titres au plus. Large marge pour que la bibliothèque grandisse.
 */
const MAX_ITEMS = 500;

// GET /api/watchlist/ratings?items=movie:123,series:456,...
// Returns { "movie:123": "7.4", "series:456": "8.1", ... }
export async function GET(req: NextRequest) {
  if (!omdb.isEnabled()) return NextResponse.json({});

  const raw = req.nextUrl.searchParams.get("items") ?? "";
  if (!raw) return NextResponse.json({});

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
  const ratings = await Promise.all(
    items.map((item) =>
      item.mediaType === "tvdb" ? getImdbRatingByTvdb(item.id) : getImdbRating(item.id, item.mediaType)
    )
  );
  items.forEach((item, i) => { result[item.key] = ratings[i]; });

  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
