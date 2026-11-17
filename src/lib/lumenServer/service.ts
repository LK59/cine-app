// Lumen serveur derrière ses routes (`/api/lumen/…`, étape 3 de docs/remux-serveur/, DECISIONS.md §156).
//
// Ce que les routes partagent, écrit une fois : qui a le droit (`lumenAccess`), quel fichier sert un
// élément Jellyfin (`lumenFileOf`), la version portée par l'adresse (`lumenVersionOf`), le moteur du
// processus avec ses fils de calcul et son cache disque (`lumenServerEngine`), le verdict que l'étape 4
// lira avant de choisir ce chemin (`lumenVerdict`), et la traduction d'une erreur en réponse
// (`lumenErrorResponse`). Les routes ne font qu'assembler.
//
// **Les statuts sont choisis contre CrowdSec** (CLAUDE.md, « An expected absence is never a 404 ») :
// `http-probing` bannit une adresse qui reçoit plus de dix 404/403/400 sur des noms distincts non
// statiques, et `v/12.m4s`, `a3/12.m4s` sont des noms distincts non statiques (`.m4s` n'est pas dans sa
// liste d'extensions statiques — décision du 16/11/2026 de garder ces noms, une exception viendra côté
// CrowdSec s'il le faut). Une Apple TV dont le fichier a été remplacé redemanderait vingt segments en
// une seconde : un 404 chacun bannirait le foyer pour des heures. D'où :
// - **410** pour une adresse qui ne désigne plus rien (autre version du fichier ou du format, segment
//   ou piste hors de l'index, nom mal formé) — avec la version actuelle dans le corps ;
// - **409** pour un fichier que Lumen serveur ne sert pas (`LumenRefusalReason` dans le corps) ;
// - **503 + `Retry-After`** pour une file pleine (« occupé ») ou Jellyfin injoignable ;
// - **500** pour une vraie erreur, écrite dans `server.log` ;
// - 401/403/404 ne viennent que du contrôle d'accès (pas de session, pas administrateur, titre caché),
//   qu'un client de l'application ne rencontre pas en rafale : il n'a jamais reçu ces adresses.

import { signLumenCastPass, signLumenTvPass, withLumenCastPass, withLumenTvPass } from "./tvPass";
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, type SessionPayload } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { assertVisible } from "@/lib/itemVisibility";
import { jellyfin } from "@/lib/clients/jellyfin";
import { DATA_DIR } from "@/lib/dataDir";
import { logError } from "@/lib/logger";
import { lumenEngine, type LumenEngine } from "./engine";
import { inlineExecutor, workerExecutor, type LumenExecutor } from "./pool";
import { lumenIndexStore } from "./indexStore";
import { lumenLocalPath } from "./paths";
import { defaultAudioTrack, lumenEligibility } from "./eligibility";
import { cuttingOf, identityKey, LumenError, lumenFormatTag, type LumenCutting, type LumenIndex, type LumenRefusal, type LumenRendition, renditionTag } from "./format";
import { sharedSegment, type BuiltSegment } from "./segmentCache";
import { targetDurationOf } from "./plan";
import { config } from "@/lib/config";
import { audienceAllows } from "@/lib/featureAudience";
import { detectLumenFfmpeg } from "./audio/ffmpeg";
import { castVideoFamily, castView, dialogueRendition, dialogueTrackView, withConversion, withDialogue, type ConversionContext } from "./audio/view";
import { lumenAudio, type FeedReader, type PlaybackMode } from "./audio/conversion";
import type { DialogueRun } from "./audio/convert";
import type { LumenDialogueMode } from "./audio/dialogue";

// ── Le moteur du processus ───────────────────────────────────────────────────

/** Autant de fils que de constructions simultanées admises par la file (`DEFAULT_CONCURRENCY`). */
export const LUMEN_WORKER_THREADS = 3;

/**
 * Le module empaqueté du fil de calcul (`tools/lumen-worker/build.mjs`, lancé par le Dockerfile) :
 * `server-boot/lumen-worker.mjs` à côté du point d'entrée, ou `LUMEN_WORKER_PATH`. `inline` force le
 * calcul sur le fil principal (tests). Absent (`next dev` sans l'avoir empaqueté), le fil principal
 * fait le même travail — plus lentement pour les autres requêtes, jamais autrement.
 */
export function lumenWorkerScript(): string | null {
  const configured = process.env.LUMEN_WORKER_PATH;
  if (configured === "inline") return null;
  const path = configured || join(process.cwd(), "server-boot", "lumen-worker.mjs");
  // `turbopackIgnore` : un chemin calculé à l'exécution ferait tracer tout le projet dans la sortie
  // `standalone` (avertissement de `next build`) ; ce fichier est copié par le Dockerfile, pas tracé.
  return existsSync(/* turbopackIgnore: true */ path) ? path : null;
}

/** Le cache disque des index, sous `DATA_DIR` (`indexStore.ts`). */
export const LUMEN_INDEX_DIR = "lumen-index";

