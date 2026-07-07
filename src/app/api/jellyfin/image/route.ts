import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

export async function GET(req: NextRequest) {
  const itemId = req.nextUrl.searchParams.get("itemId");
  const tag = req.nextUrl.searchParams.get("tag");
  if (!itemId || !JELLYFIN_ID_RE.test(itemId)) return new NextResponse(null, { status: 400 });

  const params = new URLSearchParams({ quality: "90", maxWidth: "300" });
  if (tag) params.set("tag", tag);
  const url = `${config.jellyfin.url}/Items/${itemId}/Images/Primary?${params}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(8000)]),
      headers: { "X-Emby-Token": config.jellyfin.apiKey },
    });
    if (!res.ok) return new NextResponse(null, { status: 404 });

    const blob = await res.blob();
    return new NextResponse(blob, {
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "image/jpeg",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
