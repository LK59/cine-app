import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { cachedLumenIndex, clearLumenIndexCache, lumenIndexCacheStats } from "@/lib/lumenServer/indexCache";
import { inlineExecutor, LumenQueue, workerExecutor, type LumenExecutor } from "@/lib/lumenServer/pool";
import { LumenEngine } from "@/lib/lumenServer/engine";
import { lumenEligibility } from "@/lib/lumenServer/eligibility";
import { identityKey, type FileIdentity, type LumenIndex } from "@/lib/lumenServer/format";
import type { LumenJob, LumenJobResult } from "@/lib/lumenServer/jobs";
import { FIXTURES, parseFragments } from "./lumenServer-helpers";

// Le cache d'index (partagé, revérifié, borné en octets), la file (bornée en nombre et en mémoire), les
// exécutants, et le moteur que l'étape 3 appellera — de bout en bout sur un fichier des fixtures.

function fakeIndex(identity: FileIdentity, segments = 3): LumenIndex {
  return {
    format: 1,
    cut: "idr",
    identity,
    container: "matroska",
    durationUs: 1,
    video: null,
    audio: [],
    delayUs: 0,
    frameUs: 1,
    frameRate: 24,
    segments: Array.from({ length: segments }, (_, i) => ({ startUs: i, endUs: i + 1, keyUs: i, at: i, bytes: 0 })),
    keys: { cues: 0, verified: 0, rejected: 0, idr: 0, cra: 0, craRasl: 0, leading: 0, cuts: 0 },
    bandwidth: { peak: 0, average: 0 },
    refusal: null,
    inits: { video: null, audio: {} },
    cost: { ms: 0, reads: 0, bytes: 0 },
  };
}

describe("le cache d'index", () => {
  beforeEach(() => clearLumenIndexCache());

  it("partage la construction en vol et garde le résultat pour la même version du fichier", async () => {
    const identity = { path: "/f", size: 10, mtimeMs: 1, ino: 2 };
    let builds = 0;
    const build = async () => {
      builds += 1;
      await new Promise((r) => setTimeout(r, 5));
      return fakeIndex(identity);
    };
    const identify = async () => identity;
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => cachedLumenIndex("/f", build, { identify })));
    expect(builds).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    await cachedLumenIndex("/f", build, { identify });
    expect(builds).toBe(1);
    expect(lumenIndexCacheStats()).toMatchObject({ entries: 1, hits: 1 });
  });

  it("relit un fichier remplacé (taille, mtime ou inode) sans attendre l'expiration", async () => {
    let identity = { path: "/f", size: 10, mtimeMs: 1, ino: 2 };
    let builds = 0;
    const build = async () => (builds++, fakeIndex(identity));
    const identify = async () => identity;
    await cachedLumenIndex("/f", build, { identify });
    identity = { ...identity, ino: 3 };
    const fresh = await cachedLumenIndex("/f", build, { identify });
    expect(builds).toBe(2);
    expect(fresh.identity.ino).toBe(3);
    expect(lumenIndexCacheStats().entries).toBe(1);
  });

  it("borne en octets (le plus ancien utilisé part), oublie après l'inactivité, ne garde pas un échec", async () => {
    let now = 0;
    const big = (path: string) => async () => ({ ...fakeIndex({ path, size: 1, mtimeMs: 1, ino: 1 }, 5000) });
    const identify = async (path: string) => ({ path, size: 1, mtimeMs: 1, ino: 1 });
    const options = { identify, budgetBytes: 1_000_000, now: () => now };
    await cachedLumenIndex("/a", big("/a"), options);
    await cachedLumenIndex("/b", big("/b"), options);
    await cachedLumenIndex("/a", big("/a"), options); // /a redevient le plus récent
    await cachedLumenIndex("/c", big("/c"), options);
    // Chacun pèse ~480 Ko : deux tiennent, /b est parti.
    expect(lumenIndexCacheStats().entries).toBe(2);
    expect(lumenIndexCacheStats().bytes).toBeLessThanOrEqual(1_000_000);
    now += 3 * 60 * 60 * 1000;
    await cachedLumenIndex("/d", big("/d"), options);
    expect(lumenIndexCacheStats().entries).toBe(1);

    await expect(cachedLumenIndex("/e", async () => Promise.reject(new Error("disque")), options)).rejects.toThrow("disque");
    expect(lumenIndexCacheStats().inflight).toBe(0);
  });
});

