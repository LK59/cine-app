import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { alertsClearedAt } from "@/lib/activity/alertsCleared";
import { historySeries } from "@/lib/activity/activityHistory";
import { preparedUnkept, respondPrepared } from "@/lib/cachedJson";

export const dynamic = "force-dynamic";

/**
 * Trente jours de la courbe des heures regardées, finissant le jour `end` : de quoi remonter tout
 * l'historique depuis le tableau de bord de l'Activité (07/11/2026). Les jours clos viennent de la
 * base (`activity_day_tallies`), les derniers des journaux.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const end = req.nextUrl.searchParams.get("end") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return NextResponse.json({ error: "Jour invalide" }, { status: 400 });
  return respondPrepared(req, preparedUnkept(historySeries(end, Date.now(), alertsClearedAt())));
}
