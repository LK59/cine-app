import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { passageArrivedFrom, passageFetchedFor } from "@/lib/passage/service";
import { PASSAGE_DOWNLOADS_MAX } from "@/lib/passage/downloads";
import { crossSiteWrite } from "@/lib/crossSite";
import { appendJsonLine } from "@/lib/logFile";
import { SERVER_LOG_FILE, SERVER_LOG_KEEP } from "@/lib/logger";
import { requestHost } from "@/lib/publicOrigin";

/**
 * L'attestation qu'attend l'ancienne adresse pour libérer sa place (DECISIONS.md §119).
 *
 * `GET ?items=<id>,<id>…` (au plus `2 × PASSAGE_DOWNLOADS_MAX` identifiants Jellyfin) :
 * `{ fetched: { <itemId>: <jobId> }, arrived }` — parmi ces titres, ceux que **ce compte** a récupérés entiers
 * sur la nouvelle adresse, par une session issue d'un passage parti de **la session qui demande**
 * (`passageFetchedFor`). Rien d'autre ne s'y lit : un autre compte, une autre session du même compte
 * (un autre appareil) reçoivent `{ fetched: {} }`, comme une session qui n'est jamais passée. Foyer
 * seulement ; un lien de partage n'a ni passage ni téléchargement.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value).catch(() => null);
  if (!session || (session.role !== "admin" && session.role !== "user")) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  const raw = (req.nextUrl.searchParams.get("items") ?? "").split(",").filter(Boolean);
  if (raw.length > PASSAGE_DOWNLOADS_MAX * 2 || !raw.every((id) => isJellyfinId(id))) {
    return NextResponse.json({ error: "Demande invalide" }, { status: 400 });
  }
  const fetched = passageFetchedFor(session.jti, session.u, raw.map((id) => id.toLowerCase()));
  // `arrived` : cette session est passée (`passageArrivedFrom`) — ses téléchargements inachevés ici ne
  // serviront plus.
  const arrived = passageArrivedFrom(session.jti, session.u);
  return NextResponse.json({ fetched, arrived }, { headers: { "Cache-Control": "private, no-store" } });
}

/**
 * `POST { removed: [<itemId>…] }` : l'ancienne adresse a effacé ces titres de l'appareil après
 * l'attestation — une ligne au journal (`server.log`, `scope: "offline"`, `event: "passage-freed"`),
 * à côté des autres gestes du hors ligne. Seuls les titres attestés pour cette session y sont écrits.
 */
export async function POST(req: NextRequest) {
  if (crossSiteWrite(req)) return NextResponse.json({ error: "Requête refusée" }, { status: 403 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value).catch(() => null);
  if (!session || (session.role !== "admin" && session.role !== "user")) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { removed?: unknown } | null;
  const asked = Array.isArray(body?.removed) ? body.removed.filter((id): id is string => isJellyfinId(id)).slice(0, PASSAGE_DOWNLOADS_MAX * 2) : [];
  const attested = passageFetchedFor(session.jti, session.u, asked.map((id) => id.toLowerCase()));
  const items = Object.keys(attested);
  if (items.length) {
    try {
      appendJsonLine(
        SERVER_LOG_FILE,
        {
          timestamp: new Date().toISOString(),
          level: "info",
          scope: "offline",
          event: "passage-freed",
          message: `${items.length} téléchargement(s) effacé(s) de l'ancienne adresse : récupérés sur la nouvelle`,
          user: session.u,
          host: requestHost(req.headers),
          items,
        },
        { keep: SERVER_LOG_KEEP }
      );
    } catch {
      /* une ligne perdue ne coûte rien */
    }
  }
  return NextResponse.json({ ok: true, logged: items.length });
}
