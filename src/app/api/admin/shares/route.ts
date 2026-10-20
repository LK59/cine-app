import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { sharesOverview } from "@/lib/share/overview";
import { createShare, ShareError } from "@/lib/share/service";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Les liens de partage et ce qu'ils ont consommé — l'Activité (DECISIONS.md §112). */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  return NextResponse.json(sharesOverview(), { headers: { "Cache-Control": "private, no-store" } });
}

/**
 * Créer un lien : `{ kind, itemId, radarrId?, sonarrId?, label, days }`. La réponse porte le mot de
 * passe, une seule fois — il n'est gardé que haché.
 */
export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
  try {
    const { share, password } = await createShare({
      kind: body?.kind === "series" ? "series" : body?.kind === "movie" ? "movie" : ("?" as "movie"),
      itemId: typeof body?.itemId === "string" ? body.itemId.toLowerCase() : "",
      radarrId: int(body?.radarrId),
      sonarrId: int(body?.sonarrId),
      label: typeof body?.label === "string" ? body.label : "",
      days: typeof body?.days === "number" ? body.days : NaN,
      createdBy: session.u,
      creatorJfId: session.jfId ?? null,
    });
    return NextResponse.json(
      { id: share.id, code: share.code, path: `/partage/${share.code}`, password, expiresAt: share.expiresAt, title: share.title, label: share.label },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (err) {
    if (err instanceof ShareError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    logError("share.create", err);
    return NextResponse.json({ error: "Le serveur média n'a pas pu créer le compte du lien", code: "share-unavailable" }, { status: 502 });
  }
}
