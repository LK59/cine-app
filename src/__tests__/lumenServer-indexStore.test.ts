import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lumenIndexStore, storeKey } from "@/lib/lumenServer/indexStore";
import { LumenEngine } from "@/lib/lumenServer/engine";
import { clearLumenIndexCache } from "@/lib/lumenServer/indexCache";
import { inlineExecutor } from "@/lib/lumenServer/pool";
import { runLumenJob, type LumenJob } from "@/lib/lumenServer/jobs";
import { LUMEN_FORMAT_VERSION, type FileIdentity, type LumenIndex } from "@/lib/lumenServer/format";
import { FIXTURES } from "./lumenServer-helpers";

// Le cache disque des index de Lumen serveur (DECISIONS.md §156) : relu identique (octets des init
// compris), jamais pour une autre version du fichier ou du format, effacé s'il est illisible, borné en
// octets avec le moins récemment lu évincé d'abord — et branché sur le moteur avant toute construction.

function fakeIndex(identity: FileIdentity, padding = 0): LumenIndex {
  return {
    format: LUMEN_FORMAT_VERSION,
    identity,
    container: "matroska",
    durationUs: 6_000_000,
    video: null,
    audio: [],
    delayUs: 0,
    frameUs: 41_667,
    frameRate: 24,
    segments: [{ startUs: 0, endUs: 6_000_000, keyUs: 0, at: 0, bytes: 10 }],
    keys: { cues: 1, verified: 1, rejected: 0, idr: 1, cra: 0, craRasl: 0, leading: 0, cuts: 1 },
    bandwidth: { peak: 1, average: 1 },
    refusal: null,
    inits: { video: new Uint8Array(padding).fill(9), audio: { 2: new Uint8Array([1, 2, 3]) } },
    cost: { ms: 1, reads: 1, bytes: 1 },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "laterna-lumen-store-"));
  clearLumenIndexCache();
});

describe("le cache disque des index", () => {
  const id = { path: "/m/film.mkv", size: 100, mtimeMs: 1700000000123.5, ino: 42 };

  it("relit l'index tel qu'écrit, tableaux d'octets compris", async () => {
    const store = lumenIndexStore(dir);
    expect(await store.get(id)).toBeNull();
    await store.put(fakeIndex(id, 16));
    const back = await store.get(id);
    expect(back).toEqual(fakeIndex(id, 16));
    expect(back!.inits.video).toBeInstanceOf(Uint8Array);
  });

  it("ne sert jamais un index d'une autre version du fichier, ni d'une autre cible de segment", async () => {
    const store = lumenIndexStore(dir);
    await store.put(fakeIndex(id));
    for (const other of [{ ...id, size: 101 }, { ...id, mtimeMs: id.mtimeMs + 1 }, { ...id, ino: 43 }, { ...id, path: "/m/autre.mkv" }]) {
      expect(await store.get(other)).toBeNull();
    }
    expect(await store.get(id, 6_000_000)).toBeNull();
    expect(storeKey(id)).toContain(`|${LUMEN_FORMAT_VERSION}|`);
  });

  it("un fichier illisible est une absence, et il est effacé", async () => {
    const store = lumenIndexStore(dir);
    await store.put(fakeIndex(id));
    const [name] = readdirSync(dir);
    writeFileSync(join(dir, name), "pas un index");
    expect(await store.get(id)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("borné en octets : le moins récemment lu part d'abord", async () => {
    const store = lumenIndexStore(dir, { maxBytes: 3000 });
    const ids = [1, 2, 3].map((ino) => ({ ...id, ino }));
    await store.put(fakeIndex(ids[0], 900));
    await store.put(fakeIndex(ids[1], 900));
    // Les dates du disque ont une résolution limitée : on vieillit les deux premiers à la main.
    for (const [i, f] of readdirSync(dir).entries()) utimesSync(join(dir, f), new Date(1000 + i), new Date(1000 + i));
    expect(await store.get(ids[0])).not.toBeNull(); // relu : devient le plus récent
    await store.put(fakeIndex(ids[2], 900));
    const sizes = readdirSync(dir).map((f) => statSync(join(dir, f)).size);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3000);
    expect(await store.get(ids[0])).not.toBeNull();
    expect(await store.get(ids[1])).toBeNull();
    expect(await store.get(ids[2])).not.toBeNull();
  });

  it("le moteur le lit avant de construire, et l'écrit après", async () => {
    const jobs: LumenJob["type"][] = [];
    const executor = inlineExecutor(async (job) => {
      jobs.push(job.type);
      return runLumenJob(job);
    });
    const path = join(process.cwd(), FIXTURES, "h264-aac.mkv");
    const first = new LumenEngine({ executor, store: lumenIndexStore(dir) });
    const built = await first.index(path);
    expect(first.builds).toEqual({ built: 1, fromStore: 0 });
    clearLumenIndexCache();
    const second = new LumenEngine({ executor, store: lumenIndexStore(dir) });
    const kept = await second.index(path);
    expect(second.builds).toEqual({ built: 0, fromStore: 1 });
    expect(jobs).toEqual(["index"]);
    expect(kept).toEqual(built);
    // Les segments se construisent pareil depuis l'index relu.
    const a = await first.segment(built, { kind: "video" }, 0);
    const b = await second.segment(kept, { kind: "video" }, 0);
    expect(Buffer.from(b.bytes).equals(Buffer.from(a.bytes))).toBe(true);
  });
});
