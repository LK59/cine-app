import { NextRequest, NextResponse } from "next/server";
import { booksCaller } from "@/lib/books/guard";
import { listBooks } from "@/lib/books/library";
import { progressByBook } from "@/lib/books/progress";

/**
 * La grille des livres (option, DECISIONS.md §127) : ce que Jellyfin laisse voir à ce compte, moins
 * ses tags bloqués (§54), avec la position de lecture de chacun. 404 tant que l'option est coupée.
 */
export async function GET(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  try {
    const books = await listBooks(caller);
    const progress = progressByBook(caller.u);
    for (const book of books) book.progress = progress.get(book.id) ?? null;
    return NextResponse.json({ books }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    // Jellyfin n'a pas répondu : l'écran le dit, sans détail (une adresse ou un statut interne ne
    // regarde pas qui lit).
    return NextResponse.json({ error: "Bibliothèque injoignable" }, { status: 502 });
  }
}
