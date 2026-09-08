import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { isJellyfinId, isSubtitleStreamIndex, isUnderJellyfinPrefix } from "@/lib/jellyfinPath";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
) {
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });

  const { itemId } = await params;
  if (!isJellyfinId(itemId)) return new NextResponse(null, { status: 400 });

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) return new NextResponse(null, { status: 403 });

  const mediaSourceId = req.nextUrl.searchParams.get("mediaSourceId");
  const index = req.nextUrl.searchParams.get("index");
  // Ces deux valeurs arrivent en clair dans la query string — pas besoin d'un `%2F` pour y
  // glisser un `/`. Les seuls appelants passent `source.Id` (un identifiant Jellyfin) et
  // `s.Index` (un entier) : la forme est connue, donc exigée.
  if (!isJellyfinId(mediaSourceId) || !isSubtitleStreamIndex(index)) {
    return new NextResponse(null, { status: 400 });
  }

  const target = `${config.jellyfin.url}/Videos/${itemId}/${mediaSourceId}/Subtitles/${index}/Stream.vtt`;
  // Ceinture et bretelles, comme sur la route de flux : la vérification porte sur l'URL
  // assemblée, celle que `fetch` normalisera.
  if (!isUnderJellyfinPrefix(target, `${config.jellyfin.url}/Videos/${itemId}/`)) {
    return new NextResponse(null, { status: 400 });
  }

  try {
    const res = await fetch(target, {
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(8000)]),
      headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
    });
    if (!res.ok) return new NextResponse(null, { status: 404 });

    const blob = await res.blob();
    return new NextResponse(blob, {
      headers: {
        "Content-Type": "text/vtt",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
