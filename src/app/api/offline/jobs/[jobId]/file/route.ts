import fs from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { offlineFile, offlineJobFor, touchOfflineJob } from "@/lib/offline/jobs";
import { noteOfflineServed } from "@/lib/offline/events";

const JOB_ID = /^[0-9a-f]{32}$/;

/**
 * Les octets d'une version hors ligne, par plages — pendant sa préparation aussi : seulement ce qui
 * est déjà écrit. `X-Offline-Generation` dit de quelle préparation ils viennent : un appareil qui
 * gardait le début d'une autre recommence (`jobs.ts`). Une plage au-delà de ce qui est écrit répond
 * 416 avec `X-Offline-Bytes`, l'appareil repasse plus tard.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!JOB_ID.test(jobId)) return new NextResponse(null, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.u) return new NextResponse(null, { status: 401 });
  const job = offlineJobFor(session.u, jobId);
  if (!job || job.status === "failed" || job.status === "queued") return new NextResponse(null, { status: 404 });
  touchOfflineJob(jobId);
  const written = job.bytes;
  const done = job.status === "done";
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Offline-Generation": String(job.generation),
    "X-Offline-Bytes": String(written),
    "X-Offline-Done": done ? "1" : "0",
  };
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
  const start = range ? Number(range[1]) : 0;
  const askedEnd = range && range[2] !== "" ? Number(range[2]) : Infinity;
  const end = Math.min(askedEnd, written - 1);
  if (start >= written || end < start) return new NextResponse(null, { status: 416, headers });
  headers["Content-Length"] = String(end - start + 1);
  headers["Content-Range"] = `bytes ${start}-${end}/${done ? written : "*"}`;
  // La dernière plage d'une version finie : l'appareil l'a désormais entière — une ligne au journal
  // la première fois pour ce compte, jamais une par plage (`noteOfflineServed`).
  noteOfflineServed(session.u, job, end);
  const stream = fs.createReadStream(offlineFile(jobId), { start, end });
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, { status: 206, headers });
}
