import { withLumenTvPass } from "@/lib/lumenServer/tvPass";
import { NextResponse, type NextRequest } from "next/server";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { isPlaybackId } from "@/lib/lumenServer/playbackStats";
import { parseCutMode, parseTargetSeconds } from "@/lib/lumenServer/format";
import { conversionModeOf, goneResponse, lumenAccess, lumenErrorResponse, lumenVerdict, masterAddress, newPlaybackId, NO_STORE, playbackKey } from "@/lib/lumenServer/service";
import { lumenAudio } from "@/lib/lumenServer/audio/conversion";
import { muxVersion } from "@/lib/lumenServer/trials";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ itemId: string }> };

/** Ce qu'on attend un index en construction avant de répondre `pending` (2 à 25 s à froid, quelques ms gardé). */
const DEFAULT_WAIT_MS = 2000;
const MAX_WAIT_MS = 30_000;

/**
 * `GET /api/lumen/{itemId}/eligibility?audio=N&s=<lecture>&wait=<ms>[&cut=idr][&target=2]` — Lumen serveur peut-il lire cet
 * élément avec cette piste (DECISIONS.md §156) ? Toujours 200 avec `ok`, sauf l'index encore en
 * construction : 202 et `pending`, la construction continue et la question se repose. Un refus porte une
 * raison stable (`LumenRefusalReason`) que l'étape 4 journalise avant de laisser le lecteur actuel lire.
 * `ok` donne l'adresse de la liste maître, avec la version du fichier et l'identifiant de lecture —
 * celui de la page s'il est donné (`s`), sinon un nouveau. `audio` absent : la piste que le fichier
 * marque par défaut. `cut` : une découpe d'essai (`idr`, `cra-leading` — DECISIONS.md §157, §158, la page
 * `/lumen-test`) ; absent, la règle `cra`. `target` : une cible d'essai en secondes (2, 3, 6 ; 4 par défaut). `mux=1` :
 * l'essai du son par défaut multiplexé dans les segments vidéo (étape 3e, `trials.ts`) — la version et l'adresse
 * rendues portent `m1`, le reste du verdict est celui de la règle. Administrateur seul (`lumenAccess`).
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
  const cut = parseCutMode(q.get("cut"));
  if (cut === null) return goneResponse("lumen-inconnu", "Découpe inconnue");
  const targetUs = parseTargetSeconds(q.get("target"));
  if (targetUs === null) return goneResponse("lumen-inconnu", "Cible inconnue");
  const wait = Number(q.get("wait") ?? DEFAULT_WAIT_MS);
  const s = rawS ?? newPlaybackId();
  // Les modes d'essai de la conversion du son (§163, page `/lumen-test`) : le pool de ffmpeg pré-lancés (`convPool=1`
  // ou `0`) et la lecture froide (`convCold=1`, sans le cache), pour cette lecture seulement. Sans eux, rien ne change.
  const mode = conversionModeOf(q);
  if (mode) lumenAudio().setPlaybackMode(playbackKey(session.u, s), mode);
  try {
    const verdict = await lumenVerdict(itemId, {
      audio: rawAudio ? Number(rawAudio) : undefined,
      s,
      waitMs: Number.isFinite(wait) ? Math.min(MAX_WAIT_MS, Math.max(0, wait)) : DEFAULT_WAIT_MS,
      cut,
      targetUs,
      session,
      // `tv=1` : l'adresse munie du laissez-passer d'une Apple TV (§186) — le lecteur, pour qu'AirPlay marche.
      tv: q.get("tv") === "1",
      // `cast=1` : l'adresse d'un récepteur Chromecast (§192) — le son en AAC, le laissez-passer `cc.{jeton}`, CORS.
      // `hevc=0` : ce récepteur a déjà refusé le HEVC (l'émetteur s'en souvient pour la page).
      ...(q.get("cast") === "1" ? { cast: { hevc: q.get("hevc") !== "0" } } : {}),
    });
    if (q.get("mux") === "1" && q.get("cast") !== "1" && verdict.ok && verdict.audioTrack !== null) {
      const s = new URL(verdict.master, "http://x").pathname.split("/")[5];
      // Le laissez-passer d'une Apple TV (§186), gardé sur l'adresse de l'essai.
      const tv = /\/tv\.([^/]+)\/master\.m3u8/.exec(verdict.master)?.[1];
      verdict.version = muxVersion(verdict.version);
      verdict.master = masterAddress(itemId, verdict.version, s, verdict.audioTrack);
      if (tv) verdict.master = withLumenTvPass(verdict.master, tv);
    }
    return NextResponse.json(verdict, { status: "pending" in verdict ? 202 : 200, headers: NO_STORE });
  } catch (error) {
    return lumenErrorResponse(error, { itemId, route: "eligibility" }).response;
  }
}
