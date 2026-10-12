import { describe, it, expect, beforeEach } from "vitest";
import {
  LIGHTER_CARRY_MS,
  LIGHTER_FLOOR_BPS,
  LinkRecovery,
  MAX_STUTTER_POPUPS,
  MEDIUM_POPUP_AFTER_MS,
  POPUP_GAP_MS,
  SlowLog,
  StutterWatch,
  capForLighter,
  carriedLighter,
  forgetLighterCarry,
  forgetLighters,
  lighterFor,
  lighterMaxWidth,
  nextLighter,
  noteLighter,
  openingAdvice,
  playbackLinkSlow,
  rememberLighter,
} from "@/lib/slowLinkPolicy";

// Ce que le lecteur propose quand le lien ne porte pas le film (DECISIONS.md §78) — les règles de Louis
// du 12/10/2026, une par une.

const NEED = 3_900_000;
/** `bytesPerSecond` pendant `seconds` secondes de réception. */
const at = (bytesPerSecond: number, seconds: number) => ({ bytes: bytesPerSecond * seconds, receivingMs: seconds * 1000 });
const fresh = { popup: null, dismissed: false, unstable: false };

describe("A — l'ouverture", () => {
  it("A1 : l'indice dès 5 s de réception sous la moitié du besoin, pas avant ; retiré au-dessus", () => {
    expect(openingAdvice(at(40_000, 4.9), NEED, 4_900, fresh).hint).toBe(false);
    expect(openingAdvice(at(40_000, 5), NEED, 5_000, fresh)).toMatchObject({ hint: true, popup: null });
    expect(openingAdvice(at(250_000, 8), NEED, 8_000, fresh).hint).toBe(false);
  });

  it("A2 : très lente (< 25 %) avec les preuves (10 s, 256 Kio) — la fenêtre « lente »", () => {
    expect(openingAdvice(at(40_000, 9), NEED, 9_000, fresh).popup).toBeNull();
    const ten = openingAdvice(at(40_000, 10), NEED, 10_000, fresh);
    expect(ten.popup).toBe("lente");
    expect(ten.recvBps).toBeCloseTo(320_000, -3);
    expect(ten.needBps).toBe(NEED);
    // Les preuves : 256 Kio reçus au moins.
    expect(openingAdvice(at(20_000, 10), NEED, 10_000, fresh).popup).toBeNull();
  });

  it("A3 : moyenne (25–50 %) — rien avant 20 s sans image, la fenêtre « moyenne » ensuite", () => {
    expect(MEDIUM_POPUP_AFTER_MS).toBe(20_000);
    const medium = at(170_000, 19);
    expect(openingAdvice(medium, NEED, 19_000, fresh)).toMatchObject({ hint: true, popup: null });
    expect(openingAdvice(at(170_000, 20), NEED, 20_000, fresh).popup).toBe("moyenne");
  });

  it("une fenêtre « lente » montrée reste tant que le débit est sous la moitié — pas de clignotement autour du quart", () => {
    expect(openingAdvice(at(170_000, 12), NEED, 12_000, { ...fresh, popup: "lente" }).popup).toBe("lente");
    expect(openingAdvice(at(300_000, 12), NEED, 12_000, { ...fresh, popup: "lente" }).popup).toBeNull();
  });

  it("fermée par le spectateur, la fenêtre ne revient pas — l'indice reste", () => {
    expect(openingAdvice(at(40_000, 20), NEED, 20_000, { ...fresh, dismissed: true })).toMatchObject({ hint: true, popup: null });
  });

  it("C : pendant une coupure (tentatives qui échouent, hors ligne), ni indice ni fenêtre — jamais d'allégée pour une coupure", () => {
    expect(openingAdvice(at(40_000, 20), NEED, 20_000, { ...fresh, unstable: true })).toMatchObject({ hint: false, popup: null });
  });

  it("rien reçu, besoin inconnu, mesure absurde : rien, et jamais d'exception", () => {
    expect(openingAdvice({ bytes: 0, receivingMs: 30_000 }, NEED, 30_000, fresh).hint).toBe(false);
    expect(openingAdvice(at(40_000, 20), null, 20_000, fresh).hint).toBe(false);
    expect(openingAdvice(null, NEED, 20_000, fresh).hint).toBe(false);
    expect(openingAdvice({ bytes: NaN, receivingMs: 20_000 }, NEED, 20_000, fresh).hint).toBe(false);
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

  it("le barème de largeur : HEVC 720p jusqu'à 2,5 Mbit/s puis 1080p ; H.264 720p sous 4,5 puis 1080p ; jamais au-delà", () => {
    expect(lighterMaxWidth(1_500_000, true)).toBe(1280);
    expect(lighterMaxWidth(2_500_000, true)).toBe(1280);
    expect(lighterMaxWidth(3_000_000, true)).toBe(1920);
    expect(lighterMaxWidth(2_500_000, false)).toBe(1280);
    expect(lighterMaxWidth(4_000_000, false)).toBe(1280);
    expect(lighterMaxWidth(5_000_000, false)).toBe(1920);
    expect(lighterMaxWidth(20_000_000, true)).toBe(1920);
  });

  it("le palier vaut pour ce titre, dix minutes, et abaisse le plafond ; sans palier, le plafond d'avant", () => {
    forgetLighters();
    expect(capForLighter("film", 100_000_000, 0)).toEqual({ maxBitrate: 100_000_000, step: null });
    noteLighter("film", { targetBps: 2_500_000, tier: 1 }, 0);
    expect(capForLighter("film", 100_000_000, 1000).maxBitrate).toBe(2_500_000);
    expect(capForLighter("autre", 100_000_000, 1000).step).toBeNull();
    expect(lighterFor("film", 11 * 60_000)).toBeNull();
  });
});

describe("B — les saccades en pleine lecture", () => {
  it("un blocage réseau de plus de 5 s déclenche ; un blocage de calcul ou de décodeur jamais", () => {
    const watch = new StutterWatch();
    expect(watch.longWait(0, false)).toBe(false);
    expect(watch.longWait(0, true)).toBe(true);
  });

  it("le 3e blocage réseau de plus d'1 s en 3 min déclenche ; pas les plus courts, pas les épars", () => {
    const watch = new StutterWatch();
    expect(watch.waitEnded(0, 1500, true)).toBe(false);
    expect(watch.waitEnded(10_000, 800, true)).toBe(false);
    expect(watch.waitEnded(20_000, 1500, false)).toBe(false);
    expect(watch.waitEnded(30_000, 1500, true)).toBe(false);
    expect(watch.waitEnded(40_000, 1500, true)).toBe(true);
    const sparse = new StutterWatch();
    sparse.waitEnded(0, 2000, true);
    sparse.waitEnded(100_000, 2000, true);
    expect(sparse.waitEnded(200_000, 2000, true)).toBe(false);
  });

  it("une fenêtre à la fois ; la suivante 3 min après la fermeture ; deux au plus par séance", () => {
    expect(MAX_STUTTER_POPUPS).toBe(2);
    const watch = new StutterWatch();
    expect(watch.longWait(0, true)).toBe(true);
    watch.shown();
    expect(watch.longWait(1000, true)).toBe(false);
    watch.closed(2000);
    expect(watch.longWait(2000 + POPUP_GAP_MS - 1, true)).toBe(false);
    expect(watch.longWait(2000 + POPUP_GAP_MS, true)).toBe(true);
    watch.shown();
    watch.closed(400_000);
    expect(watch.longWait(400_000 + POPUP_GAP_MS * 2, true)).toBe(false);
    expect(watch.count).toBe(2);
  });

  it("le débit mesuré sous le besoin, prouvé (2 s de réception, 256 Kio) ; rien reçu n'est pas une lenteur", () => {
    expect(playbackLinkSlow(at(300_000, 10), NEED)).toBe(true);
    expect(playbackLinkSlow(at(600_000, 10), NEED)).toBe(false);
    expect(playbackLinkSlow({ bytes: 0, receivingMs: 0 }, NEED)).toBe(false);
    expect(playbackLinkSlow(at(300_000, 1), NEED)).toBe(false);
  });
});

describe("la règle des deux minutes et le lien rétabli", () => {
  beforeEach(() => {
    forgetLighterCarry();
  });

  it("une séance allégée arrêtée : la lecture lancée dans les 2 min reprend son palier, quel que soit le titre ; après, non", () => {
    rememberLighter({ targetBps: 2_500_000, tier: 1 }, 1000);
    expect(carriedLighter(1000 + LIGHTER_CARRY_MS - 1)).toEqual({ targetBps: 2_500_000, tier: 1 });
    expect(carriedLighter(1000 + LIGHTER_CARRY_MS + 1)).toBeNull();
    forgetLighterCarry();
    expect(carriedLighter(2000)).toBeNull();
  });

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
    log.choose("allégée", 12_000);
    expect(log.fields().slowChoice).toBe("allégée");
    expect(log.fields().slowLink).toContain("choix allégée +12.0 s");
  });

  it("borné : une ligne ne grossit jamais sans fin", () => {
    const log = new SlowLog();
    for (let i = 0; i < 100; i++) log.note(`événement ${i} ${"x".repeat(40)}`);
    expect(log.fields().slowLink.length).toBeLessThanOrEqual(480);
  });
});
