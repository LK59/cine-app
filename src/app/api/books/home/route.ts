import { NextRequest, NextResponse } from "next/server";
import { booksCaller } from "@/lib/books/guard";
import { bookIndex, resumeFrom, withProgress } from "@/lib/books/bookIndex";
import { progressByBook } from "@/lib/books/progress";

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
    const index = await bookIndex(caller);
    const progress = progressByBook(caller.u);
    return NextResponse.json(
      {
        total: index.books.length,
        resume: resumeFrom(index, progress),
        recent: withProgress(index.home.recent, progress),
        rows: index.home.rows.map((row) => ({ ...row, books: withProgress(row.books, progress) })),
        hidden: index.home.hidden,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Bibliothèque injoignable" }, { status: 502 });
  }
}
