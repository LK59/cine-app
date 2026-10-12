import { describe, it, expect } from "vitest";
import {
  LIGHTER_FLOOR_BPS,
  LinkRecovery,
  PREWARM_AFTER_MS,
  SWITCH_MEDIUM_MS,
  SWITCH_VERY_SLOW_MS,
  SlowLog,
  StutterWatch,
  decideOpening,
  decidePlayback,
  lighterMaxWidth,
  nextLighter,
  openingAdvice,
  playbackLinkSlow,
} from "@/lib/slowLinkPolicy";

// Ce que le lecteur fait quand le lien ne porte pas le film (DECISIONS.md §78) — les règles de Louis
// du 12/10/2026, une par une.

const NEED = 3_900_000;
/** `bytesPerSecond` pendant `seconds` secondes de réception. */
const at = (bytesPerSecond: number, seconds: number) => ({ bytes: bytesPerSecond * seconds, receivingMs: seconds * 1000 });
describe("A — l'ouverture : indice, préchauffage, bascule", () => {
  it("A1 : l'indice dès 5 s de réception sous la moitié du besoin, pas avant ; rien au-dessus", () => {
    expect(openingAdvice(at(40_000, 4.9), NEED, 4_900, false).hint).toBe(false);
    expect(openingAdvice(at(40_000, 5), NEED, 5_000, false)).toMatchObject({ hint: true, prewarm: false, switchNow: false });
    expect(openingAdvice(at(250_000, 8), NEED, 8_000, false)).toMatchObject({ hint: false, prewarm: false });
  });

  it("préchauffage dès 8 s si la mesure est mauvaise", () => {
    expect(PREWARM_AFTER_MS).toBe(8_000);
    expect(openingAdvice(at(40_000, 7), NEED, 7_900, false).prewarm).toBe(false);
    expect(openingAdvice(at(40_000, 8), NEED, 8_000, false).prewarm).toBe(true);
  });

  it("très lente (< 25 %) : bascule à 10 s, preuves réunies (10 s, 256 Kio)", () => {
    expect(SWITCH_VERY_SLOW_MS).toBe(10_000);
    expect(openingAdvice(at(40_000, 9), NEED, 9_000, false).switchNow).toBe(false);
    const ten = openingAdvice(at(40_000, 10), NEED, 10_000, false);
    expect(ten.switchNow).toBe(true);
    expect(ten.recvBps).toBeCloseTo(320_000, -3);
    expect(openingAdvice(at(20_000, 10), NEED, 10_000, false).switchNow).toBe(false);
  });

  it("moyenne (25–50 %) : préchauffage dès 8 s, bascule seulement à 20 s", () => {
    expect(SWITCH_MEDIUM_MS).toBe(20_000);
    expect(openingAdvice(at(170_000, 19), NEED, 19_000, false)).toMatchObject({ hint: true, prewarm: true, switchNow: false });
    expect(openingAdvice(at(170_000, 20), NEED, 20_000, false).switchNow).toBe(true);
  });

  it("C : pendant une coupure, ni indice ni préchauffage ni bascule — jamais d'allégée pour une coupure", () => {
    expect(openingAdvice(at(40_000, 20), NEED, 20_000, true)).toMatchObject({ hint: false, prewarm: false, switchNow: false });
  });

  it("rien reçu, besoin inconnu, mesure absurde : rien, et jamais d'exception", () => {
    expect(openingAdvice({ bytes: 0, receivingMs: 30_000 }, NEED, 30_000, false).hint).toBe(false);
    expect(openingAdvice(at(40_000, 20), null, 20_000, false).hint).toBe(false);
    expect(openingAdvice(null, NEED, 20_000, false).hint).toBe(false);
    expect(openingAdvice({ bytes: NaN, receivingMs: 20_000 }, NEED, 20_000, false).hint).toBe(false);
  });
});

