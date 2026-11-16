import { NextResponse, type NextRequest } from "next/server";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { isPlaybackId } from "@/lib/lumenServer/playbackStats";
import { LumenError } from "@/lib/lumenServer/format";
import {
  defaultAudioTrack,
  goneResponse,
  logLumenError,
  lumenAccess,
  lumenErrorResponse,
  lumenIndexOf,
  lumenSegment,
  lumenServerEngine,
  lumenVerdict,
  lumenVersionOf,
  newPlaybackId,
  NO_STORE,
  segmentAt,
} from "@/lib/lumenServer/service";
import { lumenEligibility } from "@/lib/lumenServer/eligibility";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ itemId: string }> };

/** Le verdict n'attend presque pas : la page n'attend pas `prepare`, elle le lance et continue. */
const VERDICT_WAIT_MS = 100;

/**
 * `POST /api/lumen/{itemId}/prepare` — `{ audio?, position?, s? }` : l'étape 4 l'appelle à l'appui sur
 * Lire (DECISIONS.md §156). Lance la construction de l'index (2 à 25 s à froid sur le disque partagé,
 * quelques millisecondes une fois gardé — `indexStore.ts`) puis, en arrière-plan, celle du segment de
 * reprise (vidéo et piste choisie, au segment qui contient `position`), gardé deux minutes pour la
 * première requête de Safari (`segmentCache.ts`). Répond tout de suite le même verdict qu'`eligibility`
 * (202 `pending` si l'index n'est pas prêt) ; la préparation continue sans la réponse.
 * Administrateur seul (`lumenAccess`) ; un POST, donc aussi refusé par le proxy à tout autre compte
 * et à toute page d'un autre site (`crossSiteWrite`).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { itemId } = await params;
  if (!isJellyfinId(itemId)) return goneResponse("lumen-inconnu", "Élément inconnu");
  const session = await lumenAccess(req, itemId);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { audio?: unknown; position?: unknown; s?: unknown } | null;
  const audio = body?.audio;
  if (audio !== undefined && audio !== null && !(typeof audio === "number" && Number.isInteger(audio) && audio > 0 && audio < 10_000)) {
    return goneResponse("lumen-inconnu", "Piste audio mal formée");
  }
  const position = typeof body?.position === "number" && Number.isFinite(body.position) && body.position > 0 ? body.position : 0;
  if (body?.s !== undefined && !isPlaybackId(body.s)) return goneResponse("lumen-inconnu", "Identifiant de lecture mal formé");
  const s = (body?.s as string | undefined) ?? newPlaybackId();

  void warm(itemId, typeof audio === "number" ? audio : undefined, position);
  try {
    const verdict = await lumenVerdict(itemId, { audio: typeof audio === "number" ? audio : undefined, s, waitMs: VERDICT_WAIT_MS });
    return NextResponse.json(verdict, { status: "pending" in verdict ? 202 : 200, headers: NO_STORE });
  } catch (error) {
    return lumenErrorResponse(error, { itemId, route: "prepare" }).response;
  }
}

/**
 * L'index (partagé avec le verdict : une seule construction), puis le segment de reprise vidéo et son
 * pendant audio, gardés pour la première requête. Une file pleine n'est pas une erreur : la requête de
 * Safari construira le segment elle-même.
 */
async function warm(itemId: string, audio: number | undefined, position: number): Promise<void> {
  try {
    const found = await lumenIndexOf(itemId);
    if ("refusal" in found) return;
    const { index } = found;
    const audioTrack = audio ?? defaultAudioTrack(index);
    if (!lumenEligibility(index, audioTrack).ok) return;
    const engine = lumenServerEngine();
    const version = lumenVersionOf(index);
    const n = segmentAt(index, position);
    await Promise.all([
      lumenSegment(engine, index, version, { kind: "video" }, n, { keep: true }),
      ...(audioTrack !== null ? [lumenSegment(engine, index, version, { kind: "audio", track: audioTrack }, n, { keep: true })] : []),
    ]);
  } catch (error) {
    if (error instanceof LumenError && error.code === "occupe") return;
    logLumenError("lumen/prepare", error, { itemId });
  }
}
