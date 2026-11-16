// Ce que sert `GET /api/lumen/{itemId}/{version}/{s}/{nom}` (étape 3, DECISIONS.md §156) : la liste
// maître, une liste média, un init ou un segment — selon le nom, que `parseLumenPath` lit strictement.
//
// L'adresse porte tout ce qu'il faut pour répondre sans état :
// - `{version}` (`lumenVersionOf`) : le format produit et l'empreinte du fichier. Une autre que celle du
//   disque répond 410 avec la version actuelle — jamais les octets d'un autre fichier. Le format dit aussi
//   la découpe (`1-…` la règle, `1c1-…`/`1l1-…` les essais de §157) : c'est lui qui choisit l'index ;
// - `{s}` : l'identifiant de la lecture, dans le chemin et non dans la requête, pour que les URI
//   relatives des listes (`v.m3u8`, `init-v.mp4`, `v/12.m4s`) en héritent sans réécriture (rfc8216bis
//   §4.1 : une URI relative se résout contre l'adresse de la liste). Il ne sert qu'au relevé
//   (`playbackStats.ts`) : un `s` inconnu du serveur est servi pareil ;
// - `?audio=N` sur la liste maître seulement : la piste que la page ouvrirait (DEFAULT=YES, sa variante
//   en tête).
//
// Les en-têtes (2-serveur.md §2.2, DECISIONS.md §131) :
// - listes : `application/vnd.apple.mpegurl`, `private, no-cache` (revalidées à chaque fois : elles ne
//   coûtent rien et une version qui change doit se voir), compressées par nous (`encodePlaylist`, brotli
//   au-dessus de 1 Ko) — Next ne compresse pas ce type (mime-db ne le dit pas compressible), et ne doit
//   pas : il retirerait la longueur déclarée ;
// - init et segments : `video/mp4` (jamais compressé par Next : `compressible: false`), `private,
//   max-age=86400, immutable` — l'adresse porte la version du fichier et du format, un segment gardé ne
//   peut donc pas survivre à un remplacement ;
// - la longueur par `lengthHeader` (le marqueur que `boot.mjs` traduit) : jamais `Content-Length` ni
//   `Content-Encoding` écrits ici ;
// - `Server-Timing` : `app` (toute la route), `idx` (fichier + index), et pour un segment `wait` (file),
//   `build` (fil de calcul), `disk` (attente du disque pendant la construction) — ce qui dira, en
//   production, si un segment lent était le disque partagé avec X-Ray, la file ou le remuxeur.
// Une requête `Range` reçoit le corps entier en 200 : une réponse valide (RFC 9110 §14.2), et la leçon
// des listes tronquées de Safari (relais de flux) — rien n'est annoncé (`Accept-Ranges` absent).

import { NextResponse, type NextRequest } from "next/server";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { encodePlaylist } from "@/lib/playlistEncoding";
import { lengthHeader } from "@/lib/responseFraming";
import { noteMediaRead } from "@/lib/repliques/playbackActivity";
import { createT, loadLocaleDict, localeOf } from "@/lib/i18n";
import type { LabelOptions } from "@/lib/trackLabel";
import { cutModeOfTag, LUMEN_FORMAT_VERSION, parseLumenPath, segmentName, type LumenPath } from "./format";
import { lumenEligibility } from "./eligibility";
import { isPlaybackId, noteBuilt, noteRefused, noteRequest, noteSent, noteTrace, playbackOf, type PlaybackStats } from "./playbackStats";
import {
  defaultAudioTrack,
  formatTagOf,
  goneResponse,
  isLumenVersion,
  lumenAccess,
  lumenErrorResponse,
  lumenIndexOf,
  lumenSegment,
  lumenServerEngine,
  lumenVersionOf,
  refusedResponse,
} from "./service";

export const PLAYLIST_TYPE = "application/vnd.apple.mpegurl";
export const SEGMENT_TYPE = "video/mp4";
export const PLAYLIST_CACHE = "private, no-cache";
/** Un jour : une séance, et bien au-delà ; l'adresse change avec le fichier et le format. */
export const SEGMENT_CACHE = "private, max-age=86400, immutable";
/** Les octets d'un segment partent par morceaux : le dernier lu dit quand tout a été remis au réseau. */
const SEND_CHUNK = 256 * 1024;

