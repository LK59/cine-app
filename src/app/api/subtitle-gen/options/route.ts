import { NextRequest, NextResponse } from "next/server";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { assertVisible } from "@/lib/itemVisibility";
import { callerOf } from "@/lib/subtitleGen/request";
import { genOptions } from "@/lib/subtitleGen/service";

/**
 * Ce que le lecteur peut proposer pour ce titre (DECISIONS.md §69) : la fonction existe-t-elle,
 * vers quelles langues, quelles tâches courent déjà, et le quota du compte. Sans clé, `enabled:
 * false` et rien d'autre — la fonction n'existe pas.
 */
export async function GET(req: NextRequest) {
  const itemId = req.nextUrl.searchParams.get("itemId");
  if (!isJellyfinId(itemId)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const who = await callerOf(req);
  if (!who) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const refused = await assertVisible(who.session, itemId);
  if (refused) return refused;
  try {
    return NextResponse.json(await genOptions(who.caller, itemId), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
