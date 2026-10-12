import { NextRequest, NextResponse } from "next/server";
import { JOB_ID, callerOf } from "@/lib/subtitleGen/request";
import { resume } from "@/lib/subtitleGen/service";

/**
 * Relancer une tâche en pause (DECISIONS.md §69). Une pause `budget` reste en pause tant que le
 * budget du mois est atteint, une pause `config` tant que la clé manque : la réponse le dit.
 * Reprendre ne compte pas dans le quota.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!JOB_ID.test(jobId)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  if (!(await callerOf(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const job = resume(jobId);
  if (!job) return NextResponse.json({ error: "not-found" }, { status: 404 });
  return NextResponse.json({ jobId: job.id, status: job.status, ...(job.reason ? { reason: job.reason } : {}) });
}
