import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { shareRefusal } from "@/lib/share/guard";
import { config } from "@/lib/config";
import { logPlaybackEvent, isPlayerEventKind } from "@/lib/playerLog";
import { recoverLostPosition } from "@/lib/lostStopPosition";
import { playerLogAllowed } from "@/lib/writeLimits";
import { alreadyWritten, isLineId } from "@/lib/playerLogIds";
import { noteSessionStart } from "@/lib/xray/orders";
import { xrayConfigured, xrayOpenTo } from "@/lib/clients/xray";

/**
 * The player telling the server what happened to it.
 *
 * Open to every signed-in account, not only administrators: the whole point is to hear from the
 * seventeen people who will never open a technical panel. Nothing here reads anything back —
 * this endpoint only ever appends — so the worst a caller can do is write about themselves.
 */
export async function POST(req: NextRequest) {
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });

  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.u) return new NextResponse(null, { status: 403 });

  const body = (await req.json().catch(() => null)) as { kind?: unknown; fields?: unknown } | null;
  // Une limite par compte (D12, voir `writeLimits.ts`) : un client qui boucle faisait tourner le
  // journal en quelques minutes. Le banc d'un administrateur n'y est pas soumis — il écrit bien
  // plus vite, et dans son propre journal ; un autre compte qui pose `bench` se le voit retirer.
  const benchLine = session.role === "admin" && Boolean((body?.fields as { bench?: unknown } | undefined)?.bench);
  if (!benchLine && !playerLogAllowed(session.u)) return NextResponse.json({ error: "Trop d'envois" }, { status: 429 });
  if (!isPlayerEventKind(body?.kind)) return NextResponse.json({ error: "Événement inconnu" }, { status: 400 });

  const fields = body?.fields;
  // The account comes from the session, never from the body: the one field that says who this
  // was about must not be the one field anybody can forge.
  const cleaned = fields && typeof fields === "object" ? { ...(fields as Record<string, unknown>) } : {};
  // `bench` envoie la ligne dans le journal du banc : réservé à l'administrateur, qui seul lance
  // un banc. Sinon, n'importe quel compte pourrait sortir ses lignes du journal des spectateurs.
  if (session.role !== "admin") delete cleaned.bench;
  // L'identifiant de la ligne sert à ne pas écrire deux fois un renvoi (`unsentLines.ts`) ; il
  // n'apprend rien au lecteur du journal et n'y va pas. Une ligne déjà écrite est acceptée — que
  // le navigateur la retire de sa file — sans être réécrite.
  const lineId = cleaned.lineId;
  delete cleaned.lineId;
  if (isLineId(lineId) && alreadyWritten(session.u, lineId)) return NextResponse.json({ ok: true, duplicate: true });
  // Un bilan perdu connaît la dernière position mieux que Jellyfin : il la lui rend, s'il n'a rien
  // de plus récent (voir `lostStopPosition.ts`). Ce que ça a donné part dans la ligne ; un échec ici
  // ne coûte que la reprise d'avant, jamais la ligne elle-même.
  // Pour un lien de partage, seulement sur son titre (DECISIONS.md §112) : la ligne, elle, s'écrit.
  if (body.kind === "stop" && cleaned.why === "lost" && !(await shareRefusal(session, cleaned.itemId))) {
    cleaned.resumeFix = await recoverLostPosition(session.jfId, cleaned).catch((error: unknown) =>
      `échec : ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)
    );
  }
  logPlaybackEvent(session.u, body.kind, cleaned);
  // Les acteurs à l'écran (option, DECISIONS.md §138) : une séance qui commence commande l'analyse de
  // ce qu'elle regarde, et de l'épisode suivant. La ligne `start` est le seul signal que les trois
  // lecteurs (natif, serveur, Chromecast) envoient tous, avec l'élément et la position. Ni un banc, ni
  // le lecteur hors ligne (le fichier est déjà sur l'appareil), ni un autre titre que celui d'un lien de
  // partage. Sans attente : la réponse part tout de suite, et rien d'ici ne peut la faire échouer.
  // Réglée sur `admins`, seules les séances des administrateurs commandent une analyse (`xrayOpenTo`).
  if (body.kind === "start" && xrayConfigured() && xrayOpenTo(session) && !cleaned.bench && cleaned.player !== "hors-ligne" && !(await shareRefusal(session, cleaned.itemId))) {
    noteSessionStart(cleaned.itemId, cleaned.at, session.u);
  }
  return NextResponse.json({ ok: true });
}
