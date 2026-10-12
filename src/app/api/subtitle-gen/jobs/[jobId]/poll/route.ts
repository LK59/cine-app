import { NextRequest, NextResponse } from "next/server";
import { JOB_ID, callerOf } from "@/lib/subtitleGen/request";
import { pollJob } from "@/lib/subtitleGen/service";

/**
 * Le sondage du lecteur, toutes les deux secondes environ (DECISIONS.md §69) : les lignes traduites
 * depuis la révision déjà reçue, et la position de la tête de lecture — c'est elle qui donne la
 * priorité à ce spectateur. Une tâche est partagée : n'importe quel compte connecté peut la sonder,
 * elle ne contient que la traduction d'un sous-titre que ce titre propose déjà.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!JOB_ID.test(jobId)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const who = await callerOf(req);
  if (!who) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { since?: unknown; position?: unknown; sessionId?: unknown } | null;
  const since = typeof body?.since === "number" && Number.isFinite(body.since) ? body.since : 0;
  const position = typeof body?.position === "number" && Number.isFinite(body.position) ? body.position : undefined;
  const viewerKey = typeof body?.sessionId === "string" && body.sessionId.length <= 64 ? `${who.caller.user}:${body.sessionId}` : who.caller.user;
  const reply = pollJob(jobId, since, position, viewerKey);
  if (!reply) return NextResponse.json({ error: "not-found" }, { status: 404 });
  return NextResponse.json(reply, { headers: { "Cache-Control": "no-store" } });
}
