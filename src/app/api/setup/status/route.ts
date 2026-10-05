import { NextResponse } from "next/server";
import { localAdmin, setupDone } from "@/lib/settings/setup";

/**
 * L'état de l'assistant de premier lancement — public : l'assistant s'ouvre avant toute connexion
 * (DECISIONS.md §48). Rien de secret : deux booléens.
 */
export async function GET() {
  return NextResponse.json({ done: setupDone(), needsAdmin: localAdmin() === null }, { headers: { "Cache-Control": "no-store" } });
}
