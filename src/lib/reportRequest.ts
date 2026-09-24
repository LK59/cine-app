import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { reportsDb, type ReportRow } from "@/lib/db";
import { canSee, whoIs, type Who } from "@/lib/reports";

/** La session de qui appelle, ou la réponse qui la refuse. */
export async function reportCaller(req: NextRequest): Promise<Who | NextResponse> {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  return whoIs(session);
}

/** Le signalement demandé, s'il existe et que cet appelant peut le voir — sinon 404, sans dire lequel des deux. */
export function reportFor(id: string, who: Who): ReportRow | NextResponse {
  const n = Number(id);
  const report = Number.isInteger(n) && n > 0 ? reportsDb.get(n) : null;
  if (!report || !canSee(report, who)) return NextResponse.json({ error: "Signalement introuvable" }, { status: 404 });
  return report;
}

/** Le JSON d'un champ de formulaire. */
export function jsonField(form: FormData, name: string): unknown {
  const raw = form.get(name);
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
