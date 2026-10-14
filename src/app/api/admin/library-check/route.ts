import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { libraryCheckStatus, refreshLibraryCheckIfStale, startLibraryCheck } from "@/lib/libraryCheck/run";

export const dynamic = "force-dynamic";

/**
 * Le contrôle de la bibliothèque (DECISIONS.md §90) — administrateur seul, lecture comprise (`proxy.ts`
 * le range aussi dans `ADMIN_ONLY_READS`) : il nomme chaque titre et chaque dossier, tags bloqués
 * compris.
 *
 * GET : le dernier résultat, l'analyse en cours s'il y en a une — et, si le résultat a plus d'un jour,
 * une nouvelle analyse part en arrière-plan. POST : « Analyser », tout de suite. Ni l'un ni l'autre
 * n'attend l'analyse, qui prend de quelques secondes à une minute.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  refreshLibraryCheckIfStale();
  return NextResponse.json(libraryCheckStatus());
}

export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  void startLibraryCheck();
  return NextResponse.json(libraryCheckStatus(), { status: 202 });
}
