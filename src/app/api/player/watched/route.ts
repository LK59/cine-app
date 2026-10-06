import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { libraryIndex, setWatched, type WatchedType } from "@/lib/watched";

export const dynamic = "force-dynamic";

/**
 * Marquer ou démarquer un titre « vu » (DECISIONS.md §51) — depuis une fiche de la bibliothèque,
 * une fiche de découverte (titre absent de Jellyfin) ou « Ma liste ».
 *
 * `{ type, tmdbId, watched, title?, year?, posterPath? }`, ou `{ itemId, watched }` depuis une fiche
 * de la bibliothèque, qui connaît l'élément Jellyfin et pas toujours le titre TMDB. Une série n'est
 * marquée qu'au niveau de la série : aucun de ses épisodes n'est coché (`setWatched`).
 */
export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.watched !== "boolean") return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });

  let type: WatchedType | null = body.type === "movie" || body.type === "series" ? body.type : null;
  let tmdbId = typeof body.tmdbId === "number" && Number.isInteger(body.tmdbId) && body.tmdbId > 0 ? body.tmdbId : null;
  if ((!type || !tmdbId) && isJellyfinId(body.itemId)) {
    const title = (await libraryIndex())?.byJellyfinId.get(body.itemId as string);
    if (title) ({ type, tmdbId } = title);
  }
  if (!type || !tmdbId) return NextResponse.json({ error: "Titre introuvable" }, { status: 404 });

  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  try {
    const result = await setWatched({ userId: session.jfId ?? session.u, jfId: session.jfId ?? null }, type, tmdbId, body.watched, {
      title: text(body.title, 300),
      year: typeof body.year === "number" ? body.year : null,
      posterPath: text(body.posterPath, 300) ?? null,
    });
    return NextResponse.json({ ok: true, type, tmdbId, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur Jellyfin" }, { status: 502 });
  }
}
