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
import { inlineExecutor, workerExecutor } from "./pool";
import { lumenIndexStore } from "./indexStore";
import { lumenLocalPath } from "./paths";
import { defaultAudioTrack, lumenEligibility } from "./eligibility";
import { cuttingOf, identityKey, LumenError, lumenFormatTag, type LumenCutting, type LumenIndex, type LumenRefusal, type LumenRendition, renditionTag } from "./format";
import { sharedSegment, type BuiltSegment } from "./segmentCache";
import { targetDurationOf } from "./plan";

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

/**
 * L'index de l'élément : son fichier, puis l'index gardé ou construit. Un fichier disparu (renommé
 * par Radarr/Sonarr : `ENOENT` sur l'ancien chemin) fait relire Jellyfin une fois. `cutting` : la découpe
 * et sa cible (`cra` et 4 s sauf essai de la page `/lumen-test`, §157, §158) — un index à part par découpe.
 */
export async function lumenIndexOf(itemId: string, cutting: Partial<LumenCutting> = {}): Promise<{ index: LumenIndex } | { refusal: LumenRefusal }> {
  const { cut, targetUs } = cuttingOf(cutting.cut, cutting.targetUs);
  const engine = lumenServerEngine();
  let file = await lumenFileOf(itemId);
  for (let attempt = 0; ; attempt++) {
    if ("refusal" in file) return file;
    try {
      return { index: await engine.index(file.path, targetUs, cut) };
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

/** Le segment `n` de `rendition`, partagé avec une requête identique en vol ou préparé d'avance. */
export function lumenSegment(engine: LumenEngine, index: LumenIndex, version: string, rendition: LumenRendition, n: number, options: { keep?: boolean } = {}): Promise<{ segment: BuiltSegment; reused: boolean }> {
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
  | { ok: true; version: string; master: string; audioTrack: number | null; audio: LumenAudioFacts[]; segments: number; durationS: number; targetS: number; cutFacts: LumenCutFacts }
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
  }));
}

export { defaultAudioTrack };

/** L'adresse de la liste maître d'une lecture. `s` dans le chemin : les URI relatives des listes en héritent. */
export function masterAddress(itemId: string, version: string, s: string, audioTrack: number | null): string {
  return `/api/lumen/${itemId}/${version}/${s}/master.m3u8${audioTrack !== null ? `?audio=${audioTrack}` : ""}`;
}

/**
 * Lumen serveur peut-il lire cet élément avec cette piste, et à quelle adresse ? `waitMs` : combien
 * attendre un index qui se construit — au-delà, `pending`, la construction continue (et son échec
 * éventuel va au journal). L'étape 4 appelle `prepare` à l'appui sur Lire, puis décide avec ceci.
 */
export async function lumenVerdict(itemId: string, options: { audio: number | null | undefined; s: string; waitMs: number } & Partial<LumenCutting>): Promise<LumenVerdict> {
  const building = lumenIndexOf(itemId, { cut: options.cut, targetUs: options.targetUs });
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
  return {
    ok: true,
    version,
    master: masterAddress(itemId, version, options.s, audioTrack),
    audioTrack,
    audio,
    segments: index.segments.length,
    durationS: Math.round(index.durationUs / 1000) / 1000,
    targetS: targetDurationOf(index.segments),
    cutFacts,
  };
}

/** Un identifiant de lecture tiré par le serveur, quand la page n'en donne pas. */
export function newPlaybackId(): string {
  return randomBytes(9).toString("base64url");
}
