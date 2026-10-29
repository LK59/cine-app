import { NextRequest, NextResponse } from "next/server";
import { bookIdOf, booksCaller } from "@/lib/books/guard";
import { bookIndex, withProgress } from "@/lib/books/bookIndex";
import { bookFor, playedBooksOf } from "@/lib/books/library";
import { progressByBook } from "@/lib/books/progress";
import { addToReadingList, listedBooks, readingListFrom, removeFromReadingList } from "@/lib/books/readingList";

/**
 * « Ma liste de lecture » (option, DECISIONS.md §129), pour le compte de la session et lui seul.
 *
 * `GET` : les livres de la liste que ce compte voit (sa vue de l'index), avec sa position et « lu ».
 * `POST { id }` : ajouter un livre — seulement un livre que ce compte voit (`bookFor`, sous son identité
 * Jellyfin, comme une position) ; sinon 404, la même réponse qu'un livre qui n'existe pas.
 * `DELETE ?id=…` : retirer — toujours permis, ce n'est que sa propre ligne.
 */
export async function GET(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  try {
    const [index, played] = await Promise.all([bookIndex(caller), playedBooksOf(caller)]);
    const books = readingListFrom(index, listedBooks(caller.u));
    const progress = progressByBook(caller.u);
    const shown = withProgress(books, progress, played).map((b, i) => ({ ...b, listedAt: books[i].listedAt }));
    return NextResponse.json({ books: shown }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Bibliothèque injoignable" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const raw = await req.text().catch(() => "");
  if (raw.length > 500) return new NextResponse(null, { status: 413 });
  let id: string | null = null;
  try {
    const body = JSON.parse(raw) as { id?: unknown };
    id = typeof body?.id === "string" ? bookIdOf(body.id) : null;
  } catch {
    /* refusé juste après */
  }
  if (!id) return new NextResponse(null, { status: 400 });
  try {
    if (!(await bookFor(caller, id))) return new NextResponse(null, { status: 404 });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
  if (!addToReadingList(caller.u, id)) return NextResponse.json({ error: "Liste pleine" }, { status: 409 });
  return NextResponse.json({ ok: true, listed: true });
}

export async function DELETE(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const id = bookIdOf(req.nextUrl.searchParams.get("id") ?? undefined);
  if (!id) return new NextResponse(null, { status: 400 });
  removeFromReadingList(caller.u, id);
  return NextResponse.json({ ok: true, listed: false });
}
