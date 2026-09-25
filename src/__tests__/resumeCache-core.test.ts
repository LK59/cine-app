import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CHUNK_SIZE, HttpByteSource, MemoryByteSource, forgetHandover, openingBytes, type ByteSource, type DiskChunks } from "@/lib/webcodecs/byteSource";
import { clusterOffsetForTime } from "@/lib/webcodecs/matroska";
import { createSampleReader, openMediaFile } from "@/lib/webcodecs/mediaFile";
import { diskChunksFor, openingFacts, sameFile, type FileIdentity } from "@/lib/resumeCache/diskChunks";
import { MAX_TITLE_CHUNKS, RECORD_AHEAD_SECONDS, recordOpening } from "@/lib/resumeCache/record";
import { MAX_TITLES, MAX_TOTAL_CHUNKS, covers, planResumeCache, remainingChunks, resumeTargets } from "@/lib/resumeCache/plan";
import type { ResumeIndex, ResumeManifest } from "@/lib/resumeCache/store";
import { bigMatroska } from "./helpers/bigMatroska";

/**
 * La reprise instantanée (25/09/2026) : ce qui est gardé, ce qui est servi, et ce qui ne l'est
 * jamais. Mesure de départ : ouverture en reprise à 616 ms médians sur iPhone, jusqu'à 2,1 s pour les
 * 10 % les plus lents — un temps d'octets, pas de calcul (`cout.spec.ts`).
 */

// ---------------------------------------------------------------------------------------------
// Le planificateur.

describe("quels titres garder", () => {
  const t = (itemId: string, startSeconds = 100) => ({ itemId, startSeconds });

  it("les premiers de « Reprendre », puis « À suivre », sans doublon et bornés", () => {
    const targets = resumeTargets([t("a"), t("b"), t("c"), t("d")], [t("b"), t("e"), t("f")]);
    expect(targets.map((x) => x.itemId)).toEqual(["a", "b", "c", "e"]);
    expect(targets.length).toBeLessThanOrEqual(MAX_TITLES);
  });

  const entry = (over: Partial<ResumeIndex[string]> = {}): ResumeIndex[string] => ({
    savedAt: 1_000,
    startSeconds: 100,
    coveredFrom: 98,
    coveredTo: 110,
    bytes: 5 << 20,
    partial: false,
    ...over,
  });

  it("rien à refaire quand la position est couverte", () => {
    expect(planResumeCache([t("a", 100)], { a: entry() }, 2_000)).toEqual({ record: [], remove: [] });
  });

  it("refait un titre dont la position a quitté ce qui est couvert — il a regardé plus loin", () => {
    expect(covers(entry(), 300)).toBe(false);
    expect(planResumeCache([t("a", 300)], { a: entry() }, 2_000).record.map((x) => x.itemId)).toEqual(["a"]);
  });

  it("efface ce qui a quitté la liste — fini, ou retiré de « Reprendre »", () => {
    expect(planResumeCache([t("b")], { a: entry(), b: entry() }, 2_000)).toEqual({ record: [], remove: ["a"] });
  });

  it("efface et refait ce qui est trop ancien", () => {
    const plan = planResumeCache([t("a")], { a: entry({ savedAt: 0 }) }, 15 * 24 * 3600_000);
    expect(plan.remove).toEqual(["a"]);
    expect(plan.record.map((x) => x.itemId)).toEqual(["a"]);
  });

  it("compte la place restante sans ce qui part ou sera refait", () => {
    const index = { a: entry({ bytes: 10 << 20 }), b: entry({ bytes: 20 << 20 }) };
    expect(remainingChunks(index, { record: [t("a")], remove: [] })).toBe(MAX_TOTAL_CHUNKS - 20);
  });
});

// ---------------------------------------------------------------------------------------------
// L'identité du fichier.

