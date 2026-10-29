import { NextRequest, NextResponse } from "next/server";
import { booksCaller } from "@/lib/books/guard";
import { isReaderDeviceType } from "@/lib/books/deviceType";
import { strictReaderPrefs } from "@/lib/books/readerPrefs";
import { MAX_PREFS_BYTES, readerPrefsFor, saveReaderPrefs } from "@/lib/books/readerPrefsStore";

/**
 * Les réglages du lecteur de livres (option, DECISIONS.md §129), pour le compte de la session et le type
 * d'appareil nommé — jamais un autre compte : l'adresse ne nomme que le type.
 *
 * `GET ?device=telephone|tablette|ordinateur` : ceux de ce type, ou à défaut les derniers écrits par le
 * compte (`readerPrefsFor`) ; `{ prefs: null }` quand il n'a jamais rien réglé.
 * `PUT { device, prefs, ageMs? }` : les réglages entiers, validés (`strictReaderPrefs`) — un champ inconnu
 * ou hors bornes refuse tout. `ageMs` : depuis quand le changement attend sur l'appareil (hors ligne), pour
 * le placer dans l'horloge du serveur, comme une position (`readAt`).
 */
const MAX_AGE_MS = 365 * 24 * 3_600_000;

export async function GET(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const device = req.nextUrl.searchParams.get("device");
  if (!isReaderDeviceType(device)) return new NextResponse(null, { status: 400 });
  const stored = readerPrefsFor(caller.u, device);
  return NextResponse.json(
    stored ? { prefs: stored.prefs, own: stored.own, from: stored.from, updatedAt: stored.updatedAt } : { prefs: null },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

export async function PUT(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_PREFS_BYTES) return new NextResponse(null, { status: 413 });
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    /* refusé juste après */
  }
  if (!body || !isReaderDeviceType(body.device)) return NextResponse.json({ error: "Réglages invalides" }, { status: 400 });
  const prefs = strictReaderPrefs(body.prefs);
  if (!prefs) return NextResponse.json({ error: "Réglages invalides" }, { status: 400 });
  const ageMs = typeof body.ageMs === "number" && Number.isFinite(body.ageMs) && body.ageMs >= 0 && body.ageMs <= MAX_AGE_MS ? body.ageMs : 0;
  const { kept } = saveReaderPrefs(caller.u, body.device, prefs, Date.now() - ageMs);
  return NextResponse.json({ ok: true, ...(kept ? { kept: true } : {}) });
}
