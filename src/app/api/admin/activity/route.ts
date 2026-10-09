import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { household, listAccounts, recentSeances, weekSignals } from "@/lib/activity/accounts";
import { alertsClearedAt } from "@/lib/activity/alertsCleared";

export const dynamic = "force-dynamic";

/** La vue d'ensemble : qui est là, qui regarde quoi, les comptes, et la semaine en chiffres. */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const now = Date.now();
  // Lue une fois et passée à chaque calcul : les quatre parties voient la même date d'effacement.
  const clearedAt = alertsClearedAt();
  const [accounts, signals] = await Promise.all([listAccounts(now, clearedAt), Promise.resolve(weekSignals(now, clearedAt))]);
  return NextResponse.json({ now, accounts, signals, recent: recentSeances(20, now, clearedAt), household: household(now, clearedAt), alertsClearedAt: clearedAt });
}
