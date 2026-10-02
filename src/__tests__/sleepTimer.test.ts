import { describe, it, expect, beforeEach } from "vitest";
import {
  SLEEP_OFF,
  SLEEP_FADE_MS,
  blocksAutoAdvance,
  chooseSleepTimer,
  continueSleepTimer,
  sleepRemainingMinutes,
  sleepTimerDue,
  sleepTimerFired,
  sleepTimerLogFields,
  sleepTimerStore,
  sleepVolumeFactor,
  sleepWarningSeconds,
  tickSleepTimer,
  type SleepTimerState,
} from "@/lib/sleepTimer";

/**
 * La minuterie de veille, sans navigateur : ce qu'elle compte, quand elle prévient, quand elle
 * arrête — et qu'elle survive à ce qui remonte les lecteurs. Le moteur (`useSleepTimer`) ne fait
 * qu'appliquer ces règles à un élément vidéo.
 */

const MIN = 60_000;

/** Fait passer `ms` de temps par battements de 250 ms, en lecture ou non. */
function run(state: SleepTimerState, ms: number, playing = true): SleepTimerState {
  let s = state;
  for (let t = 0; t < ms; t += 250) s = tickSleepTimer(s, Math.min(250, ms - t), playing);
  return s;
}

describe("la minuterie de veille — le temps compté", () => {
  it("ne compte que pendant la lecture : une pause ne la consomme pas", () => {
    let s = chooseSleepTimer(SLEEP_OFF, "15");
    s = run(s, 5 * MIN, true);
    s = run(s, 20 * MIN, false);
    expect(s.remainingMs).toBe(10 * MIN);
    expect(sleepTimerDue(s)).toBe(false);
  });

  it("arrive à échéance après la durée choisie, en temps de film", () => {
    let s = chooseSleepTimer(SLEEP_OFF, "30");
    s = run(s, 30 * MIN - 1000);
    expect(sleepTimerDue(s)).toBe(false);
    s = run(s, 1000);
    expect(sleepTimerDue(s)).toBe(true);
  });

  it("mesure un battement espacé — un onglet en arrière-plan — sans rien perdre", () => {
    const s = tickSleepTimer(chooseSleepTimer(SLEEP_OFF, "15"), 60_000, true);
    expect(s.remainingMs).toBe(14 * MIN);
  });

  it("ne descend jamais sous zéro et ignore un temps négatif", () => {
    const s = tickSleepTimer(chooseSleepTimer(SLEEP_OFF, "15"), 99 * MIN, true);
    expect(s.remainingMs).toBe(0);
    expect(tickSleepTimer(s, -5, true)).toBe(s);
  });

  it("« off » et « Fin de l'épisode » n'ont rien à compter", () => {
    expect(run(SLEEP_OFF, MIN)).toEqual(SLEEP_OFF);
    const episode = chooseSleepTimer(SLEEP_OFF, "episode");
    expect(run(episode, 99 * MIN)).toEqual(episode);
    expect(sleepTimerDue(episode)).toBe(false);
  });

  it("dit les minutes restantes arrondies au-dessus", () => {
    expect(sleepRemainingMinutes(chooseSleepTimer(SLEEP_OFF, "90"))).toBe(90);
    expect(sleepRemainingMinutes(run(chooseSleepTimer(SLEEP_OFF, "15"), 61_000))).toBe(14);
    expect(sleepRemainingMinutes(run(chooseSleepTimer(SLEEP_OFF, "15"), 15 * MIN - 1000))).toBe(1);
    expect(sleepRemainingMinutes(SLEEP_OFF)).toBeNull();
  });
});