describe("la décision (une seule machine pour les deux lecteurs)", () => {
  const base = { needBps: NEED, unstable: false, auto: true, prewarm: "none" as const, currentStep: null, giveUpMs: 35_000 };

  it("bon réseau : rien, jamais", () => {
    for (const t of [5_000, 8_000, 10_000, 20_000, 34_000]) {
      expect(decideOpening({ ...base, measure: at(2_000_000, t / 1000), elapsedMs: t }).action).toEqual({ kind: "none" });
    }
  });

  it("très lente : préchauffer à 8 s, basculer à 10 s si le préchauffage est prêt (ou en échec), attendre s'il tourne", () => {
    expect(decideOpening({ ...base, measure: at(40_000, 8), elapsedMs: 8_000 }).action).toEqual({ kind: "prewarm", step: { targetBps: 1_500_000, tier: 1 } });
    expect(decideOpening({ ...base, measure: at(40_000, 10), elapsedMs: 10_000, prewarm: "running" }).action).toEqual({ kind: "none" });
    expect(decideOpening({ ...base, measure: at(40_000, 12), elapsedMs: 12_000, prewarm: "ready" }).action.kind).toBe("switch");
    expect(decideOpening({ ...base, measure: at(40_000, 12), elapsedMs: 12_000, prewarm: "failed" }).action.kind).toBe("switch");
  });

  it("au délai du renoncement : sans lenteur prouvée, l'ancien renoncement ; prouvée, la bascule en Automatique, l'écran sinon", () => {
    expect(decideOpening({ ...base, measure: at(0, 35), elapsedMs: 35_000 }).action).toEqual({ kind: "giveUp" });
    expect(decideOpening({ ...base, measure: at(40_000, 35), elapsedMs: 35_000 }).action.kind).toBe("switch");
    expect(decideOpening({ ...base, auto: false, measure: at(40_000, 35), elapsedMs: 35_000 }).action.kind).toBe("screen");
    // Au plancher, plus de palier : l'écran.
    expect(decideOpening({ ...base, currentStep: { targetBps: 1_500_000, tier: 2 }, measure: at(40_000, 35), elapsedMs: 35_000 }).action.kind).toBe("screen");
    // Une coupure en cours : on attend son issue.
    expect(decideOpening({ ...base, unstable: true, measure: at(40_000, 35), elapsedMs: 35_000 }).action).toEqual({ kind: "none" });
  });

  it("Originale, ou version allégée non permise : l'indice seulement avant le renoncement", () => {
    const { advice, action } = decideOpening({ ...base, auto: false, measure: at(40_000, 12), elapsedMs: 12_000 });
    expect(advice.hint).toBe(true);
    expect(action).toEqual({ kind: "none" });
  });

  it("en pleine lecture : préchauffer au déclenchement, basculer quand c'est prêt ; rien en Originale ni au plancher", () => {
    const reading = { recvBps: 2_000_000, needBps: NEED };
    expect(decidePlayback({ triggered: true, auto: true, prewarm: "none", currentStep: null, ...reading })).toEqual({ kind: "prewarm", step: { targetBps: 1_500_000, tier: 1 } });
    expect(decidePlayback({ triggered: false, auto: true, prewarm: "running", currentStep: null, ...reading })).toEqual({ kind: "none" });
    expect(decidePlayback({ triggered: false, auto: true, prewarm: "ready", currentStep: null, ...reading }).kind).toBe("switch");
    expect(decidePlayback({ triggered: true, auto: false, prewarm: "none", currentStep: null, ...reading })).toEqual({ kind: "none" });
    expect(decidePlayback({ triggered: true, auto: true, prewarm: "none", currentStep: { targetBps: 1_500_000, tier: 3 }, ...reading })).toEqual({ kind: "none" });
  });

  it("dégressif côté serveur : le palier suivant part du palier en cours", () => {
    const { action } = decideOpening({ ...base, currentStep: { targetBps: 5_000_000, tier: 1 }, measure: at(250_000, 20), elapsedMs: 20_000, prewarm: "ready", needBps: 5_000_000 });
    expect(action).toEqual({ kind: "switch", step: { targetBps: 1_500_000, tier: 2 } });
  });
});

describe("D — la version allégée : débit adapté et dégressif", () => {
  it("les exemples de Louis : 30/5 → 2,5 ; 16/10 → 5 ; mesuré 0,3 → plancher 1,5", () => {
    expect(nextLighter(5_000_000, 30_000_000, null)).toEqual({ targetBps: 2_500_000, tier: 1 });
    expect(nextLighter(10_000_000, 16_000_000, null)).toEqual({ targetBps: 5_000_000, tier: 1 });
    expect(nextLighter(300_000, 3_900_000, null)).toEqual({ targetBps: LIGHTER_FLOOR_BPS, tier: 1 });
  });

  it("dégressif : max(1,5, min(précédent / 2, mesuré / 2)) ; au plancher, plus de palier", () => {
    const first = nextLighter(10_000_000, 16_000_000, null)!;
    expect(nextLighter(8_000_000, 5_000_000, first)).toEqual({ targetBps: 2_500_000, tier: 2 });
    expect(nextLighter(3_000_000, 5_000_000, first)).toEqual({ targetBps: 1_500_000, tier: 2 });
    expect(nextLighter(1_000_000, 2_500_000, { targetBps: 2_500_000, tier: 2 })).toEqual({ targetBps: 1_500_000, tier: 3 });
    expect(nextLighter(1_000_000, 1_500_000, { targetBps: 1_500_000, tier: 3 })).toBeNull();
  });

  it("toujours sous le besoin : un fichier de moins de 1,5 Mbit/s n'a pas de version allégée", () => {
    expect(nextLighter(300_000, 1_200_000, null)).toBeNull();
  });

  it("le barème de largeur : HEVC 720p jusqu'à 2,5 Mbit/s puis 1080p ; H.264 720p sous 6 puis 1080p ; jamais au-delà", () => {
    expect(lighterMaxWidth(1_500_000, true)).toBe(1280);
    expect(lighterMaxWidth(2_500_000, true)).toBe(1280);
    expect(lighterMaxWidth(3_000_000, true)).toBe(1920);
    expect(lighterMaxWidth(2_500_000, false)).toBe(1280);
    expect(lighterMaxWidth(4_000_000, false)).toBe(1280);
    expect(lighterMaxWidth(5_000_000, false)).toBe(1280);
    expect(lighterMaxWidth(6_000_000, false)).toBe(1920);
    expect(lighterMaxWidth(20_000_000, true)).toBe(1920);
  });

});

