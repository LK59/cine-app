import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CHUNK_SIZE, MemoryByteSource, type DiskChunks, type HttpByteSource } from "@/lib/webcodecs/byteSource";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { NORMAL_BUDGET, type StorageBudget } from "@/lib/resumeCache/budget";
import { DiskReserve, MIN_LEAD_SECONDS, PARALLEL, RANGE_CHUNKS, type ReserveDeps } from "@/lib/resumeCache/diskReserve";
import { readResumeIndex, readResumeManifest, saveResumeEntry, setResumeStoreForTests, type ResumeManifest } from "@/lib/resumeCache/store";
import { bigMatroska } from "./helpers/bigMatroska";
import { FakeDir } from "./helpers/fakeOpfs";

/**
 * Le tampon d'avance sur l'appareil (28/09/2026) : ce qu'il prend, quand il s'en abstient — le
 * lecteur passe toujours avant —, ce qu'il garde et ce qu'il efface, et ce qu'il en dit au journal.
 */

// Deux minutes, 400 ko par seconde : ~46 Mio, une image clé par seconde.
const FILE = bigMatroska(120, 400_000);
const URL = "/api/jellyfin/stream/x/stream.mkv?static=true&mediaSourceId=x";
const IDENTITY = { itemId: "x", streamUrl: URL, size: FILE.length, fileVersion: "etag-1" };
const LAST = Math.floor((FILE.length - 1) / CHUNK_SIZE);

let root: FakeDir;
let clock: number;
let lead: number;
let fetched: [number, number][];
let parsed: Awaited<ReturnType<typeof openMediaFile>>;

beforeEach(async () => {
  root = new FakeDir();
  setResumeStoreForTests(async () => root);
  clock = 1_000_000;
  lead = 30;
  fetched = [];
  parsed = await openMediaFile(new MemoryByteSource(FILE));
});
afterEach(() => setResumeStoreForTests(null));

function fakeFetch(): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>).Range;
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!.map(Number);
    fetched.push([Math.floor(from / CHUNK_SIZE), Math.floor(to / CHUNK_SIZE)]);
    return {
      status: 206,
      headers: { get: (name: string) => (name === "Content-Range" ? `bytes ${from}-${to}/${FILE.length}` : null) },
      arrayBuffer: async () => FILE.slice(from, to + 1).buffer,
    } as unknown as Response;
  }) as typeof fetch;
}

function fakeSource(over: Record<string, unknown> = {}) {
  let disk: DiskChunks | null = null;
  const memory = new Map<number, Uint8Array>();
  const source = {
    size: FILE.length,
    lastModified: null,
    get diskLayer() {
      return disk;
    },
    attachDisk(layer: DiskChunks) {
      disk ??= layer;
    },
    readsWaiting: 0,
    demandedChunk: 0,
    seekFocused: false,
    memoryChunk: (index: number) => memory.get(index) ?? null,
    deviceBytes: 0,
    networkBytes: 0,
    memory,
    ...over,
  };
  return source;
}

function start(source = fakeSource(), video = { currentTime: 0, seeking: false }, budget: StorageBudget = NORMAL_BUDGET, report = vi.fn(), hidden = false) {
  const deps: ReserveDeps = { fetch: fakeFetch(), now: () => clock, budget: async () => budget, hidden: () => hidden };
  const reserve = DiskReserve.start(
    "louis",
    IDENTITY,
    { source: source as unknown as HttpByteSource, file: parsed, video: video as unknown as HTMLVideoElement, lead: () => lead, delay: () => 0 },
    report,
    deps
  )!;
  return { reserve, source, video, report };
}

const fetchedChunks = () => fetched.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));

