import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { createStreamDeckToken, listStreamDeckTokens, revokeStreamDeckToken } from "@/lib/streamdeck/tokens";

export const dynamic = "force-dynamic";

/** Les jetons du Stream Deck (27/10/2026) : la liste, la création (montré une fois), la révocation. */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  return NextResponse.json({ tokens: listStreamDeckTokens() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 40) : "";
  if (!name) return NextResponse.json({ error: "name" }, { status: 400 });
  const created = createStreamDeckToken(name, session.jfUser ?? session.u);
  if (!created) return NextResponse.json({ error: "limit" }, { status: 409 });
  return NextResponse.json(created, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[0-9a-f]{16}$/.test(id)) return NextResponse.json({ error: "id" }, { status: 400 });
  return revokeStreamDeckToken(id) ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: "absent" }, { status: 404 });
}
