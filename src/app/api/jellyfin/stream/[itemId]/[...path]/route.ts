import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

// Root cause found live via temporary request logging: right after a fresh remux job starts
// (e.g. on an audio-track switch, which always requests a brand new PlaySessionId/ffmpeg job),
// the very first fetch for the HLS init segment (fmp4's EXT-X-MAP, hls1/main/-1.mp4) can race
// ffmpeg's own disk writes and come back as a transient 500 — Jellyfin returns the playlist text
// instantly (cheap to generate), but the actual segment files depend on real ffmpeg I/O that
// takes a brief moment to catch up. hls.js already retries a failed fragment load internally
// with backoff, silently absorbing this — which is exactly why Firefox never showed a problem.
// Safari's native (non-MSE) HLS pipeline does not retry a failed segment fetch anywhere near as
// forgivingly, especially for the foundational init segment: one transient 500 there was enough
// to make it give up on the whole source instantly (MediaError code 4, SRC_NOT_SUPPORTED) — not
// a WebKit element-reuse limitation after all (a genuinely fresh <video> element hit it just the
// same), a real server-timing race that Firefox was silently protecting us from all along.
const UPSTREAM_RETRY_DELAYS_MS = [200, 500, 1000];

async function fetchWithRetry(target: string, headers: Record<string, string>, signal: AbortSignal) {
  let res = await fetch(target, { signal, headers });
  for (const delay of UPSTREAM_RETRY_DELAYS_MS) {
    if (res.ok) return res;
    await new Promise((resolve) => setTimeout(resolve, delay));
    res = await fetch(target, { signal, headers });
  }
  return res;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ itemId: string; path: string[] }> }
) {
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });

  const { itemId, path } = await params;
  if (!JELLYFIN_ID_RE.test(itemId)) return new NextResponse(null, { status: 400 });

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) return new NextResponse(null, { status: 403 });

  const restPath = path.join("/");
  const target = `${config.jellyfin.url}/videos/${itemId}/${restPath}${req.nextUrl.search}`;
  const isStatic = req.nextUrl.searchParams.get("static") === "true";
  const isManifest = restPath.endsWith(".m3u8");

  try {
    // Root cause found live: Safari issues a speculative byte-Range request for the manifest
    // itself on a second load of the same path (e.g. an audio-track switch) — never seen on a
    // first load. Forwarding that Range to Jellyfin got back a 206 Partial Content (only the
    // first ~1.4KB), which we then handed to the browser under a plain 200 with no Content-Range
    // — a manifest silently truncated mid-line, not the full playlist it claimed to be. Safari's
    // native HLS parser can't make sense of that and rejects the whole source outright
    // (MediaError code 4, SRC_NOT_SUPPORTED) — instantly, no network delay needed to explain it.
    // We always need the complete manifest text anyway (for the URL-rewrite below), so Range is
    // simply never forwarded for this case — Jellyfin always returns the full playlist, we always
    // send the browser the full rewritten text back with a plain 200, which is a perfectly valid
    // response to a Range request under HTTP (the client falls back to using the whole body).
    const range = isManifest ? null : req.headers.get("range");
    const incomingRange = req.headers.get("range");
    const res = await fetchWithRetry(
      target,
      // Only DirectPlay/DirectStream's static file endpoint is Range-seekable — forwarding it
      // here is what lets the browser's native <video> seeking issue real HTTP range requests
      // instead of always re-fetching from byte 0.
      { "X-Emby-Token": config.jellyfin.apiKey, ...(range ? { Range: range } : {}) },
      AbortSignal.any([req.signal, AbortSignal.timeout(30_000)])
    );
    if (!res.ok || !res.body) {
      console.log("[stream proxy]", new Date().toLocaleTimeString("fr-FR"), "NOT OK", restPath, JSON.stringify({ incomingRange, upstreamStatus: res.status }));
      return new NextResponse(null, { status: res.status || 502 });
    }

    const contentType = res.headers.get("Content-Type") ?? "application/octet-stream";

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
      const buf = Buffer.from(rewritten, "utf-8");

      // Root cause, finally confirmed live: even with the *full, untruncated* manifest sent back
      // under a plain 200 (the previous fix — never forwarding Range upstream — already achieved
      // that; server logs showed upstreamLen === sentLen every time), Safari still failed
      // instantly. WebKit's native HLS resource loader apparently treats "I asked for a Range and
      // got back a 200 that ignores it" as a hard failure in its own right, regardless of whether
      // the body is actually complete and valid — not just a truncation problem, a protocol
      // *compliance* problem. The real fix is to actually honor Range for the manifest properly:
      // slice the final rewritten text ourselves (its byte length can differ from Jellyfin's
      // original due to the URL rewrite above, so this can't be delegated to Jellyfin's own Range
      // handling) and return a genuine 206 + Content-Range when one is requested.
      const rangeMatch = incomingRange ? /^bytes=(\d*)-(\d*)$/.exec(incomingRange) : null;
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Accept-Ranges": "bytes",
      };

      if (rangeMatch) {
        const total = buf.length;
        const start = rangeMatch[1] ? Math.min(parseInt(rangeMatch[1], 10), total - 1) : 0;
        const end = rangeMatch[2] ? Math.min(parseInt(rangeMatch[2], 10), total - 1) : total - 1;
        const slice = buf.subarray(start, end + 1);
        headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
        headers["Content-Length"] = String(slice.length);
        console.log("[stream proxy]", new Date().toLocaleTimeString("fr-FR"), "manifest 206", restPath, JSON.stringify({ incomingRange, total, start, end }));
        return new NextResponse(slice, { status: 206, headers });
      }

      headers["Content-Length"] = String(buf.length);
      console.log("[stream proxy]", new Date().toLocaleTimeString("fr-FR"), "manifest 200", restPath, JSON.stringify({ incomingRange, len: buf.length }));
      return new NextResponse(buf, { headers });
    }
    console.log("[stream proxy]", new Date().toLocaleTimeString("fr-FR"), "ok", restPath, JSON.stringify({ incomingRange, upstreamStatus: res.status, isStatic }));

    if (isStatic) {
      // DirectPlay/DirectStream: a single big Range-seekable file, not an immutable HLS
      // segment — pass through the real status (200 or 206) and range headers as-is instead
      // of assuming 200, so native <video> seeking works.
      const passthroughHeaders: Record<string, string> = { "Content-Type": contentType, "Cache-Control": "public, max-age=21600" };
      const contentRange = res.headers.get("Content-Range");
      const contentLength = res.headers.get("Content-Length");
      const acceptRanges = res.headers.get("Accept-Ranges");
      if (contentRange) passthroughHeaders["Content-Range"] = contentRange;
      if (contentLength) passthroughHeaders["Content-Length"] = contentLength;
      if (acceptRanges) passthroughHeaders["Accept-Ranges"] = acceptRanges;
      return new NextResponse(res.body, { status: res.status, headers: passthroughHeaders });
    }

    // Each HLS segment URL is tied to a specific PlaySessionId and never changes
    // content once generated — immutable, and long-lived enough to cover a
    // full movie, so a rewind past hls.js's in-memory buffer replays from the
    // browser's HTTP cache instead of re-hitting Jellyfin.
    return new NextResponse(res.body, {
      headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=21600, immutable" },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
