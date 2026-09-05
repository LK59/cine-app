// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { displayRange, toneMappingApplies, TONE_CURVES, TONE_LEVELS } from "@/lib/hdrToSdr";

function answerWith(answers: Record<string, boolean> | null) {
  if (answers === null) {
    // Un navigateur sans matchMedia du tout.
    Object.defineProperty(window, "matchMedia", { value: undefined, configurable: true });
    return;
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({ matches: answers[query] ?? false })),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("displayRange", () => {
  it("reads an HDR screen", () => {
    answerWith({ "(dynamic-range: high)": true });
    expect(displayRange()).toBe("high");
  });

  it("reads an ordinary screen", () => {
    answerWith({ "(dynamic-range: standard)": true });
    expect(displayRange()).toBe("standard");
  });

  // Le cas qui justifie de poser les deux questions : un navigateur qui ne connaît pas
  // `dynamic-range` répond faux aux deux. Le confondre avec un écran standard ferait corriger
  // l'image d'un vrai écran HDR, ce qui est la seule façon d'aggraver les choses.
  it("does not mistake an unanswered question for a standard screen", () => {
    answerWith({});
    expect(displayRange()).toBe("unknown");
    answerWith(null);
    expect(displayRange()).toBe("unknown");
  });
});

describe("toneMappingApplies", () => {
  it("only corrects an HDR file on a screen known to be standard", () => {
    expect(toneMappingApplies(true, "standard")).toBe(true);
    expect(toneMappingApplies(true, "high")).toBe(false);
    expect(toneMappingApplies(true, "unknown")).toBe(false);
    expect(toneMappingApplies(false, "standard")).toBe(false);
  });
});

describe("TONE_CURVES", () => {
  it("has a curve for every level but « off »", () => {
    for (const level of TONE_LEVELS) {
      if (level === "off") continue;
      expect(TONE_CURVES[level]).toBeTruthy();
    }
  });

  // Les trois forces doivent aller dans le même sens, sinon « forte » ne veut rien dire.
  it("grows monotonically from light to strong", () => {
    const { light, medium, strong } = TONE_CURVES;
    expect(light.exponent).toBeLessThan(medium.exponent);
    expect(medium.exponent).toBeLessThan(strong.exponent);
    expect(light.saturation).toBeLessThan(medium.saturation);
    expect(medium.saturation).toBeLessThan(strong.saturation);
  });

  // Un exposant supérieur à 1 assombrit tout, y compris les hautes lumières : l'amplitude est là
  // pour les rattraper. Sans elle, la correction rendrait le contraste en éteignant l'image.
  it("lifts the highlights the gamma would otherwise take with it", () => {
    for (const curve of Object.values(TONE_CURVES)) {
      expect(curve.exponent).toBeGreaterThan(1);
      expect(curve.amplitude).toBeGreaterThan(1);
    }
  });
});
