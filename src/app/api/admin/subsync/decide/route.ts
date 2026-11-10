import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { logError } from "@/lib/logger";
import { decideScope } from "@/lib/subtitleSync/admin";
import { parseAction, parseScope } from "@/lib/subtitleSync/scope";

export const dynamic = "force-dynamic";

/**
 * « Recaler » / « Refuser » / « Rétablir » (DECISIONS.md §141) : `{ scope, …, trackKey?, action: "apply" | "reject"
 * | "reset" }`. Une saison, une série ou un élément n'applique que des mesures fiables d'un décalage ou d'une
 * dérive ; une mesure périmée (le fichier a changé) n'est jamais appliquée. Administrateur seul.
 */
export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const scope = parseScope(body, true);
  const action = parseAction(body?.action);
  if (!scope || !action) return NextResponse.json({ error: "invalid" }, { status: 400 });
  try {
    const changed = await decideScope(scope, action, session.u);
    return NextResponse.json({ changed }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logError("subtitle-sync/decide", error, { scope: scope.scope, action });
    return NextResponse.json({ error: "decide" }, { status: 500 });
  }
}
