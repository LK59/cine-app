import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { assertVisible } from "@/lib/itemVisibility";
import { emptyXray, scenesForPlayer, type XrayPlayerPayload } from "@/lib/xray/scenes";

export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" };

/**
 * Les acteurs à l'écran d'un film ou d'un épisode, pour le lecteur (DECISIONS.md §138) : les scènes
 * analysées par `laterna-xray`, jointes à la distribution.
 *
 * Une route appelée par élément : « rien ici » répond **200** avec `scenes: []` et un `status` qui dit
 * pourquoi — option coupée, pas encore analysé, en cours, service injoignable —, jamais 404 (CLAUDE.md,
 * « An expected absence is never a 404 » : une rangée de 404 fait bannir l'adresse par le relais).
 *
 * Un élément que ce compte ne voit pas (tags bloqués, bibliothèque non permise, autre titre qu'un lien
 * de partage) répond exactement comme un élément jamais analysé : `none`. La question est posée à
 * Jellyfin sous l'identité du compte (`assertVisible`), avant toute lecture du service.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  if (!isJellyfinId(itemId)) return NextResponse.json({ error: "itemId invalide" }, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const refused = await assertVisible(session, itemId);
  if (refused) {
    // Caché à ce compte : comme s'il n'avait jamais été analysé, sans rien dire de plus.
    if (refused.status === 404) return NextResponse.json(emptyXray("none") satisfies XrayPlayerPayload, { headers: PRIVATE });
    return refused;
  }
  return NextResponse.json(await scenesForPlayer(itemId), { headers: PRIVATE });
}