describe("B — les saccades en pleine lecture", () => {
  it("un blocage réseau de plus de 5 s déclenche ; un blocage de calcul ou de décodeur jamais", () => {
    const watch = new StutterWatch();
    expect(watch.longWait(0, false)).toBe(false);
    expect(watch.longWait(0, true)).toBe(true);
  });

  it("le 3e blocage réseau de plus d'1 s en 3 min déclenche ; pas les plus courts, pas les épars ; le compte repart après", () => {
    const watch = new StutterWatch();
    expect(watch.waitEnded(0, 1500, true)).toBe(false);
    expect(watch.waitEnded(10_000, 800, true)).toBe(false);
    expect(watch.waitEnded(20_000, 1500, false)).toBe(false);
    expect(watch.waitEnded(30_000, 1500, true)).toBe(false);
    expect(watch.waitEnded(40_000, 1500, true)).toBe(true);
    expect(watch.waitEnded(50_000, 1500, true)).toBe(false);
    const sparse = new StutterWatch();
    sparse.waitEnded(0, 2000, true);
    sparse.waitEnded(100_000, 2000, true);
    expect(sparse.waitEnded(200_000, 2000, true)).toBe(false);
  });

  it("le débit mesuré sous le besoin, prouvé (2 s de réception, 256 Kio) ; rien reçu n'est pas une lenteur", () => {
    expect(playbackLinkSlow(at(300_000, 10), NEED)).toBe(true);
    expect(playbackLinkSlow(at(600_000, 10), NEED)).toBe(false);
    expect(playbackLinkSlow({ bytes: 0, receivingMs: 0 }, NEED)).toBe(false);
    expect(playbackLinkSlow(at(300_000, 1), NEED)).toBe(false);
  });
});

describe("le lien rétabli", () => {
  it("la capacité à 115 % du besoin classique pendant 10 s efface la mémoire ; à 100 %, non", () => {
    const classic = 16_000_000;
    // Rafales à 18,4 Mb/s (115 %) : 10 s d'affilée suffisent.
    const good = new LinkRecovery();
    const burst = { bytes: (18_400_000 / 8) * 2, receivingMs: 2000 };
    let cleared = false;
    for (let t = 0; t <= 11_000 && !cleared; t += 1000) cleared = good.check(t, burst, classic);
    expect(cleared).toBe(true);
    expect(good.capacityBps).toBeCloseTo(18_400_000, -4);
    const equal = new LinkRecovery();
    const even = { bytes: (16_000_000 / 8) * 2, receivingMs: 2000 };
    let never = false;
    for (let t = 0; t <= 30_000; t += 1000) never = never || equal.check(t, even, classic);
    expect(never).toBe(false);
  });

  it("une lecture sous 110 % remet le compte à zéro ; une lecture sans réception ne compte ni pour ni contre", () => {
    const classic = 10_000_000;
    const ok = { bytes: (12_000_000 / 8) * 2, receivingMs: 2000 };
    const bad = { bytes: (9_000_000 / 8) * 2, receivingMs: 2000 };
    const recovery = new LinkRecovery();
    recovery.check(0, ok, classic);
    recovery.check(5000, bad, classic);
    expect(recovery.check(10_000, ok, classic)).toBe(false);
    expect(recovery.check(15_000, { bytes: 0, receivingMs: 0 }, classic)).toBe(false);
    expect(recovery.check(20_000, ok, classic)).toBe(true);
  });
});

describe("F — le fil du journal", () => {
  it("rien quand rien n'a paru ; sinon quoi, quand, débits, et le dernier choix", () => {
    const log = new SlowLog();
    expect(log.fields()).toEqual({});
    log.noteAt("indice", 5000, 320_000, 3_900_000);
    expect(log.fields()).toEqual({ slowLink: "indice +5.0 s (0.32/3.9)", slowChoice: "aucun" });
    log.choose("réessayer", 12_000);
    expect(log.fields().slowChoice).toBe("réessayer");
    expect(log.fields().slowLink).toContain("choix réessayer +12.0 s");
  });

  it("borné : une ligne ne grossit jamais sans fin", () => {
    const log = new SlowLog();
    for (let i = 0; i < 100; i++) log.note(`événement ${i} ${"x".repeat(40)}`);
    expect(log.fields().slowLink.length).toBeLessThanOrEqual(480);
  });
});
