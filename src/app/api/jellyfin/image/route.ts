import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

export async function GET(req: NextRequest) {
  const itemId = req.nextUrl.searchParams.get("itemId");
  const tag = req.nextUrl.searchParams.get("tag");
  if (!itemId) return new NextResponse(null, { status: 400 });

  const url = `${config.jellyfin.url}/Items/${itemId}/Images/Primary?tag=${tag ?? ""}&quality=90&maxWidth=300`;

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