/** Le moteur du processus, créé à la première requête Lumen — aucun fil ne tourne avant. */
export function lumenServerEngine(): LumenEngine {
  return lumenEngine(() => {
    const script = lumenWorkerScript();
    if (!script && process.env.NODE_ENV === "production") {
      // Le Dockerfile l'empaquette : son absence en production est un défaut de l'image, à voir.
      logError("lumen/worker", new Error("Module du fil de calcul absent : calcul sur le fil principal"), { cwd: process.cwd() });
    }
    return {
      executor: script ? workerExecutor(pathToFileURL(script), LUMEN_WORKER_THREADS) : inlineExecutor(),
      store: lumenIndexStore(join(DATA_DIR, LUMEN_INDEX_DIR)),
    };
  });
}

// ── Qui a le droit ───────────────────────────────────────────────────────────

/**
 * La session qui peut lire Lumen serveur, ou la réponse de refus.
 *
 * Phase de test : **l'administrateur seul**, revérifié ici et pas seulement par le proxy
 * (`ADMIN_ONLY_READS`). Le cookie est la seule porte : aucun laissez-passer de diffusion
 * (`castPassFor`) n'est lu — `castItemOf` ne reconnaît pas `/api/lumen/…`, donc le proxy ne laisse
 * passer personne sans session, et cette fonction ne regarde pas le paramètre `castToken` du tout. Le
 * jeton d'une Apple TV viendra avec l'étape AirPlay, signé avec sa propre portée. Un lien de partage
 * est refusé nommément, avant même le rôle : sa porte (`shareGate`) est une liste fermée qui ne
 * contient pas ces routes, et rien ici ne doit l'ouvrir par accident le jour où le rôle s'élargit.
 * Le titre doit être visible du compte (`assertVisible` : tags bloqués, bibliothèques — un
 * administrateur voit tout, mais la question est posée pour le jour où la porte s'ouvrira).
 */
export async function lumenAccess(req: NextRequest, itemId: string): Promise<SessionPayload | NextResponse> {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Session requise", code: "lumen-session" }, { status: 401, headers: NO_STORE });
  if (session.role === "share" || session.role !== "admin") {
    return NextResponse.json({ error: "Réservé à l'administrateur", code: "lumen-admin" }, { status: 403, headers: NO_STORE });
  }
  // Coupé par l'exploitant (§194) : 409, « pas servi ici » — jamais 404 (CrowdSec). L'hôte rend la lecture au lecteur
  // actuel, comme pour un refus prévu.
  if (!config.lumen.serverEnabled) return NextResponse.json({ error: "Lumen serveur coupé sur cette installation", code: "lumen-coupe" }, { status: 409, headers: NO_STORE });
  const refused = await assertVisible(session, itemId);
  if (refused) return refused;
  return session;
}

// ── Le fichier d'un élément ──────────────────────────────────────────────────

const FILES = Symbol.for("cine-app.lumenServer.files");
/** Le chemin d'un élément change rarement (un fichier remplacé garde souvent son nom) : dix minutes, comme X-Ray. */
const FILE_TTL_MS = 10 * 60 * 1000;
const MAX_FILES = 500;

interface FileEntry {
  at: number;
  /** Le chemin local réel, ou le refus. */
  result: { path: string } | { refusal: LumenRefusal };
}

function files(): Map<string, FileEntry> {
  const g = globalThis as unknown as Record<symbol, Map<string, FileEntry> | undefined>;
  return (g[FILES] ??= new Map());
}

/**
 * Le fichier local que sert l'élément `itemId` : `MediaSources[0].Path` lu chez Jellyfin avec la clé
 * du serveur (`getItemForAnalysis`, l'appel d'X-Ray), traduit par `lumenLocalPath` (`LUMEN_PATH_MAP`,
 * garde-fous de racine et de liens). Le droit du compte a été vérifié avant (`lumenAccess`).
 * Jellyfin injoignable : lève (la route répond 503). `fresh` : relire Jellyfin — le fichier a pu être
 * renommé par Radarr ou Sonarr depuis.
 */
export async function lumenFileOf(itemId: string, options: { fresh?: boolean; now?: number } = {}): Promise<{ path: string } | { refusal: LumenRefusal }> {
  const cache = files();
  const now = options.now ?? Date.now();
  const held = cache.get(itemId);
  if (held && !options.fresh && now - held.at < FILE_TTL_MS) return held.result;
  // La rafale d'une ouverture (préparation, verdict, liste maître) ne demande le fichier qu'une fois.
  const pending = inflightFiles().get(itemId);
  if (pending) return pending;
  const promise = readFileOf(itemId, now).finally(() => inflightFiles().delete(itemId));
  inflightFiles().set(itemId, promise);
  return promise;
}

const INFLIGHT_FILES = Symbol.for("cine-app.lumenServer.filesInflight");
function inflightFiles(): Map<string, Promise<FileEntry["result"]>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<FileEntry["result"]>> | undefined>;
  return (g[INFLIGHT_FILES] ??= new Map());
}

