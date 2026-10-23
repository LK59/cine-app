import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { ackPassageArrival, availablePassageItems, passageArrival } from "@/lib/passage/service";

/**
 * Ce qu'un passage a emporté (DECISIONS.md §119), pour la session qui en est issue.
 *
 * `GET` : `{ at, settings?, downloads? }`, ou `{}` — lu au lancement du cinéma sur la nouvelle
 * adresse, application installée comprise : c'est là, et pas seulement dans la page `/passage`, que
 * l'appareil les pose (une application installée sur iPhone a son propre stockage). Les
 * téléchargements emportés n'y figurent que s'ils sont encore visibles pour ce compte
 * (`availablePassageItems`, sous son identité Jellyfin : supprimé ou masqué par ses tags bloqués,
 * un titre disparaît sans bruit) ; Jellyfin muet, la liste n'est pas rendue et reste pour le
 * lancement suivant.
 *
 * `POST { installed, settings?, downloads? }` : posés. Les réglages, dans l'application installée,
 * sont effacés ; les téléchargements, pris par cet appareil (`downloads: true`), sont effacés.
 */
async function sessionOf(req: NextRequest) {
  return verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value).catch(() => null);
}

export async function GET(req: NextRequest) {
  const session = await sessionOf(req);
  if (!session) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  const arrival = passageArrival(session.jti);
  if (!arrival) return NextResponse.json({}, { headers: { "Cache-Control": "no-store" } });
  const { downloads, ...rest } = arrival;
  let visible: typeof downloads | undefined;
  if (downloads?.length) {
    const available = await availablePassageItems(session, downloads.map((d) => d.itemId));
    if (available) visible = downloads.filter((d) => available.has(d.itemId));
  }
  if (!rest.settings && visible === undefined) return NextResponse.json({}, { headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ ...rest, ...(visible !== undefined ? { downloads: visible } : {}) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const session = await sessionOf(req);
  if (!session) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { installed?: unknown; settings?: unknown; downloads?: unknown } | null;
  ackPassageArrival(session.jti, body?.installed === true, {
    ...(body?.settings === false ? { settings: false } : {}),
    ...(body?.downloads === true ? { downloads: true } : {}),
  });
  return NextResponse.json({ ok: true });
}
