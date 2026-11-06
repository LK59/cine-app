import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { NodeWebWorker } from "./helpers/nodeWebWorker";
import type { DecodedBatch } from "@/lib/webcodecs/truehd/truehdCore";

/**
 * Le TrueHD décodé dans un worker (06/11/2026), contre le fil principal.
 *
 * Le worker exécute ici le même fichier que dans le navigateur (truehdWorker.mjs, tel quel, dans un
 * fil `worker_threads` — helpers/nodeWebWorker.ts). Les flux réels sont comparés par le banc
 * ffmpeg-wasm-regress-bench.spec.ts (FFW_WORKER=1) ; ici, les flux synthétiques du dépôt, des blocs
 * refusés et un saut.
 */

/** Les unités d'accès d'un flux TrueHD brut : la longueur, en mots de 16 bits, dans les 12 bits bas. */
function accessUnits(bytes: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  for (let at = 0; at + 4 <= bytes.length; ) {
    const length = (((bytes[at] & 0x0f) << 8) | bytes[at + 1]) * 2;
    if (length < 4) break;
    units.push(bytes.subarray(at, at + length));
    at += length;
  }
  return units;
}

const fingerprint = (batch: DecodedBatch) =>
  JSON.stringify({
    pcm: createHash("sha256").update(new Uint8Array(batch.pcm.buffer, batch.pcm.byteOffset, batch.pcm.byteLength)).digest("hex"),
    frames: [...batch.frames],
    channels: batch.channels,
    sampleRate: batch.sampleRate,
    errors: batch.errors,
  });

const realWorker = (globalThis as { Worker?: unknown }).Worker;

async function freshDecoderModule(WorkerClass: unknown) {
  vi.resetModules();
  (globalThis as { Worker?: unknown }).Worker = WorkerClass;
  return import("@/lib/webcodecs/truehd/truehdDecoder");
}

afterEach(() => {
  vi.useRealTimers();
  (globalThis as { Worker?: unknown }).Worker = realWorker;
});

/**
 * Le parcours d'une piste : des lots de 100 blocs, avec au milieu des blocs
 * refusés, un saut (`reset`) et une reprise plus loin — décodé par le décodeur donné.
 */
async function scenario(decoder: { decode(b: Uint8Array[]): Promise<DecodedBatch>; reset(): void }, units: Uint8Array[]) {
  const out: string[] = [];
  const batches: Uint8Array[][] = [];
  for (let i = 0; i < units.length; i += 100) batches.push(units.slice(i, i + 100));
  out.push(fingerprint(await decoder.decode(batches[0])));
  out.push(fingerprint(await decoder.decode([new Uint8Array(64).fill(7), ...batches[1], new Uint8Array(3000).fill(0x55)])));
  decoder.reset();
  for (const batch of batches.slice(3)) out.push(fingerprint(await decoder.decode(batch)));
  return out;
}