async function readFileOf(itemId: string, now: number): Promise<FileEntry["result"]> {
  const cache = files();
  const item = await jellyfin.getItemForAnalysis(itemId);
  const jellyfinPath = item?.MediaSources?.[0]?.Path || item?.Path || "";
  let result: FileEntry["result"];
  if (!jellyfinPath) result = { refusal: { reason: "lecture-impossible", detail: "aucun fichier chez Jellyfin" } };
  else {
    const local = await lumenLocalPath(jellyfinPath);
    result = local ? { path: local } : { refusal: { reason: "lecture-impossible", detail: "fichier absent de ce conteneur (LUMEN_PATH_MAP)" } };
  }
  cache.delete(itemId);
  cache.set(itemId, { at: now, result });
  while (cache.size > MAX_FILES) cache.delete(cache.keys().next().value!);
  return result;
}

/** Pour les tests. */
export function forgetLumenFiles(): void {
  files().clear();
  inflightFiles().clear();
}

// ── La conversion du son (phase 2, DECISIONS.md §161) ────────────────────────

/**
 * Ce qu'il faut pour servir converties les pistes DTS, TrueHD, Opus et MP2/MP3 de cette requête, ou null : l'option
 * (`LUMEN_AUDIO_CONVERT`, une audience) n'est pas ouverte à ce compte, c'est un lien de partage, ou ffmpeg n'est pas
 * là ou pas conforme (`detectLumenFfmpeg`, faite une fois). Null, Lumen serveur se comporte exactement comme sans
 * la phase 2 : ces pistes restent refusées `son-codec`.
 */
export async function lumenConversionContext(session: Pick<SessionPayload, "role"> | null | undefined): Promise<ConversionContext | null> {
  if (!session || session.role === "share" || !audienceAllows(config.lumen.audioConvert, session)) return null;
  const detection = await detectLumenFfmpeg();
  if (!detection.available) return null;
  return { ffmpegVersion: detection.version, ffmpegSha256: detection.sha256, reference: detection.reference, ...(detection.dolby ? { dolby: true } : {}) };
}

const FEED_EXECUTOR = Symbol.for("cine-app.lumenServer.feedExecutor");
/** Les fils qui lisent les blocs du son à convertir : à eux, pas ceux du remux vidéo. */
export const LUMEN_FEED_THREADS = 2;

/**
 * Les fils de calcul de la lecture du son à convertir (`audio-feed`), **à part de ceux du remux** : au banc de charge
 * du 17/11/2026, quatre conversions qui partageaient les trois fils et la file du moteur faisaient passer un segment
 * vidéo 4K de 65 à 2 156 ms (p95). Une piste TrueHD range une unité de 40 échantillons par bloc (1 200 blocs par
 * seconde) : lire 7 s de son, c'est des milliers de blocs à parcourir. Deux fils suffisent : la file de la conversion
 * borne déjà les lectures simultanées (`LUMEN_AUDIO_MAX_JOBS`).
 */
function feedExecutor(engine: LumenEngine): LumenExecutor {
  const g = globalThis as unknown as Record<symbol, LumenExecutor | undefined>;
  if (engine.executor.kind === "inline") return engine.executor;
  const script = lumenWorkerScript();
  return (g[FEED_EXECUTOR] ??= script ? workerExecutor(pathToFileURL(script), LUMEN_FEED_THREADS) : engine.executor);
}

/** La lecture d'une fenêtre de son par un fil de calcul (`audio-feed`), sur les fils de la conversion. */
export function lumenFeedReader(engine: LumenEngine): FeedReader {
  return async (spec) => {
    const began = performance.now();
    const result = await feedExecutor(engine).run({ type: "audio-feed", spec });
    if (result.type !== "audio-feed") throw new Error("Réponse inattendue du fil de calcul.");
    return { feed: result.feed, diskMs: result.cost.diskMs, ms: Math.round(performance.now() - began) };
  };
}

const DIALOGUE_EXECUTOR = Symbol.for("cine-app.lumenServer.dialogueExecutor");
/** Les fils du traitement « dialogues » : à eux, ni ceux du remux ni ceux de la lecture des blocs. */
export const LUMEN_DIALOGUE_THREADS = 2;

/**
 * Les fils de calcul de « Améliorer les dialogues » (§193, travail `dialogue`), créés au premier segment traité : une
 * tâche d'avance de 30 s, chaque segment avec ses 6 s de pré-roulement, c'est ~1,5 s de calcul (18 ms par seconde de
 * son, mesuré) — ni la lecture des blocs d'une autre conversion ni un segment vidéo n'ont à l'attendre. Deux fils :
 * la file de la conversion borne déjà les tâches simultanées (`LUMEN_AUDIO_MAX_JOBS`, 2).
 */
