import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { logRemoteDiag } from "@/lib/eventLogs";
import { remoteDiagAllowed } from "@/lib/writeLimits";

/**
 * Le relevé de télécommande d'une Fire TV — voir `installRemoteDiag` (fireTv.ts).
 *
 * Le compte vient de la session, jamais du corps. Tout est borné : trente touches et vingt focus
 * déplacés au plus, des chaînes courtes, des nombres finis ; le reste tombe. Rien n'est renvoyé.
 * Jusqu'à trois relevés par onglet (un par mode de Silk) : la limite de débit en laisse trois par
 * minute.
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
      // Depuis le 12/10 : le focus avant / après la touche, et si la grille l'a déplacé.
      before: str(k.before, 60),
      after: str(k.after, 60),
      gridMoved: k.gridMoved === true,
    };
  });
  // Les focus déplacés sans touche ni appui reçus par la page — la navigation spatiale de Silk.
  const focusMoves = (Array.isArray(body.focusMoves) ? (body.focusMoves as unknown[]) : []).slice(0, 20).map((raw) => {
    const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return { t: int(f.t, 3_600_000), from: str(f.from, 60), to: str(f.to, 60) };
  });
  const mode = body.mode === "curseur" || body.mode === "spatial" ? body.mode : undefined;
  logRemoteDiag({
    user: session.jfUser ?? session.u,
    device: requestDeviceLabel(req),
    ...(mode ? { mode, report: int(body.report, 3) } : {}),
    keys,
    focusMoves,
    pointerMoves: int(body.pointerMoves, 1_000_000),
    pointerAtFocus: int(body.pointerAtFocus, 1_000_000),
    wheels: int(body.wheels, 1_000_000),
    edgeScrolls: int(body.edgeScrolls, 1_000_000),
    spentMs: int(body.spentMs, 3_600_000),
    viewport: str(body.viewport, 20),
  });
  return new NextResponse(null, { status: 204 });
}
