import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CHUNK_SIZE, HttpByteSource, MemoryByteSource, forgetHandover, openingBytes, type ByteSource, type DiskChunks } from "@/lib/webcodecs/byteSource";
import { clusterOffsetForTime } from "@/lib/webcodecs/matroska";
import { createSampleReader, openMediaFile } from "@/lib/webcodecs/mediaFile";
import { diskChunksFor, openingFacts, sameFile, type FileIdentity } from "@/lib/resumeCache/diskChunks";
import { recordOpening } from "@/lib/resumeCache/record";
import { MAX_TITLES, MAX_TOTAL_CHUNKS, MIN_COVERED_AHEAD_SECONDS, RECENT_GRACE_MS, covers, planResumeCache, remainingChunks, resumeTargets, titleChunks } from "@/lib/resumeCache/plan";
import { ACTIVE_DAYS, LOW_SPACE_BYTES, NORMAL_BUDGET, OPENING_TITLE_CHUNKS, REDUCED_BUDGET, RESUME_MINIMAL_MAX_CHUNKS, activeTitles, budgetFor, restingShare } from "@/lib/resumeCache/budget";
import { chunksBetween, coverageFrom, resumeEnd } from "@/lib/resumeCache/coverage";
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
    const resume = ["a", "b", "c", "d", "e", "f", "g"].map((id) => t(id));
    const nextUp = ["b", "h", "i", "j", "k", "l", "m"].map((id) => t(id));
    const targets = resumeTargets(resume, nextUp);
    expect(targets.map((x) => x.itemId)).toEqual(["a", "b", "c", "d", "e", "h", "i", "j", "k", "l"]);
    expect(targets.length).toBe(MAX_TITLES);
  });

  it("une reprise ne télécharge que son minimum, une ouverture ses 16 Mio — en octets, pas en secondes", () => {
    const [started, opening] = resumeTargets([t("a")], [t("b", 0)]);
    expect(started.started).toBe(true);
    expect(opening.started).toBe(false);
    expect(titleChunks(started)).toBe(RESUME_MINIMAL_MAX_CHUNKS);
    expect(titleChunks(opening)).toBe(OPENING_TITLE_CHUNKS);
  });

  it("réduit au repos ce qui garde plus que sa part, sans jamais rien agrandir", () => {
    const now = 10 * 24 * 3600_000;
    // Deux titres actifs : 512 Mio chacun. Un troisième, lu il y a six jours, n'a plus de part.
    const index = {
      a: entry({ playedAt: now - 1000, reserveChunks: 700, minimalChunks: 3 }),
      b: entry({ playedAt: now - 2000, reserveChunks: 400, minimalChunks: 3 }),
      c: entry({ playedAt: now - 6 * 24 * 3600_000, reserveChunks: 200, minimalChunks: 3 }),
    };
    const plan = planResumeCache([t("a"), t("b"), t("c")], index, now);
    expect(plan.record.map((x) => [x.itemId, x.shareChunks])).toEqual([
      ["a", 512],
      ["c", 0],
    ]);
  });

  it("mesure une fois un titre gardé avant que sa réserve ne soit comptée", () => {
    expect(planResumeCache([t("a")], { a: entry({ reserveChunks: undefined }) }, 2_000).record.map((x) => x.itemId)).toEqual(["a"]);
  });

  const entry = (over: Partial<ResumeIndex[string]> = {}): ResumeIndex[string] => ({
    savedAt: 1_000,
    startSeconds: 100,
    coveredFrom: 98,
    coveredTo: 110,
    bytes: 5 << 20,
    partial: false,
    reserveChunks: 4,
    minimalChunks: 4,
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
    // Passé le délai de grâce de ce qu'on vient d'arrêter (voir le test suivant).
    expect(planResumeCache([t("b")], { a: entry(), b: entry() }, 1_000 + RECENT_GRACE_MS + 1)).toEqual({ record: [], remove: ["a"] });
  });

  it("efface et refait ce qui est trop ancien", () => {
    const plan = planResumeCache([t("a")], { a: entry({ savedAt: 0 }) }, 15 * 24 * 3600_000);
    expect(plan.remove).toEqual(["a"]);
    expect(plan.record.map((x) => x.itemId)).toEqual(["a"]);
  });

  it("refait un titre gardé à l'arrêt, dont la couverture n'est pas encore mesurée", () => {
    expect(covers(entry({ startSeconds: -1, coveredFrom: -1, coveredTo: -1 }), 100)).toBe(false);
    expect(planResumeCache([t("a")], { a: entry({ coveredFrom: -1, coveredTo: -1 }) }, 2_000).record.map((x) => x.itemId)).toEqual(["a"]);
  });

  it("n'efface pas ce qu'on vient d'arrêter parce que « Reprendre » ne le montre pas encore", () => {
    const index = { a: entry({ savedAt: 10_000 }) };
    expect(planResumeCache([], index, 10_000 + RECENT_GRACE_MS - 1).remove).toEqual([]);
    expect(planResumeCache([], index, 10_000 + RECENT_GRACE_MS + 1).remove).toEqual(["a"]);
  });

  it("compte la place restante sans ce qui part ou sera refait", () => {
    const index = { a: entry({ bytes: 10 << 20 }), b: entry({ bytes: 20 << 20 }) };
    expect(remainingChunks(index, { record: [{ ...t("a"), shareChunks: 0 }], remove: [] })).toBe(MAX_TOTAL_CHUNKS - 20);
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
    expect(recorded!.coveredTo).toBeGreaterThanOrEqual(20.5 + MIN_COVERED_AHEAD_SECONDS);
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
    while (lastVideo < 20.5 + MIN_COVERED_AHEAD_SECONDS) {
      const sample = await reader.next();
      expect(sample).not.toBeNull();
      if (sample!.trackNumber === video.number) lastVideo = sample!.timestampUs / 1e6;
    }
  });

  it("ne garde que l'en-tête et l'index quand le budget ne couvre pas la position", async () => {
    // 8 Mo par seconde : 4 Mio ne couvrent pas les deux secondes qui suivent la position.
    const heavy = bigMatroska(15, 8_000_000);
    const recorded = await recordOpening(new MemoryByteSource(heavy), 10, undefined, 4);
    expect(recorded!.partial).toBe(true);
    expect(recorded!.chunks).toContain(0);
    expect(recorded!.chunks.length).toBeLessThanOrEqual(3);
  });

  it("vise des octets : le même budget couvre plus d'un fichier léger que d'un lourd", async () => {
    const light = await recordOpening(new MemoryByteSource(bigMatroska(60, 300_000)), 5, undefined, 4);
    const heavy = await recordOpening(new MemoryByteSource(bigMatroska(60, 900_000)), 5, undefined, 4);
    expect(light!.partial).toBe(false);
    expect(heavy!.partial).toBe(false);
    expect(light!.coveredTo - light!.coveredFrom).toBeGreaterThan(2 * (heavy!.coveredTo - heavy!.coveredFrom));
  });

  it("signale chaque morceau une fois, au moment où il est touché", async () => {
    const seen: number[] = [];
    const recorded = await recordOpening(new MemoryByteSource(FILE), 20.5, undefined, 16, (index) => seen.push(index));
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort((a, b) => a - b)).toEqual(recorded!.chunks);
  });

  it("s'arrête net quand on le lui demande — un film qui démarre", async () => {
    let asked = 0;
    const recorded = await recordOpening(new MemoryByteSource(FILE), 20.5, () => ++asked > 3);
    expect(recorded).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Le budget de l'appareil.

describe("ce que l'appareil garde, selon sa place", () => {
  it("le budget normal, sauf sous 5 Go entre le quota et l'occupation", () => {
    expect(budgetFor({ quota: 41e9, usage: 5e7 })).toBe(NORMAL_BUDGET);
    expect(budgetFor({ quota: 10.8e9, usage: 6e9 })).toBe(REDUCED_BUDGET);
    expect(budgetFor({ quota: LOW_SPACE_BYTES - 1, usage: 0 })).toBe(REDUCED_BUDGET);
  });

  it("sans mesure, le budget normal : une écriture refusée n'est qu'un titre de moins", () => {
    expect(budgetFor(null)).toBe(NORMAL_BUDGET);
    expect(budgetFor({})).toBe(NORMAL_BUDGET);
  });

  it("le mode réduit tient dans ce qui a été décidé : 256 Mio de réserve, 750 au total", () => {
    expect(REDUCED_BUDGET.poolChunks).toBe(256);
    expect(REDUCED_BUDGET.totalChunks).toBe(750);
    expect(NORMAL_BUDGET.poolChunks).toBe(1024);
    expect(NORMAL_BUDGET.floorChunks).toBe(128);
    expect(NORMAL_BUDGET.behindChunks).toBe(128);
    for (const budget of [NORMAL_BUDGET, REDUCED_BUDGET]) {
      expect(budget.poolChunks + budget.behindChunks).toBeLessThanOrEqual(budget.totalChunks);
    }
  });

  it("les titres actifs : lus depuis moins de cinq jours, les quatre plus récents", () => {
    const now = 100 * 24 * 3600_000;
    const day = 24 * 3600_000;
    const index = {
      a: { playedAt: now - 1 * day },
      b: { playedAt: now - 2 * day },
      c: { playedAt: now - 3 * day },
      d: { playedAt: now - 4 * day },
      e: { playedAt: now - 0.5 * day },
      f: { playedAt: now - (ACTIVE_DAYS + 1) * day },
      g: {},
    };
    const active = activeTitles(index, now);
    expect(active).toEqual(["e", "a", "b", "c"]);
    expect(restingShare("a", active, NORMAL_BUDGET)).toBe(256);
    expect(restingShare("d", active, NORMAL_BUDGET)).toBe(0);
    expect(restingShare("a", ["a", "e"], NORMAL_BUDGET)).toBe(512);
  });
});

// ---------------------------------------------------------------------------------------------
// Ce que l'appareil couvre, lu dans l'index.

describe("ce que des morceaux gardés couvrent", () => {
  // Une grappe par seconde, 400 ko chacune : environ deux secondes et demie par Mio.
  const FILE = bigMatroska(60, 400_000);
  let file: Awaited<ReturnType<typeof openMediaFile>>;
  beforeEach(async () => {
    file = await openMediaFile(new MemoryByteSource(FILE));
  });

  it("tout est là : de l'image clé qui précède la position jusqu'à la fin", () => {
    const coverage = coverageFrom(file, 20.5, () => true)!;
    expect(coverage.coveredFrom).toBe(20);
    expect(coverage.coveredTo).toBeGreaterThanOrEqual(59);
    expect(coverage.chunks[0]).toBe(Math.floor(clusterOffsetForTime(file, 20e6)! / CHUNK_SIZE));
  });

  it("un trou arrête la couverture : ce qui suit est une île", () => {
    const start = Math.floor(clusterOffsetForTime(file, 20e6)! / CHUNK_SIZE);
    const coverage = coverageFrom(file, 20.5, (index) => index !== start + 4)!;
    expect(coverage.chunks.every((index) => index < start + 4)).toBe(true);
    expect(coverage.coveredTo).toBeLessThan(35);
    expect(coverage.coveredTo).toBeGreaterThan(21);
  });

  it("borné en morceaux : le plus lointain part en premier", () => {
    const whole = coverageFrom(file, 20.5, () => true)!;
    const bounded = coverageFrom(file, 20.5, () => true, 5)!;
    expect(bounded.chunks.length).toBeLessThanOrEqual(5);
    expect(bounded.chunks).toEqual(whole.chunks.slice(0, bounded.chunks.length));
    expect(bounded.coveredTo).toBeLessThan(whole.coveredTo);
  });

  it("une reprise va jusqu'au groupe qui suit celui de la position, deux secondes au moins", () => {
    expect(resumeEnd(file, 20.5, 2)).toBe(22.5);
    expect(resumeEnd(file, 20, 0.5)).toBe(22);
    expect(chunksBetween(0, CHUNK_SIZE + 1)).toEqual([0, 1]);
  });
});
