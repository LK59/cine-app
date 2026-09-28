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

/** Des mégaoctets : un nombre positif, sous le pétaoctet. */
const megabytes = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e9 ? Math.round(value * 10) / 10 : null;

const PERSIST_OUTCOMES = new Set(["accordé", "déjà", "refusé", "ignoré"]);

/**
 * Le stockage de l'appareil (28/09/2026, `storageFacts`) : la persistance demandée et obtenue, le
 * quota, l'occupation et la reprise instantanée. Seuls les champs connus, bornés ; le reste tombe.
 */
function storageOf(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const out: Record<string, string | number | boolean> = {};
  if (typeof raw.persist === "string" && PERSIST_OUTCOMES.has(raw.persist)) out.persist = raw.persist;
  if (typeof raw.persisted === "boolean") out.persisted = raw.persisted;
  if (raw.storageTimedOut === true) out.storageTimedOut = true;
  if (raw.storageMode === "normal" || raw.storageMode === "réduit") out.storageMode = raw.storageMode;
  for (const key of ["quotaMB", "usageMB", "idbMB", "cacheMB", "opfsMB", "resumeMB"] as const) {
    const n = megabytes(raw[key]);
    if (n !== null) out[key] = n;
  }
  if (typeof raw.resumeTitles === "number" && Number.isInteger(raw.resumeTitles) && raw.resumeTitles >= 0 && raw.resumeTitles < 1000) {
    out.resumeTitles = raw.resumeTitles;
  }
  return out;
}

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
    ...storageOf(body.storage),
  });
  return new NextResponse(null, { status: 204 });
}
