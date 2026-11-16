import { NextResponse, type NextRequest } from "next/server";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { isPlaybackId } from "@/lib/lumenServer/playbackStats";
import { goneResponse, lumenAccess, lumenErrorResponse, lumenVerdict, newPlaybackId, NO_STORE } from "@/lib/lumenServer/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ itemId: string }> };

/** Ce qu'on attend un index en construction avant de répondre `pending` (2 à 25 s à froid, quelques ms gardé). */
const DEFAULT_WAIT_MS = 2000;
const MAX_WAIT_MS = 30_000;

/**
 * `GET /api/lumen/{itemId}/eligibility?audio=N&s=<lecture>&wait=<ms>` — Lumen serveur peut-il lire cet
 * élément avec cette piste (DECISIONS.md §156) ? Toujours 200 avec `ok`, sauf l'index encore en
 * construction : 202 et `pending`, la construction continue et la question se repose. Un refus porte une
 * raison stable (`LumenRefusalReason`) que l'étape 4 journalise avant de laisser le lecteur actuel lire.
 * `ok` donne l'adresse de la liste maître, avec la version du fichier et l'identifiant de lecture —
 * celui de la page s'il est donné (`s`), sinon un nouveau. `audio` absent : la piste que le fichier
 * marque par défaut. Administrateur seul (`lumenAccess`).
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { itemId } = await params;
  if (!isJellyfinId(itemId)) return goneResponse("lumen-inconnu", "Élément inconnu");
  const session = await lumenAccess(req, itemId);
  if (session instanceof NextResponse) return session;
  const q = req.nextUrl.searchParams;
  const rawAudio = q.get("audio");
  if (rawAudio !== null && rawAudio !== "" && !/^[1-9]\d{0,3}$/.test(rawAudio)) return goneResponse("lumen-inconnu", "Piste audio mal formée");
  const rawS = q.get("s");
  if (rawS !== null && !isPlaybackId(rawS)) return goneResponse("lumen-inconnu", "Identifiant de lecture mal formé");
  const wait = Number(q.get("wait") ?? DEFAULT_WAIT_MS);
  try {
    const verdict = await lumenVerdict(itemId, {
      audio: rawAudio ? Number(rawAudio) : undefined,
      s: rawS ?? newPlaybackId(),
      waitMs: Number.isFinite(wait) ? Math.min(MAX_WAIT_MS, Math.max(0, wait)) : DEFAULT_WAIT_MS,
    });
    return NextResponse.json(verdict, { status: "pending" in verdict ? 202 : 200, headers: NO_STORE });
  } catch (error) {
    return lumenErrorResponse(error, { itemId, route: "eligibility" }).response;
  }
}
