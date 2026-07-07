import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { watchlistDb, type WatchlistStatus } from "@/lib/db";

async function resolveUserId(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  return session?.jfId ?? session?.u ?? null;
}

// GET /api/watchlist/item?mediaType=movie&tmdbId=123
export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const mediaType = req.nextUrl.searchParams.get("mediaType") ?? "";
  const tmdbId = parseInt(req.nextUrl.searchParams.get("tmdbId") ?? "0");
  if (!mediaType || !tmdbId) return NextResponse.json({ item: null });

  const item = watchlistDb.get(userId, mediaType, tmdbId);
  return NextResponse.json({ item });
}

// PATCH /api/watchlist/item — update status of an existing item
export async function PATCH(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id, status, note } = await req.json();
  const ok = watchlistDb.updateStatus(userId, id, status as WatchlistStatus, note);
  if (!ok) return NextResponse.json({ error: "Introuvable" }, { status: 404 });
  return NextResponse.json({ ok });
}
