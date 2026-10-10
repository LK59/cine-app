import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
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

vi.mock("@/lib/directInfo", () => ({
  fetchDirectInfo: async () => info,
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
  // Le « souffle » de 800 ms entre deux titres (`BETWEEN_TITLES_MS`), ramené à un tour de boucle :
  // attendu en temps réel, il faisait de chaque test une seconde d'attente vide, et le premier du
  // fichier (import compris) passait les 5 s sous la charge de plusieurs suites en parallèle
  // (10/10/2026). Ce que ces tests prouvent, c'est ce qui est gardé — pas la longueur de la pause.
  const realSetTimeout = globalThis.setTimeout;
  vi.stubGlobal("setTimeout", ((cb: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
    realSetTimeout(cb, ms === 800 ? 0 : ms, ...rest)) as typeof setTimeout);
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

// Le module chargé une fois, avant le premier test : importé à froid *dans* le premier, il le faisait
// passer les 5 s sous la charge de plusieurs suites en parallèle (10/10/2026).
beforeAll(async () => {
  await import("@/lib/resumeCache/useResumeCache");
});

async function run(targets: { itemId: string; startSeconds: number; positionSeconds?: number; started?: boolean }[], now = Date.now()) {
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
    // L'effacement part en arrière-plan : attendu sur son effet, pas sur une durée — dix
    // millisecondes ne suffisaient pas sous la charge de la suite complète.
    await vi.waitFor(async () => expect(await readResumeManifest("louis", "a")).toBeNull());
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
    await vi.waitFor(async () => expect(await readResumeIndex("louis")).toEqual({}));
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

  it("à l'arrêt, ne garde que de quoi reprendre, et ne le retélécharge pas ensuite", async () => {
    const { keepOnStop } = await import("@/lib/resumeCache/keepOnStop");
    const { openMediaFile } = await import("@/lib/webcodecs/mediaFile");
    const { MemoryByteSource } = await import("@/lib/webcodecs/byteSource");
    info = { streamUrl: URL_B, sizeBytes: BIG.length, fileVersion: "etag-1" };
    const file = await openMediaFile(new MemoryByteSource(BIG));
    // Le lecteur tenait 40 Mio autour de 55 s : seuls l'en-tête, l'index et le passage de la reprise partent.
    const held = new Map<number, Uint8Array>();
    for (let i = 0; i < 40; i++) held.set(i, BIG.slice(i << 20, (i + 1) << 20));
    const identity = { itemId: "b", streamUrl: URL_B, size: BIG.length, fileVersion: "etag-1" };
    const written = await keepOnStop(identity, { size: BIG.length, lastModified: null, chunks: held }, { file, seconds: 55 });
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(12);
    const kept = await readResumeManifest("louis", "b");
    expect(kept!.coveredTo).toBeLessThan(0);
    expect(kept!.chunks).toContain(0);
    expect(kept!.chunks).not.toContain(5);
    // Le passage suivant mesure depuis l'appareil : il ne retélécharge pas le passage, seulement l'index s'il manquait.
    await run([{ itemId: "b", startSeconds: 50, started: true }]);
    const at = (50 * 400_000) / (1 << 20);
    expect(fetchedChunks.filter((i) => i >= Math.floor(at) - 1 && i <= Math.floor(at) + 2)).toEqual([]);
    expect((await readResumeManifest("louis", "b"))!.coveredTo).toBeGreaterThanOrEqual(52);
  });

  it("sans index du fichier, l'arrêt n'écrit rien", async () => {
    const { keepOnStop } = await import("@/lib/resumeCache/keepOnStop");
    const held = new Map([[3, BIG.slice(3 << 20, 4 << 20)]]);
    expect(await keepOnStop({ itemId: "b", streamUrl: URL_B, size: BIG.length, fileVersion: "etag-1" }, { size: BIG.length, lastModified: null, chunks: held }, null)).toBe(0);
    expect(await readResumeIndex("louis")).toEqual({});
  });

  it("n'écrit rien à l'arrêt pour un autre fichier que celui décrit", async () => {
    const { keepOnStop } = await import("@/lib/resumeCache/keepOnStop");
    const held = new Map([[3, BIG.slice(3 << 20, 4 << 20)]]);
    const { openMediaFile } = await import("@/lib/webcodecs/mediaFile");
    const { MemoryByteSource } = await import("@/lib/webcodecs/byteSource");
    const around = { file: await openMediaFile(new MemoryByteSource(BIG)), seconds: 5 };
    expect(await keepOnStop({ itemId: "b", streamUrl: URL_B, size: BIG.length + 1, fileVersion: "etag-1" }, { size: BIG.length, lastModified: null, chunks: held }, around)).toBe(0);
    expect(await keepOnStop({ itemId: "b", streamUrl: URL_B, size: BIG.length, fileVersion: null }, { size: BIG.length, lastModified: null, chunks: held }, around)).toBe(0);
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

  it("garde de la position reculée jusqu'à un groupe après la position exacte — les deux ouvertures démarrent de l'appareil", async () => {
    // 28/09/2026 : ne gardait que depuis l'une des deux ; l'autre ouvrait « mixte ».
    info = { streamUrl: URL_B, sizeBytes: BIG.length, fileVersion: "etag-1" };
    await run([{ itemId: "b", startSeconds: 55.5, positionSeconds: 60.5, started: true }]);
    const manifest = await readResumeManifest("louis", "b");
    expect(manifest!.coveredFrom).toBeLessThanOrEqual(55.5);
    expect(manifest!.coveredTo).toBeGreaterThanOrEqual(62);
  });

  it("un morceau que le manifeste décrit mais que l'appareil a perdu est réécrit, pas le titre jeté", async () => {
    // Chasse aux défauts du 28/09 : relu au réseau, il n'était pas réécrit, et le titre entier
    // était effacé faute de lui.
    const { recordTitle } = await import("@/lib/resumeCache/recordTitle");
    const { dropResumeChunk, readResumeChunk } = await import("@/lib/resumeCache/store");
    info = { streamUrl: URL_B, sizeBytes: BIG.length, fileVersion: "etag-1" };
    await run([{ itemId: "b", startSeconds: 60.5, started: true }]);
    const before = await readResumeManifest("louis", "b");
    const lost = before!.chunks.at(-1)!;
    await dropResumeChunk("louis", "b", lost);
    const kept = await recordTitle("louis", { itemId: "b", startSeconds: 60.5, started: true }, 1024, new AbortController().signal);
    expect(kept).toBeGreaterThan(0);
    const after = await readResumeManifest("louis", "b");
    expect(after!.chunks).toContain(lost);
    expect(await readResumeChunk("louis", "b", lost)).not.toBeNull();
  });

  it("« Vider le cache » pendant un passage : le passage ne recrée rien", async () => {
    const { clearResumeStore } = await import("@/lib/resumeCache/store");
    info = { streamUrl: URL_B, sizeBytes: BIG.length, fileVersion: "etag-1" };
    const real = globalThis.fetch;
    let cleared = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (!cleared) {
        cleared = true;
        void clearResumeStore();
      }
      return real(url, init);
    });
    await run([{ itemId: "b", startSeconds: 60.5, started: true }]);
    expect(await readResumeIndex("louis")).toEqual({});
    expect(await readResumeManifest("louis", "b")).toBeNull();
  });

  it("ne remplace pas un manifeste qu'un autre a écrit depuis sa lecture", async () => {
    const { commitResumeEntry } = await import("@/lib/resumeCache/store");
    await run([{ itemId: "a", startSeconds: 20.5 }]);
    const current = await readResumeManifest("louis", "a");
    const stale = { ...current!, chunks: [0], savedAt: current!.savedAt + 1 };
    expect(await commitResumeEntry("louis", stale, [], current!.savedAt - 1)).toBe(false);
    expect((await readResumeManifest("louis", "a"))!.chunks).toEqual(current!.chunks);
    expect(await commitResumeEntry("louis", stale, [], current!.savedAt)).toBe(true);
  });

  it("ramène au minimum une réserve laissée sur l'appareil par la version d'avant", async () => {
    // 28/09/2026 : la réserve d'avance sur l'appareil a été retirée ; ce qu'elle avait laissé part.
    const { mergeResumeEntry, writeResumeChunk } = await import("@/lib/resumeCache/store");
    info = { streamUrl: URL_B, sizeBytes: BIG.length, fileVersion: "etag-1" };
    const lastChunk = Math.floor((BIG.length - 1) / (1 << 20));
    const chunks = [0, lastChunk, ...Array.from({ length: 30 }, (_, k) => 10 + k)];
    for (const i of chunks) await writeResumeChunk("louis", "b", i, BIG.slice(i << 20, Math.min(BIG.length, (i + 1) << 20)));
    await mergeResumeEntry("louis", { itemId: "b", streamUrl: URL_B, size: BIG.length, fileVersion: "etag-1", lastModified: null }, chunks, []);
    fetchedChunks = [];
    await run([{ itemId: "b", startSeconds: 50, started: true }]);
    const manifest = await readResumeManifest("louis", "b");
    expect(fetchedChunks).toEqual([]);
    expect(manifest!.chunks.length).toBeLessThanOrEqual(6);
    expect(manifest!.chunks).toEqual(expect.arrayContaining([0, lastChunk]));
    expect(manifest!.chunks.filter((i) => i > 25)).toEqual([lastChunk]);
  });
});
