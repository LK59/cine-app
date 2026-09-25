import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { forgetHandover } from "@/lib/webcodecs/byteSource";
import { setWatchingFullScreen } from "@/lib/playbackBusy";
import { hydrateFromDisk, resetPersistentCacheForTests } from "@/lib/persistentCache";
import { readResumeIndex, readResumeManifest, setResumeStoreForTests } from "@/lib/resumeCache/store";
import { forgetResumeCache, openDiskChunks } from "@/lib/resumeCache/diskChunks";
import { bigMatroska } from "./helpers/bigMatroska";
import { FakeDir } from "./helpers/fakeOpfs";

/**
 * L'orchestration de la reprise instantanée (25/09/2026), de bout en bout sur un faux OPFS et un faux
 * serveur : ce qu'un passage garde, ce qu'il efface, et qu'il cède toujours la place au film.
 */

const FILE = bigMatroska(40, 300_000);
const URL_A = "/api/jellyfin/stream/a/stream.mkv?static=true&mediaSourceId=a";
let info: { streamUrl: string; sizeBytes: number | null; fileVersion: string | null } = { streamUrl: URL_A, sizeBytes: FILE.length, fileVersion: "etag-1" };

vi.mock("@/lib/prefetch", () => ({
  preloadQuietly: async () => info,
}));

let root: FakeDir;
let requests = 0;

beforeEach(async () => {
  forgetHandover();
  root = new FakeDir();
  setResumeStoreForTests(async () => root);
  requests = 0;
  info = { streamUrl: URL_A, sizeBytes: FILE.length, fileVersion: "etag-1" };
  setWatchingFullScreen(false);
  resetPersistentCacheForTests();
  // Le compte de la page, comme l'hydratation le pose au démarrage.
  await hydrateFromDisk("louis", { has: () => true, set: () => {} });
  vi.stubGlobal("fetch", async (_url: string, init?: { headers?: Record<string, string> }) => {
    requests += 1;
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!.map(Number);
    return {
      status: 206,
      headers: { get: (name: string) => (name === "Content-Range" ? `bytes ${from}-${to}/${FILE.length}` : name === "Last-Modified" ? "Tue, 10 Mar 2026 15:14:16 GMT" : null) },
      arrayBuffer: async () => FILE.slice(from, to + 1).buffer,
    };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setResumeStoreForTests(null);
  setWatchingFullScreen(false);
});

async function run(targets: { itemId: string; startSeconds: number }[]) {
  const { runResumeCache } = await import("@/lib/resumeCache/useResumeCache");
  await runResumeCache(targets, new AbortController().signal);
}

describe("un passage de la reprise instantanée", () => {
  it("garde l'ouverture d'un titre, que le lecteur retrouve ensuite pour ce fichier-là", async () => {
    await run([{ itemId: "a", startSeconds: 20.5 }]);
    const manifest = await readResumeManifest("louis", "a");
    expect(manifest).toMatchObject({ itemId: "a", streamUrl: URL_A, size: FILE.length, fileVersion: "etag-1", partial: false, lastModified: "Tue, 10 Mar 2026 15:14:16 GMT" });
    expect(manifest!.chunks.length).toBeGreaterThan(1);
    const disk = await openDiskChunks({ itemId: "a", streamUrl: URL_A, size: FILE.length, fileVersion: "etag-1" });
    expect(disk?.has(0)).toBe(true);
  });

  it("jette sans erreur ce qui a été gardé pour un fichier depuis remplacé", async () => {
    await run([{ itemId: "a", startSeconds: 20.5 }]);
    expect(await openDiskChunks({ itemId: "a", streamUrl: URL_A, size: FILE.length, fileVersion: "etag-2" })).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(await readResumeManifest("louis", "a")).toBeNull();
    // Et le passage suivant le refait, pour le nouveau fichier.
    info = { ...info, fileVersion: "etag-2" };
    await run([{ itemId: "a", startSeconds: 20.5 }]);
    expect((await readResumeManifest("louis", "a"))?.fileVersion).toBe("etag-2");
  });

  it("efface un titre sorti de la liste, et un titre fini", async () => {
    await run([{ itemId: "a", startSeconds: 20.5 }]);
    await run([{ itemId: "b", startSeconds: 5 }]);
    expect(await readResumeManifest("louis", "a")).toBeNull();
    expect(Object.keys(await readResumeIndex("louis"))).toEqual(["b"]);
    forgetResumeCache("b");
    await new Promise((r) => setTimeout(r, 10));
    expect(await readResumeIndex("louis")).toEqual({});
  });

  it("ne fait rien pendant qu'un film tient l'écran", async () => {
    setWatchingFullScreen(true);
    await run([{ itemId: "a", startSeconds: 20.5 }]);
    expect(requests).toBe(0);
    expect(await readResumeIndex("louis")).toEqual({});
  });

  it("ne garde rien quand Jellyfin ne donne pas la version du fichier", async () => {
    info = { ...info, fileVersion: null };
    await run([{ itemId: "a", startSeconds: 20.5 }]);
    expect(await readResumeIndex("louis")).toEqual({});
  });

  it("sans OPFS, un passage ne lève pas et ne garde rien", async () => {
    setResumeStoreForTests(async () => null);
    await expect(run([{ itemId: "a", startSeconds: 20.5 }])).resolves.toBeUndefined();
    expect(await openDiskChunks({ itemId: "a", streamUrl: URL_A, size: FILE.length, fileVersion: "etag-1" })).toBeNull();
  });
});
