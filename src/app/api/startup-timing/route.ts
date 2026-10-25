import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { logStartupTiming } from "@/lib/eventLogs";
import { startupTimingAllowed } from "@/lib/writeLimits";
import { requestHost } from "@/lib/publicOrigin";

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

/** Un compte de cartes : entier, positif, borné. */
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1000 ? value : null;

/**
 * « Reprendre » posé depuis l'appareil, et ce que la réponse fraîche y a corrigé (13/10/2026,
 * `noteContinueReconciled`) : ajouts, retraits, déplacements, barres qui ont bougé.
 */
function continueOf(body: Record<string, unknown>): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  if (body.resumeFromCache === true) out.resumeFromCache = true;
  for (const key of ["resumeAdded", "resumeRemoved", "resumeMoved", "resumeProgressed"] as const) {
    const n = count(body[key]);
    if (n !== null) out[key] = n;
  }
  return out;
}

/**
 * Les requêtes de l'ouverture vues par le navigateur (15/10/2026, `routeTimingsOf`) : les quatre
 * routes connues, leurs champs connus, bornés ; le reste tombe.
 */
const TIMED_ROUTE_NAMES = new Set(["movies", "series", "resume", "nextUp"]);
const ROUTE_FIELDS = ["startMs", "waitMs", "appMs", "readMs"] as const;

function routesOf(value: unknown): Record<string, Record<string, number>> | null {
  if (!value || typeof value !== "object") return null;
  const out: Record<string, Record<string, number>> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!TIMED_ROUTE_NAMES.has(name) || !raw || typeof raw !== "object") continue;
    const fields = raw as Record<string, unknown>;
    const route: Record<string, number> = {};
    for (const key of ROUTE_FIELDS) {
      const n = ms(fields[key]);
      if (n !== null) route[key] = n;
    }
    const kB = fields.kB;
    if (typeof kB === "number" && Number.isInteger(kB) && kB >= 0 && kB < 1_000_000) route.kB = kB;
    if (Object.keys(route).length > 0) out[name] = route;
  }
  return Object.keys(out).length > 0 ? out : null;
}

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
  // Une mesure par ouverture ; au-delà du seuil, une boucle (D12, voir `writeLimits.ts`).
  if (!startupTimingAllowed(session.u)) return new NextResponse(null, { status: 429 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Corps invalide" }, { status: 400 });
  const routes = routesOf(body.routes);
  // L'adresse ouverte, d'après la requête et non le corps (§119) : un `host` du corps est ignoré.
  const host = requestHost(req.headers);
  logStartupTiming({
    user: session.jfUser ?? session.u,
    device: requestDeviceLabel(req),
    build: typeof body.build === "string" ? body.build.slice(0, 40) : null,
    version: typeof body.version === "string" ? body.version.slice(0, 20) : null,
    cacheUsed: body.cacheUsed === true,
    cacheAgeMs: ms(body.cacheAgeMs),
    cacheMs: ms(body.cacheMs),
    networkMs: ms(body.networkMs),
    bootMs: ms(body.bootMs),
    idbMs: ms(body.idbMs),
    resumeNetworkMs: ms(body.resumeNetworkMs),
    // La page est passée en arrière-plan pendant l'ouverture : les mesures d'après ne sont pas
    // envoyées (`beforeHidden`, persistentCache.ts), et ceci dit pourquoi elles manquent.
    ...(ms(body.hiddenAtMs) !== null ? { hiddenAtMs: ms(body.hiddenAtMs) as number } : {}),
    standalone: body.standalone === true,
    ...(typeof body.installedApp === "boolean" ? { installedApp: body.installedApp } : {}),
    ...(host ? { host } : {}),
    ...(routes ? { routes } : {}),
    ...continueOf(body),
    ...storageOf(body.storage),
  });
  return new NextResponse(null, { status: 204 });
}
