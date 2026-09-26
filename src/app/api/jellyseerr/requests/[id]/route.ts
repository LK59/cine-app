import { NextRequest, NextResponse } from "next/server";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { withErrorHandling } from "@/lib/api-helpers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // Un corps illisible levait hors de tout `catch` : 500 au lieu de 400 (26/09/2026).
  const body = await req.json().catch(() => null);
  const action = body?.action;
  const id = Number(params.id);
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (action === "approve") return withErrorHandling(() => jellyseerr.approveRequest(id, session?.jsCookie));
  if (action === "decline") return withErrorHandling(() => jellyseerr.declineRequest(id, session?.jsCookie));
  return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
}
