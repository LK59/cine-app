import { NextRequest, NextResponse } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const seriesId = Number(params.id);
  if (!seriesId) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  const seasonNumber = req.nextUrl.searchParams.get("seasonNumber");
  return withErrorHandling(() =>
    sonarr.triggerSearch(seriesId, seasonNumber != null ? Number(seasonNumber) : undefined)
  );
}
