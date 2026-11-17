// La version allégée côté serveur : produire, garder et préparer d'avance les segments des échelons.
//
// - **Produire** (`segment`) : le segment d'origine `n` (construit, partagé ou préparé par le chemin ordinaire — c'est
//   lui qui dit les images et leurs instants), puis un encodage VAAPI de ses images (`encodeArgs`), remis aux instants
//   de l'origine (`lightSegment`). Une seule production par segment à la fois (une requête identique attend la
//   première).
// - **Garder** : en mémoire (les plus récents, `LUMEN_LIGHT_RAM_MB`) et sur le disque (`DATA_DIR/lumen-light`,
//   `LUMEN_LIGHT_CACHE_GB`, le moins récemment lu évincé). La clé porte le fichier (son identité), l'identité de
//   l'échelon (`cid`) et le rang : un segment gardé est le même octet pour octet tant que ni le fichier ni l'encodeur
//   ne changent — et s'ils changent, l'adresse change avec eux.
// - **Borner** : `LUMEN_LIGHT_MAX_JOBS` encodages à la fois (le iGPU sert aussi Jellyfin et X-Ray). Une demande passe
//   devant l'avance ; l'avance en attente est plafonnée (`PREFETCH_QUEUE_MAX`), la plus ancienne cède.
// - **Préparer d'avance** : chaque segment allégé demandé fait préparer les `PREFETCH_AHEAD` suivants du même échelon —
//   Safari, une fois passé à l'échelon, les demandera en suivant —, et la page qui voit sa connexion faiblir fait
//   préparer l'échelon adapté à partir de sa position (`prepare`), avant que Safari ne bascule : quand il le fait, les
//   segments sont là.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "@/lib/config";
import { DATA_DIR } from "@/lib/dataDir";
import { identityKey, LumenError, type LumenIndex, type LumenLightRung } from "../format";
import { originTimes } from "./bitstream";
import { detectLightEncoder, encodeArgs, EncodeError, encodedFramesMs, runEncoder, type LightEncoderDetection } from "./encoder";
import { lightInit, lightSegment } from "./segment";

/** Combien de segments suivants préparer derrière un segment allégé demandé. */
export const PREFETCH_AHEAD = 3;
/** L'avance en attente au plus : au-delà, la plus ancienne cède (une lecture qui a sauté ailleurs). */
export const PREFETCH_QUEUE_MAX = 8;
/** Un encodage plus long est tué : 10 s de film tiennent en ~4,4 s (mesure du 17/11/2026), un segment de 30 s en ~13. */
const ENCODE_TIMEOUT_MS = 60_000;
/** Le balayage du disque, au plus une fois par tant. */
const SWEEP_EVERY_MS = 10 * 60_000;

const STATE = Symbol.for("cine-app.lumenServer.light");

/** Ce qu'il faut pour produire un segment allégé : le fichier, l'index (vue comprise) et le segment d'origine. */
export interface LightRequest {
  index: LumenIndex;
  rung: LumenLightRung;
  n: number;
  /** Les octets du segment vidéo d'origine `n` (le chemin ordinaire de `lumenSegment`). */
  origin: (n: number) => Promise<Uint8Array>;
}

export interface LightResult {
  bytes: Uint8Array;
  from: "ram" | "disk" | "built";
  encodeMs: number;
  waitMs: number;
}

interface Job {
  key: string;
  priority: 0 | 1;
  run: () => Promise<void>;
  /** Une avance qui cède sa place : ceux qui l'attendaient reçoivent « occupé », jamais une attente sans fin. */
  drop: () => void;
  enqueuedAt: number;
}

interface LightState {
  ram: Map<string, Uint8Array>;
  ramBytes: number;
  pending: Map<string, Promise<LightResult>>;
  queue: Job[];
  running: number;
  lastSweep: number;
  /** Compteurs du processus (Configuration, tests). */
  stats: { built: number; ram: number; disk: number; failed: number; prefetched: number; dropped: number; encodeMs: number };
}

function state(): LightState {
  const g = globalThis as unknown as Record<symbol, LightState | undefined>;
  return (g[STATE] ??= { ram: new Map(), ramBytes: 0, pending: new Map(), queue: [], running: 0, lastSweep: 0, stats: { built: 0, ram: 0, disk: 0, failed: 0, prefetched: 0, dropped: 0, encodeMs: 0 } });
}

export function lightStats(): LightState["stats"] & { ramBytes: number; queued: number; running: number } {
  const s = state();
  return { ...s.stats, ramBytes: s.ramBytes, queued: s.queue.length, running: s.running };
}

/** Le dossier du cache disque. */
function cacheDir(): string {
  return config.lumen.lightCacheDir || join(DATA_DIR, "lumen-light");
}

/** Le fichier d'un segment ou d'une init : par fichier (empreinte de son identité), par échelon (`cid`). */
function relPath(index: LumenIndex, rung: LumenLightRung, name: string): string {
  const file = createHash("sha1").update(identityKey(index.identity)).digest("hex").slice(0, 16);
  return join(file, `l${rung.rung}x${rung.cid}`, name);
}

