import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { logNewsEvent, type NewsLogEvent } from "@/lib/eventLogs";
import { newsDb } from "@/lib/news/store";
import { newsEventAllowed } from "@/lib/writeLimits";
import { NEWS_CLOSED_BY, NEWS_PAGE_SECTIONS } from "@/lib/news/events";

/**
 * Les mesures des Nouveautés (DECISIONS.md §73) : une ligne `kind: "nouveautés"` au journal des
 * ouvertures, et le dernier affichage du compte en base pour la vue de l'administrateur.
 *
 * Le compte vient de la session, jamais du corps ; les champs sont bornés, le reste tombe — même
 * règle que `/api/startup-timing`.
 */
const EVENTS = new Set<NewsLogEvent>(["fenêtre", "voir-plus", "page"]);
const ms = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 86_400_000 ? Math.round(v) : null);

export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  if (!newsEventAllowed(session.u)) return new NextResponse(null, { status: 429 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const event = body?.event as NewsLogEvent | undefined;
  if (!body || !event || !EVENTS.has(event)) return NextResponse.json({ error: "Requête invalide" }, { status: 400 });

  const user = session.jfUser ?? session.u;
  const noteIds = Array.isArray(body.noteIds) ? body.noteIds.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, 50) : [];
  const shownMs = ms(body.shownMs);
  const base = {
    user,
    device: requestDeviceLabel(req),
    build: typeof body.build === "string" ? body.build.slice(0, 40) : null,
    version: typeof body.version === "string" ? body.version.slice(0, 20) : null,
    noteIds,
  };

  if (event === "fenêtre") {
    const closedBy = typeof body.closedBy === "string" && (NEWS_CLOSED_BY as readonly string[]).includes(body.closedBy) ? body.closedBy : null;
    if (shownMs === null || closedBy === null) return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
    const scrolled = body.scrolled === true;
    const auto = body.auto !== false;
    logNewsEvent(event, { ...base, shownMs, closedBy, scrolled, auto });
    newsDb.noteWindow(session.u, { shownMs, closedBy, scrolled, auto });
  } else if (event === "voir-plus") {
    logNewsEvent(event, base);
    newsDb.noteSeeMore(session.u);
  } else {
    const section = typeof body.section === "string" && (NEWS_PAGE_SECTIONS as readonly string[]).includes(body.section) ? body.section : null;
    if (shownMs === null || section === null) return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
    logNewsEvent(event, { ...base, shownMs, section });
    newsDb.notePage(session.u, { shownMs, section });
  }
  return new NextResponse(null, { status: 204 });
}