function dialogueExecutor(engine: LumenEngine): LumenExecutor {
  const g = globalThis as unknown as Record<symbol, LumenExecutor | undefined>;
  if (engine.executor.kind === "inline") return engine.executor;
  const script = lumenWorkerScript();
  return (g[DIALOGUE_EXECUTOR] ??= script ? workerExecutor(pathToFileURL(script), LUMEN_DIALOGUE_THREADS) : engine.executor);
}

/** Le traitement « dialogues » d'une tâche, à cette force, par un fil de calcul. */
export function lumenDialogueRun(engine: LumenEngine, mode: LumenDialogueMode): DialogueRun {
  return {
    mode,
    enhance: async (work) => {
      const began = performance.now();
      const result = await dialogueExecutor(engine).run({ type: "dialogue", work });
      if (result.type !== "dialogue") throw new Error("Réponse inattendue du fil de calcul.");
      return { segments: result.segments, ms: Math.round(performance.now() - began) };
    },
  };
}

/**
 * Les modes d'essai de la conversion d'une lecture, lus dans une requête : `convPool=1|0` (le pool de ffmpeg
 * pré-lancés, ou pas), `convCold=1` (rien lu du cache). Null : aucun demandé — le défaut.
 */
export function conversionModeOf(q: URLSearchParams): PlaybackMode | null {
  const pool = q.get("convPool");
  const cold = q.get("convCold");
  const mode: PlaybackMode = {};
  if (pool === "1" || pool === "true") mode.pool = true;
  else if (pool === "0" || pool === "false") mode.pool = false;
  if (cold === "1" || cold === "true") mode.cold = true;
  return Object.keys(mode).length ? mode : null;
}

/** La clé d'une lecture pour l'avance et l'admission : le compte et l'identifiant de la page. */
export function playbackKey(user: string, s: string): string {
  return `${user}\u0000${s}`;
}

/**
 * L'index de l'élément : son fichier, puis l'index gardé ou construit. Un fichier disparu (renommé
 * par Radarr/Sonarr : `ENOENT` sur l'ancien chemin) fait relire Jellyfin une fois. `cutting` : la découpe
 * et sa cible (`cra` et 4 s sauf essai de la page `/lumen-test`, §157, §158) — un index à part par découpe.
 * `view` : `"cast"` pour l'adresse d'un récepteur Chromecast (`castView`, §192 — le son en AAC, depuis l'index brut) ;
 * absent, la vue de la page et d'AirPlay (§161), inchangée.
 */
export async function lumenIndexOf(
  itemId: string,
  cutting: Partial<LumenCutting> = {},
  conversion: ConversionContext | null = null,
  view: "page" | "cast" = "page"
): Promise<{ index: LumenIndex } | { refusal: LumenRefusal }> {
  const { cut, targetUs } = cuttingOf(cutting.cut, cutting.targetUs);
  const engine = lumenServerEngine();
  let file = await lumenFileOf(itemId);
  for (let attempt = 0; ; attempt++) {
    if ("refusal" in file) return file;
    try {
      const raw = await engine.index(file.path, targetUs, cut);
      if (view === "cast") return { index: castView(raw, conversion) };
      // La vue de la conversion (§161), puis celle des rendus « dialogues » (§193) : l'index lui-même quand elles ne
      // sont pas permises à cette requête.
      return { index: withDialogue(withConversion(raw, conversion), conversion) };
    } catch (error) {
      if (attempt === 0 && (error as NodeJS.ErrnoException)?.code === "ENOENT") {
        file = await lumenFileOf(itemId, { fresh: true });
        continue;
      }
      throw error;
    }
  }
}

// ── La version portée par l'adresse ──────────────────────────────────────────

/**
 * `{format}-{empreinte}` : la version du format produit (`lumenFormatTag` : `LUMEN_FORMAT_VERSION`, suivie
 * pour un essai de sa découpe, de sa révision et de sa cible — `2-…` la règle, `2i1-…`, `2l1-…`, `2t2-…`,
 * §157, §158) et douze chiffres hexadécimaux du SHA-256 de l'identité du fichier (chemin local, taille,
 * mtime, inode). La découpe est donc dans l'adresse : les URI relatives des listes en héritent, et la
 * route sait quel index lire sans rien d'autre. Un segment
 * demandé pour une autre version — fichier remplacé, déploiement qui change le format — reçoit un 410
 * net, jamais les octets d'un autre fichier recollés sur l'init de l'ancien (2-serveur.md §2.1, §2.5).
 * Le chemin local n'y paraît pas en clair : l'adresse finit dans les journaux du relais inverse.
 */
export function lumenVersionOf(index: LumenIndex): string {
  return `${lumenFormatTag(index.cut, index.targetUs)}-${createHash("sha256").update(identityKey(index.identity)).digest("hex").slice(0, 12)}`;
}

export function isLumenVersion(value: string): boolean {
  return /^[1-9]\d{0,3}(?:[a-z][1-9]\d{0,2}){0,2}-[0-9a-f]{12}$/.test(value);
}

