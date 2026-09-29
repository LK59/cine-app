import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forgetHandover } from "@/lib/webcodecs/byteSource";
import type { MatroskaFile } from "@/lib/webcodecs/matroska";

// L'en-tête gardé en mémoire était nommé par l'adresse du flux seule (audit B3). Un fichier
// remplacé au même chemin par son gestionnaire — mise à niveau, réencodage — garde son itemId et
// son mediaSourceId, donc la même adresse : la réouverture dans la même page recevait l'en-tête de
// l'ancien dès que celui-ci tenait dans la taille du nouveau (`segmentEnd <= source.size`), et le
// lecteur démultiplexait le nouveau fichier avec l'index et les pistes de l'autre.
//
// Deux vrais Matroska servis tour à tour à la même adresse ; la vraie ouverture et le vrai cache,
// seul ce qui suit l'en-tête est coupé.

const FIXTURES = join(__dirname, "fixtures", "mp4");
const SMALL = new Uint8Array(readFileSync(join(FIXTURES, "c-hevc-multi.mkv")));
const LARGE = new Uint8Array(readFileSync(join(FIXTURES, "g-audio-codecs.mkv")));

let served = SMALL;
const opened: MatroskaFile[] = [];
let readAfterHeader = false;

vi.mock("@/lib/webcodecs/mediaFile", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/webcodecs/mediaFile")>();
  return {
    ...real,
    openMediaFile: async (source: { read(offset: number, length: number): Promise<Uint8Array> }, key?: string) => {
      const file = await real.openMediaFile(source as never, key);
      opened.push(file);
      // Une lecture de la suite du film : la première réponse du serveur, celle qui dit sa taille.
      if (readAfterHeader) await source.read(0, 16);
      throw new Error("fin de l'ouverture simulée");
    },
  };
});

beforeEach(() => {
  forgetHandover();
  vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: () => true } });
  vi.stubGlobal("fetch", async (_url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    const range = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "");
    if (!range) return new Response(null, { status: 200, headers: { "Content-Length": String(served.length) } });
    const from = Number(range[1]);
    const to = Math.min(Number(range[2]), served.length - 1);
    return new Response(served.slice(from, to + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${from}-${to}/${served.length}` },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  readAfterHeader = false;
});

/** Chaque cas a son adresse : les caches du module vivent d'un cas à l'autre. */
async function open(url: string, fileVersion: string | null, knownSize: number = served.length): Promise<MatroskaFile> {
  const { probePlaybackPath } = await import("@/lib/webcodecs/remuxPlayback");
  await expect(probePlaybackPath({ streamUrl: url, knownSize, fileVersion, startSeconds: 0, onError: vi.fn() })).rejects.toThrow(/simulée/);
  forgetHandover();
  return opened[opened.length - 1];
}

describe("en-tête gardé en mémoire et version du fichier", () => {
  it("deux versions d'un fichier à la même adresse ne partagent pas leur en-tête", async () => {
    served = SMALL;
    const before = await open("/stream/a.mkv", "etag-avant");
    served = LARGE;
    const after = await open("/stream/a.mkv", "etag-apres");
    expect(after).not.toBe(before);
    expect(after.segmentEnd).toBeGreaterThan(before.segmentEnd);
  });

  it("la même version rouverte ne relit pas son en-tête", async () => {
    served = SMALL;
    const first = await open("/stream/b.mkv", "etag-meme");
    const again = await open("/stream/b.mkv", "etag-meme");
    expect(again).toBe(first);
  });

  it("sans version, une taille corrigée par le serveur fait oublier l'en-tête gardé", async () => {
    served = SMALL;
    const before = await open("/stream/c.mkv", null);
    // Le fichier est remplacé ; la description gardée dans la session annonce encore l'ancienne
    // taille. Cette ouverture-ci peut encore recevoir l'en-tête en mémoire (il ne lit rien, et la
    // réponse qui dit la vraie taille peut arriver après lui) — mais la correction de taille doit
    // le faire oublier pour la suivante : une reconstruction, un changement de piste.
    served = LARGE;
    readAfterHeader = true;
    await open("/stream/c.mkv", null, SMALL.length);
    readAfterHeader = false;
    const fresh = await open("/stream/c.mkv", null);
    expect(fresh).not.toBe(before);
  });
});
