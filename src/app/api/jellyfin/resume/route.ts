import { NextRequest, NextResponse } from "next/server";
import { errorBody } from "@/lib/apiErrorCodes";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { jellyfin } from "@/lib/clients/jellyfin";
import { catalogueLinks, cinemaHrefOf } from "@/lib/sonarrLink";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { libraryIndex, withoutWatched } from "@/lib/watched";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) {
    return NextResponse.json({ items: [] });
  }

  const [rawResume, links, index] = await Promise.all([
    jellyfin.getResumeItems(session.jfId).catch(() => ({ Items: [] })),
    catalogueLinks(),
    libraryIndex(),
  ]);
  // Sans ce qui est vu (DECISIONS.md §51) : une série marquée vue, un film marqué vu depuis sa
  // dernière lecture. Le filtre est commun à « Reprendre » et « À suivre » (`withoutWatched`).
  const resumeData = { ...rawResume, Items: withoutWatched(session.jfId, rawResume.Items, index) };

  const items = resumeData.Items.map((item) => {
    const positionTicks = item.UserData?.PlaybackPositionTicks ?? 0;
    const runtimeTicks = item.RunTimeTicks ?? 0;
    const progress = runtimeTicks > 0 ? Math.min((positionTicks / runtimeTicks) * 100, 99) : 0;

    // La fiche, par le lien que le catalogue tient de chaque élément Jellyfin — le dossier, pas les
    // identifiants que Jellyfin a compris (DECISIONS.md §89). Seuls les titres du catalogue en ont un :
    // un film dont Radarr n'a plus le fichier (en pleine mise à niveau) n'ouvre pas une fiche
    // introuvable (23/09/2026) — sans lien, la carte lance la lecture, ce que Jellyfin sait encore
    // faire. Un épisode n'a pas de lien à lui : c'est celui de sa série.
    const cinemaHref = cinemaHrefOf(links.get(item.Type === "Episode" ? item.SeriesId ?? "" : item.Id));

    return {
      id: item.Id,
      name: item.Type === "Episode" && item.SeriesName ? item.SeriesName : item.Name,
      subtitle:
        item.Type === "Episode"
          ? `S${String(item.ParentIndexNumber ?? 1).padStart(2, "0")}E${String(item.IndexNumber ?? 1).padStart(2, "0")} · ${item.Name}`
          : null,
      type: item.Type,
      progress: Math.round(progress),
      // Ticks as well as the percentage: Cinema Mode's Continue Watching cards resume playback
      // from the exact position and label themselves with the time remaining.
      positionTicks,
      runtimeTicks,
      imageTag: item.ImageTags?.Primary ?? null,
      cinemaHref,
      // L'ordre de « Reprendre » : le dernier lu d'abord (`continueOrder`).
      lastPlayedAt: item.UserData?.LastPlayedDate ?? null,
    };
  });

  return NextResponse.json({ items });
}

/**
 * Retirer un titre de « Reprendre » : sa position est oubliée, rien d'autre (voir
 * `resetPlaybackPosition`). N'agit que sur le compte de l'appelant — l'identifiant Jellyfin vient
 * de la session, jamais de la requête.
 */
export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) {
    return NextResponse.json(errorBody("Compte Jellyfin requis", "jellyfin_account_required"), { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const itemId = body?.itemId;
  if (!isJellyfinId(itemId)) {
    return NextResponse.json(errorBody("Paramètres invalides", "invalid_request"), { status: 400 });
  }
  try {
    await jellyfin.resetPlaybackPosition(session.jfId, itemId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Erreur Jellyfin" }, { status: 502 });
  }
}