/** La version de format d'une adresse (`2`, `2i1`, `2t2`…) : ce qui précède l'empreinte. */
export function formatTagOf(version: string): string {
  return version.slice(0, version.indexOf("-"));
}

// ── Les réponses ─────────────────────────────────────────────────────────────

export const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** Une adresse qui ne désigne plus rien (ou jamais rien) : 410, jamais 404 — voir l'en-tête. */
export function goneResponse(code: "lumen-perime" | "lumen-inconnu", message: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error: message, code, ...extra }, { status: 410, headers: NO_STORE });
}

/** Un fichier que Lumen serveur ne sert pas, avec la raison stable. */
export function refusedResponse(refusal: LumenRefusal): NextResponse {
  return NextResponse.json({ error: "Fichier non servi par Lumen serveur", code: "lumen-refus", reason: refusal.reason, detail: refusal.detail }, { status: 409, headers: NO_STORE });
}

export function busyResponse(message = "Lumen serveur occupé, réessayer"): NextResponse {
  return NextResponse.json({ error: message, code: "lumen-occupe" }, { status: 503, headers: { ...NO_STORE, "Retry-After": "1" } });
}

const LOGGED = Symbol.for("cine-app.lumenServer.logged");
const LOG_EVERY_MS = 60_000;

/**
 * Une erreur réelle va à `server.log` — une fois par minute pour la même erreur de la même lecture :
 * un fichier illisible fait échouer chaque segment qu'une Apple TV redemande, et une ligne par segment
 * noierait le reste. Le relevé de la lecture (`playbackStats.ts`) les compte toutes.
 */
export function logLumenError(scope: string, error: unknown, context: Record<string, unknown>, now = Date.now()): void {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  const seen = (g[LOGGED] ??= new Map());
  const message = error instanceof Error ? error.message : String(error);
  const key = `${scope}|${context.s ?? ""}|${context.itemId ?? ""}|${message.slice(0, 120)}`;
  const at = seen.get(key);
  if (at !== undefined && now - at < LOG_EVERY_MS) return;
  seen.set(key, now);
  while (seen.size > 500) seen.delete(seen.keys().next().value!);
  logError(scope, error, context);
}

/**
 * Une erreur du moteur traduite en réponse. `kind` dit ce qu'il en est pour le relevé : `busy`
 * (réessayer), `stale` (une autre version), `error` (une vraie erreur, écrite au journal).
 */
export function lumenErrorResponse(error: unknown, context: Record<string, unknown>): { response: NextResponse; kind: "busy" | "stale" | "error"; code: string } {
  if (error instanceof LumenError) {
    switch (error.code) {
      case "occupe":
        return { response: busyResponse(), kind: "busy", code: error.code };
      case "fichier-change":
        return { response: goneResponse("lumen-perime", "Le fichier a changé"), kind: "stale", code: error.code };
      case "segment-inconnu":
      case "piste-inconnue":
        return { response: goneResponse("lumen-inconnu", error.message), kind: "stale", code: error.code };
      case "non-eligible":
        return { response: refusedResponse({ reason: "piste-inconnue", detail: error.message }), kind: "stale", code: error.code };
      default:
        break;
    }
  }
  // Jellyfin injoignable pendant la recherche du fichier : rien n'est faux, réessayer plus tard.
  if (error instanceof Error && /fetch failed|ECONNREFUSED|ETIMEDOUT|TimeoutError|aborted/i.test(`${error.name} ${error.message}`)) {
    return { response: busyResponse("Jellyfin injoignable"), kind: "busy", code: "jellyfin" };
  }
  logLumenError("lumen", error, context);
  const code = error instanceof LumenError ? error.code : error instanceof Error ? error.name : "erreur";
  return {
    response: NextResponse.json({ error: "Erreur de Lumen serveur", code: "lumen-erreur" }, { status: 500, headers: NO_STORE }),
    kind: "error",
    code,
  };
}

// ── Les segments ─────────────────────────────────────────────────────────────

/**
 * Le segment `n` de `rendition`, partagé avec une requête identique en vol ou préparé d'avance. Une piste servie
 * convertie (§161, la vue `withConversion`) passe par la conversion : son propre cache en deux étages, sa file, son
 * avance (`audio/conversion.ts`) ; `session` (`playbackKey`) lui dit quelle lecture avance.
 */
