import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { Readable } from "stream";
import { resolveSession } from "@/lib/session";
import { getLocalTrailerPath, type TrailerMediaType } from "@/lib/trailerDownload";

// Serves a locally-downloaded trailer file with HTTP Range support — needed for a plain <video>
// element to buffer/seek smoothly, same reason the Jellyfin stream proxy forwards Range too
// (see that route's own note), except there's no upstream to forward to here: this reads the
// range directly off the file on disk.
export async function GET(req: NextRequest, props: { params: Promise<{ mediaType: string; tmdbId: string }> }) {
  const { mediaType, tmdbId } = await props.params;
  const session = await resolveSession(req);
  if (!session) return new NextResponse(null, { status: 401 });

  if (mediaType !== "movie" && mediaType !== "series") {
    return new NextResponse(null, { status: 400 });
  }
  const id = Number(tmdbId);
  if (!Number.isInteger(id) || id <= 0) {
    return new NextResponse(null, { status: 400 });
  }

  const filePath = getLocalTrailerPath(id, mediaType as TrailerMediaType);
  if (!filePath) return new NextResponse(null, { status: 404 });

  const stat = fs.statSync(filePath);
  const range = req.headers.get("range");

  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    // Files are immutable once written (a re-download replaces the file wholesale, it never
    // mutates in place) — safe to cache harder than the Jellyfin proxy's own live segments.
    "Cache-Control": "public, max-age=86400",
  };

  if (!range) {
    headers["Content-Length"] = String(stat.size);
    return new NextResponse(Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream, { status: 200, headers });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (start > end || start >= stat.size) {
    return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
  }

  headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  headers["Content-Length"] = String(end - start + 1);
  return new NextResponse(Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream, {
    status: 206,
    headers,
  });
}
