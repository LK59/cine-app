import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { assertVisible } from "@/lib/itemVisibility";

export async function GET(req: NextRequest) {
  const itemId = req.nextUrl.searchParams.get("itemId");
  const tag = req.nextUrl.searchParams.get("tag");
  if (!isJellyfinId(itemId)) return new NextResponse(null, { status: 400 });

  // Signé avec la clé d'administration, qui voit tout : le droit du compte sur ce titre est
  // demandé à Jellyfin d'abord, une fois par séance — voir `assertVisible`.
  const refused = await assertVisible(await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value), itemId);
  if (refused) return refused;

  const params = new URLSearchParams({ quality: "90", maxWidth: "300" });
  if (tag) params.set("tag", tag);
  const url = `${config.jellyfin.url}/Items/${itemId}/Images/Primary?${params}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(8000)]),
      headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
    });
    if (!res.ok) return new NextResponse(null, { status: 404 });

    const blob = await res.blob();
    return new NextResponse(blob, {
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "image/jpeg",
        // `private` : la réponse dépend désormais du compte qui la demande — un cache partagé ne
        // doit pas resservir à un autre l'image d'un titre qui lui est caché.
        "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
