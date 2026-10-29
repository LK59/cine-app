import { NextRequest, NextResponse } from "next/server";
import { bookIdOf, booksCaller } from "@/lib/books/guard";
import { bookIndex } from "@/lib/books/bookIndex";
import { alreadyLogged, bookFields, meaningfulSession, sessionLine, validReadingSession } from "@/lib/books/readingLog";
import { logReadingEvent } from "@/lib/eventLogs";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { readingSessionAllowed } from "@/lib/writeLimits";

/**
 * Une séance de lecture finie (option, DECISIONS.md §129) : une ligne dans `lectures.log`, pour le compte
 * de la session et lui seul. Envoyée par le lecteur quand il se referme ou que la page passe en arrière-
 * plan (`sendBeacon`, d'où `POST` et un corps lu en texte) ; une séance lue hors ligne attend sur
 * l'appareil et part au retour du réseau, avec son âge.
 *
 * Le livre doit être dans la vue de ce compte (l'index du serveur, copies cachées comprises) : sinon 404,
 * comme pour une position. Le titre et l'auteur viennent de cet index — rien du corps ne nomme le livre.
 * Une séance de moins de dix secondes sans page tournée n'est pas écrite (204) ; au-delà de soixante par
 * heure pour un compte, 429 — le lecteur ne la renvoie pas.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const id = bookIdOf((await params).id);
  if (!id) return new NextResponse(null, { status: 400 });
  const raw = await req.text().catch(() => "");
  if (raw.length > 2000) return new NextResponse(null, { status: 413 });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* refusé juste après */
  }
  const input = validReadingSession(parsed);
  if (!input) return NextResponse.json({ error: "Séance invalide" }, { status: 400 });
  if (!meaningfulSession(input)) return new NextResponse(null, { status: 204 });
  let book;
  try {
    book = (await bookIndex(caller)).all.get(id) ?? null;
  } catch {
    // L'index ne se construit pas (Jellyfin injoignable) : la séance attend sur l'appareil.
    return new NextResponse(null, { status: 502 });
  }
  if (!book) return new NextResponse(null, { status: 404 });
  if (!readingSessionAllowed(caller.u)) return new NextResponse(null, { status: 429 });
  if (alreadyLogged(caller.u, input.id)) return new NextResponse(null, { status: 204 });
  logReadingEvent("séance", {
    user: caller.jfUser ?? caller.u,
    account: caller.u,
    book: id,
    ...bookFields(book),
    device: requestDeviceLabel(req),
    ...sessionLine(input),
  });
  return new NextResponse(null, { status: 204 });
}
