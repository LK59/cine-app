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

  it("voit des saccades quand on connaît la cadence du fichier", () => {
    // 18 images/s pour un film à 24 : l'horloge va bien, l'image non.
    const judder = samples(41, (i) => ({ frames: Math.round(i * 4.5) }));
    expect(readPlayback(judder).verdict).toBe("ok");
    const r = readPlayback(judder, 24);
    expect(r.verdict).toBe("warn");
    expect(r.problems.join()).toMatch(/saccades : 18 images\/s pour 24/);
    expect(readPlayback(samples(41, () => ({})), 24).verdict).toBe("ok");
  });

  it("ne juge pas les images sur la fenêtre qui suit un saut", () => {
    // Banc iPhone du 22/09/2026 : `totalVideoFrames` compte le décodage, qui court en avance. Après
    // un saut il rattrape — 43 à 95 im/s sur des fichiers à 24 — et après une rafale tout est déjà
    // décodé : 1,8 im/s, lu comme « l'horloge avance sans image ». Faux dans les deux sens.
    const stalled = samples(17, () => ({ frames: 100 }));
    expect(readPlayback(stalled, 24).verdict).toBe("fail");
    const r = readPlayback(stalled, 24, { frames: false });
    expect(r.verdict).toBe("ok");
    expect(r.fps).toBeNull();
    expect(r.problems.join()).toMatch(/images non comptées/);
  });

  it("juge toujours l'horloge, elle, sur la fenêtre qui suit un saut", () => {
    // Ce que l'option écarte, ce sont les images — pas une horloge immobile ni un saut subi.
    const frozen = samples(17, (i) => ({ time: i < 4 ? i * 0.25 : 1, frames: i * 6 }));
    expect(readPlayback(frozen, 24, { frames: false }).verdict).toBe("fail");
  });

  it("ne juge pas les images d'une fenêtre qui contient un saut", () => {
    // Banc du 22/09/2026 : deux échecs annoncés à tort — « 2,1 images/s » sur un saut arrivé en
    // 1,1 s, et 66 à 107 images/s sur des fichiers à 24. Le compteur d'images n'est pas comparable
    // à l'horloge de part et d'autre d'un saut ; le coût du saut se mesure à son arrivée.
    const r = readPlayback(samples(17, (i) => ({ frames: 0, seeking: i > 3 && i < 8 })), 24);
    expect(r.verdict).toBe("ok");
    expect(r.problems.join()).toMatch(/saut dans la fenêtre/);
    expect(r.fps).toBeNull();
  });

  it("ne juge pas les images quand le compteur est reparti de zéro", () => {
    // Une reconstruction remet à zéro les images présentées : la soustraction devient négative.
    const r = readPlayback(samples(17, (i) => ({ frames: i < 8 ? 500 + i * 6 : (i - 8) * 6 })), 24);
    expect(r.verdict).toBe("ok");
    expect(r.problems.join()).toMatch(/reconstruction dans la fenêtre/);
  });

  it("ne juge pas les images d'une fenêtre cachée, et le note", () => {
    // Chrome cesse de dessiner la vidéo d'une fenêtre cachée ou recouverte, le son continue.
    const r = readPlayback(samples(17, (i) => ({ frames: 0, hidden: i > 4 })), 24);
    expect(r.verdict).toBe("ok");
    expect(r.problems).toEqual(["fenêtre cachée : images non comptées"]);
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
function simulated(
  faults: { runawayAfterSeek?: boolean; losePause?: boolean; vanishOnAudio?: boolean; landsLate?: boolean; losePosition?: boolean; landsAtOpen?: boolean } = {}
) {
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
  let placeAt: { at: number; time: number } | null = null;
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
      // Le lecteur neuf, prêt avant d'avoir posé sa tête : elle est à 0 un instant.
      if (faults.landsLate || faults.losePosition) {
        placeAt = { at: now + 900, time: media.currentTime };
        media.currentTime = 0;
        if (faults.losePosition) placeAt = null;
      }
      if (faults.losePause) media.paused = false;
    },
    subtitleTracks: () => [{ id: 5, label: "Français — forcés" }],
    currentSubtitle: () => subtitle,
    changeSubtitle: (id) => void (subtitle = id),
    subtitleText: () => (subtitle !== null ? "Bonjour" : null),
    frames: () => frames,
    nominalFps: () => 24,
    trace: () => "trace",
    facts: () => ({ recoveries: 0 }),
  };
  const reports: ItemResult[] = [];
  const deps: BenchDeps = {
    open: () => {
      open = "film";
      readyAt = now + 800;
      media.paused = false;
      // Un fichier à images B : le premier média commence à 1,3 s, et la tête y est posée.
      if (faults.landsAtOpen) placeAt = { at: now + 1000, time: 1.5 };
    },
    close: () => void (open = null),
    bridge: () => (open ? bridge : null),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      if (!ready && now >= readyAt) ready = true;
      if (placeAt && now >= placeAt.at) {
        media.currentTime = placeAt.time;
        placeAt = null;
      }
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

  it("ne juge pas un film confié au lecteur serveur", async () => {
    // 22/09/2026 : après une demande de diffusion, le film reste au lecteur serveur pour toute la
    // session. Le banc l'ouvrait quand même, n'en voyait jamais la première image, et concluait
    // « échec » au bout de 45 s — deux fois sur quatre passages du soir.
    const { deps, reports } = simulated();
    const [result] = await runBench(CONFIG, { ...deps, handedOver: () => true });
    expect(result.verdict).toBe("skip");
    expect(result.checks).toEqual([{ id: "handed-over", verdict: "skip", detail: "confié au lecteur serveur : rien à mesurer ici" }]);
    expect(reports).toHaveLength(1);
  });

  it("trouve l'horloge qui court sans image, sur la première lecture franche", async () => {
    // Le saut lui-même ne peut pas le dire : le compteur d'images est celui du décodage, qui court
    // en avance et rattrape après un saut (22/09/2026 — voir `ReadOptions.frames`). Une image
    // vraiment figée, elle, le reste : la lecture posée qui suit la voit.
    const { deps } = simulated({ runawayAfterSeek: true });
    const [result] = await runBench(CONFIG, deps);
    expect(result.checks.find((c) => c.id === "seek-far")!.verdict).toBe("ok");
    const caught = result.checks.filter((c) => c.verdict === "fail" && /sans image/.test(c.detail));
    expect(caught.map((c) => c.id)).toContain("long-play");
    expect(caught[0].steps).toBe("trace");
  });

  it("trouve une pause perdue au changement de piste", async () => {
    const { deps } = simulated({ losePause: true });
    const [result] = await runBench(CONFIG, deps);
    expect(result.checks.find((c) => c.id === "audio-paused")?.detail).toMatch(/pause n'a pas été gardée/);
  });

  it("attend que la tête soit reposée avant de mesurer un changement de piste", async () => {
    const { deps } = simulated({ landsLate: true });
    const [result] = await runBench(CONFIG, deps);
    expect(result.checks.filter((c) => c.id.startsWith("audio") && c.verdict !== "ok")).toEqual([]);
  });

  it("trouve un changement de piste qui rouvre au début du film", async () => {
    const { deps } = simulated({ losePosition: true });
    const [result] = await runBench(CONFIG, deps);
    expect(result.checks.find((c) => c.id === "audio-2")).toMatchObject({ verdict: "fail" });
    expect(result.checks.find((c) => c.id === "audio-2")?.detail).toMatch(/pas rouvert au bon endroit/);
  });

  it("ne prend pas l'atterrissage de l'ouverture pour un saut", async () => {
    const { deps } = simulated({ landsAtOpen: true });
    const [result] = await runBench({ ...CONFIG, depth: "quick" }, deps);
    expect(result.checks.find((c) => c.id === "play")?.verdict).toBe("ok");
  });

  it("note un lecteur qui disparaît, et passe au film suivant", async () => {
    const { deps } = simulated({ vanishOnAudio: true });
    const results = await runBench({ ...CONFIG, items: [CONFIG.items[0], CONFIG.items[0]] }, deps);
    expect(results).toHaveLength(2);
    expect(results[0].checks.at(-1)).toMatchObject({ id: "lost", verdict: "fail" });
  });

  it("joue tous les scénarios du mode extrême sur un lecteur sain, sans échec", async () => {
    const { deps } = simulated();
    const [result] = await runBench({ ...CONFIG, depth: "extreme", interactive: false }, deps);
    const ids = result.checks.map((c) => c.id);
    for (const id of ["x-storm", "x-pingpong", "x-steps", "x-seek-audio-seek", "x-audio-storm", "x-pause-storm", "x-subs-storm", "x-edge-start", "x-edge-end", "x-after-end", "x-beyond-end", "x-reopen"]) {
      expect(ids).toContain(id);
    }
    expect(result.checks.filter((c) => c.verdict === "fail")).toEqual([]);
    // Le parcours ordinaire ne se joue pas en plus.
    expect(ids).not.toContain("seek-far");
  });

  it("trouve, en mode extrême, un lecteur qui perd la position d'un changement de langue", async () => {
    const { deps } = simulated({ losePosition: true });
    const [result] = await runBench({ ...CONFIG, depth: "extreme", interactive: false }, deps);
    expect(result.verdict).toBe("fail");
  });

  it("ne compte pas l'attente d'un toucher dans le temps de réouverture", async () => {
    // Banc du 22/09/2026 : « rouvert en 393 s » — le film ouvert en 0,3 s, puis six minutes à
    // attendre que quelqu'un touche l'écran, parce que Safari exige un geste.
    const { deps } = simulated();
    let refuse = false;
    const originalOpen = deps.open;
    deps.open = (item) => {
      originalOpen(item);
      refuse = true;
    };
    const originalBridge = deps.bridge;
    deps.bridge = () => {
      const b = originalBridge();
      if (!b) return b;
      const media = b.media() as unknown as { paused: boolean; play: () => Promise<void> };
      if (refuse) {
        media.paused = true;
        media.play = async () => {
          throw new Error("NotAllowedError");
        };
      }
      return b;
    };
    deps.ask = async (q) => {
      if (q.kind === "tap") {
        await deps.sleep(400_000);
        refuse = false;
        const media = originalBridge()!.media() as unknown as { paused: boolean; play: () => Promise<void> };
        media.play = async () => void (media.paused = false);
        media.paused = false;
      }
      return "yes";
    };
    const [result] = await runBench({ ...CONFIG, depth: "extreme", interactive: false }, deps);
    const reopen = result.checks.find((c) => c.id === "x-reopen")!;
    expect(reopen.ms).toBeLessThan(5000);
    expect(reopen.detail).toMatch(/à attendre un toucher/);
  });

  it("annonce sa durée", () => {
    expect(estimateSeconds("full", 8, false)).toBe(1600);
    expect(estimateSeconds("quick", 4, true)).toBe(480);
  });
});