describe("le TrueHD dans un worker", () => {
  it.each(["mono", "stereo"])("rend au bit près ce que rend le fil principal (%s)", async (name) => {
    const units = accessUnits(new Uint8Array(readFileSync(`src/__tests__/fixtures/truehd/${name}.thd`)));
    const { TrueHdCore } = await import("@/lib/webcodecs/truehd/truehdCore");
    const core = await TrueHdCore.create(false);
    const main = await scenario({ decode: async (b) => core.decode(b), reset: () => core.reset() }, units);
    core.close();

    const { openTrueHdDecoder } = await freshDecoderModule(NodeWebWorker);
    const decoder = await openTrueHdDecoder(false);
    expect(decoder.thread).toBe("worker");
    const worker = await scenario(decoder, units);
    decoder.close();

    expect(worker).toEqual(main);
    // Le flux a bien rendu du son, et les blocs refusés ont été comptés comme sur le fil principal.
    expect(main.some((line) => JSON.parse(line).frames.some((f: number) => f > 0))).toBe(true);
    expect(JSON.parse(main[1]).errors).toBeGreaterThan(0);
  });

  it("garde l'ordre des réponses quand plusieurs lots sont en vol", async () => {
    const units = accessUnits(new Uint8Array(readFileSync("src/__tests__/fixtures/truehd/stereo.thd")));
    const { TrueHdCore } = await import("@/lib/webcodecs/truehd/truehdCore");
    const core = await TrueHdCore.create(false);
    const batches = [units.slice(0, 200), units.slice(200, 400), units.slice(400, 600)];
    const main = batches.map((b) => fingerprint(core.decode(b)));
    core.close();
    const { openTrueHdDecoder } = await freshDecoderModule(NodeWebWorker);
    const decoder = await openTrueHdDecoder(false);
    const worker = (await Promise.all(batches.map((b) => decoder.decode(b)))).map(fingerprint);
    decoder.close();
    expect(worker).toEqual(main);
  });

  it("ne vide pas le cache d'octets du lecteur : les blocs envoyés restent lisibles", async () => {
    // Les blocs sont des vues sur les morceaux de HttpByteSource ; transférer leur tampon l'aurait
    // détaché sous le lecteur.
    const units = accessUnits(new Uint8Array(readFileSync("src/__tests__/fixtures/truehd/stereo.thd")));
    const shared = units.slice(0, 50);
    const before = shared.map((u) => u.byteLength);
    const { openTrueHdDecoder } = await freshDecoderModule(NodeWebWorker);
    const decoder = await openTrueHdDecoder(false);
    await decoder.decode(shared);
    decoder.close();
    expect(shared.map((u) => u.byteLength)).toEqual(before);
    expect(shared[0].buffer.byteLength).toBeGreaterThan(0);
  });

  it("un seul worker pour la page, terminé quand plus rien n'est ouvert", async () => {
    const { openTrueHdDecoder } = await freshDecoderModule(NodeWebWorker);
    const created = NodeWebWorker.created;
    // Des reconstructions : fermer puis rouvrir, et deux ouverts en même temps.
    for (let i = 0; i < 4; i++) (await openTrueHdDecoder(false)).close();
    const a = await openTrueHdDecoder(false);
    const b = await openTrueHdDecoder(true);
    expect(NodeWebWorker.created - created).toBe(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    a.close();
    vi.advanceTimersByTime(60_000);
    // Encore un décodeur ouvert : le worker reste.
    expect(NodeWebWorker.created - created).toBe(1);
    const aliveBefore = NodeWebWorker.alive;
    b.close();
    b.close();
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(NodeWebWorker.alive).toBe(aliveBefore - 1));
    // Un film suivant en recrée un.
    const c = await openTrueHdDecoder(false);
    expect(c.thread).toBe("worker");
    expect(NodeWebWorker.created - created).toBe(2);
    c.close();
  });

  it("un décodeur fermé refuse comme celui du fil principal", async () => {
    const { openTrueHdDecoder } = await freshDecoderModule(NodeWebWorker);
    const decoder = await openTrueHdDecoder(false);
    decoder.close();
    await expect(decoder.decode([new Uint8Array(16)])).rejects.toThrow("décodeur TrueHD fermé");
  });
});

