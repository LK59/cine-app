import { NextRequest, NextResponse } from "next/server";
import { reportsDb } from "@/lib/db";
import { reportCaller } from "@/lib/reportRequest";

export const dynamic = "force-dynamic";

/**
 * La pastille de l'onglet Compte : des réponses non lues à mes signalements — et, pour
 * l'administrateur, des signalements ou des commentaires qu'il n'a pas encore lus.
 */
export async function GET(req: NextRequest) {
  const who = await reportCaller(req);
  if (who instanceof NextResponse) return who;
  return NextResponse.json({ mine: reportsDb.unreadForUser(who.userId), admin: who.admin ? reportsDb.unreadForAdmin() : 0 });
}
