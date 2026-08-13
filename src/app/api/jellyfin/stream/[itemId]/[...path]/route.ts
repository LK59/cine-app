import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ itemId: string; path: string[] }> }
) {
  const { itemId, path } = await params;
  if (!JELLYFIN_ID_RE.test(itemId)) return new NextResponse(null, { status: 400 });

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) return new NextResponse(null, { status: 403 });

  const restPath = path.join("/");
  const target = `${config.jellyfin.url}/videos/${itemId}/${restPath}${req.nextUrl.search}`;

  try {
    const res = await fetch(target, {
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]),
      headers: { "X-Emby-Token": config.jellyfin.apiKey },
    });
    if (!res.ok || !res.body) return new NextResponse(null, { status: res.status || 502 });

    const contentType = res.headers.get("Content-Type") ?? "application/octet-stream";
    const isManifest = restPath.endsWith(".m3u8");

    if (isManifest) {
      // HLS playlists can reference sibling segments/variant playlists with an
      // absolute "/videos/{itemId}/..." path (rather than one relative to this
      // manifest's own URL) — rewrite those back through our own proxy so the
      // browser never needs to know Jellyfin's real host.
      const text = await res.text();
      const rewritten = text.replace(
        new RegExp(`(?:https?:\\/\\/[^/\\s"]+)?\\/videos\\/${itemId}\\/`, "gi"),
        `/api/jellyfin/stream/${itemId}/`
      );
      return new NextResponse(rewritten, {
        headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
      });
    }

    return new NextResponse(res.body, {
      headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
