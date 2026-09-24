import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { listAccounts, recentSeances, weekSignals } from "@/lib/activity/accounts";

export const dynamic = "force-dynamic";

/** La vue d'ensemble : qui est là, qui regarde quoi, les comptes, et la semaine en chiffres. */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const now = Date.now();
  const [accounts, signals] = await Promise.all([listAccounts(now), Promise.resolve(weekSignals(now))]);
  return NextResponse.json({ now, accounts, signals, recent: recentSeances(20) });
}
