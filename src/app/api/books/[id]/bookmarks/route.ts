import { NextRequest, NextResponse } from "next/server";
import { bookIdOf, booksCaller } from "@/lib/books/guard";
import { bookFor } from "@/lib/books/library";
import { addBookmark, listBookmarks, removeBookmark, validBookmarkInput } from "@/lib/books/bookmarks";

/**
 * Les signets d'un livre (option, DECISIONS.md §127), pour le compte de la session et lui seul.
 *
 * `POST` ajoute (ou, avec `remove: true`, retire) un signet : une seule méthode d'écriture, comme la
 * position — c'est aussi ce que renvoie la file d'attente du lecteur quand il revient en ligne. Le livre
 * est vérifié comme pour la position : un signet ne s'écrit que sur un livre que ce compte voit.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const id = bookIdOf((await params).id);
  if (!id) return new NextResponse(null, { status: 400 });
  return NextResponse.json({ bookmarks: listBookmarks(caller.u, id) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const id = bookIdOf((await params).id);
  if (!id) return new NextResponse(null, { status: 400 });
  const raw = await req.text().catch(() => "");
  if (raw.length > 4000) return new NextResponse(null, { status: 413 });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* refusé juste après */
  }
  const input = validBookmarkInput(parsed);
  if (!input) return NextResponse.json({ error: "Signet invalide" }, { status: 400 });
  try {
    if (!(await bookFor(caller, id))) return new NextResponse(null, { status: 404 });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
  if (input.remove) removeBookmark(caller.u, id, input.cfi);
  else addBookmark(caller.u, id, input);
  return NextResponse.json({ bookmarks: listBookmarks(caller.u, id) });
}
