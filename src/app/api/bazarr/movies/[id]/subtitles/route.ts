import { NextRequest, NextResponse } from "next/server";
import { bazarr } from "@/lib/clients/bazarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return withErrorHandling(() => bazarr.searchMovieSubtitles(Number(params.id)));
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { candidate } = await req.json();
  const res = await bazarr.downloadMovieSubtitle({ radarrId: Number(params.id), candidate });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return NextResponse.json({ error: body || `Échec (${res.status})` }, { status: res.status });
  }
  return NextResponse.json({ ok: true });
}
