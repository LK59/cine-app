import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { localeOf } from "@/lib/i18n";
import type { SessionPayload } from "@/lib/auth";
import type { Caller } from "./service";

/**
 * L'appelant d'une route `/api/subtitle-gen/*` : sa session (le proxy l'a déjà exigée), son compte
 * Jellyfin — les descriptions de fichier se lisent sous son identité, donc avec ses tags bloqués —
 * et la langue de son interface.
 */
export async function callerOf(req: NextRequest): Promise<{ caller: Caller; session: SessionPayload } | null> {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId) return null;
  return { caller: { user: session.jfUser ?? session.u, jfId: session.jfId, locale: localeOf(req) }, session };
}

export const JOB_ID = /^[0-9a-f]{32}$/;
