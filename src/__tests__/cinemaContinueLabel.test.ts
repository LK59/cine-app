import { describe, it, expect } from "vitest";
import { formatContinueLabel } from "@/lib/cinemaContinueLabel";

const t = (key: string, vars?: Record<string, unknown>) =>
  key === "cinema.episodeShort" ? `S${vars?.season} E${vars?.episode}` : key.split(".").pop()!;

describe("formatContinueLabel", () => {
  it("« À suivre » pour un épisode jamais commencé", () => {
    expect(formatContinueLabel(t, 0, 1000, 1, 2)).toBe("upNext S1 E2");
  });

  it("« Lire » pour une série vue en entier relancée au premier épisode", () => {
    // 22/09/2026 : une série marquée vue perdait son bouton ; il revient, et dit qu'on recommence.
    expect(formatContinueLabel(t, 0, 1000, 1, 1, true)).toBe("play S1 E1");
  });
});