export async function lumenSegment(
  engine: LumenEngine,
  index: LumenIndex,
  version: string,
  rendition: LumenRendition,
  n: number,
  options: { keep?: boolean; session?: string } = {}
): Promise<{ segment: BuiltSegment; reused: boolean }> {
  // Un rendu « dialogues » (§193) : une conversion comme une autre (cache, file, avance), sous l'identité de son
  // traitement, avec `DialogueEnhancer` entre le décodeur et l'encodeur.
  if (rendition.kind === "audio" && rendition.dialogue) {
    const mode = rendition.dialogue;
    const held = index.audio.find((a) => a.number === rendition.track && a.dialogue?.cids[mode] === rendition.conv);
    const track = held ? dialogueTrackView(held, mode) : null;
    if (!track) throw new LumenError("piste-inconnue", "Rendu « dialogues » non servi.");
    const r = await lumenAudio().segment({ index, version, track, n, readFeed: lumenFeedReader(engine), session: options.session, dialogue: lumenDialogueRun(engine, mode) });
    return {
      segment: { bytes: r.bytes, buildMs: r.convMs + r.feedMs, waitMs: r.waitMs, diskMs: 0, converted: { from: r.from, convMs: r.convMs, feedMs: r.feedMs } },
      reused: r.from !== "built",
    };
  }
  const converted = rendition.kind === "audio" ? index.audio.find((a) => a.number === rendition.track && a.converted) : undefined;
  if (converted) {
    const r = await lumenAudio().segment({ index, version, track: converted, n, readFeed: lumenFeedReader(engine), session: options.session });
    return {
      segment: { bytes: r.bytes, buildMs: r.convMs + r.feedMs, waitMs: r.waitMs, diskMs: 0, converted: { from: r.from, convMs: r.convMs, feedMs: r.feedMs } },
      reused: r.from !== "built",
    };
  }
  return sharedSegment(
    `${index.identity.path}|${version}|${renditionTag(rendition)}|${n}`,
    async () => {
      const began = performance.now();
      const built = await engine.segment(index, rendition, n);
      const total = performance.now() - began;
      return {
        bytes: built.bytes,
        buildMs: built.cost.ms,
        waitMs: Math.max(0, Math.round(total - built.cost.ms)),
        diskMs: built.cost.diskMs,
        ...(built.facts.falseKey ? { falseKey: true } : {}),
      };
    },
    options
  );
}

/** Le segment qui contient l'instant `seconds` (temps du fichier). */
export function segmentAt(index: LumenIndex, seconds: number): number {
  const us = Math.max(0, seconds) * 1e6;
  let lo = 0;
  let hi = index.segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.segments[mid].startUs <= us) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

// ── Le verdict (éligibilité, préparation) ────────────────────────────────────

export interface LumenAudioFacts {
  number: number;
  codec: string;
  language: string | null;
  name: string | null;
  channels: number;
  /** « 16/JOC » pour un Atmos, comme la liste maître l'écrira. */
  hlsChannels: string | null;
  isDefault: boolean;
  servable: boolean;
  refusal: string | null;
  /**
   * Ce qui a été réparé pour la servir (§159) : `sbr-explicite` (configuration réécrite), `silence-devant`,
   * `silence-derriere` (trames de silence), ou null — copiée telle quelle.
   */
  repairs: string[];
  /**
   * Servie convertie (§161) : la cible (`eac3-640-51`, `eac3-256-20`) ; null sinon. `convertible` : la piste se
   * convertirait si l'option était en service ; `convertRefusal` : pourquoi elle ne se convertit pas.
   */
  converted: string | null;
  convertible: boolean;
  convertRefusal: string | null;
  /**
   * La piste a ses rendus « Améliorer les dialogues » (§193) : la cible (`eac3-640-51`, `eac3-256-20`) ; null sinon
   * (option coupée, ffmpeg absent, AAC, FLAC…). Absent des réponses d'avant : null.
   */
  dialogue?: string | null;
}

/** Ce que la découpe a donné : la page `/lumen-test` le montre, pour juger les découpes sur pièce. */
export interface LumenCutFacts {
  cut: LumenCutting["cut"];
  /** La cible, en secondes (4 sauf essai). */
  targetS: number;
  /** Le plus long segment, en secondes. */
  longestS: number;
  /** Clés vérifiées (lues), CRA à RASL parmi elles, coupes admises. */
  verified: number;
  craRasl: number;
  cuts: number;
  /** Coupes prises des Cues sans être lues (l'index des Cues, §158) ; 0 sous `idr`. */
  trusted: number;
}

export type LumenVerdict =
  | {
      ok: true;
      version: string;
      master: string;
      audioTrack: number | null;
      audio: LumenAudioFacts[];
      segments: number;
      durationS: number;
      targetS: number;
      cutFacts: LumenCutFacts;
      /** La piste choisie est convertie (§161) : l'état de la conversion de cette lecture. */
      conversion?: { state: "ok" | "tension"; leadS: number };
      /** L'adresse d'un récepteur (§192) : la famille de la vidéo servie, pour que l'émetteur retienne un refus du HEVC. */
      castVideo?: "h264" | "hevc";
      /**
       * Le débit moyen annoncé par la liste (AVERAGE-BANDWIDTH, b/s) : ce que l'hôte compare au débit mesuré de la
       * connexion avant d'annoncer le quart (`?bw=bas`, 17/11/2026, `lumenLink.ts`).
       */
      averageBps?: number;
      /**
       * « Améliorer les dialogues » demandé (`?dialogue=`, §193) : servi (`master` porte alors `&dialogue=`), ou pourquoi
       * non — la piste n'a pas de rendu traité, ou le serveur n'admet pas une lecture de plus qui convertit. Non servi,
       * `master` est la liste ordinaire : l'hôte rend alors la lecture au lecteur actuel, qui fait le traitement.
       */
      dialogue?: { mode: LumenDialogueMode; served: true } | { mode: LumenDialogueMode; served: false; reason: string; detail?: string };
    }
  | { ok: false; reason: string; detail?: string; audioTrack: number | null; audio: LumenAudioFacts[]; version?: string; cutFacts?: LumenCutFacts }
  /** L'index se construit encore (2 à 25 s à froid) : redemander, la construction continue sans attendre. */
  | { ok: false; pending: true; reason: "index-en-cours"; audioTrack: number | null; audio: [] };

