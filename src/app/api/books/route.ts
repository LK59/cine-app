import { NextRequest, NextResponse } from "next/server";
import { booksCaller } from "@/lib/books/guard";
import { bookIndex, pageOf, resumeFrom, withProgress } from "@/lib/books/bookIndex";
import { progressByBook } from "@/lib/books/progress";
import { BOOK_SORTS, type BookSort } from "@/lib/books/grouping";

/**
 * Une page de la grille complète des livres (option, DECISIONS.md §127) : filtrée (`q`, `serie`,
 * `auteur`, `genre`), triée (`tri`), `offset` / `limit` (200 au plus) — tirée de l'index du compte
 * (`bookIndex.ts`), jamais toute la bibliothèque d'un coup. La première page sans filtre porte aussi
 * « Continuer la lecture ». Ce que Jellyfin laisse voir à ce compte, moins ses tags bloqués (§54).
 */
export async function GET(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const p = req.nextUrl.searchParams;
  const tri = p.get("tri") as BookSort | null;
  const clip = (v: string | null) => (v ? v.slice(0, 200) : null);
  try {
    const index = await bookIndex(caller);
    const progress = progressByBook(caller.u);
    const query = {
      query: clip(p.get("q")) ?? "",
      serie: clip(p.get("serie")),
      auteur: clip(p.get("auteur")),
      genre: clip(p.get("genre")),
      tri: tri && BOOK_SORTS.includes(tri) ? tri : ("series" as const),
      offset: Number(p.get("offset") ?? 0) || 0,
      limit: Number(p.get("limit") ?? 120) || 120,
    };
    const page = pageOf(index, query);
    const first = query.offset === 0 && !query.query && !query.serie && !query.auteur && !query.genre;
    return NextResponse.json(
      {
        total: page.total,
        library: index.books.length,
        books: withProgress(page.books, progress),
        seriesCounts: page.seriesCounts,
        ...(first ? { resume: resumeFrom(index, progress) } : {}),
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    // Jellyfin n'a pas répondu : l'écran le dit, sans détail (une adresse ou un statut interne ne
    // regarde pas qui lit).
    return NextResponse.json({ error: "Bibliothèque injoignable" }, { status: 502 });
  }
}
