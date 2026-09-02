import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { jellyfin } from "@/lib/clients/jellyfin";

export interface CinemaProgressPayload {
  resumeTicks: number | null;
  runtimeTicks: number | null;
}

// A movie's own Jellyfin watch progress — CinemaMovie (the /api/cinema/movies payload) carries no
// per-user UserData at all (Radarr/TMDB fields only, shared across every viewer), so CinemaMovieDetail's
// own Play button had nothing to resume from and always started a partly-watched movie over from
// 0 unless you happened to open it via the Continue Watching row instead (which gets its resume
// point from a different endpoint entirely — Jellyfin's own resume list). This is the movie-sheet
// equivalent of what the episodes route already does for series' nextEpisode.
export async function GET(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) return NextResponse.json({ resumeTicks: null, runtimeTicks: null });

  const item = await jellyfin.getItemUserData(session.jfId, itemId).catch(() => null);
  const payload: CinemaProgressPayload = {
    resumeTicks: item?.UserData?.PlaybackPositionTicks ?? null,
    runtimeTicks: item?.RunTimeTicks ?? null,
  };
  return NextResponse.json(payload);
}
