import { describe, it, expect } from "vitest";
import { BATCH, LEAD_S, SMALL_BATCH, nextBatch, seekBatch, type PlanInput } from "@/lib/subtitleGen/scheduler";

/**
 * L'ordonnanceur (DECISIONS.md §69) : priorité absolue aux spectateurs, à tour de rôle, la
 * position la plus récente fait foi, rien n'est retraduit.
 */
const N = 1000;
// Une réplique toutes les 6 s : 1 000 répliques, 100 minutes.
const starts = Array.from({ length: N }, (_, i) => i * 6);
const ends = starts.map((s) => s + 4);
const NOW = 1_000_000;

function input(over: Partial<PlanInput> = {}): PlanInput {
  return { starts, ends, done: new Uint8Array(N), inflight: new Set(), viewers: [], now: NOW, turn: 0, resumeFrom: null, first: false, ...over };
}

describe("nextBatch", () => {
  it("part de la position du spectateur moins 10 s, en petit lot quand il attend", () => {
    const plan = nextBatch(input({ viewers: [{ key: "a", position: 600, seenAt: NOW }], first: true }));
    expect(plan).toMatchObject({ why: "viewer", viewer: "a", count: SMALL_BATCH });
    expect(starts[plan!.from]).toBeLessThanOrEqual(600);
    expect(ends[plan!.from]).toBeGreaterThanOrEqual(590);
  });

  it("prend des lots de 40 une fois que le spectateur a de l'avance", () => {
    const done = new Uint8Array(N);
    for (let i = 98; i < 110; i++) done[i] = 1; // ~70 s d'avance
    const plan = nextBatch(input({ done, viewers: [{ key: "a", position: 600, seenAt: NOW }] }));
    expect(plan).toMatchObject({ from: 110, count: BATCH, why: "viewer" });
  });

  it("ignore un spectateur qui n'a pas sondé depuis plus de 30 s", () => {
    const plan = nextBatch(input({ viewers: [{ key: "a", position: 3000, seenAt: NOW - 31_000 }] }));
    expect(plan?.why).toBe("fill");
    expect(plan?.from).toBe(0);
  });

  it("alterne entre plusieurs spectateurs en manque d'avance", () => {
    const viewers = [
      { key: "a", position: 600, seenAt: NOW },
      { key: "b", position: 3000, seenAt: NOW },
    ];
    expect(nextBatch(input({ viewers, turn: 0 }))?.viewer).toBe("a");
    expect(nextBatch(input({ viewers, turn: 1 }))?.viewer).toBe("b");
  });

  it("suit un saut : la position la plus récente fait foi, la requête en vol n'est pas reprise", () => {
    const inflight = new Set(Array.from({ length: 40 }, (_, i) => 100 + i));
    const plan = nextBatch(input({ inflight, viewers: [{ key: "a", position: 4800, seenAt: NOW }] }));
    expect(plan!.from).toBeGreaterThanOrEqual(798);
    expect(plan!.from).toBeLessThan(802);
  });

  it("ne choisit jamais une ligne faite ou en vol", () => {
    const done = new Uint8Array(N);
    for (let i = 0; i < 500; i += 2) done[i] = 1;
    const inflight = new Set([1, 3, 5]);
    for (let turn = 0; turn < 5; turn++) {
      const plan = nextBatch(input({ done, inflight, turn }))!;
      for (let i = plan.from; i < plan.from + plan.count; i++) {
        expect(done[i]).toBe(0);
        expect(inflight.has(i)).toBe(false);
      }
    }
  });

  it("continue devant les spectateurs quand tous ont leur avance, puis revient combler le début", () => {
    const done = new Uint8Array(N);
    // Le spectateur à 600 s : tout est fait de 98 à 300 (plus de cinq minutes d'avance).
    for (let i = 98; i <= 300; i++) done[i] = 1;
    const viewers = [{ key: "a", position: 600, seenAt: NOW }];
    expect(starts[301] - 600).toBeGreaterThan(LEAD_S);
    expect(nextBatch(input({ done, viewers }))).toMatchObject({ from: 301, why: "ahead" });
    // Tout est fait après lui : on revient au début.
    for (let i = 98; i < N; i++) done[i] = 1;
    expect(nextBatch(input({ done, viewers }))).toMatchObject({ from: 0, why: "fill" });
  });

  it("sans spectateur, reprend là où le dernier s'était arrêté", () => {
    expect(nextBatch(input({ resumeFrom: 1200 }))).toMatchObject({ why: "ahead" });
    expect(starts[nextBatch(input({ resumeFrom: 1200 }))!.from]).toBeGreaterThanOrEqual(1186);
  });

  it("ne rend rien quand tout est fait", () => {
    expect(nextBatch(input({ done: new Uint8Array(N).fill(1) }))).toBeNull();
  });
});

describe("seekBatch", () => {
  // Position 600 s − 10 s → réplique 98 (588-592 s).
  it("prend 8 répliques à partir de la position moins 10 s quand la zone est vide", () => {
    expect(seekBatch(input(), 600)).toEqual({ from: 98, count: SMALL_BATCH, why: "seek" });
  });

  it("ne lance rien si la réplique d'ancrage est faite ou déjà en vol", () => {
    const done = new Uint8Array(N);
    done[98] = 1;
    expect(seekBatch(input({ done }), 600)).toBeNull();
    expect(seekBatch(input({ inflight: new Set([98]) }), 600)).toBeNull();
  });

  it("s'arrête avant une ligne en vol, sans jamais la redemander", () => {
    expect(seekBatch(input({ inflight: new Set([101]) }), 600)).toEqual({ from: 98, count: 3, why: "seek" });
  });

  it("rien au-delà de la dernière réplique", () => {
    expect(seekBatch(input(), 100_000)).toBeNull();
  });
});
