import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { jellyfin } from "@/lib/clients/jellyfin";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { isWatchedLocally, libraryIndex } from "@/lib/watched";

export interface CinemaProgressPayload {
  resumeTicks: number | null;
  runtimeTicks: number | null;
  /**
   * « Vu » et « Favori » viennent d'ici, et non de la base locale.
   *
   * Chaque liste est stockée là où vit sa vérité : Jellyfin tient déjà ces deux états pour ses
   * propres applications, et une seconde copie chez nous finirait par diverger — un épisode
   * regardé sur la télé, un favori ajouté depuis le téléphone. Ils arrivent dans la même réponse
   * que la progression, qui lit déjà exactement le même objet UserData.
   */
  played: boolean;
  favorite: boolean;
  /**
   * A-t-on réellement pu lire ces deux états.
   *
   * Faux quand Jellyfin n'a pas répondu, ou quand la connexion n'a pas d'identité Jellyfin —
   * l'administrateur local. `played: false` voulait alors dire « pas vu » à une interface qui
   * proposait aussitôt de le marquer comme vu : une lecture ratée se transformait en écriture.
   */
  known: boolean;
}

// A movie's own Jellyfin watch progress — CinemaMovie (the /api/cinema/movies payload) carries no
// per-user UserData at all (Radarr/TMDB fields only, shared across every viewer), so CinemaMovieDetail's
// own Play button had nothing to resume from and always started a partly-watched movie over from
// 0 unless you happened to open it via the Continue Watching row instead (which gets its resume
// point from a different endpoint entirely — Jellyfin's own resume list). This is the movie-sheet
// equivalent of what the episodes route already does for series' nextEpisode.
async function seriesMarkedHere(session: { jfId?: string; u: string }, itemId: string): Promise<boolean> {
  try {
    const index = await libraryIndex();
    const title = index?.byJellyfinId.get(itemId);
    return title?.type === "series" ? isWatchedLocally(session.jfId ?? session.u, "series", title.tmdbId) : false;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  // Même raison que les deux autres routes de lecture : `getItemUserData` l'interpole dans
  // `/Users/{userId}/Items/{itemId}` et signe avec la clé d'administration.
  if (!isJellyfinId(itemId)) return NextResponse.json({ error: "Identifiant invalide" }, { status: 400 });
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) {
    return NextResponse.json({ resumeTicks: null, runtimeTicks: null, played: false, favorite: false, known: false });
  }

  const item = await jellyfin.getItemUserData(session.jfId, itemId).catch(() => null);
  const payload: CinemaProgressPayload = {
    resumeTicks: item?.UserData?.PlaybackPositionTicks ?? null,
    runtimeTicks: item?.RunTimeTicks ?? null,
    // Une série marquée vue à la main l'est sans qu'aucun épisode soit coché (DECISIONS.md §51) :
    // l'état de série vit chez nous. Un film, lui, suit Jellyfin, qui fait foi tant qu'il l'a.
    played: Boolean(item?.UserData?.Played) || (await seriesMarkedHere(session, itemId)),
    favorite: Boolean(item?.UserData?.IsFavorite),
    known: item !== null,
  };
  return NextResponse.json(payload);
}
