import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { assertVisible } from "@/lib/itemVisibility";
import { emptyXray, scenesForPlayer, type XrayPlayerPayload } from "@/lib/xray/scenes";
import { xrayOpenTo } from "@/lib/clients/xray";
import { personFactsForPlayer } from "@/lib/xray/person";
import { LOCALE_COOKIE, type Locale } from "@/lib/i18n";

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
 *
 * `?person=<id TMDB>` (10.27) : le panneau d'une personne touchée — âge, lieu de naissance, courte
 * biographie, autres titres dans la bibliothèque (`personFactsForPlayer`, le chemin des fiches personne
 * du cinéma). Même porte, même réponse 200 : `{ status: "none" }` quand il n'y a rien à dire. Un lien de
 * partage n'en reçoit jamais les autres titres (`library`, 10.28.1) : il ne voit que le sien.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  if (!isJellyfinId(itemId)) return NextResponse.json({ error: "itemId invalide" }, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  // Réglée sur `admins` (`featureAudience.ts`), l'option est coupée pour tout autre compte : `off`.
  if (!xrayOpenTo(session)) return NextResponse.json(emptyXray("off") satisfies XrayPlayerPayload, { headers: PRIVATE });

  const refused = await assertVisible(session, itemId);
  if (refused) {
    // Caché à ce compte : comme s'il n'avait jamais été analysé, sans rien dire de plus.
    if (refused.status === 404) return NextResponse.json(emptyXray("none") satisfies XrayPlayerPayload, { headers: PRIVATE });
    return refused;
  }
  const person = Number(req.nextUrl?.searchParams.get("person") ?? "");
  if (Number.isInteger(person) && person > 0) {
    const raw = req.cookies.get(LOCALE_COOKIE)?.value ?? "";
    const lang: Locale = raw === "en" || raw === "es" || raw === "de" ? raw : "fr";
    // Un lien de partage (§112, 10.28.1) : les faits de la personne, jamais ses autres titres de la bibliothèque.
    const share = session.role === "share";
    const facts = await personFactsForPlayer(itemId, person, lang, session.jfId, { library: !share });
    if (share) delete facts.library;
    return NextResponse.json(facts, { headers: PRIVATE });
  }
  return NextResponse.json(await scenesForPlayer(itemId), { headers: PRIVATE });
}
