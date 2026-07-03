import { NextRequest, NextResponse } from "next/server";
import { jellyseerr } from "@/lib/clients/jellyseerr";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const tmdbId = req.nextUrl.searchParams.get("tmdbId");
  const type = req.nextUrl.searchParams.get("type");

  if (!tmdbId || !type) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }

  try {
    const data =
      type === "movie"
        ? await jellyseerr.getMovieMedia(Number(tmdbId))
        : await jellyseerr.getTvMedia(Number(tmdbId));

    return NextResponse.json({ status: data.mediaInfo?.status ?? 1 });
  } catch {
    return NextResponse.json({ status: 1 });
  }
}
