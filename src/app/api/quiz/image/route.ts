import { NextRequest, NextResponse } from "next/server";
import { openQuizImage } from "@/lib/quiz/imageToken";

export const dynamic = "force-dynamic";

/**
 * Une image de « Devine le film », par son jeton chiffré (DECISIONS.md §146) : l'adresse ne dit pas de quel film il
 * s'agit. Un jeton illisible, expiré, ou une image que TMDB ne rend pas : **204**, jamais un 404 — la règle des routes
 * appelées par élément (CLAUDE.md, « An expected absence is never a 404 »).
 */
export async function GET(req: NextRequest) {
  const source = openQuizImage(req.nextUrl.searchParams.get("t"));
  if (!source) return new NextResponse(null, { status: 204 });
  try {
    const upstream = await fetch(source, { signal: AbortSignal.timeout(8000) });
    const type = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !type.startsWith("image/")) return new NextResponse(null, { status: 204 });
    const bytes = await upstream.arrayBuffer();
    return new NextResponse(bytes, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=7200" } });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
