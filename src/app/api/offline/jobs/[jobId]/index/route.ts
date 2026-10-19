import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { offlineIndex, offlineJobFor } from "@/lib/offline/jobs";

const JOB_ID = /^[0-9a-f]{32}$/;

/**
 * L'index des fragments d'une version que ce compte a demandée, à partir d'une position du fichier
 * (`?from=`) — ce que le lecteur d'un téléchargement en cours lisait fragment par fragment par le
 * réseau (`offlineIndex`). Seulement ce qui est déjà écrit.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!JOB_ID.test(jobId)) return new NextResponse(null, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.u) return new NextResponse(null, { status: 401 });
  const job = offlineJobFor(session.u, jobId);
  if (!job || job.status === "failed" || job.status === "queued") return new NextResponse(null, { status: 404 });
  const from = Math.max(0, Number(req.nextUrl.searchParams.get("from")) || 0);
  const index = await offlineIndex(job, from);
  return NextResponse.json({ ...index, generation: job.generation, done: job.status === "done" }, { headers: { "Cache-Control": "private, no-store" } });
}
