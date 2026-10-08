import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { reportsDb, type ReportRow } from "@/lib/db";
import { canSee, whoIs, type Who } from "@/lib/reports";
import { crossSiteWrite } from "@/lib/crossSite";
import { SESSION_EXPIRED_HEADER } from "@/lib/sessionExpired";
import { REPORT_BODY_LIMIT } from "@/lib/reportLimits";

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
  | "incomplete"
  | "quota"
  // Posé aussi par le téléphone avant d'envoyer (`prepareImage.ts`) ; le serveur le renvoie quand
  // un corps annoncé dépasse `REPORT_BODY_LIMIT` — la même phrase à l'écran.
  | "requestTooLarge";

export function reportError(code: ReportErrorCode, status: number, detail?: string): NextResponse {
  return NextResponse.json({ error: detail ?? code, code }, { status });
}

/**
 * La session de qui appelle, ou la réponse qui la refuse — et ce que le proxy faisait pour ces
 * routes, qu'il ne voit plus.
 *
 * Les signalements sont sortis du matcher du proxy (A2, 29/09/2026, voir `HORS_PROXY`) : il fallait
 * laisser Next garder 100 Mo de *chaque* corps d'API pour leurs captures, et vingt POST anonymes
 * suffisaient à remplir la mémoire. Tout ce qui suit passe donc ici, et **avant que la route ne
 * lise le corps** — chaque route l'appelle en premier. Dans l'ordre du proxy : l'écriture venue
 * d'une autre page (la même fonction que lui), puis la session, avec l'en-tête qui dit à la page
 * que c'est la sienne qui a disparu et pas un service amont. Le corps annoncé trop lourd vient
 * après la session : un anonyme n'apprend rien de nos limites.
 */
export async function reportCaller(req: NextRequest): Promise<Who | NextResponse> {
  if (crossSiteWrite(req)) return reportError("refused", 403, "Requête refusée");
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    const refused = reportError("unauthenticated", 401, "Non authentifié");
    refused.headers.set(SESSION_EXPIRED_HEADER, "1");
    return refused;
  }
  if (Number(req.headers?.get("content-length")) > REPORT_BODY_LIMIT) return reportError("requestTooLarge", 413, "Envoi trop lourd");
  // Un corps sans longueur annoncée (`Transfer-Encoding: chunked`) passait sous la limite ci-dessus,
  // et `formData()` le gardait entier en mémoire (audit du 08/10/2026). Un navigateur annonce
  // toujours la longueur d'un formulaire ou d'un JSON : un corps qui ne le fait pas est refusé.
  if (req.headers?.get("transfer-encoding") && !req.headers.get("content-length")) {
    return reportError("requestTooLarge", 411, "Longueur requise");
  }
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
