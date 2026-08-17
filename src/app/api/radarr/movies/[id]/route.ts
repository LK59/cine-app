import { NextRequest, NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { withErrorHandling } from "@/lib/api-helpers";
import { invalidateLibrary } from "@/lib/server-cache";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return withErrorHandling(() => radarr.getMovie(Number(params.id)));
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const payload = await req.json();
  return withErrorHandling(() => radarr.updateMovie(Number(params.id), payload));
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const id = Number(params.id);
  try {
    // Read the movie's own tmdbId BEFORE deleting it from Radarr — nothing left to read it from
    // afterwards. Best-effort throughout: Jellyseerr cleanup is a courtesy so a later re-request
    // doesn't hit its stale "already requested" state, not something that should ever block or
    // fail the actual deletion the user asked for.
    const movie = await radarr.getMovie(id).catch(() => null);

    await radarr.deleteMovie(id);
    invalidateLibrary();

    if (movie?.tmdbId) {
      const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
      try {
        const media = await jellyseerr.getMovieMedia(movie.tmdbId, session?.jsCookie);
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
