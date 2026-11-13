import { NextRequest, NextResponse } from "next/server";
import { getPeopleStats, type PeopleStat, type PeopleStats } from "@/lib/peopleStats";

export type { PeopleStat, PeopleStats };

export const dynamic = "force-dynamic";

// Le calcul vit dans `peopleStats.ts` depuis le 13/11/2026 : il est aussi préparé au démarrage
// (`statsPrewarm.ts`), et la route n'est plus qu'une lecture de ce qu'il a rangé.
export async function GET(req: NextRequest) {
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
  return NextResponse.json(getPeopleStats(forceRefresh));
}
