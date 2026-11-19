import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { logError } from "@/lib/logger";
import { triPayload } from "@/lib/tri/collect";
import { executeRemoval, PlanChangedError } from "@/lib/tri/execute";
import { parseTarget } from "@/lib/tri/target";

export const dynamic = "force-dynamic";
// qBittorrent, Radarr/Sonarr, Jellyseerr, Jellyfin, puis jusqu'à 30 s d'attente du disque.
export const maxDuration = 120;

/**
 * La suppression confirmée (DECISIONS.md §198). Le corps porte l'empreinte du plan vu à l'aperçu : si
 * le titre a changé depuis, 409 et rien ne part.
 */
export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = await req.json().catch(() => null);
  const target = parseTarget(body);
  const fingerprint = typeof body?.fingerprint === "string" ? body.fingerprint : null;
  if (!target || !fingerprint) return NextResponse.json({ error: "titre ou aperçu manquant" }, { status: 400 });
  try {
    const title = (await triPayload()).titles.find((t) => t.kind === target.kind && t.id === target.id);
    const entry = await executeRemoval({
      ...target,
      fingerprint,
      jellyseerrMediaId: title?.jellyseerrMediaId ?? null,
      requests: title?.requests.length ?? 0,
      year: title?.year ?? null,
      requestedBy: [...new Set(title?.requests.map((r) => r.user) ?? [])],
      sizeBytes: title?.sizeBytes ?? 0,
      by: session.jfUser ?? session.u,
    });
    return NextResponse.json(entry);
  } catch (e) {
    if (e instanceof PlanChangedError) return NextResponse.json({ error: e.message, changed: true }, { status: 409 });
    logError("tri", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
