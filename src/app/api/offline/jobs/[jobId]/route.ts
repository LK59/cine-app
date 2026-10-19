import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { forgetOfflineJob, offlineJobFor } from "@/lib/offline/jobs";

const JOB_ID = /^[0-9a-f]{32}$/;

/** Où en est une préparation que ce compte a demandée : état, octets écrits, `generation`. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!JOB_ID.test(jobId)) return new NextResponse(null, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.u) return new NextResponse(null, { status: 401 });
  const job = offlineJobFor(session.u, jobId);
  if (!job) return new NextResponse(null, { status: 404 });
  return NextResponse.json({ job }, { headers: { "Cache-Control": "private, no-store" } });
}

/** Ce compte n'en veut plus — annulé ou supprimé de l'appareil (`forgetOfflineJob`). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!JOB_ID.test(jobId)) return new NextResponse(null, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.u) return new NextResponse(null, { status: 401 });
  forgetOfflineJob(session.u, jobId);
  return new NextResponse(null, { status: 204 });
}
