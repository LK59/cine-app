import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpByteSource, forgetHandover, isReadAbandoned } from "@/lib/webcodecs/byteSource";

// Un saut abandonne les lectures réseau qui ne lui servent plus (22/09/2026). Depuis un serveur
// lointain, chaque saut attendait la fin de la lecture en cours — jusqu'à deux secondes — et les
// lectures d'avance de l'ancienne position occupaient le lien pendant que la nouvelle attendait.

const CHUNK = 1 << 20;
const SIZE = 200 * CHUNK;

/** Les plages demandées, et celles que le lecteur a abandonnées. Aucune réponse n'arrive seule. */
let asked: number[] = [];
let aborted: number[] = [];
let release: (() => void)[] = [];

function stubFetch() {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
    if (init?.method === "HEAD") {
      return Promise.resolve({ ok: true, headers: { get: (n: string) => (n === "Content-Length" ? String(SIZE) : null) } });
    }
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!.map(Number);
    const chunk = from / CHUNK;
    asked.push(chunk);
    return new Promise((resolve, reject) => {
      const answer = () =>
        resolve({ status: 206, headers: { get: () => `bytes ${from}-${to}/${SIZE}` }, arrayBuffer: async () => new Uint8Array(to - from + 1).buffer });
      release.push(answer);
      init?.signal?.addEventListener("abort", () => {
        aborted.push(chunk);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  forgetHandover();
  asked = [];
  aborted = [];
  release = [];
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("abandonner les lectures d'une position quittée", () => {
  it("coupe les lectures loin du saut, garde celles qui le servent, et le dit à qui attendait", async () => {
    const source = await HttpByteSource.open("/film.mkv");
    // La lecture en cours, à 10 Mo, et son avance.
    const pending = source.read(10 * CHUNK, 1000);
    await settle();
    expect(asked).toContain(10);

    // Un saut vers 100 Mo : ce qui est autour de 10 Mo ne sert plus.
    source.abandon(100 * CHUNK);
    source.warm(100 * CHUNK);
    await expect(pending).rejects.toSatisfy(isReadAbandoned);
    expect(aborted).toContain(10);
    expect(aborted).not.toContain(100);
    expect(asked).toContain(100);
  });

  it("n'abandonne pas une lecture qui se trouve déjà là où l'on saute", async () => {
    const source = await HttpByteSource.open("/film.mkv");
    const pending = source.read(50 * CHUNK, 1000);
    await settle();
    source.abandon(50 * CHUNK + 5000);
    release.forEach((answer) => answer());
    await expect(pending).resolves.toHaveLength(1000);
    expect(aborted).not.toContain(50);
  });

  it("reste utilisable après un abandon : la même plage se redemande", async () => {
    const source = await HttpByteSource.open("/film.mkv");
    const first = source.read(10 * CHUNK, 1000);
    await settle();
    source.abandon(100 * CHUNK);
    await expect(first).rejects.toSatisfy(isReadAbandoned);

    const again = source.read(10 * CHUNK, 1000);
    await settle();
    release.forEach((answer) => answer());
    await expect(again).resolves.toHaveLength(1000);
  });

  it("ne prend pas un abandon pour une panne réseau : pas de nouvelle tentative", async () => {
    const source = await HttpByteSource.open("/film.mkv");
    const pending = source.read(10 * CHUNK, 1000);
    await settle();
    const before = asked.filter((c) => c === 10).length;
    source.abandon(100 * CHUNK);
    await expect(pending).rejects.toSatisfy(isReadAbandoned);
    await new Promise((r) => setTimeout(r, 300));
    expect(asked.filter((c) => c === 10).length).toBe(before);
  });
});

describe("ce que le réseau a coûté depuis le saut", () => {
  it("compte les requêtes, les octets, le premier octet et le temps annoncé par le serveur", async () => {
    const { describeNetwork, serverTimingApp } = await import("@/lib/webcodecs/byteSource");
    vi.stubGlobal("fetch", (url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
      if (init?.method === "HEAD") {
        return Promise.resolve({ ok: true, headers: { get: (n: string) => (n === "Content-Length" ? String(SIZE) : null) } });
      }
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!.map(Number);
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: 206,
              headers: { get: (n: string) => (n === "Server-Timing" ? "app;dur=12, jf;dur=9" : `bytes ${from}-${to}/${SIZE}`) },
              arrayBuffer: async () => new Uint8Array(to - from + 1).buffer,
            }),
          20
        )
      );
    });
    const source = await HttpByteSource.open("/film.mkv");
    // Rien avant un saut : la fenêtre s'ouvre avec lui.
    expect(source.networkSinceSeek()).toBeNull();
    source.abandon(100 * CHUNK);
    await source.read(100 * CHUNK, 3 * CHUNK);
    const w = source.networkSinceSeek()!;
    expect(w.requests).toBeGreaterThanOrEqual(3);
    expect(w.bytes).toBeGreaterThanOrEqual(3 * CHUNK);
    expect(w.firstByteMaxMs).toBeGreaterThanOrEqual(15);
    expect(w.serverMaxMs).toBe(12);
    expect(describeNetwork(w)).toMatch(/Mo en \d+ ms \(\d+ Mb\/s\), \d+ requête\(s\), premier octet \d+–\d+ ms, la plus lente \d+ ms, serveur ≤ 12 ms/);
    expect(serverTimingApp(null)).toBeNull();
    expect(serverTimingApp("jf;dur=3")).toBeNull();
  });
});

describe("après un saut, ce qui sert la première image d'abord", () => {
  it("n'avance que de deux morceaux tant que le saut n'a pas sa première image, puis reprend", async () => {
    // Banc du 22/09/2026 : 11 à 21 Mo transférés avant la première image d'un saut qui n'en
    // demandait que 4 à 6 — la lecture en avance (six morceaux) prenait six parts de la bande
    // passante sur sept au morceau attendu.
    const source = await HttpByteSource.open("/film.mkv");
    await settle();
    asked = [];
    source.abandon(100 * CHUNK);
    source.warm(100 * CHUNK);
    const first = source.read(100 * CHUNK, 1000);
    await settle();
    expect([...new Set(asked)].sort((a, b) => a - b)).toEqual([100, 101, 102]);

    // La première image est là : la lecture en avance repart en entier.
    release.forEach((answer) => answer());
    await first;
    source.seekSettled();
    await settle();
    expect(Math.max(...asked)).toBe(106);
  });

  it("ne reste pas bridée si la première image n'arrive jamais", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      const source = await HttpByteSource.open("/film.mkv");
      source.abandon(100 * CHUNK);
      vi.advanceTimersByTime(9000);
      asked = [];
      source.warm(50 * CHUNK);
      expect(Math.max(...asked)).toBe(56);
    } finally {
      vi.useRealTimers();
    }
  });
});
