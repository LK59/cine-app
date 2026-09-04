import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { logPlaybackEvent, isPlayerEventKind } from "@/lib/playerLog";

/**
 * The player telling the server what happened to it.
 *
 * Open to every signed-in account, not only administrators: the whole point is to hear from the
 * seventeen people who will never open a technical panel. Nothing here reads anything back —
 * this endpoint only ever appends — so the worst a caller can do is write about themselves.
 */
export async function POST(req: NextRequest) {
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });

  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.u) return new NextResponse(null, { status: 403 });

  const body = (await req.json().catch(() => null)) as { kind?: unknown; fields?: unknown } | null;
  if (!isPlayerEventKind(body?.kind)) return NextResponse.json({ error: "Événement inconnu" }, { status: 400 });

  const fields = body?.fields;
  // The account comes from the session, never from the body: the one field that says who this
  // was about must not be the one field anybody can forge.
  logPlaybackEvent(session.u, body.kind, fields && typeof fields === "object" ? (fields as Record<string, unknown>) : {});
  return NextResponse.json({ ok: true });
}
