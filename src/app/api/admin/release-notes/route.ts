import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { newsDb } from "@/lib/news/store";
import { newsAccounts, newsSynthesis } from "@/lib/news/summary";
import { translationAvailable } from "@/lib/news/translate";
import { newsAccountNames, pageBody } from "@/lib/news/admin";

export const dynamic = "force-dynamic";

/**
 * Les Nouveautés vues de l'activité (DECISIONS.md §73) — administrateur seul, lecture comprise
 * (`proxy.ts` la range aussi dans `ADMIN_ONLY_READS`) : la lecture nomme chaque compte et ce qu'il
 * a fait de la fenêtre.
 *
 * GET : les pages (brouillons compris), l'état de chaque compte et la synthèse de la dernière page.
 * POST : un nouveau brouillon.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const names = await newsAccountNames();
  const pages = newsDb.all();
  const published = pages.filter((p) => p.status === "published");
  const states = newsDb.states();
  return NextResponse.json({
    now: Date.now(),
    pages,
    accounts: newsAccounts(names, states, published),
    synthesis: newsSynthesis(names, states, published),
    translateAvailable: translationAvailable(),
  });
}

export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = pageBody(await req.json().catch(() => null));
  if (!body) return NextResponse.json({ error: "Une version et un contenu en français sont nécessaires" }, { status: 400 });
  const id = newsDb.create(body.version, body.content);
  return NextResponse.json({ id }, { status: 201 });
}
