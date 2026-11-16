import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { lengthHeader } from "@/lib/responseFraming";

export const dynamic = "force-dynamic";

/**
 * Les fichiers de la page de test « image dans l'image » (`/pip-test`, 16/11/2026) : une mire synthétique
 * de 60 s (`testsrc2` + un 440 Hz, H.264 Main + AAC, faite par ffmpeg — aucun film, aucun droit), en MP4
 * fragmenté et en HLS fMP4. La page la lit de trois façons pour montrer à Apple, sur un iPhone, ce que
 * l'image dans l'image fait dans un onglet Safari et dans l'application posée sur l'écran d'accueil.
 *
 * Sous `/api/` et non servis tels quels depuis `public/` : le service worker recopie dans son cache tout
 * GET hors `/api/` (`public/sw.js`), et une lecture vidéo passée par lui n'aurait plus été « minimale ».
 * Les plages (`Range`) sont honorées : Safari refuse une vidéo dont le serveur ne les sert pas. Les
 * fichiers font moins de 3 Mo et sont lus en mémoire, d'où une longueur déclarée exacte.
 */
const FILES: Record<string, string> = {
  "pip.mp4": "video/mp4",
  "hls/index.m3u8": "application/vnd.apple.mpegurl",
  "hls/init.mp4": "video/mp4",
};
const SEGMENT = /^hls\/seg\d{2}\.m4s$/;

function typeOf(name: string): string | null {
  if (FILES[name]) return FILES[name];
  return SEGMENT.test(name) ? "video/mp4" : null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const name = (await ctx.params).path.join("/");
  const type = typeOf(name);
  if (!type) return new NextResponse(null, { status: 204 });
  let body: Buffer;
  try {
    body = await fs.promises.readFile(path.join(process.cwd(), "public", "pip-test", name));
  } catch {
    // Une absence attendue n'est jamais un 404 sur une route appelée par fichier (CLAUDE.md, CrowdSec).
    return new NextResponse(null, { status: 204 });
  }
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const size = body.length;
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!range[1]) end = size - 1;
    if (start >= size || start > end) {
      return new NextResponse(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    start = Math.max(0, start);
    const slice = body.subarray(start, end + 1);
    return new NextResponse(new Uint8Array(slice), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, ...lengthHeader(slice.length) },
    });
  }
  return new NextResponse(new Uint8Array(body), { status: 200, headers: { ...headers, ...lengthHeader(body.length) } });
}
