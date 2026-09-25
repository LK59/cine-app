import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  clearResumeStore,
  readResumeChunk,
  readResumeIndex,
  readResumeManifest,
  removeResumeEntry,
  safeName,
  saveResumeEntry,
  setResumeStoreForTests,
  type ResumeManifest,
} from "@/lib/resumeCache/store";
import { FakeDir } from "./helpers/fakeOpfs";

/**
 * Le magasin de la reprise instantanée (25/09/2026) : ce qu'il range, ce qu'il rend, et qu'il ne
 * lève jamais — sans OPFS, la reprise se fait par le réseau comme avant.
 */

function manifest(itemId: string, over: Partial<ResumeManifest> = {}): ResumeManifest {
  return {
    v: 1,
    itemId,
    streamUrl: `/api/jellyfin/stream/${itemId}/stream.mkv?static=true&mediaSourceId=${itemId}`,
    size: 5 << 20,
    fileVersion: "etag-1",
    lastModified: "Tue, 10 Mar 2026 15:14:16 GMT",
    savedAt: 1_000,
    startSeconds: 100,
    coveredFrom: 98,
    coveredTo: 110,
    chunks: [0, 3],
    bytes: 2 << 20,
    partial: false,
    ...over,
  };
}

const chunk = (fill: number) => new Uint8Array(1 << 20).fill(fill);

let root: FakeDir;
beforeEach(() => {
  root = new FakeDir();
  setResumeStoreForTests(async () => root);
});
afterEach(() => setResumeStoreForTests(null));

describe("le magasin de la reprise instantanée", () => {
  it("range les morceaux, le manifeste et l'index, et les rend tels quels", async () => {
    expect(await saveResumeEntry("louis", manifest("a"), new Map([[0, chunk(1)], [3, chunk(3)]]))).toBe(true);
    expect(await readResumeManifest("louis", "a")).toMatchObject({ itemId: "a", chunks: [0, 3] });
    expect((await readResumeChunk("louis", "a", 3))?.[0]).toBe(3);
    expect(await readResumeChunk("louis", "a", 1)).toBeNull();
    expect(await readResumeIndex("louis")).toEqual({ a: { savedAt: 1_000, startSeconds: 100, coveredFrom: 98, coveredTo: 110, bytes: 2 << 20, partial: false } });
  });

  it("un compte ne voit jamais ce qu'un autre a gardé", async () => {
    await saveResumeEntry("louis", manifest("a"), new Map([[0, chunk(1)]]));
    expect(await readResumeManifest("sarah", "a")).toBeNull();
    expect(await readResumeIndex("sarah")).toEqual({});
  });

  it("refait un titre de zéro : les morceaux d'une position précédente disparaissent", async () => {
    await saveResumeEntry("louis", manifest("a", { chunks: [0, 3] }), new Map([[0, chunk(1)], [3, chunk(3)]]));
    await saveResumeEntry("louis", manifest("a", { chunks: [0, 7], startSeconds: 900 }), new Map([[0, chunk(1)], [7, chunk(7)]]));
    expect(await readResumeChunk("louis", "a", 3)).toBeNull();
    expect((await readResumeChunk("louis", "a", 7))?.[0]).toBe(7);
    expect((await readResumeIndex("louis")).a.startSeconds).toBe(900);
  });

  it("efface un titre et sa ligne d'index ; tout à la déconnexion", async () => {
    await saveResumeEntry("louis", manifest("a"), new Map([[0, chunk(1)]]));
    await saveResumeEntry("louis", manifest("b"), new Map([[0, chunk(2)]]));
    await removeResumeEntry("louis", "a");
    expect(await readResumeManifest("louis", "a")).toBeNull();
    expect(Object.keys(await readResumeIndex("louis"))).toEqual(["b"]);
    await clearResumeStore();
    expect(await readResumeManifest("louis", "b")).toBeNull();
    expect(root.dirs.size).toBe(0);
  });

  it("écrit par le worker de repli quand createWritable n'existe pas (Safari d'avant)", async () => {
    const legacy = new FakeDir(false);
    const written: string[] = [];
    setResumeStoreForTests(async () => legacy, async (path, data) => {
      written.push(path.join("/"));
      legacy.writeAt(path, data);
    });
    expect(await saveResumeEntry("louis", manifest("a", { chunks: [0] }), new Map([[0, chunk(9)]]))).toBe(true);
    expect(written).toEqual(["cine-reprise/louis/a/c0", "cine-reprise/louis/a/manifest.json", "cine-reprise/louis/index.json"]);
    expect((await readResumeChunk("louis", "a", 0))?.[0]).toBe(9);
  });

  it("sans OPFS, ne lève jamais et ne rend rien", async () => {
    setResumeStoreForTests(async () => null);
    expect(await saveResumeEntry("louis", manifest("a"), new Map([[0, chunk(1)]]))).toBe(false);
    expect(await readResumeManifest("louis", "a")).toBeNull();
    expect(await readResumeChunk("louis", "a", 0)).toBeNull();
    expect(await readResumeIndex("louis")).toEqual({});
    await expect(removeResumeEntry("louis", "a")).resolves.toBeUndefined();
    await expect(clearResumeStore()).resolves.toBeUndefined();
  });

  it("ne fabrique jamais un chemin hors de son dossier", () => {
    expect(safeName("../../etc")).not.toContain("/");
    expect(safeName("..")).not.toBe("..");
    expect(safeName("f14633c4fd177082ece2fa468acf8c67")).toBe("f14633c4fd177082ece2fa468acf8c67");
  });
});
