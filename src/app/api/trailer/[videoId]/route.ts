import { exec } from "child_process";
import { promisify } from "util";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const execAsync = promisify(exec);
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

interface CacheEntry { url: string; expiresAt: number }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 60_000; // 5h — YouTube signed URLs expire around 6h
const CACHE_MAX = 50;

export async function GET(_req: Request, { params }: { params: { videoId: string } }) {
  const { videoId } = params;

  if (!YT_ID_RE.test(videoId)) {
    return new NextResponse(null, { status: 400 });
  }

  const now = Date.now();
  const cached = cache.get(videoId);
  if (cached && now < cached.expiresAt) {
    return NextResponse.redirect(cached.url, { status: 302 });
  }

  try {
    const { stdout } = await execAsync(
      `yt-dlp --get-url -f "22/18/best[height<=480][ext=mp4]" --no-playlist "https://www.youtube.com/watch?v=${videoId}"`,
      { timeout: 20_000 }
    );
    const url = stdout.trim().split("\n")[0];
    if (!url?.startsWith("http")) {
      return new NextResponse(null, { status: 404 });
    }
    if (cache.size >= CACHE_MAX) {
      cache.delete(cache.keys().next().value!);
    }
    cache.set(videoId, { url, expiresAt: now + CACHE_TTL });
    return NextResponse.redirect(url, { status: 302 });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
