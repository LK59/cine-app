import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CHUNK_SIZE, forgetHandover } from "@/lib/webcodecs/byteSource";

// Une ouverture en reprise ne télécharge pas le début du fichier (29/09/2026). La lecture de
// l'en-tête (morceau 0) déclenchait la lecture en avance des morceaux 1 à 6 — six mégaoctets du
// générique d'ouverture, demandés avant que quiconque sache où la lecture allait reprendre, et que
// personne ne lisait. Mesuré sur un épisode repris à 20 minutes : 6 Mio de réseau sur 20, et
// quand l'appareil tenait l'en-tête, l'index et la zone de reprise, *tout* le réseau de
// l'ouverture était ces six morceaux. Une ouverture au début, elle, en a besoin : c'est le film.

const SIZE = 50 * CHUNK_SIZE;
const LAST = SIZE / CHUNK_SIZE - 1;
let asked: number[] = [];

// La vraie source et la vraie ouverture ; seul l'en-tête est simulé : il lit le morceau 0, laisse
// le temps à la lecture en avance de partir, puis s'arrête — ce qui suit ne regarde pas ce test.
vi.mock("@/lib/webcodecs/mediaFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webcodecs/mediaFile")>()),
  openMediaFile: async (source: { read(offset: number, length: number): Promise<Uint8Array> }) => {
    await source.read(0, 4096);
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw new Error("fin de l'en-tête simulé");
  },
}));

beforeEach(() => {
  asked = [];
  forgetHandover();
  vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: () => true } });
  vi.stubGlobal("fetch", async (_url: string, init?: { headers?: Record<string, string> }) => {
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!.map(Number);
    asked.push(from / CHUNK_SIZE);
    return new Response(new Uint8Array(to - from + 1), { status: 206, headers: { "Content-Range": `bytes ${from}-${to}/${SIZE}` } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openAt(startSeconds: number, url: string): Promise<number[]> {
  const { probePlaybackPath } = await import("@/lib/webcodecs/remuxPlayback");
  await expect(probePlaybackPath({ streamUrl: url, knownSize: SIZE, startSeconds, onError: vi.fn() })).rejects.toThrow(/simulé/);
  return [...new Set(asked)].sort((a, b) => a - b);
}

describe("lecture en avance pendant l'en-tête", () => {
  it("une ouverture en reprise ne demande rien entre l'en-tête et la zone de reprise", async () => {
    expect(await openAt(1200, "/stream/reprise")).toEqual([0, LAST]);
  });

  it("une ouverture au début garde sa lecture en avance : ce sont les premières images", async () => {
    expect(await openAt(0, "/stream/debut")).toEqual([0, 1, 2, 3, 4, 5, 6, LAST]);
  });
});
