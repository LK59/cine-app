import { NextRequest, NextResponse } from "next/server";
import { bookIdOf, booksCaller } from "@/lib/books/guard";
import { bookFor } from "@/lib/books/library";
import { readProgress } from "@/lib/books/progress";

/** La fiche d'un livre (option, DECISIONS.md §127) : 404 pour tout ce qui n'est pas un livre visible de ce compte. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const id = bookIdOf((await params).id);
  if (!id) return new NextResponse(null, { status: 400 });
  try {
    const book = await bookFor(caller, id);
    if (!book) return new NextResponse(null, { status: 404 });
    book.progress = readProgress(caller.u, id);
    return NextResponse.json(book, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Bibliothèque injoignable" }, { status: 502 });
  }
}
