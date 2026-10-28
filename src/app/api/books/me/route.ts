import { NextRequest, NextResponse } from "next/server";
import { booksCaller } from "@/lib/books/guard";

/**
 * Le compte sous lequel ranger les livres gardés sur l'appareil (option, DECISIONS.md §127,
 * `offlineBooks.ts`) — le nom du compte de la session, et rien d'autre. Comme toutes les routes des
 * livres : 404 option coupée, jamais pour un lien de partage.
 */
export async function GET(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  return NextResponse.json({ account: caller.u }, { headers: { "Cache-Control": "private, no-store" } });
}
