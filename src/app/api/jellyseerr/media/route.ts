import { NextRequest, NextResponse } from "next/server";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

export const dynamic = "force-dynamic";

export interface SeasonInfo {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  /** Jellyseerr's own MediaStatus for this season specifically (1=unknown/missing, 2=pending,
   *  3=processing, 4=partially available, 5=available) — null when Jellyseerr has no record for
   *  it yet (never requested), same meaning as 1/unknown. */
  status: number | null;
}

export async function GET(req: NextRequest) {
  const tmdbId = req.nextUrl.searchParams.get("tmdbId");
  const type = req.nextUrl.searchParams.get("type");

  if (!tmdbId || !type) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }

  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);

  try {
    if (type === "movie") {
      const data = await jellyseerr.getMovieMedia(Number(tmdbId), session?.jsCookie);
      return NextResponse.json({ status: data.mediaInfo?.status ?? 1 });
    }

    const data = await jellyseerr.getTvMedia(Number(tmdbId), session?.jsCookie);
    const statusBySeason = new Map((data.mediaInfo?.seasons ?? []).map((s) => [s.seasonNumber, s.status]));
    const seasons: SeasonInfo[] = (data.seasons ?? [])
      // Jellyseerr's own request modal excludes season 0 (specials) from "all" by convention —
      // matched here too rather than offering something Jellyseerr itself treats as edge-case.
      .filter((s) => s.seasonNumber > 0)
      .map((s) => ({
        seasonNumber: s.seasonNumber,
        name: s.name ?? `Saison ${s.seasonNumber}`,
        episodeCount: s.episodeCount ?? 0,
        status: statusBySeason.get(s.seasonNumber) ?? null,
      }));

    return NextResponse.json({ status: data.mediaInfo?.status ?? 1, seasons });
  } catch {
    return NextResponse.json({ status: 1, seasons: [] });
  }
}
