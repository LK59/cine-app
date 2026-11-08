import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { logRecapView } from "@/lib/eventLogs";
import { recapEventAllowed } from "@/lib/writeLimits";

/**
 * L'usage de « Précédemment » (DECISIONS.md §137) : `affiché` et `synopsis`, une ligne au journal des
 * ouvertures. Le compte vient de la session, jamais du corps ; les champs sont bornés, le reste tombe —
 * même règle que les mesures des Nouveautés.
 */
const EVENTS = new Set(["affiché", "synopsis"]);
const short = (v: unknown, n: number): string | null => (typeof v === "string" && v ? v.slice(0, n) : null);

export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.role === "share") return new NextResponse(null, { status: 401 });
  if (!recapEventAllowed(session.u)) return new NextResponse(null, { status: 429 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const event = body?.event;
  if (typeof event !== "string" || !EVENTS.has(event)) return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
  const idleMin = typeof body?.idleMin === "number" && Number.isFinite(body.idleMin) && body.idleMin >= 0 ? Math.round(body.idleMin) : null;
  logRecapView(event as "affiché" | "synopsis", {
    user: session.jfUser ?? session.u,
    device: requestDeviceLabel(req),
    series: short(body?.series, 120),
    episode: short(body?.episode, 12),
    source: body?.source === "officiel" ? "officiel" : "ia",
    idleMin,
  });
  return new NextResponse(null, { status: 204 });
}
