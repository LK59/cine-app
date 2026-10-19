import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { DATA_DIR } from "@/lib/dataDir";
import { labSampleByFile } from "@/lib/labSamples";

/**
 * Un extrait du test de qualité hors ligne, servi par plages comme le flux d'un film : le lecteur le
 * lit par `HttpByteSource`, qui ne demande jamais le fichier entier. Seuls les noms de
 * `LAB_SAMPLES` passent — aucun chemin venu de l'adresse n'atteint le disque.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (session?.role !== "admin") return new NextResponse(null, { status: 403 });
  const sample = labSampleByFile((await params).file);
  if (!sample) return new NextResponse(null, { status: 404 });
  const file = path.join(DATA_DIR, "lab", "offline-samples", sample.file);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (!range || (range[1] === "" && range[2] === "")) {
    headers["Content-Length"] = String(size);
    return new NextResponse(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { status: 200, headers });
  }
  // `bytes=-N` : les N derniers octets.
  const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
  const end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || end < start) {
    return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  headers["Content-Length"] = String(end - start + 1);
  headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new NextResponse(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, { status: 206, headers });
}
