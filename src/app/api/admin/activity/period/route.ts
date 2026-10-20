import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { monthSignals } from "@/lib/activity/accounts";
import { allTimeSignals } from "@/lib/activity/activityHistory";

export const dynamic = "force-dynamic";

/**
 * Les chiffres de l'Activité sur trente jours (`?period=30`) ou depuis le début (`?period=all`).
 * À part de la vue d'ensemble, relue toutes les vingt secondes : ils ne se demandent que quand
 * l'administrateur les choisit.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const period = req.nextUrl.searchParams.get("period");
  if (period === "30") return NextResponse.json(monthSignals());
  if (period === "all") return NextResponse.json(allTimeSignals());
  return NextResponse.json({ error: "Période inconnue" }, { status: 400 });
}
