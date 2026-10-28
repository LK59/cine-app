import { NextRequest, NextResponse } from "next/server";
import { booksCaller } from "@/lib/books/guard";
import { accountCopies, bookIndex, resumeFrom, withProgress } from "@/lib/books/bookIndex";
import { progressByBook } from "@/lib/books/progress";
import { playedBooksOf } from "@/lib/books/library";
import { bookmarkedBooks } from "@/lib/books/bookmarks";

/**
 * L'accueil de la catégorie Livres (option, DECISIONS.md §127), déjà calculé par le serveur
 * (`bookIndex.ts`) : « Continuer la lecture », « Récemment ajoutés » et les rangées de séries, d'auteurs
 * et de genres — au plus une douzaine de rangées de vingt livres, quelle que soit la bibliothèque.
 * Le téléphone ne télécharge jamais la liste entière pour en faire ses rangées.
 */
export async function GET(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  try {
    const [index, played] = await Promise.all([bookIndex(caller), playedBooksOf(caller)]);
    const progress = progressByBook(caller.u);
    // Une copie cachée que ce compte a commencée ou marquée est montrée chez lui à la place de l'autre.
    const copies = accountCopies(index, [...progress.keys(), ...bookmarkedBooks(caller.u)]);
    return NextResponse.json(
      {
        total: index.books.length,
        resume: resumeFrom(index, progress),
        recent: withProgress(index.home.recent, progress, played, copies),
        rows: index.home.rows.map((row) => ({ ...row, books: withProgress(row.books, progress, played, copies) })),
        hidden: index.home.hidden,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Bibliothèque injoignable" }, { status: 502 });
  }
}
