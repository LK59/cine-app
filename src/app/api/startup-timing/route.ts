import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { deviceLabel } from "@/lib/deviceLabel";
import { logStartupTiming } from "@/lib/eventLogs";

/**
 * Ce que l'ouverture du cinéma a coûté, cache de l'appareil ou réseau — voir `persistentCache.ts`.
 *
 * Le compte vient de la session, jamais du corps : une mesure ne parle que de celui qui l'envoie.
 * Les nombres sont bornés, le reste ignoré ; rien n'est renvoyé.
 */
const ms = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 86_400_000 * 30 ? Math.round(value) : null;

export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return new NextResponse(null, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Corps invalide" }, { status: 400 });
  logStartupTiming({
    user: session.jfUser ?? session.u,
    device: deviceLabel(req.headers.get("user-agent")),
    build: typeof body.build === "string" ? body.build.slice(0, 40) : null,
    cacheUsed: body.cacheUsed === true,
    cacheAgeMs: ms(body.cacheAgeMs),
    cacheMs: ms(body.cacheMs),
    networkMs: ms(body.networkMs),
    standalone: body.standalone === true,
  });
  return new NextResponse(null, { status: 204 });
}
