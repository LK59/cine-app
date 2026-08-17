import { NextRequest, NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { guid, indexerId, mediaId } = body ?? {};
  if (!guid || !indexerId) return NextResponse.json({ error: "guid et indexerId requis" }, { status: 400 });

  return withErrorHandling(async () => {
    const result = await radarr.grabRelease(guid, indexerId);
    // Only present for a movie that was just added unmonitored via /api/discover/add — a real
    // release was just picked for it, so it should behave like any normal library entry from
    // here on (Radarr's own future searches for upgrades, etc.). Best-effort: the grab itself
    // already succeeded, a failure to flip this shouldn't fail the whole request.
    if (mediaId) {
      const movie = await radarr.getMovie(Number(mediaId)).catch(() => null);
      if (movie && !movie.monitored) {
        await radarr.updateMovie(Number(mediaId), { ...movie, monitored: true }).catch(() => {});
      }
    }
    return result;
  });
}
