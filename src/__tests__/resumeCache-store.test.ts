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
  writeResumeChunk,
  sweepResumeStore,
  SWEEP_MIN_AGE_MS,
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
    expect(await readResumeIndex("louis")).toEqual({ a: { savedAt: 1_000, startSeconds: 100, coveredFrom: 98, coveredTo: 110, bytes: 2 << 20, partial: false, reserveChunks: 2 } });
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
    expect(written).toEqual(["cine-reprise-2/louis/a/c0", "cine-reprise-2/louis/a/manifest.json", "cine-reprise-2/louis/index.json"]);
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

  it("écrit un morceau découpé dans une plus grande plage à sa taille exacte — même sur un Safari qui écrirait tout", async () => {
    // 28/09/2026 : 7 Go sur un iPhone pour ~800 Mo téléchargés — chaque morceau pesait sa plage de 8 Mio.
    const safari = new FakeDir(true, true);
    setResumeStoreForTests(async () => safari);
    const range = new Uint8Array(8 << 20).map((_, i) => i & 0xff);
    const third = range.subarray(2 << 20, 3 << 20);
    expect(await writeResumeChunk("louis", "a", 2, third)).toBe(true);
    const read = await readResumeChunk("louis", "a", 2);
    expect(read!.byteLength).toBe(1 << 20);
    expect(read![0]).toBe(third[0]);
  });

  it("la voie de repli aussi n'écrit que le morceau", async () => {
    const written: Uint8Array[] = [];
    setResumeStoreForTests(async () => new FakeDir(false), async (_path, data) => void written.push(data));
    const range = new Uint8Array(4 << 20);
    await writeResumeChunk("louis", "a", 1, range.subarray(1 << 20, 2 << 20));
    expect(written[0].byteLength).toBe(1 << 20);
    expect(written[0].buffer.byteLength).toBe(1 << 20);
  });

  it("efface l'ancien dossier au premier accès — les morceaux de huit fois leur taille partent", async () => {
    await (await root.getDirectoryHandle("cine-reprise", { create: true })).getFileHandle("c0", { create: true });
    setResumeStoreForTests(async () => root);
    expect(root.dirs.has("cine-reprise")).toBe(true);
    await readResumeIndex("louis");
    expect(root.dirs.has("cine-reprise")).toBe(false);
  });

  it("balaye ce qu'aucun manifeste ne décrit — et épargne ce qui vient d'être écrit", async () => {
    // 28/09/2026 : la réserve sur l'appareil de la version du matin a pu laisser des morceaux jamais
    // inscrits (une application tuée entre deux mises à jour du manifeste).
    await saveResumeEntry("louis", manifest("a", { chunks: [0] }), new Map([[0, chunk(1)]]));
    await writeResumeChunk("louis", "a", 7, chunk(7));
    await writeResumeChunk("louis", "orphelin", 2, chunk(2));
    const later = Date.now() + SWEEP_MIN_AGE_MS + 1_000;
    // Récents : rien ne part.
    expect(await sweepResumeStore("louis", Date.now())).toBe(0);
    expect(await readResumeChunk("louis", "a", 7)).not.toBeNull();
    // Assez vieux : le morceau non inscrit et le titre inconnu de l'index partent, le reste demeure.
    expect(await sweepResumeStore("louis", later)).toBeGreaterThanOrEqual(2);
    expect(await readResumeChunk("louis", "a", 7)).toBeNull();
    expect(await readResumeChunk("louis", "a", 0)).not.toBeNull();
    expect(await readResumeManifest("louis", "a")).not.toBeNull();
    const account = root.dirs.get("cine-reprise-2")!.dirs.get("louis")!;
    expect(account.dirs.has("orphelin")).toBe(false);
  });

  it("sans moyen de lister un dossier, le balayage ne fait rien", async () => {
    await writeResumeChunk("louis", "orphelin", 2, chunk(2));
    const account = root.dirs.get("cine-reprise-2")!.dirs.get("louis")!;
    (account as unknown as { keys?: unknown }).keys = undefined;
    expect(await sweepResumeStore("louis", Date.now() + 1e9)).toBe(0);
    expect(account.dirs.has("orphelin")).toBe(true);
  });
});
