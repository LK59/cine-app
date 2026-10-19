import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Les aperçus de la barre gardés avec un téléchargement (Louis, 19/10/2026) : chaque planche rangée
 * à côté du film ; un titre sans aperçus le dit (`null`) ; une panne en route n'est pas notée comme
 * une absence (`undefined`, réessayé au prochain chargement).
 */

const files = new Map<string, Uint8Array>();
vi.mock("@/lib/offline/deviceStore", () => ({
  deviceStore: {
    writeFile: async (_a: string, id: string, name: string, bytes: Uint8Array) => void files.set(`${id}/${name}`, bytes),
    readFile: async (_a: string, id: string, name: string) => {
      const bytes = files.get(`${id}/${name}`);
      return bytes ? new Blob([bytes as BlobPart]) : null;
    },
  },
}));

const { storeOfflineTrickplay, readOfflineTrickplayUrls } = await import("@/lib/offline/trickplay");

const info = { width: 320, height: 180, tileWidth: 10, tileHeight: 10, thumbnailCount: 250, intervalMs: 10_000 };

beforeEach(() => {
  files.clear();
  vi.unstubAllGlobals();
});

describe("aperçus de la barre hors ligne", () => {
  it("garde toutes les planches et rend leur description", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      if (url.includes("/info")) return new Response(JSON.stringify(info));
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const kept = await storeOfflineTrickplay("acc", "job", "item");
    expect(kept).toEqual({ ...info, tiles: 3 });
    expect([...files.keys()].sort()).toEqual(["job/trickplay-0.jpg", "job/trickplay-1.jpg", "job/trickplay-2.jpg"]);
    expect(asked.filter((u) => u.includes("/tile")).every((u) => u.includes("width=320"))).toBe(true);
  });

  it("un titre sans aperçus : null ; une panne : undefined", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    expect(await storeOfflineTrickplay("acc", "job", "item")).toBeNull();
    vi.stubGlobal("fetch", async (url: string) => (url.includes("/info") ? new Response(JSON.stringify(info)) : new Response(null, { status: 502 })));
    expect(await storeOfflineTrickplay("acc", "job", "item")).toBeUndefined();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await storeOfflineTrickplay("acc", "job", "item")).toBeUndefined();
  });

  it("relit les planches en adresses blob, ou rien s'il en manque une", async () => {
    files.set("job/trickplay-0.jpg", new Uint8Array([1]));
    files.set("job/trickplay-1.jpg", new Uint8Array([2]));
    const urls = await readOfflineTrickplayUrls("acc", "job", 2);
    expect(urls).toHaveLength(2);
    expect(urls!.every((u) => u.startsWith("blob:"))).toBe(true);
    expect(await readOfflineTrickplayUrls("acc", "job", 3)).toBeNull();
  });
});
