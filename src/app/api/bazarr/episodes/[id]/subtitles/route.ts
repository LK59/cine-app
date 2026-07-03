import { NextRequest, NextResponse } from "next/server";
import { bazarr } from "@/lib/clients/bazarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return withErrorHandling(() => bazarr.searchEpisodeSubtitles(Number(params.id)));
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { seriesId, candidate } = await req.json();
  const res = await bazarr.downloadEpisodeSubtitle({
    seriesId: Number(seriesId),
    episodeId: Number(params.id),
    candidate,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return NextResponse.json({ error: body || `Échec (${res.status})` }, { status: res.status });
  }
  return NextResponse.json({ ok: true });
}
