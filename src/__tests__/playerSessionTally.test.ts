import { describe, it, expect } from "vitest";
import { SessionTally, MIN_WAIT_MS, newPlayerSessionId } from "@/lib/playerSessionTally";

// Le décompte qui fait le bilan d'une séance. Les attentes d'une à quatre secondes n'avaient
// aucune trace : seules celles de cinq secondes et plus devenaient une ligne `stall`.
describe("SessionTally", () => {
  it("compte une attente, sa durée et la plus longue", () => {
    const t = new SessionTally();
    t.waitStarted(0);
    t.waitEnded(1200);
    t.waitStarted(5000);
    t.waitEnded(8000);
    expect(t.summary(9000)).toMatchObject({ waits: 2, waitedMs: 4200, longestWaitMs: 3000 });
  });

  it("ignore ce qui est trop bref pour se voir", () => {
    const t = new SessionTally();
    t.waitStarted(0);
    t.waitEnded(MIN_WAIT_MS - 1);
    expect(t.summary(1000).waits).toBe(0);
  });

  it("ne redouble pas une attente signalée deux fois", () => {
    const t = new SessionTally();
    t.waitStarted(0);
    t.waitStarted(500);
    t.waitEnded(1000);
    expect(t.summary(2000)).toMatchObject({ waits: 1, waitedMs: 1000 });
  });

  it("compte l'attente en cours quand la séance finit dessus", () => {
    const t = new SessionTally();
    t.waitStarted(0);
    expect(t.summary(2500)).toMatchObject({ waits: 1, waitedMs: 2500, longestWaitMs: 2500 });
  });

  it("laisse au saut l'attente qu'il interrompt", () => {
    const t = new SessionTally();
    t.waitStarted(0);
    t.waitAbandoned();
    t.waitEnded(4000);
    t.seekArrived(900);
    t.seekArrived(300);
    t.audioSwitched();
    expect(t.summary(5000)).toMatchObject({ waits: 0, seeks: 2, seekWaitMs: 1200, audioSwitches: 1 });
  });
});

describe("newPlayerSessionId", () => {
  it("donne un identifiant court, différent à chaque séance", () => {
    const ids = new Set(Array.from({ length: 50 }, newPlayerSessionId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z-]{8}$/);
  });
});
