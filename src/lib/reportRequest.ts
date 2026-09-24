import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { reportsDb, type ReportRow } from "@/lib/db";
import { canSee, whoIs, type Who } from "@/lib/reports";

/**
 * Ce que l'écran sait dire d'un refus, dans la langue du compte (`report.errors.<code>`). Le
 * `error` qui l'accompagne reste en français : il est pour le journal et pour qui lit la réponse
 * brute, jamais affiché tel quel (un compte réglé en anglais lisait « Formulaire illisible »).
 */
export type ReportErrorCode =
  | "unauthenticated"
  | "notFound"
  | "form"
  | "notImage"
  | "tooLarge"
  | "tooMany"
  | "empty"
  | "notDraft"
  | "draftNoComment"
  | "refused"
  | "incomplete";

export function reportError(code: ReportErrorCode, status: number, detail?: string): NextResponse {
  return NextResponse.json({ error: detail ?? code, code }, { status });
}

/** La session de qui appelle, ou la réponse qui la refuse. */
export async function reportCaller(req: NextRequest): Promise<Who | NextResponse> {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return reportError("unauthenticated", 401, "Non authentifié");
  return whoIs(session);
}

/** Le signalement demandé, s'il existe et que cet appelant peut le voir — sinon 404, sans dire lequel des deux. */
export function reportFor(id: string, who: Who): ReportRow | NextResponse {
  const n = Number(id);
  const report = Number.isInteger(n) && n > 0 ? reportsDb.get(n) : null;
  if (!report || !canSee(report, who)) return reportError("notFound", 404, "Signalement introuvable");
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
