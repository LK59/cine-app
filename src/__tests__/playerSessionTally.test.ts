import { describe, it, expect } from "vitest";
import { SessionTally, MIN_WAIT_MS, WatchedClock, newPlayerSessionId } from "@/lib/playerSessionTally";

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

describe("SessionTally — arrière-plan", () => {
  it("compte les absences, leur durée, et celles qui ont coûté une reconstruction", () => {
    const t = new SessionTally();
    t.hidden(0);
    t.hidden(10); // un second signal ne redouble rien
    expect(t.shown(60_000)).toBe(60_000);
    t.backgroundRebuilt();
    t.hidden(100_000);
    expect(t.summary(130_000)).toMatchObject({ backgrounds: 2, backgroundMs: 90_000, backgroundRebuilds: 1 });
    expect(t.lastBackgroundMs).toBe(60_000);
  });

  it("n'appelle pas attente le temps passé en arrière-plan", () => {
    const t = new SessionTally();
    t.waitStarted(0);
    t.hidden(100);
    t.shown(50_000);
    t.waitEnded(50_100);
    expect(t.summary(60_000).waits).toBe(0);
  });
});

// Un saut lancé juste avant de quitter l'application et arrivé au retour comptait l'absence
// entière comme attente : 286 s pour un Mac mis en veille (24/09/2026).
describe("SessionTally — temps passé en arrière-plan", () => {
  it("compte l'absence en cours et les absences finies", () => {
    const tally = new SessionTally();
    expect(tally.hiddenMsSoFar(1_000)).toBe(0);
    tally.hidden(1_000);
    expect(tally.hiddenMsSoFar(4_000)).toBe(3_000);
    tally.shown(5_000);
    expect(tally.hiddenMsSoFar(9_000)).toBe(4_000);
  });
});

describe("SessionTally — l'arrière-plan sur une ligne d'incident", () => {
  /**
   * Red Dragon, 24/09/2026 : deux « Media failed to decode » sur un iPhone passé dix-huit fois en
   * arrière-plan, et rien pour dire si la panne suivait un déverrouillage.
   */
  it("ne dit rien pour une page qui n'a jamais quitté l'écran", () => {
    expect(new SessionTally().backgroundFacts(1000)).toEqual({});
  });

  it("dit depuis combien de temps la page est revenue, et combien de temps elle était partie", () => {
    const tally = new SessionTally();
    tally.hidden(10_000);
    tally.shown(70_000);
    expect(tally.backgroundFacts(71_500)).toEqual({ shownAgoMs: 1_500, lastHiddenMs: 60_000 });
  });

  it("dit qu'elle est encore en arrière-plan, et depuis quand", () => {
    const tally = new SessionTally();
    tally.hidden(10_000);
    expect(tally.backgroundFacts(12_000)).toEqual({ hiddenNow: true, hiddenForMs: 2_000 });
  });
});

describe("WatchedClock", () => {
  it("compte le temps joué, pauses exclues, et chaque ligne ne rend compte que de sa part", () => {
    const clock = new WatchedClock();
    clock.run(0);
    clock.run(5_000); // un second « play » ne redémarre pas le compte
    clock.halt(10_000);
    clock.halt(20_000); // une pause pendant la pause ne compte rien
    expect(clock.seconds(30_000)).toBe(10);
    clock.run(30_000);
    // Une fin de diffusion en pleine lecture : sa part, puis on repart de zéro sans s'arrêter.
    expect(clock.take(40_000)).toBe(20);
    expect(clock.seconds(45_000)).toBe(5);
    clock.halt(50_000);
    expect(clock.take(60_000)).toBe(10);
    expect(clock.take(70_000)).toBe(0);
  });
});