function audioFacts(index: LumenIndex): LumenAudioFacts[] {
  return index.audio.map((a) => ({
    number: a.number,
    codec: a.codecId,
    language: a.language,
    name: a.name,
    channels: a.channels,
    hlsChannels: a.signal?.channels ?? null,
    isDefault: a.isDefault,
    servable: !a.refusal && !!index.inits.audio[a.number],
    refusal: a.refusal?.reason ?? null,
    repairs: [
      ...(a.configuration ? ["sbr-explicite"] : []),
      ...(a.silence?.leadUntilUs != null ? ["silence-devant"] : []),
      ...(a.silence?.tailFromUs != null ? ["silence-derriere"] : []),
    ],
    converted: a.converted?.target ?? null,
    convertible: !!a.convert,
    convertRefusal: a.convertRefusal ?? null,
    // Seulement quand il y a quelque chose à dire : sans l'option, le verdict garde la forme d'avant.
    ...(a.dialogue ? { dialogue: a.dialogue.target } : {}),
  }));
}

export { defaultAudioTrack };

/** L'adresse de la liste maître d'une lecture. `s` dans le chemin : les URI relatives des listes en héritent. */
export function masterAddress(itemId: string, version: string, s: string, audioTrack: number | null, dialogue?: LumenDialogueMode): string {
  const query = [...(audioTrack !== null ? [`audio=${audioTrack}`] : []), ...(dialogue ? [`dialogue=${dialogue}`] : [])];
  return `/api/lumen/${itemId}/${version}/${s}/master.m3u8${query.length ? `?${query.join("&")}` : ""}`;
}

/**
 * Lumen serveur peut-il lire cet élément avec cette piste, et à quelle adresse ? `waitMs` : combien
 * attendre un index qui se construit — au-delà, `pending`, la construction continue (et son échec
 * éventuel va au journal). L'étape 4 appelle `prepare` à l'appui sur Lire, puis décide avec ceci.
 */
