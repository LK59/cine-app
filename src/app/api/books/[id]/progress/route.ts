import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { bookIdOf, booksCaller } from "@/lib/books/guard";
import { bookFor, forgetPlayed } from "@/lib/books/library";
import { readProgress, saveProgress, validProgressInput } from "@/lib/books/progress";
import { logError } from "@/lib/logger";

/**
 * La position de lecture d'un livre (option, DECISIONS.md §127), pour le compte de la session et lui
 * seul — l'adresse ne nomme que le livre, jamais un compte.
 *
 * `POST` : envoyé par le lecteur au fil des pages (regroupé) et à la fermeture (`sendBeacon`, qui ne
 * sait faire que `POST`). Le livre est vérifié comme pour le fichier : une position ne s'écrit que sur
 * un livre que ce compte voit. La première fois que le lecteur dit `finished`, le livre est noté « lu »
 * chez Jellyfin sous l'identité du compte — une seule fois, et sans que l'échec de cet appel ne perde
 * la position.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const id = bookIdOf((await params).id);
  if (!id) return new NextResponse(null, { status: 400 });
  return NextResponse.json({ progress: readProgress(caller.u, id) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const id = bookIdOf((await params).id);
  if (!id) return new NextResponse(null, { status: 400 });
  // Un `sendBeacon` envoie son corps en texte : il est lu tel quel puis analysé.
  const raw = await req.text().catch(() => "");
  if (raw.length > 8000) return new NextResponse(null, { status: 413 });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* refusé juste après */
  }
  const input = validProgressInput(parsed);
  if (!input) return NextResponse.json({ error: "Position invalide" }, { status: 400 });

  try {
    if (!(await bookFor(caller, id))) return new NextResponse(null, { status: 404 });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
  // Une position lue hors ligne et renvoyée plus tard n'efface pas celle, plus récente, qu'un autre
  // appareil a écrite entre-temps.
  if (input.at !== null) {
    const held = readProgress(caller.u, id);
    if (held && held.updatedAt > input.at) return NextResponse.json({ ok: true, kept: true });
  }
  const { firstFinish } = saveProgress(caller.u, id, input.cfi, input.fraction, input.finished);
  if (firstFinish && caller.jfId) {
    await jellyfin.markPlayed(caller.jfId, id).catch((err: unknown) => logError("books/progress", err, { itemId: id }));
    // Le badge « Lu » de la grille vient de Jellyfin, gardé deux minutes : on le redemande.
    forgetPlayed(caller.jfId);
  }
  return NextResponse.json({ ok: true });
}
