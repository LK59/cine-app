import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinFetch } from "@/lib/jellyfinBreaker";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { verifyStreamDeckToken } from "@/lib/streamdeck/tokens";
import { streamDeckPlays } from "@/lib/streamdeck/plays";

export const dynamic = "force-dynamic";

/**
 * L'affiche d'une lecture en cours, à la taille d'une touche (27/10/2026). Seulement celle d'un titre
 * qui joue en ce moment : le jeton du plugin ne parcourt pas le catalogue.
 */
export async function GET(req: NextRequest) {
  if (!verifyStreamDeckToken(req.headers.get("authorization"))) return new NextResponse(null, { status: 401 });
  const itemId = req.nextUrl.searchParams.get("itemId");
  if (!isJellyfinId(itemId)) return new NextResponse(null, { status: 400 });
  const playing = await streamDeckPlays().catch(() => null);
  if (!playing?.plays.some((p) => p.imageItemId === itemId)) return new NextResponse(null, { status: 404 });
  try {
    const url = `${config.jellyfin.url}/Items/${itemId}/Images/Primary?${new URLSearchParams({ quality: "80", maxHeight: "288" })}`;
    const res = await jellyfinFetch(url, { signal: AbortSignal.any([req.signal, AbortSignal.timeout(8000)]), headers: jellyfinAuthHeaders(config.jellyfin.apiKey) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return new NextResponse(null, { status: 404 });
    }
    return new NextResponse(await res.blob(), {
      headers: { "Content-Type": res.headers.get("Content-Type") ?? "image/jpeg", "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