describe("la file", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("borne le nombre de constructions et la mémoire, dans l'ordre d'arrivée", async () => {
    const queue = new LumenQueue({ concurrency: 2, memoryBudget: 100, maxQueued: 10 });
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const job = (name: string, cost: number) => {
      gates.set(name, deferred());
      return queue.run(cost, async () => {
        started.push(name);
        await gates.get(name)!.promise;
        return name;
      });
    };
    const results = [job("a", 60), job("b", 30), job("c", 50), job("d", 10)];
    await Promise.resolve();
    // a et b tiennent (90) ; c (50) dépasserait le budget, et d attend derrière lui (pas de dépassement).
    expect(started).toEqual(["a", "b"]);
    gates.get("a")!.resolve();
    await results[0];
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a", "b", "c", "d"].slice(0, 3));
    gates.get("b")!.resolve();
    gates.get("c")!.resolve();
    await Promise.all(results.slice(1, 3));
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a", "b", "c", "d"]);
    gates.get("d")!.resolve();
    expect(await Promise.all(results)).toEqual(["a", "b", "c", "d"]);
    expect(queue.peakBytes).toBeLessThanOrEqual(100);
  });

  it("laisse passer seul un travail plus lourd que tout le budget, et refuse au-delà de la file", async () => {
    const queue = new LumenQueue({ concurrency: 1, memoryBudget: 10, maxQueued: 1 });
    const gate = deferred();
    const heavy = queue.run(1000, () => gate.promise.then(() => "lourd"));
    const waiting = queue.run(1, async () => "petit");
    await expect(queue.run(1, async () => "trop")).rejects.toMatchObject({ code: "occupe" });
    gate.resolve();
    expect(await Promise.all([heavy, waiting])).toEqual(["lourd", "petit"]);
  });
});

describe("l'exécutant à fils", () => {
  it("passe les travaux à de vrais worker_threads, transfère les octets, remonte les erreurs nettes, remplace un fil mort", async () => {
    // Un fil qui parle le protocole de worker.ts sans charger le moteur : le moteur réel, empaqueté,
    // est éprouvé par le banc (tools/lumen-worker/build.mjs).
    const script = `
      import { parentPort, workerData } from "node:worker_threads";
      if (!workerData.lumenWorker) throw new Error("workerData");
      parentPort.on("message", ({ id, job }) => {
        if (job.path === "/mort") process.exit(3);
        if (job.path === "/erreur") return parentPort.postMessage({ id, ok: false, error: { message: "changé", code: "fichier-change" } });
        const bytes = new Uint8Array(1 << 20).fill(7);
        parentPort.postMessage({ id, ok: true, result: { type: "segment", result: { bytes, facts: {} }, cost: {} } }, [bytes.buffer]);
      });`;
    const executor = workerExecutor(new URL(`data:text/javascript,${encodeURIComponent(script)}`), 2);
    try {
      const results = await Promise.all([1, 2, 3].map((i) => executor.run({ type: "index", path: `/f${i}` })));
      for (const r of results) {
        if (r.type !== "segment") throw new Error("type");
        expect(r.result.bytes.length).toBe(1 << 20);
      }
      await expect(executor.run({ type: "index", path: "/erreur" })).rejects.toMatchObject({ code: "fichier-change" });
      await expect(executor.run({ type: "index", path: "/mort" })).rejects.toThrow(/arrêté/);
      const after = await executor.run({ type: "index", path: "/encore" });
      expect(after.type).toBe("segment");
    } finally {
      await executor.close();
    }
  });
});

describe("le moteur, de bout en bout", () => {
  beforeEach(() => clearLumenIndexCache());

  it("index, éligibilité, listes, init et segments d'un fichier, par la file et un exécutant", async () => {
    const calls: LumenJob["type"][] = [];
    const inline = inlineExecutor();
    const counting: LumenExecutor = { kind: "inline", run: (job: LumenJob): Promise<LumenJobResult> => (calls.push(job.type), inline.run(job)), close: inline.close };
    const engine = new LumenEngine({ executor: counting });
    const path = join(FIXTURES, "h264-aac.mkv");
    const [index, again] = await Promise.all([engine.index(path, 1_000_000), engine.index(path, 1_000_000)]);
    expect(index).toBe(again);
    expect(calls).toEqual(["index"]);
    expect(identityKey(index.identity)).toContain("h264-aac.mkv");

    const track = index.audio[0].number;
    expect(lumenEligibility(index, track)).toEqual({ ok: true });
    expect(engine.master(index, { audioTrack: track, labels: { locale: "en", canaux: (n) => `${n} ch`, piste: (n) => `Track ${n}` } })).toContain(`URI="a${track}.m3u8"`);
    expect(engine.playlist(index, { kind: "video" })).toContain("v/5.m4s");
    expect(engine.init(index, { kind: "audio", track }).length).toBeGreaterThan(100);

    const resolved = engine.resolve(index, `a${track}/2.m4s`);
    expect(resolved).toEqual({ kind: "segment", rendition: { kind: "audio", track }, n: 2 });
    expect(engine.resolve(index, "v/6.m4s")).toBeNull();
    expect(engine.resolve(index, "a9.m3u8")).toBeNull();

    const segment = await engine.segment(index, { kind: "video" }, 2);
    const fragments = parseFragments(segment.bytes);
    expect(fragments[0].sequence).toBe(2001);
    expect(segment.cost.reads).toBeGreaterThan(0);
    expect(calls).toEqual(["index", "segment"]);
    await engine.close();
  });
});
