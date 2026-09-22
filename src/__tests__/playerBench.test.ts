import { describe, it, expect } from "vitest";
import { readPlayback, seededPositions, type Sample } from "@/lib/playerBench/measure";
import { runBench, estimateSeconds, type BenchDeps, type ItemResult } from "@/lib/playerBench/runner";
import type { BenchBridge } from "@/lib/playerBench/bridge";

// Le banc d'essai lui-même, sans navigateur : ses lectures de courbes, puis ses scénarios joués
// sur un lecteur simulé — sain, puis porteur des pannes que le banc existe pour trouver.

const samples = (n: number, f: (i: number) => Partial<Sample>): Sample[] =>
  Array.from({ length: n }, (_, i) => ({ wall: i * 250, time: i * 0.25, frames: i * 6, paused: false, seeking: false, ...f(i) }));

describe("readPlayback", () => {
  it("lit une lecture normale comme telle", () => {
    const r = readPlayback(samples(17, () => ({})));
    expect(r.verdict).toBe("ok");
    expect(r.clockSeconds).toBeCloseTo(4, 1);
    expect(r.fps).toBeCloseTo(24, 0);
  });

  it("voit l'horloge qui avance sans image (2012 sur iPhone, 22/09/2026)", () => {
    const r = readPlayback(samples(17, () => ({ frames: 100 })));
    expect(r.verdict).toBe("fail");
    expect(r.problems.join()).toMatch(/sans image/);
  });

  it("voit l'horloge immobile hors pause (1917 sur iPhone)", () => {
    const r = readPlayback(samples(17, (i) => ({ time: i < 4 ? i * 0.25 : 1, frames: 24 })));
    expect(r.verdict).toBe("fail");
    expect(r.longestFreezeMs).toBeGreaterThanOrEqual(2500);
  });

  it("voit un saut que personne n'a demandé", () => {
    const r = readPlayback(samples(17, (i) => ({ time: i < 8 ? i * 0.25 : 300 + i * 0.25, frames: i * 6 })));
    expect(r.verdict).toBe("fail");
    expect(r.jumps).toBe(1);
  });

  it("ne compte pas une pause voulue contre le rythme", () => {
    expect(readPlayback(samples(17, () => ({ paused: true, time: 5 }))).problems).toEqual(["resté en pause"]);
  });

  it("tire des positions reproductibles, dans le film", () => {
    const a = seededPositions("abc", 5, 6000);
    expect(seededPositions("abc", 5, 6000)).toEqual(a);
    expect(seededPositions("abd", 5, 6000)).not.toEqual(a);
    for (const p of a) {
      expect(p).toBeGreaterThanOrEqual(300);
      expect(p).toBeLessThanOrEqual(5400);
    }
  });
});

/** Un lecteur simulé, sur une horloge simulée. `faults` y met les pannes à trouver. */
function simulated(faults: { runawayAfterSeek?: boolean; losePause?: boolean; vanishOnAudio?: boolean } = {}) {
  let now = 0;
  const media = {
    currentTime: 0,
    paused: true,
    seeking: false,
    duration: 3600,
    play: async () => void (media.paused = false),
    pause: () => void (media.paused = true),
  };
  let frames = 0;
  let framesStuck = false;
  let ready = false;
  let readyAt = 800;
  let audio = 1;
  let subtitle: number | null = null;
  let open: string | null = null;
  const bridge: BenchBridge = {
    itemId: "film",
    media: () => media as unknown as HTMLVideoElement,
    path: () => "remux",
    ready: () => ready,
    error: () => null,
    duration: () => media.duration,
    seek: (s) => {
      media.currentTime = s;
      if (faults.runawayAfterSeek) framesStuck = true;
    },
    audioTracks: () => [{ id: 1, label: "Français" }, { id: 2, label: "Anglais" }],
    currentAudio: () => audio,
    changeAudio: (id) => {
      if (faults.vanishOnAudio) {
        open = null;
        return;
      }
      audio = id;
      ready = false;
      readyAt = now + 600;
      if (faults.losePause) media.paused = false;
    },
    subtitleTracks: () => [{ id: 5, label: "Français — forcés" }],
    currentSubtitle: () => subtitle,
    changeSubtitle: (id) => void (subtitle = id),
    subtitleText: () => (subtitle !== null ? "Bonjour" : null),
    frames: () => frames,
    trace: () => "trace",
    facts: () => ({ recoveries: 0 }),
  };
  const reports: ItemResult[] = [];
  const deps: BenchDeps = {
    open: () => {
      open = "film";
      readyAt = now + 800;
      media.paused = false;
    },
    close: () => void (open = null),
    bridge: () => (open ? bridge : null),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      if (!ready && now >= readyAt) ready = true;
      if (ready && !media.paused) {
        media.currentTime += ms / 1000;
        if (!framesStuck) frames += Math.round((ms / 1000) * 24);
      }
    },
    ask: async () => "yes",
    progress: () => {},
    cancelled: () => false,
    report: (r) => void reports.push(r),
  };
  return { deps, reports };
}

const CONFIG = { runId: "t", items: [{ itemId: "film", title: "Film" }], depth: "full" as const, interactive: true };

describe("runBench", () => {
  it("passe tout sur un lecteur sain, et le dit", async () => {
    const { deps, reports } = simulated();
    const [result] = await runBench(CONFIG, deps);
    const failed = result.checks.filter((c) => c.verdict === "fail" || c.verdict === "warn");
    expect(failed).toEqual([]);
    expect(result.verdict).toBe("ok");
    expect(reports).toHaveLength(1);
    // Tout ce qui est annoncé a été joué.
    const ids = result.checks.map((c) => c.id);
    for (const id of ["open", "play", "seek-far", "seek-back-10", "burst", "pause", "paused-seek", "audio-2", "seek-then-audio", "audio-paused", "subtitles-5", "long-play", "question:sync"]) {
      expect(ids).toContain(id);
    }
  });

  it("trouve l'horloge qui court sans image après un saut", async () => {
    const { deps } = simulated({ runawayAfterSeek: true });
    const [result] = await runBench(CONFIG, deps);
    const seek = result.checks.find((c) => c.id === "seek-far")!;
    expect(seek.verdict).toBe("fail");
    expect(seek.detail).toMatch(/sans image/);
    expect(seek.steps).toBe("trace");
  });

  it("trouve une pause perdue au changement de piste", async () => {
    const { deps } = simulated({ losePause: true });
    const [result] = await runBench(CONFIG, deps);
    expect(result.checks.find((c) => c.id === "audio-paused")?.detail).toMatch(/pause n'a pas été gardée/);
  });

  it("note un lecteur qui disparaît, et passe au film suivant", async () => {
    const { deps } = simulated({ vanishOnAudio: true });
    const results = await runBench({ ...CONFIG, items: [CONFIG.items[0], CONFIG.items[0]] }, deps);
    expect(results).toHaveLength(2);
    expect(results[0].checks.at(-1)).toMatchObject({ id: "lost", verdict: "fail" });
  });

  it("annonce sa durée", () => {
    expect(estimateSeconds("full", 8, false)).toBe(1600);
    expect(estimateSeconds("quick", 4, true)).toBe(480);
  });
});
