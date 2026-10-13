import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// L'exécution commune de la connexion lente (DECISIONS.md §79) : ce qu'elle fait d'un préchauffage quand
// le spectateur saute ailleurs pendant qu'un saut attend son image.

const started: { startSeconds: number; state: string }[] = [];
vi.mock("@/lib/lighterPrewarm", async (original) => {
  const real = await original<typeof import("@/lib/lighterPrewarm")>();
  return {
    ...real,
    startPrewarm: (options: { itemId: string; step: { targetBps: number; tier: number }; startSeconds: number }) => {
      const prewarm = { ...options, state: "ready", startedAt: 0, readyAt: 1, data: null, segment: null, variant: null, ready: Promise.resolve(true), abort: new AbortController() };
      started.push(prewarm);
      return prewarm;
    },
    cancelPrewarm: (prewarm: { state: string }) => {
      prewarm.state = "cancelled";
    },
  };
});

import { SlowLinkRunner, type SlowLinkHost } from "@/lib/slowLinkRunner";
import { SlowLog } from "@/lib/slowLinkPolicy";

/** Un hôte à 0,3 Mbit/s pour 4 demandés : très lent, prouvé — la bascule dès 10 s. */
function host(position: { at: number }) {
  const switches: { resumeAt: number; held: unknown }[] = [];
  const log = new SlowLog();
  const value: SlowLinkHost = {
    itemId: "film",
    log: () => log,
    audioStreamIndex: () => 1,
    over: () => false,
    switchTo: (_step, resumeAt, _cause, held) => void switches.push({ resumeAt, held }),
    screen: () => {},
    giveUp: () => {},
    playbackDecision: () => {},
    seekBlocked: () => false,
    paused: () => false,
    seekMeasure: (elapsedMs) => ({ bytes: Math.round((300_000 / 8) * (elapsedMs / 1000)), receivingMs: elapsedMs }),
    needBps: () => 4_000_000,
    unstable: () => false,
    auto: () => true,
    currentStep: () => null,
    position: () => position.at,
    seekSignal: () => {},
  };
  return { value, switches };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  started.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("un saut resté sans image, puis un autre saut ailleurs", () => {
  it("la bascule part de la position demandée en dernier, jamais de celle d'un préchauffage précédent", async () => {
    // Saut à 1000 s, 10 s sans image : préchauffage à 1000 s. Le spectateur, impatient, saute à 3000 s.
    // Dix secondes plus tard, la bascule reprenait le préchauffage prêt — et le renvoyait à 1000 s,
    // trente-trois minutes en arrière de ce qu'il venait de demander (13/10/2026).
    const position = { at: 1000 };
    const { value, switches } = host(position);
    const runner = new SlowLinkRunner();
    runner.attach(value);
    runner.seekStarted();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started.map((p) => p.startSeconds)).toEqual([1000]);
    expect(switches).toHaveLength(0);
    position.at = 3000;
    // Natif : chaque `seeking` relance le compte ; serveur : compté depuis le premier de la série.
    runner.seekStarted();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(switches).toHaveLength(1);
    expect(switches[0].resumeAt).toBe(3000);
    // Le préchauffage de 1000 s est refermé ; celui qui sert est à 3000 s.
    expect(started[0].state).toBe("cancelled");
    expect(started.at(-1)?.startSeconds).toBe(3000);
    runner.dispose();
  });

  it("le serveur (compte non relancé) : un second saut juste avant la bascule ne la fait pas partir de l'ancien", async () => {
    const position = { at: 1000 };
    const { value, switches } = host(position);
    const runner = new SlowLinkRunner();
    runner.attach(value);
    runner.seekStarted();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toHaveLength(1);
    position.at = 3000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(switches.every((s) => s.resumeAt === 3000)).toBe(true);
    expect(switches).toHaveLength(1);
    runner.dispose();
  });

  it("le même saut, sans autre geste : le préchauffage est repris tel quel, à sa position", async () => {
    const position = { at: 1000 };
    const { value, switches } = host(position);
    const runner = new SlowLinkRunner();
    runner.attach(value);
    runner.seekStarted();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(started).toHaveLength(1);
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ resumeAt: 1000, held: started[0] });
    runner.dispose();
  });
});
