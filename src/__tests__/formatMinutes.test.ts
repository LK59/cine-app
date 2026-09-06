import { describe, it, expect } from "vitest";
import { formatMinutes } from "@/lib/format";

describe("formatMinutes", () => {
  // Le point de départ : « 70 min » oblige à faire la division soi-même pour savoir ce qu'on
  // s'engage à regarder.
  it("says an hour and ten rather than seventy minutes", () => {
    expect(formatMinutes(70)).toBe("1h10");
    expect(formatMinutes(152)).toBe("2h32");
  });

  // En dessous d'une heure, la minute reste la bonne unité — « 0h45 » serait une coquetterie.
  it("keeps minutes below the hour", () => {
    expect(formatMinutes(45)).toBe("45min");
    expect(formatMinutes(1)).toBe("1min");
  });

  it("pads the minutes so two durations line up", () => {
    expect(formatMinutes(65)).toBe("1h05");
    expect(formatMinutes(120)).toBe("2h00");
  });

  // Rien à dire vaut mieux que « 0min » : l'appelant n'affiche alors rien du tout.
  it("says nothing when there is nothing to say", () => {
    expect(formatMinutes(0)).toBeNull();
    expect(formatMinutes(null)).toBeNull();
    expect(formatMinutes(undefined)).toBeNull();
    expect(formatMinutes(-5)).toBeNull();
  });
});
