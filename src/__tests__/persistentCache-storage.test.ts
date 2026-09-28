import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { storageFacts, startPersistence } from "@/lib/persistentCache";
import { saveResumeEntry, setResumeStoreForTests, type ResumeManifest } from "@/lib/resumeCache/store";
import { FakeDir } from "./helpers/fakeOpfs";

/**
 * Le stockage de l'appareil sur la ligne d'ouverture (28/09/2026) : la persistance était demandée
 * et sa réponse jetée, et la place offerte par chaque appareil jamais mesurée — deux questions à
 * trancher avant de garder davantage sur l'appareil.
 */

const WEBKIT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";

function manifest(itemId: string, bytes: number): ResumeManifest {
  return {
    v: 1,
    itemId,
    streamUrl: `/api/jellyfin/stream/${itemId}/stream.mkv?static=true&mediaSourceId=${itemId}`,
    size: 5 << 20,
    fileVersion: "etag-1",
    lastModified: null,
    savedAt: 1_000,
    startSeconds: 100,
    coveredFrom: 98,
    coveredTo: 110,
    chunks: [0],
    bytes,
    partial: false,
  };
}

beforeEach(() => {
  const root = new FakeDir();
  setResumeStoreForTests(async () => root);
});
afterEach(() => setResumeStoreForTests(null));

describe("storageFacts", () => {
  it("dit la persistance obtenue, le quota, l'occupation, et le détail quand Chromium le donne", async () => {
    const storage = {
      persisted: async () => true,
      persist: async () => true,
      estimate: async () => ({ quota: 61_234_567_890, usage: 212_345_678, usageDetails: { indexedDB: 2_000_000, caches: 30_000_000, fileSystem: 180_000_000 } }),
    };
    startPersistence(WEBKIT, storage);
    const facts = await storageFacts(storage as unknown as StorageManager, null);
    expect(facts).toEqual({ persist: "déjà", persisted: true, quotaMB: 61234.6, usageMB: 212.3, storageMode: "normal", idbMB: 2, cacheMB: 30, opfsMB: 180 });
  });

  it("dit ce que la reprise instantanée garde pour ce compte", async () => {
    await saveResumeEntry("louis", manifest("a", 24 << 20), new Map([[0, new Uint8Array(1 << 20)]]));
    await saveResumeEntry("louis", manifest("b", 8 << 20), new Map([[0, new Uint8Array(1 << 20)]]));
    const facts = await storageFacts(undefined, "louis");
    expect(facts.resumeTitles).toBe(2);
    expect(facts.resumeMB).toBe(33.6);
  });

  it("part sans ces chiffres plutôt que d'attendre un navigateur qui ne répond pas", async () => {
    const storage = { estimate: () => new Promise<StorageEstimate>(() => {}) };
    expect(await storageFacts(storage as unknown as StorageManager, null, 20)).toEqual({ storageTimedOut: true });
  });

  it("ne lève jamais", async () => {
    const storage = { persisted: async () => { throw new Error("x"); }, estimate: async () => { throw new Error("y"); } };
    await expect(storageFacts(storage as unknown as StorageManager, null)).resolves.toBeTypeOf("object");
  });
});