function keyOf(index: LumenIndex, rung: LumenLightRung, name: string): string {
  return relPath(index, rung, name);
}

function remember(key: string, bytes: Uint8Array): void {
  const s = state();
  const old = s.ram.get(key);
  if (old) {
    s.ram.delete(key);
    s.ramBytes -= old.length;
  }
  s.ram.set(key, bytes);
  s.ramBytes += bytes.length;
  const cap = config.lumen.lightRamMb * 1024 * 1024;
  while (s.ramBytes > cap && s.ram.size > 1) {
    const [oldest, value] = s.ram.entries().next().value as [string, Uint8Array];
    s.ram.delete(oldest);
    s.ramBytes -= value.length;
  }
}

function fromRam(key: string): Uint8Array | null {
  const s = state();
  const bytes = s.ram.get(key);
  if (!bytes) return null;
  // Le plus récemment lu en dernier : l'éviction prend le plus ancien.
  s.ram.delete(key);
  s.ram.set(key, bytes);
  return bytes;
}

async function fromDisk(rel: string): Promise<Uint8Array | null> {
  if (config.lumen.lightCacheGb <= 0) return null;
  const path = join(cacheDir(), rel);
  try {
    const bytes = new Uint8Array(await readFile(path));
    const now = new Date();
    void utimes(path, now, now).catch(() => {});
    return bytes;
  } catch {
    return null;
  }
}

async function toDisk(rel: string, bytes: Uint8Array): Promise<void> {
  if (config.lumen.lightCacheGb <= 0) return;
  const path = join(cacheDir(), rel);
  try {
    await mkdir(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  } catch {
    // Disque plein ou interdit : le segment reste servi de la mémoire, rien d'autre ne dépend du disque.
  }
  void sweep();
}

/** L'éviction du disque : au-delà du plafond, le moins récemment lu part d'abord. */
async function sweep(force = false): Promise<void> {
  const s = state();
  const now = Date.now();
  if (!force && now - s.lastSweep < SWEEP_EVERY_MS) return;
  s.lastSweep = now;
  const cap = config.lumen.lightCacheGb * 1024 ** 3;
  const files: { path: string; size: number; at: number }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (depth < 2) await walk(path, depth + 1);
      else {
        try {
          const st = await stat(path);
          if (st.isFile()) files.push({ path, size: st.size, at: Math.max(st.atimeMs, st.mtimeMs) });
        } catch {
          // Parti entre-temps.
        }
      }
    }
  };
  await walk(cacheDir(), 0);
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= cap) return;
  files.sort((a, b) => a.at - b.at);
  for (const f of files) {
    if (total <= cap * 0.9) break;
    await unlink(f.path).catch(() => {});
    total -= f.size;
  }
}

/** La file des encodages : une demande devant l'avance ; l'avance bornée. */
function enqueue(job: Job): void {
  const s = state();
  if (job.priority === 1) {
    const waiting = s.queue.filter((j) => j.priority === 1);
    if (waiting.length >= PREFETCH_QUEUE_MAX) {
      const oldest = waiting[0];
      s.queue.splice(s.queue.indexOf(oldest), 1);
      s.stats.dropped += 1;
      s.pending.delete(oldest.key);
      oldest.drop();
    }
  }
  s.queue.push(job);
  s.queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
  pump();
}

function pump(): void {
  const s = state();
  while (s.running < config.lumen.lightMaxJobs && s.queue.length > 0) {
    const job = s.queue.shift()!;
    s.running += 1;
    void job.run().finally(() => {
      s.running -= 1;
      pump();
    });
  }
}

/** L'encodeur, s'il est là ; sinon une erreur « occupé » (503), jamais 404. */
async function encoder(): Promise<Extract<LightEncoderDetection, { available: true }>> {
  const detection = await detectLightEncoder();
  if (!detection.available) throw new LumenError("occupe", `Version allégée indisponible : ${detection.reason}`);
  return detection;
}

