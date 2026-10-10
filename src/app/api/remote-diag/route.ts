import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { logRemoteDiag } from "@/lib/eventLogs";
import { remoteDiagAllowed } from "@/lib/writeLimits";

/**
 * Le relevé de télécommande d'une Fire TV — voir `installRemoteDiag` (fireTv.ts).
 *
 * Le compte vient de la session, jamais du corps. Tout est borné : trente touches au plus, des
 * chaînes courtes, des nombres finis ; le reste tombe. Rien n'est renvoyé.
 */
const str = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");
const int = (value: unknown, max: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), max) : 0;

export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return new NextResponse(null, { status: 401 });
  if (!remoteDiagAllowed(session.u)) return new NextResponse(null, { status: 429 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body.keys)) return NextResponse.json({ error: "Corps invalide" }, { status: 400 });
  const keys = (body.keys as unknown[]).slice(0, 30).map((raw) => {
    const k = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      key: str(k.key, 24),
      code: str(k.code, 24),
      keyCode: int(k.keyCode, 1000),
      target: str(k.target, 60),
      prevented: k.prevented === true,
      t: int(k.t, 3_600_000),
    };
  });
  logRemoteDiag({
    user: session.jfUser ?? session.u,
    device: requestDeviceLabel(req),
    keys,
    pointerMoves: int(body.pointerMoves, 1_000_000),
    wheels: int(body.wheels, 1_000_000),
    spentMs: int(body.spentMs, 3_600_000),
    viewport: str(body.viewport, 20),
  });
  return new NextResponse(null, { status: 204 });
}
