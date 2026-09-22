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