describe("le tampon d'avance sur l'appareil", () => {
  it("prend de l'avance au-delà de ce que le lecteur lit déjà, par plages, et le lecteur la voit", async () => {
    const { reserve, source } = start();
    await reserve.settleForTests();
    expect(fetched.length).toBe(PARALLEL);
    expect(fetched.every(([a, b]) => b - a + 1 <= RANGE_CHUNKS)).toBe(true);
    // Au-delà de la lecture en avance du lecteur (six morceaux après le dernier demandé).
    expect(Math.min(...fetchedChunks())).toBeGreaterThan(source.demandedChunk + 6);
    expect(source.diskLayer?.has(fetchedChunks()[0])).toBe(true);
    await reserve.stop();
    const manifest = await readResumeManifest("louis", "x");
    expect(manifest!.chunks).toEqual(expect.arrayContaining(fetchedChunks()));
    expect(manifest!.playedAt).toBe(clock);
    expect(manifest!.coveredTo).toBeLessThan(0);
  });

  it("laisse le lien au lecteur : avance courte, lecture en attente, saut, page cachée", async () => {
    lead = MIN_LEAD_SECONDS - 1;
    const short = start();
    await short.reserve.settleForTests();
    await short.reserve.stop();
    lead = 30;
    const waiting = start(fakeSource({ readsWaiting: 1 }));
    await waiting.reserve.settleForTests();
    await waiting.reserve.stop();
    const seeking = start(fakeSource(), { currentTime: 0, seeking: true });
    await seeking.reserve.settleForTests();
    await seeking.reserve.stop();
    const hidden = start(fakeSource(), undefined, NORMAL_BUDGET, vi.fn(), true);
    await hidden.reserve.settleForTests();
    await hidden.reserve.stop();
    expect(fetched).toEqual([]);
  });

  it("écrit d'abord ce que le lecteur tient en mémoire, sans le redemander au réseau", async () => {
    const source = fakeSource({ demandedChunk: 3 });
    for (let index = 0; index <= 8; index++) source.memory.set(index, FILE.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
    const { reserve } = start(source);
    await reserve.settleForTests();
    await reserve.stop();
    const manifest = await readResumeManifest("louis", "x");
    for (let index = 0; index <= 8; index++) expect(manifest!.chunks).toContain(index);
    expect(fetchedChunks().some((index) => index <= 8)).toBe(false);
    expect(reserve.facts().memoryChunks).toBe(9);
  });

  it("ne garde jamais devant la tête plus que ce qui lui est permis", async () => {
    const small: StorageBudget = { ...NORMAL_BUDGET, poolChunks: 10 };
    const { reserve } = start(fakeSource(), undefined, small);
    for (let i = 0; i < 5; i++) await reserve.settleForTests();
    await reserve.stop();
    expect((await readResumeManifest("louis", "x"))!.chunks.length).toBeLessThanOrEqual(10);
    expect(fetchedChunks().length).toBeLessThanOrEqual(10);
  });

  it("emprunte aux autres titres actifs, leur plus lointain d'abord, jamais sous leur plancher", async () => {
    const pool: StorageBudget = { ...NORMAL_BUDGET, poolChunks: 100, floorChunks: 20 };
    for (const [itemId, playedAt] of [["a", clock - 1000], ["b", clock - 2000]] as const) {
      const chunks = Array.from({ length: 46 }, (_, i) => i);
      const manifest: ResumeManifest = {
        v: 1,
        itemId,
        streamUrl: `/s/${itemId}`,
        size: 46 * CHUNK_SIZE,
        fileVersion: "e",
        lastModified: null,
        savedAt: clock,
        startSeconds: 0,
        coveredFrom: 0,
        coveredTo: 100,
        chunks,
        bytes: 46 * CHUNK_SIZE,
        partial: false,
        headerChunks: [0, 45],
        playedAt,
      };
      await saveResumeEntry("louis", manifest, new Map(chunks.map((i) => [i, new Uint8Array(1)])));
    }
    // Les deux autres gardent 44 chacun : il ne reste que 12 de libre, 60 en les ramenant à 20.
    const { reserve } = start(fakeSource(), undefined, pool);
    for (let i = 0; i < 6; i++) await reserve.settleForTests();
    await reserve.stop();
    const index = await readResumeIndex("louis");
    expect(index.b.reserveChunks).toBeLessThan(44);
    expect(index.b.reserveChunks).toBeGreaterThanOrEqual(20);
    expect(index.a.reserveChunks).toBeGreaterThanOrEqual(20);
    // Le moins récemment lu cède d'abord, et son plus lointain part — l'en-tête reste.
    const b = await readResumeManifest("louis", "b");
    expect(b!.chunks).toContain(45);
    expect(b!.chunks).toContain(1);
    expect(b!.chunks).not.toContain(44);
    expect(fetchedChunks().length).toBeGreaterThan(12);
  });

  it("efface derrière la tête au-delà de sa marge, jamais le début du fichier", async () => {
    const behind: StorageBudget = { ...NORMAL_BUDGET, behindChunks: 2 };
    const chunks = Array.from({ length: 30 }, (_, i) => i);
    await saveResumeEntry(
      "louis",
      { v: 1, ...IDENTITY, lastModified: null, savedAt: clock, startSeconds: -1, coveredFrom: -1, coveredTo: -1, chunks, bytes: 30 * CHUNK_SIZE, partial: false },
      new Map(chunks.map((i) => [i, FILE.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)]))
    );
    const video = { currentTime: 60, seeking: false };
    const { reserve } = start(fakeSource({ demandedChunk: 60 }), video, behind);
    await reserve.settleForTests();
    clock += 16_000;
    await reserve.settleForTests();
    await reserve.stop();
    const manifest = await readResumeManifest("louis", "x");
    const head = Math.floor(parsed.cues.filter((c) => c.timeUs <= 60e6).at(-1)!.clusterOffset / CHUNK_SIZE);
    expect(manifest!.chunks).toContain(0);
    expect(manifest!.chunks.filter((i) => i > 0 && i < head - 2)).toEqual([]);
    expect(manifest!.chunks.filter((i) => i >= head - 2 && i < 30).length).toBeGreaterThan(0);
  });

  it("après un retour en arrière, libère le plus lointain pour combler le trou devant la tête", async () => {
    const small: StorageBudget = { ...NORMAL_BUDGET, poolChunks: 12 };
    // Une réserve laissée loin devant (morceaux 30 à 41), la tête revenue au début.
    const chunks = Array.from({ length: 12 }, (_, i) => 30 + i);
    await saveResumeEntry(
      "louis",
      { v: 1, ...IDENTITY, lastModified: null, savedAt: clock, startSeconds: -1, coveredFrom: -1, coveredTo: -1, chunks, bytes: 12 * CHUNK_SIZE, partial: false },
      new Map(chunks.map((i) => [i, FILE.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)]))
    );
    const { reserve } = start(fakeSource(), undefined, small);
    for (let i = 0; i < 4; i++) await reserve.settleForTests();
    await reserve.stop();
    const manifest = await readResumeManifest("louis", "x");
    expect(fetchedChunks().length).toBeGreaterThan(0);
    expect(Math.min(...fetchedChunks())).toBeLessThan(30);
    // Le plus lointain est parti d'abord ; la limite tient.
    expect(manifest!.chunks).not.toContain(41);
    expect(manifest!.chunks.length).toBeLessThanOrEqual(12);
  });

  it("s'arrête quand le serveur annonce un autre fichier, et n'écrit plus rien", async () => {
    const { reserve, source } = start();
    await reserve.settleForTests();
    const before = fetched.length;
    source.diskLayer!.verify(FILE.length + 1, null);
    await reserve.settleForTests();
    expect(fetched.length).toBe(before);
  });

  it("raconte la lecture au journal : départ, point toutes les trente secondes, arrêt", async () => {
    const report = vi.fn();
    // Le lecteur tient sa lecture en avance en mémoire, entre la tête et ce que le tampon télécharge.
    const source = fakeSource();
    for (let index = 0; index <= 6; index++) source.memory.set(index, FILE.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
    const { reserve } = start(source, undefined, NORMAL_BUDGET, report);
    await reserve.settleForTests();
    clock += 31_000;
    lead = 2;
    await reserve.settleForTests();
    await reserve.stop("fin de lecture");
    const events = report.mock.calls.map(([fields]) => fields.event);
    expect(events).toEqual(["départ", "point", "arrêt"]);
    const point = report.mock.calls[1][0];
    expect(point).toMatchObject({ idle: `avance du navigateur sous ${MIN_LEAD_SECONDS} s`, limitMB: 1024 });
    expect(point.windowMB).toBeGreaterThan(0);
    expect(point.aheadMB).toBeGreaterThan(0);
    expect(point.aheadS).toBeGreaterThan(10);
    expect(report.mock.calls[2][0]).toMatchObject({ why: "fin de lecture", netMB: fetchedChunks().length, memMB: 7 });
  });

  it("un fichier sans version ou d'une autre taille : pas de tampon du tout", () => {
    const deps: ReserveDeps = { fetch: fakeFetch(), now: () => clock, budget: async () => NORMAL_BUDGET, hidden: () => false };
    const ctx = { source: fakeSource() as unknown as HttpByteSource, file: parsed, video: {} as HTMLVideoElement, lead: () => 30, delay: () => 0 };
    expect(DiskReserve.start("louis", { ...IDENTITY, fileVersion: null }, ctx, vi.fn(), deps)).toBeNull();
    expect(DiskReserve.start("louis", { ...IDENTITY, size: FILE.length + 1 }, ctx, vi.fn(), deps)).toBeNull();
    expect(LAST).toBeGreaterThan(40);
  });
});