describe("le repli sur le fil principal", () => {
  it("sans worker possible, décode sur le fil principal et dit pourquoi — une fois pour la page", async () => {
    let attempts = 0;
    class Refused {
      constructor() {
        attempts++;
        throw new Error("Refused to create a worker (CSP)");
      }
    }
    const { openTrueHdDecoder } = await freshDecoderModule(Refused);
    const decoder = await openTrueHdDecoder(false);
    expect(decoder.thread).toBe("principal");
    expect(decoder.workerRefusal).toMatch(/CSP/);
    await expect(decoder.decode([new Uint8Array(16)])).resolves.toMatchObject({ frames: Int32Array.from([0]) });
    decoder.close();
    (await openTrueHdDecoder(false)).close();
    expect(attempts).toBe(1);
  });

  it("un worker qui ne démarre pas (script refusé, module inconnu) se replie aussi", async () => {
    class NeverStarts {
      onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
      onmessage = null;
      onmessageerror = null;
      constructor() {
        setTimeout(() => this.onerror?.({ message: "SyntaxError: Unexpected token 'export'", preventDefault() {} }), 0);
      }
      postMessage() {}
      terminate() {}
    }
    const { openTrueHdDecoder } = await freshDecoderModule(NeverStarts);
    const decoder = await openTrueHdDecoder(false);
    expect(decoder.thread).toBe("principal");
    expect(decoder.workerRefusal).toMatch(/Unexpected token/);
    decoder.close();
  });

  it("un worker muet est abandonné après 20 s", async () => {
    class Silent {
      onerror = null;
      onmessage = null;
      onmessageerror = null;
      postMessage() {}
      terminate() {}
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { openTrueHdDecoder } = await freshDecoderModule(Silent);
    const opening = openTrueHdDecoder(false);
    await vi.advanceTimersByTimeAsync(20_000);
    vi.useRealTimers();
    const decoder = await opening;
    expect(decoder.thread).toBe("principal");
    expect(decoder.workerRefusal).toMatch(/20 s/);
    decoder.close();
  });

  it("un worker perdu en cours de film fait échouer ce qui attendait, sans bloquer", async () => {
    class DiesOnDecode {
      onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onmessageerror = null;
      constructor() {
        setTimeout(() => this.onmessage?.({ data: { listening: true } }), 0);
      }
      postMessage(message: { op: string; req?: number }) {
        setTimeout(() => {
          if (message.op === "init") this.onmessage?.({ data: { ready: true } });
          else if (message.op === "open") this.onmessage?.({ data: { req: message.req, ok: true } });
          else if (message.op === "decode") this.onerror?.({ message: "out of memory", preventDefault() {} });
        }, 0);
      }
      terminate() {}
    }
    const { openTrueHdDecoder } = await freshDecoderModule(DiesOnDecode);
    const decoder = await openTrueHdDecoder(false);
    expect(decoder.thread).toBe("worker");
    await expect(decoder.decode([new Uint8Array(16)])).rejects.toThrow(/worker TrueHD perdu \(out of memory\)/);
    await expect(decoder.decode([new Uint8Array(16)])).rejects.toThrow(/worker TrueHD perdu/);
    decoder.close();
    // Le suivant repart d'un worker neuf, pas d'un repli : la page sait en créer.
    expect((await openTrueHdDecoder(false)).thread).toBe("worker");
  });
});

describe("au journal du lecteur", () => {
  it("la ligne start dit où le TrueHD a été décodé, et rien pour un autre film", async () => {
    vi.resetModules();
    vi.doMock("@/lib/webcodecs/truehd/truehdAudio", () => ({
      openTrueHdTrack: async () => ({
        format: { sampleRate: 48000, numberOfChannels: 8 },
        samples: async function* () {},
        close: () => {},
        thread: "principal",
        workerRefusal: "pas prêt en 20 s",
      }),
    }));
    try {
      const { SoftwareAudioTrack } = await import("@/lib/webcodecs/softwareAudio");
      const { trueHdThreadFacts } = await import("@/components/player/nativeHostHelpers");
      expect(trueHdThreadFacts()).toEqual({});
      const source = { size: 0, read: async () => new Uint8Array(0), close: () => {} };
      await SoftwareAudioTrack.open(source, 3, "A_TRUEHD");
      expect(trueHdThreadFacts()).toEqual({ truehdThread: "principal", truehdWorkerError: "pas prêt en 20 s" });
      // Lu une fois : la reconstruction suivante dira le sien.
      expect(trueHdThreadFacts()).toEqual({});
    } finally {
      vi.doUnmock("@/lib/webcodecs/truehd/truehdAudio");
    }
  });
});

describe("ce que le build en fait", () => {
  it("lance le worker par un module en ligne, jamais par new Worker(new URL(…)) que Turbopack recompile", () => {
    // Next 16.4.3 reconnaît `new Worker(<URL de new URL("./x", import.meta.url)>)`, même au travers
    // d'une variable, et en fait un worker à lui : le fichier recompilé dans ses morceaux, chargé par
    // `importScripts` dans un worker classique (lu dans la sortie du build, 06/11/2026). Le worker
    // doit exécuter les octets mêmes de truehdWorker.mjs, ceux que Node a prouvés.
    const code = readFileSync("src/lib/webcodecs/truehd/truehdDecoder.ts", "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    const created = code.match(/new Worker\(([^,)]+)/g) ?? [];
    expect(created).toEqual(["new Worker(bootstrap"]);
    expect(code).toMatch(/const bootstrap = URL\.createObjectURL\(new Blob\(\[`import \$\{JSON\.stringify\(workerUrl\.href\)\};/);
  });
});
