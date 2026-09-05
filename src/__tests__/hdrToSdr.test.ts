// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { displayRange, shouldPresentHdr, hdrModeApplies, HDR_MODES } from "@/lib/hdrToSdr";

function answerWith(answers: Record<string, boolean> | null) {
  if (answers === null) {
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
  // `dynamic-range` répond faux aux deux. Le confondre avec un écran standard ferait reprendre
  // l'affichage d'un vrai écran HDR — c'est-à-dire remplacer du HDR par du standard.
  it("does not mistake an unanswered question for a standard screen", () => {
    answerWith({});
    expect(displayRange()).toBe("unknown");
    answerWith(null);
    expect(displayRange()).toBe("unknown");
  });
});

describe("shouldPresentHdr", () => {
  it("takes over an HDR file on a screen that says it is standard", () => {
    expect(shouldPresentHdr(true, true, "auto", "standard")).toBe(true);
  });

  // Le seul faux positif qui abîmerait vraiment quelque chose : reprendre l'affichage sur un
  // écran HDR revient à remplacer du HDR natif par une conversion vers le standard.
  it("never takes over an HDR screen on its own", () => {
    expect(shouldPresentHdr(true, true, "auto", "high")).toBe(false);
  });

  // Un écran dont on ne sait rien peut être HDR : dans le doute, on ne touche à rien.
  it("abstains when the screen cannot answer", () => {
    expect(shouldPresentHdr(true, true, "auto", "unknown")).toBe(false);
  });

  it("leaves an SDR file and the canvas path alone whatever the mode", () => {
    for (const mode of HDR_MODES) {
      expect(shouldPresentHdr(false, true, mode, "standard")).toBe(false);
      expect(shouldPresentHdr(true, false, mode, "standard")).toBe(false);
    }
  });

  // Les deux échappatoires, dans les deux sens : « toujours » couvre l'écran HDR dont le système
  // a coupé le mode HDR et le navigateur qui ne sait pas répondre ; « jamais » couvre celui à qui
  // la reprise coûte plus qu'elle ne rapporte.
  it("obeys the viewer over the detection, both ways", () => {
    expect(shouldPresentHdr(true, true, "always", "high")).toBe(true);
    expect(shouldPresentHdr(true, true, "always", "unknown")).toBe(true);
    expect(shouldPresentHdr(true, true, "never", "standard")).toBe(false);
  });
});

describe("hdrModeApplies", () => {
  it("offers the setting only where it could act", () => {
    expect(hdrModeApplies(true, true)).toBe(true);
    expect(hdrModeApplies(false, true)).toBe(false);
    expect(hdrModeApplies(true, false)).toBe(false);
  });
});