describe("la minuterie de veille — les trente dernières secondes", () => {
  it("prévient à trente secondes, et pas avant", () => {
    let s = chooseSleepTimer(SLEEP_OFF, "15");
    s = run(s, 15 * MIN - 31_000);
    expect(sleepWarningSeconds(s)).toBeNull();
    s = run(s, 1000);
    expect(sleepWarningSeconds(s)).toBe(30);
    s = run(s, 10_500);
    expect(sleepWarningSeconds(s)).toBe(20);
  });

  it("baisse le son pendant les cinq dernières secondes, jusqu'au silence", () => {
    let s = chooseSleepTimer(SLEEP_OFF, "15");
    s = run(s, 15 * MIN - SLEEP_FADE_MS - 1000);
    expect(sleepVolumeFactor(s)).toBe(1);
    s = run(s, 1000 + SLEEP_FADE_MS / 2);
    expect(sleepVolumeFactor(s)).toBeCloseTo(0.5, 5);
    s = run(s, SLEEP_FADE_MS / 2);
    expect(sleepVolumeFactor(s)).toBe(0);
  });

  it("« Continuer » relance la même durée en entier, et le son revient", () => {
    let s = chooseSleepTimer(SLEEP_OFF, "30");
    s = run(s, 30 * MIN - 2000);
    expect(sleepVolumeFactor(s)).toBeLessThan(1);
    s = continueSleepTimer(s);
    expect(s).toMatchObject({ mode: "30", remainingMs: 30 * MIN });
    expect(sleepVolumeFactor(s)).toBe(1);
    expect(sleepWarningSeconds(s)).toBeNull();
  });

  it("une fois déclenchée, retombe à « off » et se souvient d'avoir arrêté le film", () => {
    const s = sleepTimerFired(run(chooseSleepTimer(SLEEP_OFF, "60"), 60 * MIN));
    expect(s.mode).toBe("off");
    expect(sleepTimerDue(s)).toBe(false);
    expect(sleepTimerLogFields(s)).toEqual({ sleepTimer: "60" });
  });
});

describe("la minuterie de veille — « Fin de l'épisode »", () => {
  it("empêche l'enchaînement automatique, et seulement elle", () => {
    expect(blocksAutoAdvance(chooseSleepTimer(SLEEP_OFF, "episode"))).toBe(true);
    for (const mode of ["off", "15", "30", "60", "90"] as const) {
      expect(blocksAutoAdvance(chooseSleepTimer(SLEEP_OFF, mode))).toBe(false);
    }
  });
});

describe("la minuterie de veille — au journal", () => {
  it("ne dit rien d'une séance sans minuterie", () => {
    expect(sleepTimerLogFields(SLEEP_OFF)).toEqual({});
  });

  it("nomme la minuterie choisie", () => {
    expect(sleepTimerLogFields(chooseSleepTimer(SLEEP_OFF, "episode"))).toEqual({ sleepTimer: "episode" });
  });
});

describe("la minuterie de veille — le magasin, au-dessus des lecteurs", () => {
  beforeEach(() => sleepTimerStore.clear());

  it("survit à un changement d'épisode : rien dans l'enchaînement ne la touche", () => {
    // Le lecteur natif est remonté à chaque épisode, le magasin non : ce que l'épisode 1 a
    // consommé reste consommé dans l'épisode 2.
    sleepTimerStore.choose("30");
    sleepTimerStore.tick(10 * MIN, true);
    // … l'épisode 1 finit, le lecteur est démonté, l'épisode 2 monte un nouveau lecteur …
    sleepTimerStore.tick(5 * MIN, true);
    expect(sleepTimerStore.get()).toMatchObject({ mode: "30", remainingMs: 15 * MIN });
  });

  it("prévient ses abonnés, et s'efface à la fermeture", () => {
    let calls = 0;
    const off = sleepTimerStore.subscribe(() => (calls += 1));
    sleepTimerStore.choose("15");
    sleepTimerStore.setFadeBase(0.8);
    sleepTimerStore.clear();
    off();
    expect(calls).toBe(2);
    expect(sleepTimerStore.get()).toEqual(SLEEP_OFF);
    expect(sleepTimerStore.fadeBase()).toBeNull();
  });

  it("ne prévient pas pour un battement en pause, qui ne change rien", () => {
    sleepTimerStore.choose("15");
    let calls = 0;
    const off = sleepTimerStore.subscribe(() => (calls += 1));
    sleepTimerStore.tick(250, false);
    off();
    expect(calls).toBe(0);
  });
});
