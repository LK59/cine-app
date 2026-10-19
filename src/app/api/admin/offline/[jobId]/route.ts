import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { deleteOfflineCopy } from "@/lib/offline/jobs";

export const dynamic = "force-dynamic";

const JOB_ID = /^[0-9a-f]{32}$/;

/**
 * Effacer une version du serveur, depuis l'Activité. Administrateur seul : la route le vérifie, et
 * `proxy.ts` refuse de toute façon cette écriture à un compte ordinaire (elle n'est pas dans sa liste
 * blanche — seule `DELETE /api/offline/jobs/<id>`, qui ne retire que sa propre demande, y est).
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const { jobId } = await params;
  if (!JOB_ID.test(jobId)) return NextResponse.json({ error: "Version inconnue" }, { status: 400 });
  if (!deleteOfflineCopy(jobId, session.u)) return NextResponse.json({ error: "Version inconnue" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
