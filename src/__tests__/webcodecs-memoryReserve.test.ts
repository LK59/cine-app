import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CHUNK_SIZE, HttpByteSource, MemoryByteSource, forgetHandover } from "@/lib/webcodecs/byteSource";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import {
  MAX_AHEAD_SECONDS,
  MIN_LEAD_SECONDS,
  MemoryReserve,
  RANGE_CHUNKS,
  reserveBudgetBytes,
  reserveSpeedBps,
  type ReserveDeps,
} from "@/lib/webcodecs/memoryReserve";
import { bigMatroska } from "./helpers/bigMatroska";

/**
 * La réserve d'avance en mémoire (28/09/2026) : ce qu'elle prend, quand elle s'en abstient — le
 * lecteur passe toujours avant —, qu'elle ne touche jamais à l'appareil, et ce qu'elle en dit au
 * journal. Elle remplace une réserve écrite dans l'OPFS, retirée pour la santé de la mémoire flash.
 */

// Deux minutes, 400 ko par seconde (3,2 Mb/s) : ~46 Mio, une image clé par seconde.
const FILE = bigMatroska(120, 400_000);
const URL = "/api/jellyfin/stream/x/stream.mkv?static=true&mediaSourceId=x";

let clock: number;
let lead: number;
let hidden: boolean;
let fetched: number[];
let playerFetched: number[];
let parsed: Awaited<ReturnType<typeof openMediaFile>>;

function respond(file: Uint8Array, log: number[]) {
  return async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>).Range;
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!.map(Number);
    for (let i = Math.floor(from / CHUNK_SIZE); i <= Math.floor(to / CHUNK_SIZE); i++) log.push(i);
    return {
      status: 206,
      headers: { get: (name: string) => (name === "Content-Range" ? `bytes ${from}-${to}/${file.length}` : null) },
      arrayBuffer: async () => file.slice(from, to + 1).buffer,
    } as unknown as Response;
  };
}

beforeEach(async () => {
  forgetHandover();
  clock = 1_000_000;
  lead = 30;
  hidden = false;
  fetched = [];
  playerFetched = [];
  parsed = await openMediaFile(new MemoryByteSource(FILE));
  vi.stubGlobal("fetch", respond(FILE, playerFetched));
});
afterEach(() => vi.unstubAllGlobals());

function deps(budgetBytes = 150e6, file = FILE): ReserveDeps {
  return { fetch: respond(file, fetched) as typeof fetch, now: () => clock, hidden: () => hidden, budgetBytes: () => budgetBytes };
}

async function start(video = { currentTime: 0, seeking: false }, budgetBytes?: number, report = vi.fn()) {
  const source = (await HttpByteSource.open(URL, FILE.length)).withoutReadahead();
  const reserve = MemoryReserve.start(
    { source, file: parsed, video: video as unknown as HTMLVideoElement, lead: () => lead, delay: () => 0 },
    report,
    deps(budgetBytes)
  );
  return { reserve, source, video, report };
}

/** Des tours de boucle, l'horloge avançant de `stepMs` entre chacun — la cadence en dépend. */
async function pump(reserve: MemoryReserve, turns: number, stepMs = 10_000) {
  for (let i = 0; i < turns; i++) {
    await reserve.settleForTests();
    clock += stepMs;
  }
}

