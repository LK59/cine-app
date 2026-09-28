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
/** Un fichier plus long que ce qu'une ouverture garde : de quoi voir ce qui est relu, et ce qui ne l'est pas. */
const BIG = bigMatroska(150, 400_000);
const URL_B = "/api/jellyfin/stream/b/stream.mkv?static=true&mediaSourceId=b";
const FILES: Record<string, Uint8Array> = { [URL_A]: FILE, [URL_B]: BIG };
/** Les morceaux de 1 Mio demandés au réseau, dans l'ordre. */
let fetchedChunks: number[] = [];
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
  fetchedChunks = [];
  vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
    requests += 1;
    const file = FILES[url] ?? FILE;
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!.map(Number);
    fetchedChunks.push(Math.floor(from / (1 << 20)));
    return {
      status: 206,
      headers: { get: (name: string) => (name === "Content-Range" ? `bytes ${from}-${to}/${file.length}` : name === "Last-Modified" ? "Tue, 10 Mar 2026 15:14:16 GMT" : null) },
      arrayBuffer: async () => file.slice(from, to + 1).buffer,
    };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setResumeStoreForTests(null);
  setWatchingFullScreen(false);
});

async function run(targets: { itemId: string; startSeconds: number; started?: boolean }[], now = Date.now()) {
  const { runResumeCache } = await import("@/lib/resumeCache/useResumeCache");
  await runResumeCache(targets, new AbortController().signal, now);
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
    // Sorti de la liste après le délai de grâce de ce qu'on vient d'arrêter (`RECENT_GRACE_MS`).
    await run([{ itemId: "b", startSeconds: 5 }], Date.now() + 6 * 60_000);
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

  it("refait un titre à une autre position sans retélécharger l'en-tête ni l'index", async () => {
    // 28/09/2026 : la position avance sur un autre appareil ; seul le passage change.
    info = { streamUrl: URL_B, sizeBytes: BIG.length, fileVersion: "etag-1" };
    await run([{ itemId: "b", startSeconds: 5 }]);
    const first = await readResumeManifest("louis", "b");
    const lastChunk = Math.floor((BIG.length - 1) / (1 << 20));
    expect(first!.chunks).toEqual(expect.arrayContaining([0, lastChunk]));
    fetchedChunks = [];
    await run([{ itemId: "b", startSeconds: 120 }]);
    const second = await readResumeManifest("louis", "b");
    expect(second!.startSeconds).toBe(120);
    expect(second!.coveredFrom).toBeLessThanOrEqual(120);
    expect(fetchedChunks.length).toBeGreaterThan(0);
    expect(fetchedChunks).not.toContain(0);
    expect(fetchedChunks).not.toContain(lastChunk);
    // Ce qui ne sert plus (le passage d'avant) est effacé ; l'en-tête et l'index restent.
    expect(second!.chunks).toEqual(expect.arrayContaining([0, lastChunk]));
    expect(second!.chunks.filter((i) => first!.chunks.includes(i) && i !== 0 && i !== lastChunk && i < 10)).toEqual([]);
  });

  it("garde à l'arrêt ce que le lecteur tenait en mémoire, et ne le retélécharge pas ensuite", async () => {
    const { keepOnStop } = await import("@/lib/resumeCache/keepOnStop");
    info = { streamUrl: URL_B, sizeBytes: BIG.length, fileVersion: "etag-1" };
    const held = new Map<number, Uint8Array>();
    for (let i = 20; i <= 40; i++) held.set(i, BIG.slice(i << 20, (i + 1) << 20));
    const identity = { itemId: "b", streamUrl: URL_B, size: BIG.length, fileVersion: "etag-1" };
    expect(await keepOnStop(identity, { size: BIG.length, lastModified: null, chunks: held })).toBe(21);
    const kept = await readResumeManifest("louis", "b");
    expect(kept!.coveredTo).toBeLessThan(0);
    // Le lecteur s'en sert déjà.
    const disk = await openDiskChunks(identity);
    expect(disk?.has(25)).toBe(true);
    // Le passage suivant mesure la couverture en relisant l'appareil : seuls l'en-tête et l'index manquent.
    const at = (22 << 20) / 400_000;
    await run([{ itemId: "b", startSeconds: at, started: true }]);
    const measured = await readResumeManifest("louis", "b");
    expect(measured!.coveredFrom).toBeLessThanOrEqual(at);
    expect(measured!.coveredTo).toBeGreaterThan(at);
    expect(fetchedChunks.filter((i) => i >= 21 && i <= 40)).toEqual([]);
  });

  it("n'écrit rien à l'arrêt pour un autre fichier que celui décrit", async () => {
    const { keepOnStop } = await import("@/lib/resumeCache/keepOnStop");
    const held = new Map([[3, BIG.slice(3 << 20, 4 << 20)]]);
    expect(await keepOnStop({ itemId: "b", streamUrl: URL_B, size: BIG.length + 1, fileVersion: "etag-1" }, { size: BIG.length, lastModified: null, chunks: held })).toBe(0);
    expect(await keepOnStop({ itemId: "b", streamUrl: URL_B, size: BIG.length, fileVersion: null }, { size: BIG.length, lastModified: null, chunks: held })).toBe(0);
    expect(await readResumeIndex("louis")).toEqual({});
  });

  it("« Vider le cache » efface tout ce qui est gardé", async () => {
    const { clearDeviceCache } = await import("@/lib/resumeCache/clearDeviceCache");
    await run([{ itemId: "a", startSeconds: 20.5 }]);
    expect(Object.keys(await readResumeIndex("louis"))).toEqual(["a"]);
    await clearDeviceCache();
    expect(await readResumeIndex("louis")).toEqual({});
    expect(await openDiskChunks({ itemId: "a", streamUrl: URL_A, size: FILE.length, fileVersion: "etag-1" })).toBeNull();
  });

  it("règle fondamentale : au repos, une reprise ne télécharge que de quoi démarrer", async () => {
    // 28/09/2026 : la version d'avant prenait 128 Mio par titre commencé, d'elle-même, depuis l'accueil.
    info = { streamUrl: URL_B, sizeBytes: BIG.length, fileVersion: "etag-1" };
    await run([{ itemId: "b", startSeconds: 60.5, started: true }]);
    const manifest = await readResumeManifest("louis", "b");
    // L'en-tête, l'index, le groupe de la position et le suivant : quelques mégaoctets, rien d'autre.
    expect(new Set(fetchedChunks).size).toBeLessThanOrEqual(5);
    expect(manifest!.coveredFrom).toBeLessThanOrEqual(60.5);
    expect(manifest!.coveredTo).toBeGreaterThanOrEqual(62);
    expect(manifest!.minimalChunks).toBeLessThanOrEqual(3);
    // Et un second passage ne télécharge plus rien.
    fetchedChunks = [];
    await run([{ itemId: "b", startSeconds: 60.5, started: true }]);
    expect(fetchedChunks).toEqual([]);
  });

  it("garde l'avance qu'une lecture a laissée, dans la part du titre, sans rien télécharger de plus", async () => {
    const { keepOnStop } = await import("@/lib/resumeCache/keepOnStop");
    info = { streamUrl: URL_B, sizeBytes: BIG.length, fileVersion: "etag-1" };
    const identity = { itemId: "b", streamUrl: URL_B, size: BIG.length, fileVersion: "etag-1" };
    // Une lecture arrêtée vers 50 s a laissé l'en-tête, derrière elle, et 20 Mio devant.
    const lastChunk = Math.floor((BIG.length - 1) / (1 << 20));
    const held = new Map<number, Uint8Array>();
    for (const i of [0, lastChunk, ...Array.from({ length: 30 }, (_, k) => 10 + k)]) held.set(i, BIG.slice(i << 20, Math.min(BIG.length, (i + 1) << 20)));
    await keepOnStop(identity, { size: BIG.length, lastModified: null, chunks: held });
    fetchedChunks = [];
    await run([{ itemId: "b", startSeconds: 50, started: true }]);
    const manifest = await readResumeManifest("louis", "b");
    expect(fetchedChunks).toEqual([]);
    // Seul titre actif : toute la réserve est à lui. Ce qui est derrière la position est effacé.
    const anchor = Math.floor((50 * 400_000) / (1 << 20));
    expect(manifest!.chunks.filter((i) => i > 0 && i < anchor - 1)).toEqual([]);
    expect(manifest!.chunks).toEqual(expect.arrayContaining([0, lastChunk, 39]));
    expect(manifest!.coveredTo).toBeGreaterThan(90);
    expect(manifest!.headerChunks).toEqual(expect.arrayContaining([0, lastChunk]));
  });

  it("réduit une réserve à la part du titre en effaçant le plus lointain", async () => {
    const { recordTitle } = await import("@/lib/resumeCache/recordTitle");
    const { keepOnStop } = await import("@/lib/resumeCache/keepOnStop");
    info = { streamUrl: URL_B, sizeBytes: BIG.length, fileVersion: "etag-1" };
    const identity = { itemId: "b", streamUrl: URL_B, size: BIG.length, fileVersion: "etag-1" };
    const lastChunk = Math.floor((BIG.length - 1) / (1 << 20));
    const held = new Map<number, Uint8Array>();
    for (const i of [0, lastChunk, ...Array.from({ length: 30 }, (_, k) => 10 + k)]) held.set(i, BIG.slice(i << 20, Math.min(BIG.length, (i + 1) << 20)));
    await keepOnStop(identity, { size: BIG.length, lastModified: null, chunks: held });
    await recordTitle("louis", { itemId: "b", startSeconds: 50, started: true, shareChunks: 8 }, 1000, new AbortController().signal);
    const manifest = await readResumeManifest("louis", "b");
    const reserve = manifest!.chunks.filter((i) => i !== 0 && i !== lastChunk);
    expect(reserve.length).toBeLessThanOrEqual(8);
    expect(Math.max(...reserve)).toBeLessThan(30);
    expect(manifest!.coveredTo).toBeLessThan(80);
  });
});
