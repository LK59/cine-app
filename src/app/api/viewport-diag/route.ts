import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { logViewportDiag } from "@/lib/eventLogs";
import { viewportDiagAllowed } from "@/lib/writeLimits";

/**
 * Le relevé de hauteur de l'application installée sur iPhone et iPad — voir `viewportHeal.ts`.
 *
 * Le compte vient de la session, jamais du corps. Seuls les champs connus, bornés ; le reste tombe.
 * Rien n'est renvoyé.
 */
const SNAPSHOT_FIELDS = ["inner", "outer", "width", "vv", "vvTop", "client", "shell", "shellTop", "scrollY"] as const;
const DECISIONS = new Set(["rien", "focus", "focus au toucher", "champ", "film"]);
const TRIGGERS = new Set(["retour", "pageshow", "redimensionné", "clavier fermé", "toucher"]);

const px = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 100_000 ? Math.round(value) : null;
const str = (value: unknown, max: number): string | null => (typeof value === "string" ? value.slice(0, max) : null);

function snapshotOf(value: unknown): Record<string, number> {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of SNAPSHOT_FIELDS) {
    const n = px(raw[key]);
    if (n !== null) out[key] = n;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return new NextResponse(null, { status: 401 });
  if (!viewportDiagAllowed(session.u)) return new NextResponse(null, { status: 429 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Corps invalide" }, { status: 400 });
  logViewportDiag({
    user: session.jfUser ?? session.u,
    device: requestDeviceLabel(req),
    trigger: typeof body.trigger === "string" && TRIGGERS.has(body.trigger) ? body.trigger : null,
    decision: typeof body.decision === "string" && DECISIONS.has(body.decision) ? body.decision : null,
    best: px(body.best),
    before: snapshotOf(body.before),
    after: snapshotOf(body.after),
    screen: str(body.screen, 20),
    build: str(body.build, 40),
    version: str(body.version, 20),
  });
  return new NextResponse(null, { status: 204 });
}
