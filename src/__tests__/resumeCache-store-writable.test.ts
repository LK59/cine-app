import { it, expect, afterEach } from "vitest";
import { setResumeStoreForTests, writeResumeChunk, type DirHandleLike, type FileHandleLike } from "@/lib/resumeCache/store";

/**
 * Une écriture OPFS refusée — le quota dépassé, précisément le cas qu'`overQuota` anticipe — laissait
 * son flux d'écriture ouvert : ni `close`, ni `abort`, donc le `.crswap` et le verrou du fichier tenus
 * jusqu'au ramasse-miettes. Le flux est abandonné, et l'appelant voit toujours l'échec.
 */

afterEach(() => setResumeStoreForTests(null, null));

function storeWith(write: () => Promise<void>, abort: () => Promise<void>) {
  const streams: { closed: boolean; aborted: boolean }[] = [];
  const file: FileHandleLike = {
    getFile: async () => new Blob([]),
    createWritable: async () => {
      const s = { closed: false, aborted: false };
      streams.push(s);
      return {
        write,
        close: async () => {
          s.closed = true;
        },
        abort: async () => {
          s.aborted = true;
          await abort();
        },
      };
    },
  };
  const dir: DirHandleLike = {
    getDirectoryHandle: async () => dir,
    getFileHandle: async () => file,
    removeEntry: async () => {},
  };
  setResumeStoreForTests(async () => dir, null);
  return streams;
}

const quota = async () => {
  throw new DOMException("quota", "QuotaExceededError");
};

it("un write refusé abandonne son flux, et l'écriture reste un échec", async () => {
  const streams = storeWith(quota, async () => {});
  expect(await writeResumeChunk("compte", "item", 3, new Uint8Array(16))).toBe(false);
  expect(streams[0]).toEqual({ closed: false, aborted: true });
});

it("un abandon qui lève lui-même ne change rien à l'échec rendu", async () => {
  const streams = storeWith(quota, async () => {
    throw new TypeError("flux déjà fermé");
  });
  expect(await writeResumeChunk("compte", "item", 3, new Uint8Array(16))).toBe(false);
  expect(streams[0].aborted).toBe(true);
});
