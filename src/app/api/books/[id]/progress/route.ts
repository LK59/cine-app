import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { bookIdOf, booksCaller } from "@/lib/books/guard";
import { bookFor, forgetPlayed } from "@/lib/books/library";
import { dismissedAt, dismissProgress, forgetUnstarted, readAt, readProgress, saveProgress, validProgressInput, MIN_STARTED_FRACTION } from "@/lib/books/progress";
import { logError } from "@/lib/logger";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { logReadingEvent } from "@/lib/eventLogs";
import { bookIndex } from "@/lib/books/bookIndex";
import { bookFields } from "@/lib/books/readingLog";
import { removeFromReadingList } from "@/lib/books/readingList";

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
  // `now` : l'heure du serveur, pour que l'appareil compare sa copie à `updatedAt` sans mêler deux horloges.
  return NextResponse.json({ progress: readProgress(caller.u, id), now: Date.now() }, { headers: { "Cache-Control": "private, no-store" } });
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

  let book;
  try {
    book = await bookFor(caller, id);
    if (!book) return new NextResponse(null, { status: 404 });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
  // Une position lue hors ligne et renvoyée plus tard n'efface pas celle, plus récente, qu'un autre
  // appareil a écrite entre-temps.
  const at = readAt(input);
  if (at !== null) {
    const held = readProgress(caller.u, id);
    if (held && held.updatedAt > at) return NextResponse.json({ ok: true, kept: true });
    // Ni un retrait de « Continuer la lecture » fait depuis : une page lue avant ne l'y remet pas.
    const dismissed = dismissedAt(caller.u, id);
    if (dismissed !== null && dismissed > at) return NextResponse.json({ ok: true, kept: true });
  }
  // Pas commencé : revenu à la page où il s'était ouvert (`atStart`, dit par le lecteur) — il redevient « pas
  // commencé » (`forgetUnstarted`, les signets restent). Toute autre page le commence, la deuxième comprise :
  // un seuil de 1 % (28/10/2026) demandait quatre pages d'un roman de 400 avant « Continuer la lecture »
  // (29/10/2026). La page d'ouverture elle-même n'est jamais envoyée (`BookReader`). Un client d'avant ne dit
  // pas `atStart` : il garde le seuil (`MIN_STARTED_FRACTION`).
  if (!input.finished && (input.atStart === true || (input.atStart === null && input.fraction < MIN_STARTED_FRACTION))) {
    forgetUnstarted(caller.u, id);
    return NextResponse.json({ ok: true, notStarted: true });
  }
  // Datée de sa lecture, pas de sa réception : une page tournée juste après un envoi n'est plus « plus
  // vieille » que lui, et une position partie de la file garde son heure. Jamais dans le futur.
  const device = requestDeviceLabel(req);
  const { firstFinish } = saveProgress(caller.u, id, input.cfi, input.fraction, input.finished, Math.min(Date.now(), at ?? Date.now()), device);
  if (firstFinish) {
    // Terminé : il quitte « Ma liste de lecture » (§129) — elle dit ce qui reste à lire —, et l'activité le sait.
    removeFromReadingList(caller.u, id);
    logReadingEvent("terminé", { user: caller.jfUser ?? caller.u, account: caller.u, book: id, ...bookFields(book), device });
  }
  if (firstFinish && caller.jfId) {
    await jellyfin.markPlayed(caller.jfId, id).catch((err: unknown) => logError("books/progress", err, { itemId: id }));
    // Le badge « Lu » de la grille vient de Jellyfin, gardé deux minutes : on le redemande.
    forgetPlayed(caller.jfId);
  }
  return NextResponse.json({ ok: true });
}

/**
 * « Retirer de Continuer la lecture » (fiche du livre) : pour le compte de la session seulement. La
 * position reste — le livre rouvre où il en était —, il revient dans la rangée à la prochaine page lue.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const id = bookIdOf((await params).id);
  if (!id) return new NextResponse(null, { status: 400 });
  if (dismissProgress(caller.u, id) !== null) {
    // Pour l'activité (§129) : le titre lu dans l'index, sans demander Jellyfin — un retrait n'attend personne.
    const book = await bookIndex(caller)
      .then((index) => index.all.get(id) ?? null)
      .catch(() => null);
    logReadingEvent("retiré", { user: caller.jfUser ?? caller.u, account: caller.u, book: id, ...bookFields(book), device: requestDeviceLabel(req) });
  }
  return NextResponse.json({ ok: true });
}
