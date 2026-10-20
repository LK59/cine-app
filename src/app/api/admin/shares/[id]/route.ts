import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { deleteShare, extendShare, revokeShare, ShareError } from "@/lib/share/service";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

const ID = /^[0-9a-f]{16}$/;

/** `{ action: "extend", days }` ou `{ action: "revoke" }` (DECISIONS.md §112). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const { id } = await params;
  if (!ID.test(id)) return NextResponse.json({ error: "Lien inconnu" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { action?: unknown; days?: unknown } | null;
  try {
    if (body?.action === "revoke") {
      const share = await revokeShare(id, session.u);
      return share ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Lien inconnu" }, { status: 404 });
    }
    if (body?.action === "extend") {
      await extendShare(id, typeof body.days === "number" ? body.days : NaN, session.u);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
  } catch (err) {
    if (err instanceof ShareError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    logError("share.update", err, { share: id });
    return NextResponse.json({ error: "Le serveur média ne répond pas", code: "share-unavailable" }, { status: 502 });
  }
}

/** Efface le lien, son compte Jellyfin et ses sessions. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const { id } = await params;
  if (!ID.test(id)) return NextResponse.json({ error: "Lien inconnu" }, { status: 400 });
  try {
    return (await deleteShare(id, session.u)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Lien inconnu" }, { status: 404 });
  } catch (err) {
    logError("share.delete", err, { share: id });
    return NextResponse.json({ error: "Le serveur média ne répond pas", code: "share-unavailable" }, { status: 502 });
  }
}