export interface LumenNameParams {
  itemId: string;
  version: string;
  s: string;
  name: string[];
}

function timing(parts: Record<string, number>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k};dur=${Math.round(v)}`)
    .join(", ");
}

async function labelsFor(req: NextRequest): Promise<LabelOptions> {
  const locale = localeOf(req);
  const t = createT(await loadLocaleDict(locale), await loadLocaleDict("fr"), locale);
  return { locale, canaux: (n) => t("player.trackLabel.channels", { n }), piste: (n) => t("player.trackLabel.track", { n }) };
}

async function playlistResponse(req: NextRequest, text: string, serverTiming: string): Promise<NextResponse> {
  const encoded = await encodePlaylist(Buffer.from(text, "utf-8"), req.headers.get("accept-encoding"));
  return new NextResponse(new Uint8Array(encoded.body), {
    headers: { "Content-Type": PLAYLIST_TYPE, "Cache-Control": PLAYLIST_CACHE, "Server-Timing": serverTiming, ...encoded.headers },
  });
}

/**
 * Le corps d'un segment, remis par morceaux de 256 Kio : la lecture qui suit le dernier dit que tout a
 * été passé au réseau (`sendMs`, le trajet vu du serveur) ; une annulation (Safari qui abandonne les
 * segments d'avant un saut, une page fermée) est comptée à part.
 */
export function measuredBody(bytes: Uint8Array, done: (sendMs: number, aborted: boolean) => void): ReadableStream<Uint8Array> {
  const began = performance.now();
  let at = 0;
  let finished = false;
  const finish = (aborted: boolean) => {
    if (finished) return;
    finished = true;
    done(performance.now() - began, aborted);
  };
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (at >= bytes.length) {
          controller.close();
          finish(false);
          return;
        }
        const end = Math.min(bytes.length, at + SEND_CHUNK);
        controller.enqueue(bytes.subarray(at, end));
        at = end;
      },
      cancel() {
        finish(true);
      },
    },
    { highWaterMark: 1 }
  );
}

/** `?audio=N` : un numéro de piste, ou `undefined` (la piste par défaut du fichier), ou `null` si mal formé. */
function audioParam(req: NextRequest): number | undefined | null {
  const raw = req.nextUrl.searchParams.get("audio");
  if (raw === null || raw === "") return undefined;
  return /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : null;
}

export async function serveLumenName(req: NextRequest, params: LumenNameParams): Promise<NextResponse> {
  const receivedAt = performance.now();
  const { itemId, version, s } = params;
  // Une adresse mal formée est une adresse qui ne désigne rien : 410, comme une autre version — un
  // 400 compterait pour CrowdSec (voir `service.ts`).
  if (!isJellyfinId(itemId)) return goneResponse("lumen-inconnu", "Élément inconnu");
  const session = await lumenAccess(req, itemId);
  if (session instanceof NextResponse) return session;
  if (!isLumenVersion(version) || !isPlaybackId(s)) return goneResponse("lumen-inconnu", "Adresse inconnue");
  // La découpe vient de l'adresse : une version d'un autre format (un déploiement qui l'a fait monter, une
  // révision des essais) ne désigne plus rien.
  const cut = cutModeOfTag(formatTagOf(version));
  if (!cut) return goneResponse("lumen-perime", "Autre version du format", { format: LUMEN_FORMAT_VERSION });
  const name = params.name.join("/");
  if (!parseLumenPath(name)) return goneResponse("lumen-inconnu", "Nom inconnu");

  const context = { itemId, s, name };
  let found: Awaited<ReturnType<typeof lumenIndexOf>>;
  try {
    found = await lumenIndexOf(itemId, cut);
  } catch (error) {
    return lumenErrorResponse(error, context).response;
  }
  if ("refusal" in found) return refusedResponse(found.refusal);
  const { index } = found;
  const current = lumenVersionOf(index);
  const stats = playbackOf(s, { user: session.u, itemId, version: current });
  const parsed = parseLumenPath(name)!;
  noteRequest(stats, parsed.kind);
  if (current !== version) {
    noteRefused(stats, "stale");
    return goneResponse("lumen-perime", "Le fichier a changé", { version: current });
  }
  if (index.refusal) return refusedResponse(index.refusal);
  const engine = lumenServerEngine();
  const path = engine.resolve(index, name);
  if (!path) {
    noteRefused(stats, "stale");
    return goneResponse("lumen-inconnu", "Piste ou segment hors de l'index");
  }
  const idxMs = performance.now() - receivedAt;

  try {
    return await serveResolved(req, { engine, index, version: current, path, stats, receivedAt, idxMs, context });
  } catch (error) {
    const { response, kind, code } = lumenErrorResponse(error, context);
    noteRefused(stats, kind, code);
    return response;
  }
}

async function serveResolved(
  req: NextRequest,
  r: {
    engine: ReturnType<typeof lumenServerEngine>;
    index: Parameters<typeof lumenVersionOf>[0];
    version: string;
    path: LumenPath;
    stats: PlaybackStats;
    receivedAt: number;
    idxMs: number;
    context: Record<string, unknown>;
  }
): Promise<NextResponse> {
  const { engine, index, path, stats } = r;
  switch (path.kind) {
    case "master": {
      const audio = audioParam(req);
      if (audio === null) return goneResponse("lumen-inconnu", "Piste audio mal formée");
      const audioTrack = audio === undefined ? defaultAudioTrack(index) : audio;
      const verdict = lumenEligibility(index, audioTrack);
      if (!verdict.ok) return refusedResponse(verdict);
      // Des octets d'un film vont partir : l'indexation des répliques se tait (DECISIONS.md §88).
      noteMediaRead();
      const text = engine.master(index, { audioTrack, labels: await labelsFor(req) });
      return playlistResponse(req, text, timing({ app: performance.now() - r.receivedAt, idx: r.idxMs }));
    }
    case "playlist": {
      const text = engine.playlist(index, path.rendition);
      return playlistResponse(req, text, timing({ app: performance.now() - r.receivedAt, idx: r.idxMs }));
    }
    case "init": {
      const bytes = engine.init(index, path.rendition);
      noteSent(stats, { kind: "init", video: path.rendition.kind === "video", bytes: bytes.length, sendMs: 0, aborted: false });
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "Content-Type": SEGMENT_TYPE,
          "Cache-Control": SEGMENT_CACHE,
          "Server-Timing": timing({ app: performance.now() - r.receivedAt, idx: r.idxMs }),
          ...lengthHeader(bytes.length),
        },
      });
    }
    case "segment": {
      noteMediaRead();
      const video = path.rendition.kind === "video";
      const { segment, reused } = await lumenSegment(engine, index, r.version, path.rendition, path.n);
      noteBuilt(stats, { video, n: path.n, buildMs: segment.buildMs, waitMs: segment.waitMs, diskMs: segment.diskMs, reused });
      const bytes = segment.bytes;
      const track = path.rendition.kind === "audio" ? path.rendition.track : undefined;
      const body = measuredBody(bytes, (sendMs, aborted) => {
        noteSent(stats, { kind: "segment", video, bytes: bytes.length, sendMs: Math.round(sendMs), aborted, track });
        noteTrace(stats, { name: segmentName(path.rendition, path.n), buildMs: reused ? 0 : segment.buildMs, waitMs: reused ? 0 : segment.waitMs, sendMs, reused, aborted });
      });
      const parts: Record<string, number> = { app: performance.now() - r.receivedAt, idx: r.idxMs };
      if (!reused) Object.assign(parts, { wait: segment.waitMs, build: segment.buildMs, disk: segment.diskMs });
      return new NextResponse(body, {
        headers: { "Content-Type": SEGMENT_TYPE, "Cache-Control": SEGMENT_CACHE, "Server-Timing": timing(parts), ...lengthHeader(bytes.length) },
      });
    }
  }
}
