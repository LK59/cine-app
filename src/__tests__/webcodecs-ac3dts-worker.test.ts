import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { NodeWebWorker } from "./helpers/nodeWebWorker";
import type { DecodedBatch } from "@/lib/webcodecs/truehd/truehdCore";

/**
 * Les décodeurs AC-3, E-AC3 et DTS de FFmpeg 7.1.5 (tools/ac3dts-wasm, essai demux-son du 19/11/2026)
 * dans le worker du TrueHD, contre le fil principal — même fichier de worker, autre module. Les flux
 * réels sont comparés par demux-son-decodeurs.spec.ts (identiques à l'échantillon à mediabunny).
 */

/** Les trames d'un flux brut, coupées à chaque mot de synchronisation (flux synthétiques seulement). */
function frames(bytes: Uint8Array, sync: number[]): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + sync.length <= bytes.length; i++) if (sync.every((b, k) => bytes[i + k] === b)) starts.push(i);
  return starts.map((s, i) => bytes.subarray(s, starts[i + 1] ?? bytes.length));
}

const FIXTURES = {
  ac3: { which: 0 as const, sync: [0x0b, 0x77] },
  eac3: { which: 1 as const, sync: [0x0b, 0x77] },
  dts: { which: 2 as const, sync: [0x7f, 0xfe, 0x80, 0x01] },
};

const fingerprint = (batch: DecodedBatch) =>
  JSON.stringify({
    pcm: createHash("sha256").update(new Uint8Array(batch.pcm.buffer, batch.pcm.byteOffset, batch.pcm.byteLength)).digest("hex"),
    frames: [...batch.frames],
    channels: batch.channels,
    sampleRate: batch.sampleRate,
  });

const rms = (batch: DecodedBatch, channel: number) => {
  let sum = 0;
  let n = 0;
  for (let i = channel; i < batch.pcm.length; i += batch.channels) {
    sum += batch.pcm[i] * batch.pcm[i];
    n++;
  }
  return 20 * Math.log10(Math.sqrt(sum / n));
};

const realWorker = (globalThis as { Worker?: unknown }).Worker;

async function freshDecoderModule(WorkerClass: unknown) {
  vi.resetModules();
  (globalThis as { Worker?: unknown }).Worker = WorkerClass;
  return import("@/lib/webcodecs/truehd/truehdDecoder");
}

afterEach(() => {
  (globalThis as { Worker?: unknown }).Worker = realWorker;
});

describe("AC-3, E-AC3 et DTS de FFmpeg 7.1.5 dans le worker", () => {
  it.each(Object.keys(FIXTURES) as (keyof typeof FIXTURES)[])("rend au bit près ce que rend le fil principal (%s)", async (name) => {
    const { which, sync } = FIXTURES[name];
    const units = frames(new Uint8Array(readFileSync(`src/__tests__/fixtures/ac3dts/stereo.${name}`)), sync);
    expect(units.length).toBeGreaterThan(5);
    const half = Math.floor(units.length / 2);
    const { Ac3DtsCore } = await import("@/lib/webcodecs/ac3dts/ac3dtsCore");
    const core = await Ac3DtsCore.create(which);
    const main = [core.decode(units.slice(0, half)), core.decode(units.slice(half))];
    core.close();

    const { openAc3DtsDecoder } = await freshDecoderModule(NodeWebWorker);
    const decoder = await openAc3DtsDecoder(which);
    expect(decoder.thread).toBe("worker");
    const worker = [await decoder.decode(units.slice(0, half)), await decoder.decode(units.slice(half))];
    decoder.close();

    expect(worker.map(fingerprint)).toEqual(main.map(fingerprint));
    // Du son, et chaque canal à sa place : la gauche (440 Hz à 1/16) bien plus forte que la droite (1/80).
    expect(main[1].channels).toBe(2);
    expect(rms(main[1], 0) - rms(main[1], 1)).toBeGreaterThan(10);
  });

  it("un worker par module : le TrueHD et l'AC-3 ne partagent ni worker ni module", async () => {
    const { openAc3DtsDecoder, openTrueHdDecoder } = await freshDecoderModule(NodeWebWorker);
    const created = NodeWebWorker.created;
    const a = await openAc3DtsDecoder(0);
    const b = await openAc3DtsDecoder(2);
    const t = await openTrueHdDecoder(false);
    expect(NodeWebWorker.created - created).toBe(2);
    expect([a.thread, b.thread, t.thread]).toEqual(["worker", "worker", "worker"]);
    a.close();
    b.close();
    t.close();
  });

  it("sans Worker : le fil principal, et la raison", async () => {
    const { openAc3DtsDecoder } = await freshDecoderModule(undefined);
    const decoder = await openAc3DtsDecoder(1);
    expect(decoder.thread).toBe("principal");
    expect(decoder.workerRefusal).toBe("pas de Worker");
    decoder.close();
  });
});