async function produce(req: LightRequest, key: string, priority: 0 | 1): Promise<LightResult> {
  const s = state();
  const ram = fromRam(key);
  if (ram) {
    s.stats.ram += 1;
    return { bytes: ram, from: "ram", encodeMs: 0, waitMs: 0 };
  }
  const disk = await fromDisk(key);
  if (disk) {
    s.stats.disk += 1;
    remember(key, disk);
    return { bytes: disk, from: "disk", encodeMs: 0, waitMs: 0 };
  }
  const enqueuedAt = performance.now();
  return new Promise<LightResult>((resolve, reject) => {
    enqueue({
      key,
      priority,
      enqueuedAt,
      drop: () => reject(new LumenError("occupe", "Avance allégée abandonnée (file pleine).")),
      run: async () => {
        const waitMs = performance.now() - enqueuedAt;
        try {
          const { path } = await encoder();
          const origin = originTimes(await req.origin(req.n));
          const fromUs = origin.presentations[0] - req.index.delayUs;
          const run = await runEncoder(path, encodeArgs(req.index.identity.path, req.rung, fromUs, origin.presentations.length), {
            timeoutMs: ENCODE_TIMEOUT_MS,
            niceness: priority === 0 ? 5 : 10,
          });
          // Chaque image donnée à l'encodeur est celle de l'origine, à la milliseconde (le temps du Matroska) : une image
          // répétée, sautée ou décalée se voit ici, jamais dans le film (banc du 17/11/2026 : sans `-fps_mode passthrough`,
          // la première image répétée 96 fois). Sans relevé (un ffmpeg qui ne l'écrit pas), le compte d'images suffit.
          const received = encodedFramesMs(run.stderr);
          const expected = origin.presentations.map((p) => Math.floor((p - req.index.delayUs) / 1000));
          if (received.length > 0) {
            // ±1 ms : la base de temps de l'encodeur arrondit autrement que le conteneur ; une image d'écart fait 40 ms.
            const off = received.findIndex((ms, i) => Math.abs(ms - expected[i]) > 1);
            if (received.length !== expected.length || off >= 0) {
              throw new LumenError(
                "segment-vide",
                `Segment allégé ${req.n} : ${received.length} images reçues pour ${expected.length}${off >= 0 ? `, la ${off + 1}e à ${received[off]} ms au lieu de ${expected[off]}` : ""}.`
              );
            }
          }
          const built = lightSegment(run.stdout, origin, req.n, req.index.delayUs);
          s.stats.built += 1;
          s.stats.encodeMs += run.ms;
          remember(key, built.bytes);
          void toDisk(key, built.bytes);
          resolve({ bytes: built.bytes, from: "built", encodeMs: run.ms, waitMs });
        } catch (error) {
          s.stats.failed += 1;
          reject(error instanceof EncodeError ? new LumenError("occupe", error.message) : error);
        }
      },
    });
  });
}

/**
 * Le segment allégé `n` de l'échelon : de la mémoire, du disque, ou encodé (une demande, devant l'avance) ; puis les
 * suivants préparés d'avance. Lève `LumenError` : `occupe` (encodeur absent ou en échec — 503), `segment-vide`.
 */
export async function lightSegmentFor(req: LightRequest): Promise<LightResult> {
  const key = keyOf(req.index, req.rung, `${req.n}.m4s`);
  const s = state();
  let running = s.pending.get(key);
  if (!running) {
    running = produce(req, key, 0).finally(() => s.pending.delete(key));
    s.pending.set(key, running);
  } else {
    // Déjà en avance : demandé maintenant, il passe devant le reste de l'avance (et ne peut plus céder sa place).
    const queued = s.queue.find((j) => j.key === key);
    if (queued && queued.priority === 1) {
      queued.priority = 0;
      s.queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
    }
  }
  const result = await running;
  prefetch(req, req.n + 1, PREFETCH_AHEAD);
  return result;
}

/**
 * Préparer `count` segments de l'échelon à partir de `from` (l'avance d'un segment demandé, ou la page qui voit sa
 * connexion faiblir) : sans attendre, derrière les demandes. Ce qui est déjà gardé ou en route ne coûte rien.
 */
export function prefetch(req: Omit<LightRequest, "n">, from: number, count: number): void {
  const s = state();
  for (let n = from; n < Math.min(req.index.segments.length, from + count); n++) {
    const key = keyOf(req.index, req.rung, `${n}.m4s`);
    if (s.pending.has(key) || s.ram.has(key)) continue;
    s.stats.prefetched += 1;
    const running = produce({ ...req, n }, key, 1).finally(() => s.pending.delete(key));
    running.catch(() => {});
    s.pending.set(key, running);
  }
}

/**
 * L'init de l'échelon : une image encodée au début du film (ses jeux de paramètres pour le `hvcC`), gardée comme un
 * segment. Coûte un encodage d'une image (~0,3 à 1 s) la première fois par fichier et par échelon.
 */
export async function lightInitFor(index: LumenIndex, rung: LumenLightRung, origin: (n: number) => Promise<Uint8Array>): Promise<Uint8Array> {
  const key = keyOf(index, rung, "init.mp4");
  const ram = fromRam(key);
  if (ram) return ram;
  const disk = await fromDisk(key);
  if (disk) {
    remember(key, disk);
    return disk;
  }
  const s = state();
  let running = s.pending.get(key) as Promise<LightResult> | undefined;
  if (!running) {
    running = (async (): Promise<LightResult> => {
      const { path } = await encoder();
      const times = originTimes(await origin(0));
      const fromUs = times.presentations[0] - index.delayUs;
      const run = await runEncoder(path, encodeArgs(index.identity.path, rung, fromUs, 1), { timeoutMs: ENCODE_TIMEOUT_MS, niceness: 5 });
      const bytes = lightInit(run.stdout, rung, index);
      remember(key, bytes);
      void toDisk(key, bytes);
      return { bytes, from: "built", encodeMs: run.ms, waitMs: 0 };
    })().finally(() => s.pending.delete(key));
    s.pending.set(key, running);
  }
  return (await running).bytes;
}

export const __testing = {
  reset(): void {
    const g = globalThis as unknown as Record<symbol, LightState | undefined>;
    g[STATE] = undefined;
  },
  state,
  sweep,
};
