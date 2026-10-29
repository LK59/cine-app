import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { bookIdOf, booksCaller } from "@/lib/books/guard";
import { bookFor, forgetPlayed } from "@/lib/books/library";
import { markRead, markUnread } from "@/lib/books/progress";
import { bookFields } from "@/lib/books/readingLog";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { logReadingEvent } from "@/lib/eventLogs";
import { logError } from "@/lib/logger";

/**
 * « Marquer comme lu » (`POST`) et « Marquer comme non lu » (`DELETE`), depuis la fiche d'un livre
 * (29/10/2026) — pour le compte de la session et lui seul, sur un livre qu'il voit (`bookFor`).
 *
 * Comme les films, « lu » vit chez Jellyfin (ses autres applications le savent) et chez nous (la position,
 * « Continuer la lecture ») : les deux bougent ensemble. Il reste dans « Ma liste de lecture », comme un film vu
 * reste dans « À voir » (29/10/2026).
 * Un Jellyfin qui refuse n'empêche pas l'état local, et le dit dans `server.log`.
 */
async function resolve(req: NextRequest, params: Promise<{ id: string }>) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const id = bookIdOf((await params).id);
  if (!id) return new NextResponse(null, { status: 400 });
  try {
    const book = await bookFor(caller, id);
    if (!book) return new NextResponse(null, { status: 404 });
    return { caller, id, book };
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolve(req, params);
  if (r instanceof NextResponse) return r;
  const { caller, id, book } = r;
  markRead(caller.u, id);
  if (caller.jfId) {
    await jellyfin.markPlayed(caller.jfId, id).catch((err: unknown) => logError("books/read", err, { itemId: id, played: true }));
    // Le badge « Lu » vient de Jellyfin, gardé deux minutes : on le redemande.
    forgetPlayed(caller.jfId);
  }
  logReadingEvent("marqué lu", { user: caller.jfUser ?? caller.u, account: caller.u, book: id, ...bookFields(book), device: requestDeviceLabel(req) });
  return NextResponse.json({ ok: true, read: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolve(req, params);
  if (r instanceof NextResponse) return r;
  const { caller, id, book } = r;
  markUnread(caller.u, id);
  if (caller.jfId) {
    await jellyfin.markUnplayed(caller.jfId, id).catch((err: unknown) => logError("books/read", err, { itemId: id, played: false }));
    forgetPlayed(caller.jfId);
  }
  logReadingEvent("marqué non lu", { user: caller.jfUser ?? caller.u, account: caller.u, book: id, ...bookFields(book), device: requestDeviceLabel(req) });
  return NextResponse.json({ ok: true, read: false });
}
