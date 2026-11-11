import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { jellyfin } from "@/lib/clients/jellyfin";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { signValue, verifyValue, type Roster, type TvTicket } from "../../../../../salons/src/seal";

export const dynamic = "force-dynamic";

const subOf = (session: { jfId?: string; u: string }) => session.jfId ?? `local:${session.u}`;

/**
 * Le droit de lancer un titre sur la télévision commune d'un salon (DECISIONS.md §146, étape 3).
 *
 * Un titre ne se lance pour le salon **que si tous les présents peuvent le voir** : pour chaque compte de la liste
 * signée par le service (`roster`), Jellyfin doit rendre l'élément sous son identifiant — tags bloqués et bibliothèques
 * permises compris, comme partout (`getItemFile`). Un refus ne dit pas à cause de qui. Accordé, le droit est signé
 * pour ce salon et ce titre (`seal.ts`, « tv »), et le service ne lance rien d'autre.
 *
 * Toujours 200 : `{ allowed: false }` sinon.
 */
export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const headers = { "Cache-Control": "private, no-store" };
  const denied = () => NextResponse.json({ allowed: false }, { headers });
  const key = config.salons.key;
  if (session.role === "share" || key.length < 32) return denied();
  const body = (await req.json().catch(() => null)) as { itemId?: unknown; roster?: unknown } | null;
  const itemId = body?.itemId;
  if (!isJellyfinId(itemId)) return denied();
  const roster = verifyValue<Roster>(body?.roster, key, "roster");
  const me = subOf(session);
  if (!roster || roster.exp <= Date.now() || !Array.isArray(roster.subs) || !roster.subs.includes(me) || roster.subs.length > 16) return denied();

  // Chaque compte Jellyfin présent doit voir l'élément ; un compte local (l'administrateur sans Jellyfin) n'a pas de
  // restriction propre.
  const jfIds = roster.subs.filter((s): s is string => typeof s === "string" && !s.startsWith("local:") && isJellyfinId(s));
  const visible = await Promise.all(jfIds.map((id) => jellyfin.getItemFile(id, itemId).then((item) => !!item, () => false)));
  if (visible.some((ok) => !ok)) return denied();
  const ticket: TvTicket = { room: roster.room, itemId, exp: Date.now() + 5 * 60_000 };
  return NextResponse.json({ allowed: true, ticket: signValue(ticket, key, "tv") }, { headers });
}
