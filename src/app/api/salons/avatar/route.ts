import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { avatarDb } from "@/lib/db";
import { parseLook } from "../../../../../salons/src/tv";

export const dynamic = "force-dynamic";

const subOf = (session: { jfId?: string; u: string }) => session.jfId ?? `local:${session.u}`;

/**
 * L'apparence de l'avatar du compte dans les salons du chalet (DECISIONS.md §146, étape 5) : `[couleur, chapeau,
 * écharpe, lunettes]`, gardée par compte — la même sur tous ses appareils. `null` : jamais choisie (le chalet en tire
 * une de l'identifiant).
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  return NextResponse.json({ look: session.role === "share" ? null : avatarDb.get(subOf(session)) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PUT(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  if (session.role === "share") return NextResponse.json({ saved: false });
  const body = (await req.json().catch(() => null)) as { look?: unknown } | null;
  const look = parseLook(body?.look);
  if (!look) return NextResponse.json({ saved: false });
  avatarDb.set(subOf(session), look);
  return NextResponse.json({ saved: true, look });
}
