import { NextRequest, NextResponse } from "next/server";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { assertVisible } from "@/lib/itemVisibility";
import { callerOf } from "@/lib/subtitleGen/request";
import { createOrJoin } from "@/lib/subtitleGen/service";

/**
 * Lancer une génération, ou rejoindre celle qui court déjà pour ce fichier et cette langue
 * (DECISIONS.md §69). Écriture ouverte aux comptes ordinaires (liste blanche du proxy) : elle ne
 * dépense que dans les limites du quota quotidien du compte et du budget mensuel de l'installation.
 *
 * Refus nommés : 429 `quota`, 402 `budget`, 409 `exists`, 422 `no-source` ; 404 `disabled` quand la
 * fonction n'existe pas (pas de clé).
 */
export async function POST(req: NextRequest) {
  const who = await callerOf(req);
  if (!who) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { itemId?: unknown; mediaSourceId?: unknown; target?: unknown; position?: unknown; sessionId?: unknown } | null;
  const itemId = body?.itemId;
  if (!isJellyfinId(itemId) || typeof body?.target !== "string") return NextResponse.json({ error: "invalid" }, { status: 400 });
  const mediaSourceId = body.mediaSourceId === undefined || body.mediaSourceId === null ? undefined : body.mediaSourceId;
  if (mediaSourceId !== undefined && !isJellyfinId(mediaSourceId)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const refused = await assertVisible(who.session, itemId);
  if (refused) return refused;
  const position = typeof body.position === "number" && Number.isFinite(body.position) ? body.position : undefined;
  const viewerKey = typeof body.sessionId === "string" && body.sessionId.length <= 64 ? `${who.caller.user}:${body.sessionId}` : who.caller.user;
  try {
    const result = await createOrJoin(who.caller, { itemId, mediaSourceId: mediaSourceId as string | undefined, target: body.target, position }, viewerKey);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ jobId: result.jobId, status: result.status });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
