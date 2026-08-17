import { NextRequest, NextResponse } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { withErrorHandling } from "@/lib/api-helpers";
import { invalidateLibrary } from "@/lib/server-cache";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return withErrorHandling(() => sonarr.getSeriesById(Number(params.id)));
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const payload = await req.json();
  return withErrorHandling(() => sonarr.updateSeries(Number(params.id), payload));
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const id = Number(params.id);
  try {
    // Read the series' own tmdbId BEFORE deleting it from Sonarr — nothing left to read it from
    // afterwards. Best-effort throughout: Jellyseerr cleanup is a courtesy so a later re-request
    // doesn't hit its stale "already requested" state, not something that should ever block or
    // fail the actual deletion the user asked for.
    const series = await sonarr.getSeriesById(id).catch(() => null);

    await sonarr.deleteSeries(id);
    invalidateLibrary();

    if (series?.tmdbId) {
      const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
      try {
        const media = await jellyseerr.getTvMedia(series.tmdbId, session?.jsCookie);
        if (media.mediaInfo?.id) await jellyseerr.deleteMedia(media.mediaInfo.id, session?.jsCookie);
      } catch {
        // Jellyseerr unreachable/no stale record/etc. — the actual deletion above already
        // succeeded, this cleanup just doesn't happen this time.
      }
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Échec de la suppression" }, { status: 500 });
  }
}
