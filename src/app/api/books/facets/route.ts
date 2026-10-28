import { NextRequest, NextResponse } from "next/server";
import { booksCaller } from "@/lib/books/guard";
import { bookIndex } from "@/lib/books/bookIndex";

/**
 * Les choix des menus de la grille complète (option, DECISIONS.md §127) : chaque série, chaque auteur
 * (« Nom Prénom » et « Prénom Nom » rapprochés), chaque genre porté par deux livres au moins. Demandés
 * une fois, à l'ouverture de la grille.
 */
export async function GET(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  try {
    const index = await bookIndex(caller);
    return NextResponse.json(index.facets, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Bibliothèque injoignable" }, { status: 502 });
  }
}
