import { NextRequest, NextResponse } from "next/server";
import { booksCaller } from "@/lib/books/guard";
import { bookIndex, searchIndex, withProgress } from "@/lib/books/bookIndex";
import { progressByBook } from "@/lib/books/progress";
import { playedBooksOf } from "@/lib/books/library";
import { createRateLimiter } from "@/lib/rateLimiter";

const SEARCH_LIMIT = 12;
// La limite de la recherche des films et séries, par compte (CLAUDE.md, « Per-account limits »).
const searchAllowed = createRateLimiter(120, 60_000);

/**
 * Les livres dans la recherche de l'application (option, DECISIONS.md §127) : douze au plus, tirés de
 * l'index en mémoire du compte (`bookIndex.ts`) — aucun aller-retour vers Jellyfin par frappe. Une
 * requête à part de celle des films et séries : leurs résultats ne l'attendent jamais.
 */
export async function GET(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 100);
  if (q.length < 2) return NextResponse.json({ books: [] }, { headers: { "Cache-Control": "private, no-store" } });
  if (!searchAllowed(`books:${caller.u}`)) return NextResponse.json({ error: "Trop de recherches" }, { status: 429 });
  try {
    const [index, played] = await Promise.all([bookIndex(caller), playedBooksOf(caller)]);
    const books = withProgress(searchIndex(index, q, SEARCH_LIMIT), progressByBook(caller.u), played);
    return NextResponse.json({ books }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Bibliothèque injoignable" }, { status: 502 });
  }
}
