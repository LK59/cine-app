import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { lengthHeader } from "@/lib/responseFraming";
import { isPlaybackId, lumenChronoOf, markChrono, serverClockMs } from "@/lib/lumenServer/playbackStats";
import { goneResponse, lumenAccess, NO_STORE } from "@/lib/lumenServer/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ itemId: string }> };

/** Le plus gros échantillon de débit servi : de quoi sortir du démarrage lent de TCP sans coûter une rafale de film. */
const MAX_PROBE_BYTES = 16 * 1024 * 1024;

/**
 * `GET /api/lumen/{itemId}/chrono?s=<lecture>` — la chronologie de la page de banc `/lumen-test` (étape 3e de
 * docs/remux-serveur/, DECISIONS §160). Administrateur seul (`lumenAccess`), comme toutes ces routes. Trois usages :
 *
 * - **sans autre paramètre** : un échange de l'horloge. Rend `{ t1, t2 }` — l'arrivée de la requête et le départ de
 *   la réponse sur l'horloge des horodatages (`serverClockMs`), avant et après le contrôle d'accès : la page en tire
 *   le décalage à la manière de NTP (`((t1 − t0) + (t2 − t3)) / 2`) et garde l'échange au plus court aller-retour.
 *   Le premier échange **marque la lecture `s` comme chronométrée** (`markChrono`) : chaque requête de Safari pour
 *   elle sera horodatée (arrivée, prête, premier et dernier morceau remis) ;
 * - **`&bytes=N`** : N octets aléatoires (incompressibles, `application/octet-stream`, que ni Next ni le relais ne
 *   compressent) — un échantillon du débit réel vers l'appareil, que la page mesure elle-même par Resource Timing.
 *   Le serveur ne peut pas le mesurer : ses envois s'arrêtent dans les tampons du noyau et du relais inverse ;
 * - **`&records=1`** : la chronologie notée pour cette lecture et ce compte (`{ now, entries }`), relue par la page à
 *   la fin d'un essai pour dessiner ses cascades.
 *
 * Toujours 200 (ou 410 pour une adresse mal formée) : une absence n'est jamais un 404 (CrowdSec, §156).
 */
export async function GET(req: NextRequest, { params }: Params) {
  const t1 = serverClockMs();
  const { itemId } = await params;
  if (!isJellyfinId(itemId)) return goneResponse("lumen-inconnu", "Élément inconnu");
  const session = await lumenAccess(req, itemId);
  if (session instanceof NextResponse) return session;
  const q = req.nextUrl.searchParams;
  const s = q.get("s");
  if (!isPlaybackId(s)) return goneResponse("lumen-inconnu", "Identifiant de lecture mal formé");

  const rawBytes = q.get("bytes");
  if (rawBytes !== null) {
    const n = /^\d{1,8}$/.test(rawBytes) ? Math.min(MAX_PROBE_BYTES, Number(rawBytes)) : 0;
    if (n <= 0) return goneResponse("lumen-inconnu", "Taille mal formée");
    const body = new Uint8Array(randomBytes(n));
    return new NextResponse(body, { headers: { ...NO_STORE, "Content-Type": "application/octet-stream", ...lengthHeader(n) } });
  }
  if (q.get("records") === "1") {
    return NextResponse.json({ now: serverClockMs(), entries: lumenChronoOf(s, session.u) ?? [] }, { headers: NO_STORE });
  }
  markChrono(s, { user: session.u, itemId });
  return NextResponse.json({ t1, t2: serverClockMs() }, { headers: NO_STORE });
}
