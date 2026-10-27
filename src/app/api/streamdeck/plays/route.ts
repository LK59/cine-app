import { NextRequest, NextResponse } from "next/server";
import { verifyStreamDeckToken } from "@/lib/streamdeck/tokens";
import { streamDeckPlays } from "@/lib/streamdeck/plays";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Les lectures en cours, pour le plugin Stream Deck (27/10/2026) — sans session : `/api/streamdeck`
 * est dans `PUBLIC_PATHS`, et c'est le jeton du plugin qui ouvre la route (`streamdeck/tokens.ts`).
 * Lecture seule ; rien d'autre ne s'ouvre avec ce jeton.
 */
export async function GET(req: NextRequest) {
  if (!verifyStreamDeckToken(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "jeton" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    return NextResponse.json(await streamDeckPlays(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logError("streamdeck.plays", error);
    return NextResponse.json({ error: "jellyfin" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
