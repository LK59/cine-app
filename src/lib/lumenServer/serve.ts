// Ce que sert `GET /api/lumen/{itemId}/{version}/{s}/{nom}` (étape 3, DECISIONS.md §156) : la liste
// maître, une liste média, un init ou un segment — selon le nom, que `parseLumenPath` lit strictement.
//
// L'adresse porte tout ce qu'il faut pour répondre sans état :
// - `{version}` (`lumenVersionOf`) : le format produit et l'empreinte du fichier. Une autre que celle du
//   disque répond 410 avec la version actuelle — jamais les octets d'un autre fichier. Le format dit aussi
//   la découpe et sa cible (`2-…` la règle, `2i1-…`/`2l1-…`/`2t2-…` les essais de §157, §158) : c'est lui
//   qui choisit l'index ;
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

import { config } from "@/lib/config";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, type SessionPayload } from "@/lib/auth";
import { castProgressRelay } from "@/lib/castProgress";
import { LUMEN_CC_PREFIX, LUMEN_TV_PREFIX, verifyLumenCastPass, verifyLumenTvPass, type LumenTvPass } from "./tvPass";
import { castPreflightResponse, withCastCors } from "@/lib/castCors";
import { castMasterPlaylist } from "./playlists";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { encodePlaylist } from "@/lib/playlistEncoding";
import { lengthHeader } from "@/lib/responseFraming";
import { noteMediaRead } from "@/lib/repliques/playbackActivity";
import { createT, loadLocaleDict, localeOf } from "@/lib/i18n";
import type { LabelOptions } from "@/lib/trackLabel";
import { cuttingOfTag, LUMEN_FORMAT_VERSION, parseLumenPath, segmentName, type LumenPath } from "./format";
import { lumenEligibility } from "./eligibility";
import { parseDialogueMode } from "./audio/dialogue";
import { chronoEntry, isPlaybackId, noteBuilt, noteConvertBusy, noteConverted, noteRefused, noteRequest, noteSent, noteTrace, playbackOf, serverClockMs, type ChronoEntry, type PlaybackStats } from "./playbackStats";
import { masterWithSubtitles, serveSubtitleRendition, SUBTITLE_HEADER } from "./subtitleServe";
import { parseSubtitlePath } from "./subtitles";
import { masterTrialOptions, muxedInit, muxedMaster, muxedMediaPlaylist, muxedSegment, muxVersion, parseMuxedPath, splitMuxTag, withMasterTrials, type MuxedPath } from "./trials";
import {
  defaultAudioTrack,
  formatTagOf,
  goneResponse,
  isLumenVersion,
  lumenAccess,
  lumenErrorResponse,
  lumenIndexOf,
  lumenSegment,
  lumenConversionContext,
  lumenServerEngine,
  lumenVersionOf,
  NO_STORE,
  playbackKey,
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

export async function playlistResponse(req: NextRequest, text: string, serverTiming: string): Promise<NextResponse> {
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
export function measuredBody(bytes: Uint8Array, done: (sendMs: number, aborted: boolean) => void, first?: () => void): ReadableStream<Uint8Array> {
  const began = performance.now();
  let at = 0;
  let finished = false;
  let started = false;
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
        if (!started) {
          // Le premier morceau demandé par le réseau : la chronologie (étape 3e) y lit l'instant du premier octet.
          started = true;
          first?.();
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

/** Ce que les routes lisent d'une session, tiré d'un laissez-passer valable : l'administrateur qui l'a demandé. */
function tvSessionOf(pass: LumenTvPass): SessionPayload {
  return { u: pass.user, role: "admin", jti: pass.jti, exp: 0, ...(pass.jfId ? { jfId: pass.jfId } : {}) };
}

/** `?audio=N` : un numéro de piste, ou `undefined` (la piste par défaut du fichier), ou `null` si mal formé. */
function audioParam(req: NextRequest): number | undefined | null {
  const raw = req.nextUrl.searchParams.get("audio");
  if (raw === null || raw === "") return undefined;
  return /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : null;
}

export async function serveLumenName(req: NextRequest, params: LumenNameParams): Promise<NextResponse> {
  const receivedAt = performance.now();
  // L'arrivée sur l'horloge de la chronologie (étape 3e) : notée seulement si la lecture est chronométrée.
  const arrivedAt = serverClockMs();
  const { itemId, version, s } = params;
  // Une adresse mal formée est une adresse qui ne désigne rien : 410, comme une autre version — un
  // 400 compterait pour CrowdSec (voir `service.ts`).
  if (!isJellyfinId(itemId)) return goneResponse("lumen-inconnu", "Élément inconnu");
  // Le laissez-passer d'une Apple TV, dans le chemin (`…/{s}/tv.{jeton}/{nom}`, §186) : revérifié ici avec la même
  // fonction que le proxy — ce titre, cette lecture, la session vivante, un administrateur, six heures. Avec lui, le
  // cookie n'est pas regardé : la même adresse sert la page et le téléviseur. Sans lui, la session administrateur.
  // Le laissez-passer d'un récepteur Chromecast (`…/{s}/cc.{jeton}/{nom}`, §192) : même vérification sous sa propre
  // portée (`lumen-cc`), et il change ce qui est servi — la vue `castView` (le son en AAC), la liste maître du
  // récepteur, des réponses en CORS.
  const first = params.name[0] ?? "";
  const cast = first.startsWith(LUMEN_CC_PREFIX);
  const tvSegment = first.startsWith(LUMEN_TV_PREFIX) || cast ? first : null;
  let tvPass: LumenTvPass | null = null;
  if (tvSegment) {
    const token = tvSegment.slice(cast ? LUMEN_CC_PREFIX.length : LUMEN_TV_PREFIX.length);
    tvPass = isPlaybackId(s) ? await (cast ? verifyLumenCastPass(token, itemId, s) : verifyLumenTvPass(token, itemId, s)) : null;
    // 401, jamais 403/404/400 : un jeton échu en rafale ne doit pas compter pour CrowdSec (`http-probing`).
    if (!tvPass) return NextResponse.json({ error: "Laissez-passer refusé", code: "lumen-tv" }, { status: 401, headers: NO_STORE });
  }
  // Une requête munie d'un cookie (la page) répond en plus au contrôle d'accès ordinaire : le jeton ne prête jamais
  // ses droits à une autre session — un compte ordinaire ou un lien de partage qui aurait recopié l'adresse de
  // l'administrateur reste refusé, et le titre caché à un compte le reste (`assertVisible`). Sans cookie (le
  // téléviseur), le jeton seul.
  const cookied = !!req.cookies.get(SESSION_COOKIE)?.value;
  // Le récepteur lit depuis le domaine de Google : chaque réponse à un laissez-passer valable, sans cookie, porte le CORS
  // de §64 (`*`, jamais d'identifiants) — erreurs comprises, pour que le lecteur du récepteur en lise le statut.
  const checked = { tvPass, cookied, cast, tvSegment, receivedAt, arrivedAt };
  if (cast && tvPass && !cookied) return withCastCors(await serveChecked(req, params, checked));
  return serveChecked(req, params, checked);
}

/**
 * La question préalable (CORS) d'un récepteur Chromecast sur une adresse `cc.{jeton}` (§192) : 204 avec les en-têtes de
 * §64 pour un jeton valable (le proxy l'a laissée passer avec la même fonction, `lumenCastPreflightFor`), 401 sans CORS
 * sinon — jamais 403/404 (CrowdSec). Aucune autre adresse de Lumen serveur ne répond à `OPTIONS` : la page, une Apple
 * TV, le banc lisent sans question préalable.
 */
export async function serveLumenPreflight(params: LumenNameParams): Promise<Response> {
  const first = params.name[0] ?? "";
  const token = first.startsWith(LUMEN_CC_PREFIX) ? first.slice(LUMEN_CC_PREFIX.length) : null;
  const pass = token && isJellyfinId(params.itemId) && isPlaybackId(params.s) ? await verifyLumenCastPass(token, params.itemId, params.s) : null;
  if (!pass) return NextResponse.json({ error: "Laissez-passer refusé", code: "lumen-tv" }, { status: 401, headers: NO_STORE });
  return castPreflightResponse();
}

/** La suite de `serveLumenName`, une fois le laissez-passer éventuel vérifié. */
async function serveChecked(
  req: NextRequest,
  params: LumenNameParams,
  checked: { tvPass: LumenTvPass | null; cookied: boolean; cast: boolean; tvSegment: string | null; receivedAt: number; arrivedAt: number }
): Promise<NextResponse> {
  const { itemId, version, s } = params;
  const { tvPass, cookied, cast, tvSegment, receivedAt, arrivedAt } = checked;
  // Coupé par l'exploitant (§194) : un téléviseur aussi — son laissez-passer ne passe pas par `lumenAccess`.
  if (!config.lumen.serverEnabled) return NextResponse.json({ error: "Lumen serveur coupé sur cette installation", code: "lumen-coupe" }, { status: 409, headers: NO_STORE });
  const session = tvPass && !cookied ? tvSessionOf(tvPass) : await lumenAccess(req, itemId);
  if (session instanceof NextResponse) return session;
  if (!isLumenVersion(version) || !isPlaybackId(s)) return goneResponse("lumen-inconnu", "Adresse inconnue");
  // Un téléviseur : la requête sans cookie munie d'un laissez-passer — la position de ses segments vidéo est rapportée
  // pour ce compte quand la page s'est tue (`castProgress.ts`). Le lecteur de la page porte la même adresse, avec
  // son cookie : il n'en passe jamais par là.
  const television = tvPass && !cookied ? tvPass : null;
  const nameParts = tvSegment ? params.name.slice(1) : params.name;
  // La découpe vient de l'adresse : une version d'un autre format (un déploiement qui l'a fait monter, une
  // révision des essais) ne désigne plus rien.
  // L'essai multiplexé (étape 3e, `trials.ts`) se lit dans la version (`2m1-…`) ; sans lui, rien ne change.
  const { base, mux } = splitMuxTag(formatTagOf(version));
  const cutting = cuttingOfTag(base);
  if (!cutting) return goneResponse("lumen-perime", "Autre version du format", { format: LUMEN_FORMAT_VERSION });
  const name = nameParts.join("/");
  // L'essai multiplexé n'existe pas pour un récepteur : son adresse ne désigne rien.
  if (cast && mux) return goneResponse("lumen-inconnu", "Essai multiplexé hors Chromecast");
  const muxed = mux ? parseMuxedPath(name) : null;
  // Les rendus de sous-titres (§191, `subtitles.ts`) : des noms à part, jamais vus du moteur.
  const subtitle = parseSubtitlePath(name);
  if (!parseLumenPath(name) && !muxed && !subtitle) return goneResponse("lumen-inconnu", "Nom inconnu");

  const context = { itemId, s, name };
  let found: Awaited<ReturnType<typeof lumenIndexOf>>;
  try {
    // La vue de la conversion du son (§161) : l'index lui-même sans l'option, sans ffmpeg, ou pour un autre compte.
    // Un récepteur Chromecast : la vue `castView` (§192), depuis l'index brut, avec le même contexte de conversion.
    found = await lumenIndexOf(itemId, cutting, await lumenConversionContext(session), cast ? "cast" : "page");
  } catch (error) {
    return lumenErrorResponse(error, context).response;
  }
  if ("refusal" in found) return refusedResponse(found.refusal);
  const { index } = found;
  const ruled = lumenVersionOf(index);
  // L'adresse d'un essai multiplexé porte la version de la règle plus `m1` : comparée telle quelle.
  const current = mux ? muxVersion(ruled) : ruled;
  const stats = playbackOf(s, { user: session.u, itemId, version: current });
  const chrono = chronoEntry(stats, name, arrivedAt);
  const answer = (response: NextResponse): NextResponse => {
    if (chrono && response.status !== 200) chrono.status = response.status;
    return response;
  };
  // Les sous-titres ne comptent pas au relevé : ses compteurs (listes, segments) sont ceux de l'image et du son.
  const parsed = parseLumenPath(name) ?? (muxed ? { kind: muxed.kind } : null);
  if (parsed) noteRequest(stats, parsed.kind);
  if (current !== version) {
    noteRefused(stats, "stale");
    return answer(goneResponse("lumen-perime", "Le fichier a changé", { version: current }));
  }
  if (index.refusal) return answer(refusedResponse(index.refusal));
  if (subtitle) {
    const response = await serveSubtitleRendition(req, {
      path: subtitle,
      index,
      session,
      itemId,
      playlistResponse: (request, text) => playlistResponse(request, text, timing({ app: performance.now() - receivedAt })),
    });
    noteReady(chrono);
    return answer(response);
  }
  const engine = lumenServerEngine();
  const path = muxed ? (muxedServed(index, muxed) ? muxed : null) : engine.resolve(index, name);
  if (!path) {
    noteRefused(stats, "stale");
    return answer(goneResponse("lumen-inconnu", "Piste ou segment hors de l'index"));
  }
  const idxMs = performance.now() - receivedAt;

  try {
    const resolved = { engine, index, version: ruled, stats, receivedAt, idxMs, context, chrono, session: playbackKey(session.u, s), account: session, television, itemId };
    return answer(muxed ? await serveMuxed(req, { ...resolved, path: muxed }) : await serveResolved(req, { ...resolved, path: path as LumenPath, mux, cast }));
  } catch (error) {
    const { response, kind, code } = lumenErrorResponse(error, context);
    noteRefused(stats, kind, code);
    // Un segment son converti « occupé » (§163) : le dire nommément. Le lecteur de Safari ne lit pas cet en-tête ;
    // il sert au relevé, au banc, et à l'hôte de l'étape 4 qui voudra distinguer la conversion saturée d'une file
    // de remux pleine avant de basculer vers le lecteur actuel (5-conversion-son.md §5.7).
    if (kind === "busy" && path.kind !== "master" && path.kind !== "playlist" && "rendition" in path && path.rendition.kind === "audio" && path.rendition.conv) {
      noteConvertBusy(stats);
      response.headers.set("X-Lumen-Son", "occupe");
    }
    return answer(response);
  }
}

/** Une piste multiplexée n'existe que pour une piste servie, et un segment que dans l'index. */
function muxedServed(index: Parameters<typeof lumenVersionOf>[0], path: MuxedPath): boolean {
  const track = index.audio.find((a) => a.number === path.track);
  // Pas de son converti dans l'essai multiplexé (§161) : il n'a été mesuré qu'avec des pistes copiées.
  if (!index.video || !track || track.refusal || track.converted || !index.inits.audio[path.track] || !index.inits.video) return false;
  return path.kind !== "segment" || path.n < index.segments.length;
}

/** Les instants d'une réponse dans la chronologie : prête maintenant, relatifs à l'arrivée. */
function noteReady(chrono: ChronoEntry | null): void {
  if (chrono) chrono.ready = round1(serverClockMs() - chrono.at);
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * L'essai multiplexé (levier a, étape 3e) : la liste, l'init et les segments « vidéo + piste N ». Un segment
 * multiplexé est fait des deux segments de la règle — construits, partagés et préparés exactement comme eux
 * (`lumenSegment`, la clé porte la version de la règle : un segment de reprise préparé sert aussi l'essai) —,
 * dont les fragments sont entrelacés (`muxedSegment`). Rien ici n'est gardé en plus.
 */
async function serveMuxed(
  req: NextRequest,
  r: {
    engine: ReturnType<typeof lumenServerEngine>;
    index: Parameters<typeof lumenVersionOf>[0];
    version: string;
    path: MuxedPath;
    stats: PlaybackStats;
    receivedAt: number;
    idxMs: number;
    chrono: ChronoEntry | null;
  }
): Promise<NextResponse> {
  const { engine, index, path, stats } = r;
  const audio = { kind: "audio" as const, track: path.track };
  if (path.kind === "playlist") {
    const text = muxedMediaPlaylist(engine.playlist(index, { kind: "video" }), path.track);
    noteReady(r.chrono);
    return playlistResponse(req, text, timing({ app: performance.now() - r.receivedAt, idx: r.idxMs }));
  }
  if (path.kind === "init") {
    const bytes = muxedInit(engine.init(index, { kind: "video" }), engine.init(index, audio));
    noteSent(stats, { kind: "init", video: true, bytes: bytes.length, sendMs: 0, aborted: false });
    noteReady(r.chrono);
    if (r.chrono) r.chrono.bytes = bytes.length;
    return new NextResponse(new Uint8Array(bytes), {
      headers: { "Content-Type": SEGMENT_TYPE, "Cache-Control": SEGMENT_CACHE, "Server-Timing": timing({ app: performance.now() - r.receivedAt, idx: r.idxMs }), ...lengthHeader(bytes.length) },
    });
  }
  noteMediaRead();
  const [v, a] = await Promise.all([lumenSegment(engine, index, r.version, { kind: "video" }, path.n), lumenSegment(engine, index, r.version, audio, path.n)]);
  noteBuilt(stats, { video: true, n: path.n, buildMs: v.segment.buildMs, waitMs: v.segment.waitMs, diskMs: v.segment.diskMs, reused: v.reused, falseKey: v.segment.falseKey });
  noteBuilt(stats, { video: false, n: path.n, buildMs: a.segment.buildMs, waitMs: a.segment.waitMs, diskMs: a.segment.diskMs, reused: a.reused });
  const bytes = muxedSegment(v.segment.bytes, a.segment.bytes, path.n);
  return segmentResponse(r, { bytes, name: `vm${path.track}/${path.n}.m4s`, video: true, reused: v.reused && a.reused, buildMs: Math.max(v.segment.buildMs, a.segment.buildMs), waitMs: Math.max(v.segment.waitMs, a.segment.waitMs), diskMs: v.segment.diskMs + a.segment.diskMs });
}

/**
 * La réponse d'un segment : le corps remis par morceaux et mesuré (`measuredBody`), le relevé, la trace, et la
 * chronologie si la lecture en a une (prête, premier et dernier morceau remis).
 */
function segmentResponse(
  r: { stats: PlaybackStats; receivedAt: number; idxMs: number; chrono: ChronoEntry | null },
  seg: { bytes: Uint8Array; name: string; video: boolean; track?: number; reused: boolean; buildMs: number; waitMs: number; diskMs: number }
): NextResponse {
  const { stats, chrono } = r;
  const bytes = seg.bytes;
  noteReady(chrono);
  if (chrono) {
    chrono.bytes = bytes.length;
    if (seg.reused) chrono.reused = true;
    else {
      chrono.build = Math.round(seg.buildMs);
      chrono.wait = Math.round(seg.waitMs);
    }
  }
  const body = measuredBody(
    bytes,
    (sendMs, aborted) => {
      if (chrono) {
        chrono.last = round1(serverClockMs() - chrono.at);
        if (aborted) chrono.aborted = true;
      }
      noteSent(stats, { kind: "segment", video: seg.video, bytes: bytes.length, sendMs: Math.round(sendMs), aborted, track: seg.track });
      noteTrace(stats, { name: seg.name, buildMs: seg.reused ? 0 : seg.buildMs, waitMs: seg.reused ? 0 : seg.waitMs, sendMs, reused: seg.reused, aborted, bytes: bytes.length });
    },
    chrono ? () => (chrono.first = round1(serverClockMs() - chrono.at)) : undefined
  );
  const parts: Record<string, number> = { app: performance.now() - r.receivedAt, idx: r.idxMs };
  if (!seg.reused) Object.assign(parts, { wait: seg.waitMs, build: seg.buildMs, disk: seg.diskMs });
  return new NextResponse(body, {
    headers: { "Content-Type": SEGMENT_TYPE, "Cache-Control": SEGMENT_CACHE, "Server-Timing": timing(parts), ...lengthHeader(bytes.length) },
  });
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
    chrono: ChronoEntry | null;
    /** L'essai multiplexé : la liste maître désigne la piste dans les segments vidéo (`muxedMaster`). */
    mux: boolean;
    /** La lecture (`playbackKey`), pour l'avance de la conversion du son. */
    session: string;
    /** Un téléviseur (§186) : la position de ses segments vidéo, rapportée quand la page s'est tue. */
    television?: LumenTvPass | null;
    itemId?: string;
    /** Le compte (la session, ou l'administrateur du laissez-passer) : Jellyfin lu pour lui, pour `?st=` (§191). */
    account?: Pick<SessionPayload, "jfId">;
    /** L'adresse d'un récepteur Chromecast (§192) : la liste maître du récepteur (`castMasterPlaylist`). */
    cast?: boolean;
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
      if (r.cast) {
        // Le récepteur (§192) : sa propre liste, une seule piste son, ni essai ni groupe par codec.
        const text = castMasterPlaylist(index, { audioTrack, labels: await labelsFor(req) });
        noteReady(r.chrono);
        return playlistResponse(req, text, timing({ app: performance.now() - r.receivedAt, idx: r.idxMs }));
      }
      // `?groupes=codec` : l'ancienne forme (un groupe par codec), un essai de `/lumen-test` (§185).
      const perCodecGroups = req.nextUrl.searchParams.get("groupes") === "codec";
      // `?dialogue=on|strong` (§193) : les rendus « dialogues » à la place des rendus ordinaires. Mal formé : 410, comme
      // une piste mal formée ; une piste sans ce rendu garde le sien (l'hôte le sait par le verdict).
      const dialogue = parseDialogueMode(req.nextUrl.searchParams.get("dialogue"));
      if (dialogue === null) return goneResponse("lumen-inconnu", "Mode « dialogues » inconnu");
      let text = engine.master(index, { audioTrack, labels: await labelsFor(req), ...(perCodecGroups ? { perCodecGroups } : {}), ...(dialogue ? { dialogue } : {}) });
      // Les essais de la seule liste maître (étape 3e, `trials.ts`) : sans `?start=` ni `?bw=`, le texte de la règle.
      text = withMasterTrials(text, masterTrialOptions(req.nextUrl.searchParams));
      if (r.mux && audioTrack !== null) text = muxedMaster(text, audioTrack);
      // `?st=N` (§191) : le rendu de sous-titres que le téléviseur doit dessiner. Sans lui, la liste d'avant à l'octet près.
      const subtitled = await masterWithSubtitles(req, text, { session: r.account ?? {}, itemId: r.itemId ?? "" });
      if (!subtitled) return goneResponse("lumen-inconnu", "Sous-titre mal formé");
      noteReady(r.chrono);
      const response = await playlistResponse(req, subtitled.text, timing({ app: performance.now() - r.receivedAt, idx: r.idxMs }));
      if (subtitled.outcome) response.headers.set(SUBTITLE_HEADER, subtitled.outcome);
      return response;
    }
    case "playlist": {
      const text = engine.playlist(index, path.rendition);
      noteReady(r.chrono);
      return playlistResponse(req, text, timing({ app: performance.now() - r.receivedAt, idx: r.idxMs }));
    }
    case "init": {
      const bytes = engine.init(index, path.rendition);
      noteReady(r.chrono);
      if (r.chrono) r.chrono.bytes = bytes.length;
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
      const { segment, reused } = await lumenSegment(engine, index, r.version, path.rendition, path.n, { session: r.session });
      noteBuilt(stats, { video, n: path.n, buildMs: segment.buildMs, waitMs: segment.waitMs, diskMs: segment.diskMs, reused, falseKey: segment.falseKey });
      if (segment.converted) noteConverted(stats, { ...segment.converted, waitMs: segment.waitMs });
      if (video && r.television && r.itemId) {
        castProgressRelay().noteCastPosition({ jfId: r.television.jfId, user: r.television.user, itemId: r.itemId, player: "lumen-serveur" }, index.segments[path.n].startUs / 1e6);
      }
      const track = path.rendition.kind === "audio" ? path.rendition.track : undefined;
      return segmentResponse(r, { bytes: segment.bytes, name: segmentName(path.rendition, path.n), video, track, reused, buildMs: segment.buildMs, waitMs: segment.waitMs, diskMs: segment.diskMs });
    }
  }
}
