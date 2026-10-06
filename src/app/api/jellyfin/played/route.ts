import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { invalidateKey } from "@/lib/server-cache";
import { libraryIndex } from "@/lib/watched";
import { watchedDb } from "@/lib/db";


// « Ma liste » lit « vu » et « favoris » depuis deux requêtes ciblées, mises en cache : les
// vider ici évite qu'elle contredise, pendant la durée du cache, le geste qui vient de la
// changer. Deux clés, celles de cette personne seule.
function invalidateOwnLibrary(userId: string) {
  invalidateKey(`jf:played:${userId}`);
  invalidateKey(`jf:favorites:${userId}`);
}

async function mirrorMovie(jfId: string, itemId: string, played: boolean) {
  const title = (await libraryIndex())?.byJellyfinId.get(itemId);
  if (title?.type !== "movie") return;
  if (played) {
    const existing = watchedDb.get(jfId, "movie", title.tmdbId);
    watchedDb.upsert({ userId: jfId, mediaType: "movie", tmdbId: title.tmdbId, title: existing?.title ?? "", year: existing?.year ?? null, posterPath: existing?.posterPath ?? null, manual: false, jfPresent: true, jfPlayed: true, watchedAt: existing ? undefined : Date.now() });
  } else {
    watchedDb.remove(jfId, "movie", title.tmdbId);
  }
}

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  if (!session?.jfId) {
    return NextResponse.json({ error: "Compte Jellyfin requis" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const itemId = body?.itemId as string | undefined;
  const played = body?.played as boolean | undefined;

  // Écrit avec la clé d'administration : un identifiant qui n'en est pas un est refusé ici,
  // avant tout appel (`jellyfinIdSegment` le refuserait aussi, mais en 502).
  if (!isJellyfinId(itemId) || typeof played !== "boolean") {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }

  try {
    if (played) {
      await jellyfin.markPlayed(session.jfId, itemId);
    } else {
      await jellyfin.markUnplayed(session.jfId, itemId);
    }
    invalidateOwnLibrary(session.jfId);
    // La copie locale suit aussitôt (DECISIONS.md §51) — pour un film seulement : un épisode n'a
    // pas de ligne à lui, et une série cochée ici (pages d'administration) l'est épisode par
    // épisode chez Jellyfin, ce que la synchronisation recopiera.
    await mirrorMovie(session.jfId, itemId, played).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur Jellyfin" },
      { status: 502 }
    );
  }
}
