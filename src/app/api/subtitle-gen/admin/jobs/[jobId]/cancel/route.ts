import { NextResponse } from "next/server";
import { JOB_ID } from "@/lib/subtitleGen/request";
import { cancel } from "@/lib/subtitleGen/service";

/** Annuler une tâche — administrateur seulement (toute écriture hors liste blanche l'est). */
export async function POST(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!JOB_ID.test(jobId)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const job = cancel(jobId);
  if (!job) return NextResponse.json({ error: "not-found" }, { status: 404 });
  return NextResponse.json({ jobId: job.id, status: job.status, ...(job.reason ? { reason: job.reason } : {}) });
}