describe("un morceau n'est servi que pour ce fichier-là", () => {
  const manifest: ResumeManifest = {
    v: 1,
    itemId: "a",
    streamUrl: "/api/jellyfin/stream/a/stream.mkv?static=true&mediaSourceId=a",
    size: 3 * CHUNK_SIZE,
    fileVersion: "etag-1",
    lastModified: "Tue, 10 Mar 2026 15:14:16 GMT",
    savedAt: 0,
    startSeconds: 100,
    coveredFrom: 98,
    coveredTo: 110,
    chunks: [0],
    bytes: CHUNK_SIZE,
    partial: false,
  };
  const identity: FileIdentity = { itemId: "a", streamUrl: manifest.streamUrl, size: manifest.size, fileVersion: "etag-1" };

  it("même taille, même version, même adresse — et rien quand la version manque", () => {
    expect(sameFile(manifest, identity)).toBe(true);
    expect(sameFile(manifest, { ...identity, fileVersion: "etag-2" })).toBe(false);
    expect(sameFile(manifest, { ...identity, size: manifest.size + 1 })).toBe(false);
    expect(sameFile(manifest, { ...identity, fileVersion: null })).toBe(false);
  });

  it("se tait et se jette dès que le serveur annonce un autre fichier", () => {
    const remove = vi.fn(async () => {});
    const disk = diskChunksFor("louis", manifest, async () => new Uint8Array(CHUNK_SIZE), remove);
    disk.verify(manifest.size, manifest.lastModified);
    expect(disk.has(0)).toBe(true);
    disk.verify(manifest.size, "Wed, 11 Mar 2026 09:00:00 GMT");
    expect(disk.has(0)).toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);

    const other = diskChunksFor("louis", manifest, async () => new Uint8Array(CHUNK_SIZE), remove);
    other.verify(manifest.size + 42, null);
    expect(other.has(0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// La source d'octets du lecteur, servie par l'appareil puis par le réseau.

describe("HttpByteSource avec des morceaux gardés", () => {
  const FILE = new Uint8Array(3 * CHUNK_SIZE + 12345).map((_, i) => (i * 31) & 0xff);
  let served: [number, number][] = [];
  let lastModified = "Tue, 10 Mar 2026 15:14:16 GMT";
  let total = FILE.length;

  beforeEach(() => {
    forgetHandover();
    served = [];
    lastModified = "Tue, 10 Mar 2026 15:14:16 GMT";
    total = FILE.length;
    vi.stubGlobal("fetch", async (_url: string, init?: { headers?: Record<string, string> }) => {
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!.map(Number);
      served.push([from, to]);
      return {
        status: 206,
        headers: { get: (name: string) => (name === "Content-Range" ? `bytes ${from}-${to}/${total}` : name === "Last-Modified" ? lastModified : null) },
        arrayBuffer: async () => FILE.slice(from, to + 1).buffer,
      };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function disk(indices: number[], onVerify?: (total: number, lastModified: string | null) => boolean): DiskChunks & { reads: number[] } {
    let off = false;
    const reads: number[] = [];
    return {
      reads,
      has: (i) => !off && indices.includes(i),
      read: async (i) => {
        reads.push(i);
        return FILE.slice(i * CHUNK_SIZE, Math.min(FILE.length, (i + 1) * CHUNK_SIZE));
      },
      verify: (t, lm) => {
        if (onVerify && !onVerify(t, lm)) off = true;
      },
    };
  }

  /** Égalité à l'octet près, sans la comparaison élément par élément de `toEqual` (lente sur 2 Mo). */
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);

  it("rend le fichier à l'octet près, les morceaux gardés venant de l'appareil", async () => {
    const d = disk([0, 3]);
    const source = await HttpByteSource.open("/f", FILE.length, d);
    const bytes = await source.read(CHUNK_SIZE - 100, 2 * CHUNK_SIZE + 300);
    expect(same(bytes, FILE.subarray(CHUNK_SIZE - 100, 3 * CHUNK_SIZE + 200))).toBe(true);
    expect(await source.read(0, 16)).toEqual(FILE.slice(0, 16));
    expect(await source.read(3 * CHUNK_SIZE + 10, 50)).toEqual(FILE.slice(3 * CHUNK_SIZE + 10, 3 * CHUNK_SIZE + 60));
    expect(d.reads).toContain(0);
    // Les morceaux 0 et 3 ne sont jamais demandés au réseau.
    expect(served.some(([from]) => from === 0 || from === 3 * CHUNK_SIZE)).toBe(false);
    expect(openingBytes("/f")!.device).toBe(CHUNK_SIZE + 12345);
    expect(openingFacts("/f")).toMatchObject({ openedFrom: "mixte" });
    source.close(false);
  });

  it("ne sert plus rien de l'appareil dès que le serveur annonce un autre fichier", async () => {
    lastModified = "Wed, 11 Mar 2026 09:00:00 GMT";
    const d = disk([0, 2, 3], (_t, lm) => lm === "Tue, 10 Mar 2026 15:14:16 GMT");
    const source = await HttpByteSource.open("/g", FILE.length, d);
    // Le morceau 1 vient du réseau, qui annonce l'autre date : la couche se tait.
    await source.read(CHUNK_SIZE + 5, 10);
    await new Promise((r) => setTimeout(r, 10));
    const readsBefore = d.reads.length;
    expect(await source.read(2 * CHUNK_SIZE + 7, 10)).toEqual(FILE.slice(2 * CHUNK_SIZE + 7, 2 * CHUNK_SIZE + 17));
    expect(d.reads.length).toBe(readsBefore);
    expect(served.some(([from]) => from === 2 * CHUNK_SIZE)).toBe(true);
    source.close(false);
  });

  it("prend le réseau quand l'appareil rend une longueur inattendue", async () => {
    const d: DiskChunks = { has: (i) => i === 1, read: async () => new Uint8Array(10), verify: () => {} };
    const source = await HttpByteSource.open("/h", FILE.length, d);
    expect(await source.read(CHUNK_SIZE, 20)).toEqual(FILE.slice(CHUNK_SIZE, CHUNK_SIZE + 20));
    expect(served.some(([from]) => from === CHUNK_SIZE)).toBe(true);
    source.close(false);
  });

  it("sans morceaux gardés, rien ne change", async () => {
    const source = await HttpByteSource.open("/i", FILE.length);
    expect(await source.read(10, 20)).toEqual(FILE.slice(10, 30));
    expect(openingFacts("/i")).toMatchObject({ openedFrom: "réseau", deviceBytes: 0 });
    source.close(false);
  });
});

// ---------------------------------------------------------------------------------------------
// L'enregistreur : ce que l'ouverture lit, et que cela suffit à rouvrir sans réseau.

/** Une source qui ne connaît que certains morceaux, et lève pour tout le reste — « sans réseau ». */
function onlyChunks(file: Uint8Array, chunks: number[]): ByteSource {
  const inner = new MemoryByteSource(file);
  const allowed = new Set(chunks);
  return {
    size: file.length,
    read(offset, length) {
      const end = Math.min(file.length, offset + length);
      for (let i = Math.floor(offset / CHUNK_SIZE); i <= Math.floor((end - 1) / CHUNK_SIZE); i++) {
        if (!allowed.has(i)) return Promise.reject(new Error(`morceau ${i} non gardé`));
      }
      return inner.read(offset, length);
    },
    close() {},
  };
}

describe("enregistrer ce que l'ouverture lit", () => {
  const FILE = bigMatroska(40, 300_000);

  it("garde l'en-tête, l'index et le passage depuis l'image clé qui précède", async () => {
    const recorded = await recordOpening(new MemoryByteSource(FILE), 20.5);
    expect(recorded).not.toBeNull();
    expect(recorded!.partial).toBe(false);
    expect(recorded!.coveredFrom).toBe(20);
    expect(recorded!.coveredTo).toBeGreaterThanOrEqual(20.5 + RECORD_AHEAD_SECONDS);
    // L'en-tête (début) et l'index (fin) sont dans des morceaux différents du passage.
    expect(recorded!.chunks).toContain(0);
    expect(recorded!.chunks).toContain(Math.floor((FILE.length - 1) / CHUNK_SIZE));
    expect(recorded!.chunks.length).toBeLessThan(Math.ceil(FILE.length / CHUNK_SIZE));
  });

  it("ces morceaux suffisent à rouvrir le fichier et à lire le passage — sans réseau", async () => {
    const recorded = await recordOpening(new MemoryByteSource(FILE), 20.5);
    const offline = onlyChunks(FILE, recorded!.chunks);
    const file = await openMediaFile(offline);
    const video = file.tracks.find((track) => track.type === "video")!;
    const reader = createSampleReader(offline, file, clusterOffsetForTime(file, 20.5e6, video.number)!);
    let lastVideo = 0;
    while (lastVideo < 20.5 + RECORD_AHEAD_SECONDS) {
      const sample = await reader.next();
      expect(sample).not.toBeNull();
      if (sample!.trackNumber === video.number) lastVideo = sample!.timestampUs / 1e6;
    }
  });

  it("ne garde que l'en-tête et l'index quand le passage dépasse la borne", async () => {
    // 8 Mo par seconde : les quatre secondes de 10 à 13 font 32 Mio, au-delà des 24 par titre.
    const heavy = bigMatroska(15, 8_000_000);
    const recorded = await recordOpening(new MemoryByteSource(heavy), 10);
    expect(recorded!.partial).toBe(true);
    expect(recorded!.chunks.length).toBeLessThanOrEqual(MAX_TITLE_CHUNKS);
    expect(recorded!.chunks).toContain(0);
  });

  it("s'arrête net quand on le lui demande — un film qui démarre", async () => {
    let asked = 0;
    const recorded = await recordOpening(new MemoryByteSource(FILE), 20.5, () => ++asked > 3);
    expect(recorded).toBeNull();
  });
});
