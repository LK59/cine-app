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
let usage: number | null;

beforeEach(async () => {
  root = new FakeDir();
  setResumeStoreForTests(async () => root);
  clock = 1_000_000;
  lead = 30;
  fetched = [];
  usage = 50e6;
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
  const deps: ReserveDeps = { fetch: fakeFetch(), now: () => clock, budget: async () => budget, hidden: () => hidden, usage: async () => usage };
  const reserve = DiskReserve.start(
    "louis",
    IDENTITY,
    { source: source as unknown as HttpByteSource, file: parsed, video: video as unknown as HTMLVideoElement, lead: () => lead, delay: () => 0 },
    report,
    deps
  )!;
  return { reserve, source, video, report };
}

/** Des tours de boucle, l'horloge avançant de `stepMs` entre chacun — la cadence en dépend. */
async function pump(reserve: DiskReserve, turns: number, stepMs = 10_000) {
  for (let i = 0; i < turns; i++) {
    await reserve.settleForTests();
    clock += stepMs;
  }
}

const fetchedChunks = () => fetched.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));

describe("le tampon d'avance sur l'appareil", () => {
  it("prend de l'avance au-delà de ce que le lecteur lit déjà, par plages, et le lecteur la voit", async () => {
    const { reserve, source } = start();
    await pump(reserve, 3);
    expect(fetched.length).toBeGreaterThanOrEqual(2);
    expect(fetched.every(([a, b]) => b - a + 1 <= RANGE_CHUNKS)).toBe(true);
    expect(PARALLEL).toBeGreaterThanOrEqual(1);
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
    await pump(reserve, 5);
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
    await pump(reserve, 8);
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
    await pump(reserve, 4);
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
    await pump(reserve, 3, 10_000);
    clock += 1_000;
    lead = 2;
    await reserve.settleForTests();
    await reserve.stop("fin de lecture");
    const events = report.mock.calls.map(([fields]) => fields.event);
    expect(events).toEqual(["départ", "point", "arrêt"]);
    const point = report.mock.calls[1][0];
    expect(point).toMatchObject({ idle: `avance du navigateur sous ${MIN_LEAD_SECONDS} s`, limitMB: 500 });
    expect(point.windowMB).toBeGreaterThan(0);
    expect(point.aheadMB).toBeGreaterThan(0);
    expect(point.aheadS).toBeGreaterThan(10);
    expect(report.mock.calls[2][0]).toMatchObject({ why: "fin de lecture", netMB: fetchedChunks().length, memMB: 7 });
  });

  it("ne télécharge pas plus vite que quatre fois le débit du film", async () => {
    // Le fichier fait 400 ko/s, soit 3,2 Mb/s : 12,8 Mb/s permis, 1,6 Mo par seconde.
    const { reserve } = start();
    await pump(reserve, 30, 1_000);
    await reserve.stop();
    const bytes = fetchedChunks().length * CHUNK_SIZE;
    // Trente secondes à 1,6 Mo/s, plus la première plage partie d'emblée.
    expect(bytes).toBeLessThanOrEqual(30 * 1.6e6 + RANGE_CHUNKS * CHUNK_SIZE);
    expect(bytes).toBeGreaterThan(20 * 1.6e6);
  });

  it("jamais plus de 500 Mio devant la tête, quelle que soit la réserve commune", async () => {
    const capped: StorageBudget = { ...NORMAL_BUDGET, titleChunks: 6 };
    const { reserve } = start(fakeSource(), undefined, capped);
    await pump(reserve, 6);
    await reserve.stop();
    expect(fetchedChunks().length).toBeLessThanOrEqual(6);
    expect(NORMAL_BUDGET.titleChunks).toBe(500);
  });

  it("jamais plus de cinq minutes de film devant la tête", async () => {
    // Dix minutes à 100 ko/s : les cinq premières tiennent dans ~29 Mio.
    const LONG = bigMatroska(600, 100_000);
    const longFile = await openMediaFile(new MemoryByteSource(LONG));
    const deps: ReserveDeps = {
      fetch: (async (_url: string, init?: RequestInit) => {
        const [, from, to] = /bytes=(\d+)-(\d+)/.exec((init?.headers as Record<string, string>).Range)!.map(Number);
        fetched.push([Math.floor(from / CHUNK_SIZE), Math.floor(to / CHUNK_SIZE)]);
        return { status: 206, headers: { get: (n: string) => (n === "Content-Range" ? `bytes ${from}-${to}/${LONG.length}` : null) }, arrayBuffer: async () => LONG.slice(from, to + 1).buffer } as unknown as Response;
      }) as typeof fetch,
      now: () => clock,
      budget: async () => NORMAL_BUDGET,
      hidden: () => false,
      usage: async () => usage,
    };
    const source = { ...fakeSource(), size: LONG.length };
    const report = vi.fn();
    const reserve = DiskReserve.start(
      "louis",
      { itemId: "long", streamUrl: "/long", size: LONG.length, fileVersion: "e" },
      { source: source as unknown as HttpByteSource, file: longFile, video: { currentTime: 0, seeking: false } as unknown as HTMLVideoElement, lead: () => 30, delay: () => 0 },
      report,
      deps
    )!;
    await pump(reserve, 40);
    await reserve.stop();
    const fiveMinutes = Math.floor(longFile.cues.filter((c) => c.timeUs <= 300e6).at(-1)!.clusterOffset / CHUNK_SIZE);
    expect(Math.max(...fetchedChunks())).toBeLessThanOrEqual(fiveMinutes);
    expect(Math.max(...fetchedChunks())).toBeGreaterThanOrEqual(fiveMinutes - RANGE_CHUNKS);
  });

  it("s'arrête et le dit quand le navigateur mesure plus que le plafond", async () => {
    const report = vi.fn();
    const { reserve } = start(fakeSource(), undefined, NORMAL_BUDGET, report);
    await pump(reserve, 1);
    usage = 7e9;
    clock += 16_000;
    await pump(reserve, 2);
    const before = fetched.length;
    await pump(reserve, 3);
    expect(fetched.length).toBe(before);
    // Déjà arrêté par le garde-fou : un second arrêt attend la fin du premier.
    await reserve.stop();
    const errors = report.mock.calls.map(([f]) => f).filter((f) => f.event === "erreur");
    expect(errors[0].message).toMatch(/au-delà du plafond/);
    expect(report.mock.calls.map(([f]) => f.event)).toContain("arrêt");
  });

  it("à l'arrêt, mesure depuis la dernière position lue — l'élément est déjà vidé", async () => {
    const report = vi.fn();
    const video = { currentTime: 30, seeking: false };
    const source = fakeSource({ demandedChunk: 12 });
    for (let index = 0; index <= 20; index++) source.memory.set(index, FILE.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
    const { reserve } = start(source, video, NORMAL_BUDGET, report);
    await pump(reserve, 2);
    video.currentTime = 0;
    await reserve.stop();
    const stopLine = report.mock.calls.map(([f]) => f).find((f) => f.event === "arrêt");
    expect(stopLine.aheadMB).toBeGreaterThan(3);
    // Et ce qui est derrière la position d'arrêt, au-delà de la petite marge, est effacé.
    const manifest = await readResumeManifest("louis", "x");
    const head = Math.floor(parsed.cues.filter((c) => c.timeUs <= 30e6).at(-1)!.clusterOffset / CHUNK_SIZE);
    expect(manifest!.chunks.filter((i) => i > 0 && i < head - 8)).toEqual([]);
  });

  it("un fichier sans version ou d'une autre taille : pas de tampon du tout", () => {
    const deps: ReserveDeps = { fetch: fakeFetch(), now: () => clock, budget: async () => NORMAL_BUDGET, hidden: () => false, usage: async () => usage };
    const ctx = { source: fakeSource() as unknown as HttpByteSource, file: parsed, video: {} as HTMLVideoElement, lead: () => 30, delay: () => 0 };
    expect(DiskReserve.start("louis", { ...IDENTITY, fileVersion: null }, ctx, vi.fn(), deps)).toBeNull();
    expect(DiskReserve.start("louis", { ...IDENTITY, size: FILE.length + 1 }, ctx, vi.fn(), deps)).toBeNull();
    expect(LAST).toBeGreaterThan(40);
  });
});
