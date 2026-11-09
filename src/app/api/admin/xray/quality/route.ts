import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { xray, xrayConfigured, type XrayQualityGroup } from "@/lib/clients/xray";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { logError } from "@/lib/logger";
import { taskLog } from "@/lib/taskLog";
import { seriesRows } from "@/lib/xray/scanStore";

export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" };

export type XrayQualityRow = XrayQualityGroup & { name: string | null };

export interface XrayQualityPayload {
  configured: boolean;
  /** Le service n'a pas répondu (ou une version d'avant 10.30, sans `/quality`). */
  unavailable?: boolean;
  overall?: XrayQualityGroup;
  movies?: XrayQualityGroup | null;
  /** Les séries, les moins bien nommées d'abord (l'ordre du service). */
  series?: XrayQualityRow[];
}

function nameOf(seriesId: string | null): string | null {
  if (!seriesId) return null;
  try {
    return seriesRows(seriesId).name;
  } catch {
    return null;
  }
}

/**
 * La qualité des noms (10.30, DECISIONS.md §138, « Qui parle ») — Configuration → Acteurs à l'écran : par série
 * et pour toute la bibliothèque, la part du temps de parole qui porte un nom, les voix indécises et en désaccord
 * (mémoire de la série contre visages de l'épisode), la part du temps de visage nommée ; les séries les moins
 * bien nommées d'abord (`GET`). `POST { action: "reset", seriesId }` : « Réinitialiser la mémoire de cette
 * série » — le service efface ses contributions (visages et voix) puis la renomme dans l'ordre des épisodes,
 * sans relire un fichier. Administrateur seul : `adminOnly`, et `/api/admin/xray` est dans `ADMIN_ONLY_READS`.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  if (!xrayConfigured()) return NextResponse.json({ configured: false } satisfies XrayQualityPayload, { headers: PRIVATE });
  try {
    const q = await xray.quality();
    const payload: XrayQualityPayload = {
      configured: true,
      overall: q.overall,
      movies: q.movies,
      series: (q.series ?? []).map((s) => ({ ...s, name: nameOf(s.seriesId) })),
    };
    return NextResponse.json(payload, { headers: PRIVATE });
  } catch (error) {
    logError("xray/quality", error);
    return NextResponse.json({ configured: true, unavailable: true } satisfies XrayQualityPayload, { headers: PRIVATE });
  }
}

export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { action?: unknown; seriesId?: unknown } | null;
  if (body?.action !== "reset" || !isJellyfinId(body.seriesId)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  if (!xrayConfigured()) return NextResponse.json({ error: "off" }, { status: 409 });
  const seriesId = body.seriesId.toLowerCase();
  try {
    const { name, itemIds } = seriesRows(seriesId);
    const out = await xray.resetSeriesMemory(seriesId, itemIds);
    taskLog("xray", "mémoire de série réinitialisée", { série: name ?? seriesId, contributions: out.removed, épisodes: out.queued });
    return NextResponse.json(out, { headers: PRIVATE });
  } catch (error) {
    logError("xray/memory-reset", error, { seriesId });
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