describe("la réserve d'avance en mémoire", () => {
  it("prend de l'avance au-delà de la lecture en avance du lecteur, qui la lit sans réseau", async () => {
    const { reserve, source } = await start();
    await pump(reserve, 4);
    expect(fetched.length).toBeGreaterThan(0);
    // Au-delà de la lecture en avance du lecteur (les six morceaux après le dernier demandé).
    expect(Math.min(...fetched)).toBeGreaterThanOrEqual(source.demandedChunk + 7);
    const first = Math.min(...fetched);
    expect(source.reserveIndices).toContain(first);
    // Le lecteur y lit sans une requête : le morceau passe de la réserve au cache.
    playerFetched = [];
    vi.stubGlobal("fetch", respond(FILE, playerFetched));
    const bytes = await source.read(first * CHUNK_SIZE + 10, 100);
    expect(bytes).toEqual(FILE.slice(first * CHUNK_SIZE + 10, first * CHUNK_SIZE + 110));
    expect(playerFetched).toEqual([]);
    expect(source.reserveBytes).toBe(CHUNK_SIZE);
    expect(source.reserveIndices).not.toContain(first);
    reserve.stop();
    source.close(false);
  });

  it("laisse le lien au lecteur : avance courte, saut", async () => {
    lead = MIN_LEAD_SECONDS - 1;
    const short = await start();
    await pump(short.reserve, 3);
    short.reserve.stop();
    lead = 30;
    const seeking = await start({ currentTime: 0, seeking: true });
    await pump(seeking.reserve, 3);
    seeking.reserve.stop();
    expect(fetched).toEqual([]);
  });

  it("se retient tant qu'une lecture du lecteur attend un octet", async () => {
    const { reserve, source } = await start();
    let release: () => void = () => {};
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      await new Promise<void>((resolve) => (release = resolve));
      return respond(FILE, playerFetched)(url, init);
    });
    const pending = source.read(0, 10);
    expect(source.readsWaiting).toBe(1);
    await pump(reserve, 2);
    expect(fetched).toEqual([]);
    release();
    await pending;
    reserve.stop();
  });

  it("rend sa mémoire quand la page passe en arrière-plan — iOS tue d'abord les pages qui en tiennent", async () => {
    const report = vi.fn();
    const { reserve, source } = await start(undefined, undefined, report);
    await pump(reserve, 3);
    expect(source.reserveIndices.length).toBeGreaterThan(0);
    hidden = true;
    await pump(reserve, 1);
    expect(source.reserveIndices).toEqual([]);
    reserve.stop();
    expect(report.mock.calls.at(-1)![0]).toMatchObject({ event: "arrêt", emptied: 1 });
  });

  it("ne dépasse jamais sa part de mémoire", async () => {
    const { reserve, source } = await start(undefined, 4 * CHUNK_SIZE);
    await pump(reserve, 6);
    expect(source.reserveIndices.length).toBeLessThanOrEqual(4);
    reserve.stop();
  });

  it("ne télécharge pas plus vite que 50 Mb/s", async () => {
    // 50 Mb/s : 6,25 Mo par seconde. Quatre secondes, et la première plage partie d'emblée.
    const { reserve } = await start();
    await pump(reserve, 4, 1_000);
    reserve.stop();
    const bytes = fetched.length * CHUNK_SIZE;
    expect(bytes).toBeLessThanOrEqual(4 * 6.25e6 + RANGE_CHUNKS * CHUNK_SIZE);
    expect(reserveSpeedBps()).toBe(50e6);
  });

  it("attend une minute de lecture réelle avant de rien télécharger", async () => {
    // Un quart des séances des autres comptes durent moins d'une minute (28/09/2026).
    let watched = 20;
    const source = (await HttpByteSource.open(URL, FILE.length)).withoutReadahead();
    const report = vi.fn();
    const reserve = MemoryReserve.start(
      { source, file: parsed, video: { currentTime: 0, seeking: false } as unknown as HTMLVideoElement, lead: () => 30, delay: () => 0, watched: () => watched },
      report,
      deps()
    );
    await pump(reserve, 4);
    expect(fetched).toEqual([]);
    watched = 61;
    await pump(reserve, 2);
    expect(fetched.length).toBeGreaterThan(0);
    reserve.stop();
  });

  it("remplit par rafales : pleine, elle se tait jusqu'à redescendre à la moitié", async () => {
    // Pour que la radio dorme entre deux rafales : ce qui coûte, c'est le nombre de réveils.
    const report = vi.fn();
    const video = { currentTime: 0, seeking: false };
    const { reserve, source } = await start(video, 16 * CHUNK_SIZE, report);
    await pump(reserve, 8);
    expect(source.reserveIndices.length).toBe(16);
    const afterFirst = fetched.length;
    // La tête avance un peu : quelques morceaux consommés, moins de la moitié — aucune requête.
    for (const index of source.reserveIndices.slice(0, 4)) await source.read(index * CHUNK_SIZE, 10);
    await pump(reserve, 3);
    expect(fetched.length).toBe(afterFirst);
    // Sous la moitié : une rafale, jusqu'à la pleine capacité.
    for (const index of source.reserveIndices.slice(0, 6)) await source.read(index * CHUNK_SIZE, 10);
    await pump(reserve, 6);
    expect(fetched.length).toBeGreaterThan(afterFirst);
    expect(source.reserveIndices.length).toBe(16);
    reserve.stop();
    expect(report.mock.calls.at(-1)![0]).toMatchObject({ event: "arrêt", bursts: 2 });
  });

  it("jamais plus de cinq minutes de film devant la tête", async () => {
    // Dix minutes à 100 ko/s : les cinq premières tiennent dans ~29 Mio.
    const LONG = bigMatroska(600, 100_000);
    const longFile = await openMediaFile(new MemoryByteSource(LONG));
    vi.stubGlobal("fetch", respond(LONG, playerFetched));
    const source = (await HttpByteSource.open("/long", LONG.length)).withoutReadahead();
    const reserve = MemoryReserve.start(
      { source, file: longFile, video: { currentTime: 0, seeking: false } as unknown as HTMLVideoElement, lead: () => 30, delay: () => 0 },
      vi.fn(),
      deps(150e6, LONG)
    );
    await pump(reserve, 40);
    reserve.stop();
    const fiveMinutes = Math.floor(longFile.cues.filter((c) => c.timeUs <= MAX_AHEAD_SECONDS * 1e6).at(-1)!.clusterOffset / CHUNK_SIZE);
    expect(Math.max(...fetched)).toBeLessThanOrEqual(fiveMinutes);
    expect(Math.max(...fetched)).toBeGreaterThanOrEqual(fiveMinutes - RANGE_CHUNKS);
  });

  it("rend ce que la tête a dépassé", async () => {
    const video = { currentTime: 0, seeking: false };
    const { reserve, source } = await start(video);
    await pump(reserve, 3);
    const before = Math.min(...source.reserveIndices);
    video.currentTime = 60;
    await pump(reserve, 1);
    const head = Math.floor(parsed.cues.filter((c) => c.timeUs <= 60e6).at(-1)!.clusterOffset / CHUNK_SIZE);
    expect(source.reserveIndices.every((i) => i >= head)).toBe(true);
    expect(before).toBeLessThan(head);
    reserve.stop();
  });

  it("raconte la lecture au journal : départ, point toutes les trente secondes, arrêt", async () => {
    const report = vi.fn();
    const { reserve } = await start(undefined, undefined, report);
    await pump(reserve, 3, 10_000);
    clock += 1_000;
    lead = 2;
    await reserve.settleForTests();
    reserve.stop("fin de lecture");
    const events = report.mock.calls.map(([fields]) => fields.event);
    expect(events).toEqual(["départ", "point", "arrêt"]);
    // 150 Mo en morceaux de 1 Mio ; 50 Mb/s au plus.
    expect(report.mock.calls[0][0]).toMatchObject({ allowedMB: 143, speedMbps: 50 });
    const point = report.mock.calls[1][0];
    expect(point).toMatchObject({ idle: `avance du navigateur sous ${MIN_LEAD_SECONDS} s` });
    expect(point.windowMB).toBeGreaterThan(0);
    expect(point.aheadMB).toBeGreaterThan(0);
    expect(report.mock.calls[2][0]).toMatchObject({ why: "fin de lecture", netMB: fetched.length });
  });

  it("arrêtée, elle rend toute sa mémoire", async () => {
    const { reserve, source } = await start();
    await pump(reserve, 3);
    expect(source.reserveIndices.length).toBeGreaterThan(0);
    reserve.stop();
    expect(source.reserveIndices).toEqual([]);
  });
});

describe("la part de mémoire de la réserve", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";
  const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Safari/605.1.15";
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

  it("prudente sur iPhone et iPad, où Safari ne dit pas sa mémoire et tue les pages gourmandes", () => {
    expect(reserveBudgetBytes(IPHONE)).toBe(150e6);
    expect(reserveBudgetBytes(IPAD_AS_MAC, { maxTouchPoints: 5 })).toBe(150e6);
  });

  it("ailleurs, selon la mémoire que le navigateur annonce", () => {
    expect(reserveBudgetBytes(CHROME, { deviceMemory: 8 })).toBe(500e6);
    expect(reserveBudgetBytes(CHROME, { deviceMemory: 4 })).toBe(200e6);
    expect(reserveBudgetBytes(CHROME, { deviceMemory: 2 })).toBe(100e6);
    expect(reserveBudgetBytes(CHROME)).toBe(300e6);
  });
});