export async function lumenVerdict(
  itemId: string,
  options: {
    audio: number | null | undefined;
    s: string;
    waitMs: number;
    session?: Pick<SessionPayload, "role" | "u"> & Partial<Pick<SessionPayload, "jti" | "jfId">>;
    /** L'adresse munie du laissez-passer d'une Apple TV (§186) : le lecteur la demande (`?tv=1`), le banc non. */
    tv?: boolean;
    /**
     * L'adresse d'un récepteur Chromecast (§192, `?cast=1`) : la vue `castView` (son AAC), la liste maître du
     * récepteur, le laissez-passer `cc.{jeton}`. `hevc: false` : l'émetteur sait que ce récepteur a refusé le HEVC
     * (un premier essai échoué) — le fichier HEVC est alors refusé ici et le récepteur garde le flux de Jellyfin.
     */
    cast?: { hevc: boolean };
    /** « Améliorer les dialogues » demandé (§193) : la liste maître de ses rendus, si la piste choisie en a un. */
    dialogue?: LumenDialogueMode;
  } & Partial<LumenCutting>
): Promise<LumenVerdict> {
  const conversion = await lumenConversionContext(options.session);
  const building = lumenIndexOf(itemId, { cut: options.cut, targetUs: options.targetUs }, conversion, options.cast ? "cast" : "page");
  const PENDING = Symbol("pending");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    building,
    new Promise<typeof PENDING>((resolve) => {
      timer = setTimeout(() => resolve(PENDING), Math.max(0, options.waitMs));
    }),
  ]).finally(() => clearTimeout(timer));
  if (raced === PENDING) {
    building.catch((error) => {
      if (!(error instanceof LumenError && error.code === "occupe")) logLumenError("lumen/index", error, { itemId });
    });
    return { ok: false, pending: true, reason: "index-en-cours", audioTrack: options.audio ?? null, audio: [] };
  }
  if ("refusal" in raced) return { ok: false, ...raced.refusal, audioTrack: options.audio ?? null, audio: [] };
  const { index } = raced;
  const audioTrack = options.audio === undefined ? defaultAudioTrack(index) : options.audio;
  const verdict = lumenEligibility(index, audioTrack);
  const audio = audioFacts(index);
  const version = lumenVersionOf(index);
  const cutFacts: LumenCutFacts = {
    cut: index.cut,
    targetS: index.targetUs / 1e6,
    longestS: Math.round(index.segments.reduce((m, seg) => Math.max(m, seg.endUs - seg.startUs), 0) / 1000) / 1000,
    verified: index.keys.verified,
    craRasl: index.keys.craRasl,
    cuts: index.keys.cuts,
    trusted: index.keys.trusted ?? 0,
  };
  if (!verdict.ok) return { ok: false, reason: verdict.reason, ...(verdict.detail ? { detail: verdict.detail } : {}), audioTrack, audio, version, cutFacts };
  const castVideo = options.cast ? castVideoFamily(index) : null;
  if (options.cast && castVideo === "hevc" && !options.cast.hevc) {
    return { ok: false, reason: "video-codec", detail: "chromecast : HEVC refusé par ce récepteur", audioTrack, audio, version, cutFacts };
  }
  // Le laissez-passer d'un récepteur (§192) : sans lui, l'adresse ne servirait à rien — un compte qui n'en reçoit pas
  // (pas administrateur, session sans identifiant) garde le flux de Jellyfin.
  const castToken = options.cast && options.session ? await signLumenCastPass(itemId, options.s, options.session) : null;
  if (options.cast && !castToken) return { ok: false, reason: "lecture-impossible", detail: "chromecast : pas de laissez-passer", audioTrack, audio, version, cutFacts };
  // L'admission (§163) : une lecture qui aurait à convertir ne commence que si le serveur peut la servir sans
  // dégrader les lectures en cours ; sinon le lecteur actuel prend le titre et convertit dans la page.
  const chosen = index.audio.find((a) => a.number === audioTrack);
  let conversionState: { state: "ok" | "tension"; leadS: number } | null = null;
  if (chosen?.converted && options.session) {
    const key = playbackKey(options.session.u, options.s);
    const admission = lumenAudio().admit(key);
    if (!admission.ok) return { ok: false, reason: "son-serveur-occupe", detail: admission.detail, audioTrack, audio, version, cutFacts };
    conversionState = lumenAudio().audioState(key);
  }
  // « Améliorer les dialogues » (§193) : servi si la piste choisie a son rendu et que le serveur admet une lecture de
  // plus qui convertit (la même admission que §163 — un rendu « dialogues » est une conversion). Sinon le verdict reste
  // `ok` pour la liste ordinaire, et dit pourquoi : la lecture elle-même reste possible, c'est le traitement qui ne
  // l'est pas ici — l'hôte la rend alors au lecteur actuel.
  let dialogue: Extract<LumenVerdict, { ok: true }>["dialogue"] | undefined;
  if (options.dialogue) {
    if (!chosen?.dialogue) dialogue = { mode: options.dialogue, served: false, reason: "dialogues-piste", detail: chosen ? chosen.codecId : "aucune piste" };
    else if (options.session && !chosen.converted) {
      const admission = lumenAudio().admit(playbackKey(options.session.u, options.s));
      dialogue = admission.ok ? { mode: options.dialogue, served: true } : { mode: options.dialogue, served: false, reason: "son-serveur-occupe", detail: admission.detail };
    } else dialogue = { mode: options.dialogue, served: true };
  }
  // Le laissez-passer d'une Apple TV dans le chemin (§186), quand le lecteur le demande : l'élément porte cette adresse
  // dès l'ouverture, et le bouton AirPlay la tend telle quelle au téléviseur, qui n'a pas de cookie. Le banc
  // (`/lumen-test`) n'en demande pas : pas de jeton là où il ne sert pas.
  const tvToken = options.tv && !options.cast && options.session ? await signLumenTvPass(itemId, options.s, options.session) : null;
  const master = masterAddress(itemId, version, options.s, audioTrack, dialogue?.served ? dialogue.mode : undefined);
  return {
    ok: true,
    version,
    master: castToken ? withLumenCastPass(master, castToken) : tvToken ? withLumenTvPass(master, tvToken) : master,
    ...(castVideo ? { castVideo } : {}),
    audioTrack,
    audio,
    segments: index.segments.length,
    durationS: Math.round(index.durationUs / 1000) / 1000,
    targetS: targetDurationOf(index.segments),
    averageBps: Math.max(index.bandwidth.average, 1),
    cutFacts,
    // Pour la bascule en cours de lecture (étape 4) : l'avance convertie et l'état de cette lecture, relus par un
    // nouvel appel à `eligibility` quand la page voit une attente (5-conversion-son.md §5.7).
    ...(chosen?.converted ? { conversion: conversionState ?? { state: "ok" as const, leadS: 0 } } : {}),
    ...(dialogue ? { dialogue } : {}),
  };
}

/** Un identifiant de lecture tiré par le serveur, quand la page n'en donne pas. */
export function newPlaybackId(): string {
  return randomBytes(9).toString("base64url");
}
