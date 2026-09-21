import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { watchlistDb, type WatchlistStatus } from "@/lib/db";

async function resolveUserId(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  return session?.jfId ?? session?.u ?? null;
}

// GET /api/watchlist — get user's full watchlist (optionally filtered by status)
export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const status = req.nextUrl.searchParams.get("status") as WatchlistStatus | null;
  const items = watchlistDb.getAll(userId, status ?? undefined);
  return NextResponse.json({ items });
}

// POST /api/watchlist — add or update item in watchlist
export async function POST(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const body = await req.json();
  // `status` et `note` ne sont plus lus : une seule liste depuis le 21/09/2026, et les notes n'ont
  // jamais été saisies (0 sur 47). Un client ancien qui en envoie encore n'y change rien.
  const { mediaType, tmdbId, tvdbId, title, year, posterPath, voteAverage } = body;

  if (!mediaType || !tmdbId || !title) {
    return NextResponse.json({ error: "mediaType, tmdbId et title sont requis" }, { status: 400 });
  }

  const item = watchlistDb.upsert({
    userId,
    mediaType,
    tmdbId,
    tvdbId: tvdbId ?? null,
    title,
    year: year ?? null,
    posterPath: posterPath ?? null,
    voteAverage: voteAverage ?? null,
    status: "to_watch",
    note: null,
  });

  return NextResponse.json({ item });
}

// DELETE /api/watchlist — remove by tmdbId + mediaType
export async function DELETE(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.tmdbId || !body?.mediaType) {
    return NextResponse.json({ error: "tmdbId et mediaType sont requis" }, { status: 400 });
  }
  const { tmdbId, mediaType } = body;
  const existing = watchlistDb.get(userId, mediaType, tmdbId);
  if (!existing) return NextResponse.json({ error: "Introuvable" }, { status: 404 });

  const ok = watchlistDb.remove(userId, existing.id);
  return NextResponse.json({ ok });
}
