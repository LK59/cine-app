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

const MEDIA_TYPES = new Set(["movie", "series"]);
const MAX_TITLE = 300;
const MAX_POSTER = 300;

/** Un entier strictement positif — un nombre, ou ses chiffres en chaîne. */
function positiveInt(v: unknown): number | null {
  const n = typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Ce qu'un ajout à la liste peut écrire, ou pourquoi il est refusé.
 *
 * Tout partait tel quel dans SQLite : un `tmdbId` objet, un titre d'un mégaoctet, un `mediaType`
 * inventé que plus aucun écran ne retrouvait (26/09/2026). Les écrans n'envoient que `movie` et
 * `series`, un identifiant TMDB entier, un titre court et une affiche en chemin ou en URL
 * (94 caractères au plus en base). Les champs d'appoint (année, note, TVDB) sont ramenés à `null`
 * s'ils sont illisibles plutôt que de faire échouer l'ajout.
 */
function readWatchlistEntry(body: unknown) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  // `status` et `note` ne sont plus lus : une seule liste depuis le 21/09/2026, et les notes n'ont
  // jamais été saisies (0 sur 47). Un client ancien qui en envoie encore n'y change rien.
  const { mediaType, title, posterPath, year, voteAverage } = b;
  const tmdbId = positiveInt(b.tmdbId);
  if (!mediaType || !b.tmdbId || !title) return "mediaType, tmdbId et title sont requis";
  if (typeof mediaType !== "string" || !MEDIA_TYPES.has(mediaType)) return "mediaType inconnu";
  if (tmdbId === null) return "tmdbId invalide";
  if (typeof title !== "string" || title.length > MAX_TITLE) return "title invalide";
  if (posterPath != null && (typeof posterPath !== "string" || posterPath.length > MAX_POSTER)) return "posterPath invalide";
  return {
    mediaType: mediaType as "movie" | "series",
    tmdbId,
    tvdbId: positiveInt(b.tvdbId),
    title,
    year: positiveInt(year),
    posterPath: (posterPath as string | null | undefined) ?? null,
    voteAverage: typeof voteAverage === "number" && Number.isFinite(voteAverage) ? voteAverage : null,
  };
}

// POST /api/watchlist — add or update item in watchlist
export async function POST(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  // Un corps illisible levait hors de tout `catch` : un 500 au lieu d'un 400 (26/09/2026).
  const body = await req.json().catch(() => null);
  const entry = readWatchlistEntry(body);
  if (typeof entry === "string") return NextResponse.json({ error: entry }, { status: 400 });

  const item = watchlistDb.upsert({ userId, ...entry, status: "to_watch", note: null });

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
