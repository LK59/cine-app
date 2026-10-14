import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { integrityStatus, pauseIntegrityCheck, startIntegrityCheck } from "@/lib/integrity/engine";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * L'intégrité des fichiers (DECISIONS.md §93), vue du contrôle de la bibliothèque — administrateur
 * seul, lecture comprise (`ADMIN_ONLY_READS` couvre `/api/admin/library-check/…` ; vérifié ici aussi).
 *
 * GET : la passe en cours ou la dernière, les comptes, les fichiers abîmés. POST `{ action }` :
 * `start` (vérifier, ou reprendre), `pause`.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  try {
    return NextResponse.json(integrityStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logError("integrite.status", error);
    return NextResponse.json({ error: "status" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action === "start") {
    const refusal = startIntegrityCheck();
    if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });
  } else if (body?.action === "pause") {
    await pauseIntegrityCheck();
  } else {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  return NextResponse.json(integrityStatus(), { headers: { "Cache-Control": "no-store" } });
}
