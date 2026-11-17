// Le service de la version allégée (`light/service.ts`) sans iGPU : un encodeur simulé rend un flux HEVC du bon nombre
// d'images. Ce qui se vérifie : la mémoire puis le disque, l'avance derrière une demande, le plafond d'encodages
// simultanés, une demande qui passe devant l'avance, et l'encodeur absent qui répond « occupé » (503), jamais 404.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LumenIndex } from "@/lib/lumenServer/format";

const runs: { frames: number; release: () => void }[] = [];
let encoderAvailable = true;
let holdRuns = false;

vi.mock("@/lib/lumenServer/light/encoder", async (orig) => {
  const actual = await orig<typeof import("@/lib/lumenServer/light/encoder")>();
  return {
    ...actual,
    detectLightEncoder: async () => (encoderAvailable ? { available: true, path: "/usr/bin/ffmpeg", version: "8.1.3", driver: "simulé", detectedAt: 0, ms: 0 } : { available: false, path: "/usr/bin/ffmpeg", reason: "pas de iGPU", detectedAt: 0 }),
    runEncoder: async (_path: string, args: readonly string[]) => {
      const frames = Number(args[args.indexOf("-frames:v") + 1]);
      if (holdRuns) await new Promise<void>((resolve) => runs.push({ frames, release: resolve }));
      else runs.push({ frames, release: () => {} });
      const nal = (type: number, ...p: number[]) => [0, 0, 0, 1, type << 1, 1, ...p];
      const stream = Array.from({ length: frames }, (_, i) => (i === 0 ? [...nal(32, 1), ...nal(33, 2), ...nal(34, 3), ...nal(19, 0x80, 1)] : nal(1, 0x80, i))).flat();
      return { stdout: Uint8Array.from(stream), stderr: "", ms: 5 };
    },
  };
});

const { lightSegmentFor, prefetch, lightStats, __testing } = await import("@/lib/lumenServer/light/service");
const { originTimes } = await import("@/lib/lumenServer/light/bitstream");
const { withLight } = await import("@/lib/lumenServer/light/view");
const { buildSegment, segmentSpec } = await import("@/lib/lumenServer/segment");
const { openMediaFile } = await import("@/lib/webcodecs/mediaFile");
const { fixtureIndex } = await import("./lumenServer-helpers");

let dir: string;
let index: LumenIndex;
let origin: (n: number) => Promise<Uint8Array>;
let close: () => void;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lumen-light-"));
  process.env.LUMEN_LIGHT_CACHE_DIR = dir;
  const { index: raw, source } = await fixtureIndex("hevc-cra.mkv");
  close = () => source.close();
  const file = await openMediaFile(source);
  // Le fixture découpé en segments d'une image clé chacun serait trop court : deux segments suffisent, on les répète.
  index = withLight({ ...raw, bandwidth: { peak: 40e6, average: 25e6 } }, { version: "8.1.3", driver: "simulé" });
  origin = async (n) => (await buildSegment(source, file, segmentSpec(index, { kind: "video" }, n % raw.segments.length))).bytes;
});
afterAll(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LUMEN_LIGHT_CACHE_DIR;
});
beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  __testing.reset();
  runs.length = 0;
  encoderAvailable = true;
  holdRuns = false;
});

describe("le service de la version allégée", () => {
  it("encodé une fois, puis de la mémoire ; les mêmes images que l'origine", async () => {
    const rung = index.light![0];
    const first = await lightSegmentFor({ index, rung, n: 0, origin });
    expect(first.from).toBe("built");
    expect(runs[0].frames).toBe(originTimes(await origin(0)).presentations.length);
    const again = await lightSegmentFor({ index, rung, n: 0, origin });
    expect(again.from).toBe("ram");
    expect(again.bytes).toEqual(first.bytes);
  });

  it("gardé sur le disque : un processus neuf (mémoire vide) le relit sans encoder", async () => {
    const rung = index.light![1];
    await lightSegmentFor({ index, rung, n: 1, origin });
    await vi.waitFor(() => expect(readdirSync(dir, { recursive: true }).some((f) => String(f).endsWith("1.m4s"))).toBe(true));
    __testing.reset();
    runs.length = 0;
    const again = await lightSegmentFor({ index, rung, n: 1, origin });
    expect(again.from).toBe("disk");
    expect(runs.length).toBe(0);
  });

  it("l'avance : les segments suivants préparés derrière une demande, jamais au-delà du film", async () => {
    const rung = index.light![0];
    await lightSegmentFor({ index, rung, n: 0, origin });
    // Le fixture n'a que deux segments : l'avance s'arrête au dernier.
    await vi.waitFor(() => expect(runs.length).toBe(2));
    expect(lightStats().prefetched).toBe(1);
  });

  it("au plus `LUMEN_LIGHT_MAX_JOBS` encodages à la fois ; une demande passe devant l'avance en attente", async () => {
    process.env.LUMEN_LIGHT_MAX_JOBS = "1";
    holdRuns = true;
    const big = { ...index, segments: Array.from({ length: 10 }, (_, k) => index.segments[k % index.segments.length]) };
    const rung = big.light![0];
    prefetch({ index: big, rung, origin }, 2, 3);
    await vi.waitFor(() => expect(runs.length).toBe(1));
    expect(lightStats().running).toBe(1);
    expect(lightStats().queued).toBe(2);
    const demanded = lightSegmentFor({ index: big, rung, n: 7, origin });
    await vi.waitFor(() => expect(lightStats().queued).toBe(3));
    runs[0].release();
    // La demande (n = 7) est servie avant les deux avances restantes (3 et 4).
    await vi.waitFor(() => expect(runs.length).toBe(2));
    expect(__testing.state().queue.map((j) => j.key.split("/").pop())).toEqual(["3.m4s", "4.m4s"]);
    runs[1].release();
    await demanded;
    holdRuns = false;
    for (const r of runs) r.release();
    delete process.env.LUMEN_LIGHT_MAX_JOBS;
  });

  it("sans encodeur : « occupé » (503 à la route), jamais 404", async () => {
    encoderAvailable = false;
    await expect(lightSegmentFor({ index, rung: index.light![0], n: 0, origin })).rejects.toMatchObject({ code: "occupe" });
  });
});
