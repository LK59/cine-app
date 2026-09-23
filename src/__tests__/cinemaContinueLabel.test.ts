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

// La ligne sous une carte de « Reprendre » (23/09/2026) : elle répétait le nom de la rangée
// (« Reprendre Ep3 S1 - 25min re… », coupée) et nommait l'épisode avant la saison.
describe("formatContinueCaption", () => {
  const ticks = (minutes: number) => minutes * 60 * 10_000_000;

  it("un épisode commencé : la saison, l'épisode, le temps restant — sans verbe", async () => {
    const { formatContinueCaption } = await import("@/lib/cinemaContinueLabel");
    const tr = (key: string, vars?: Record<string, unknown>) =>
      key === "cinema.episodeShort" ? `S${vars?.season} · É${vars?.episode}` : key === "cinema.timeRemaining" ? `${vars?.time} restantes` : key;
    expect(formatContinueCaption(tr, ticks(20), ticks(45), 1, 3)).toBe("S1 · É3 · 25 min restantes");
  });

  it("la suite d'une série garde « À suivre », qui la distingue d'une reprise", async () => {
    const { formatContinueCaption } = await import("@/lib/cinemaContinueLabel");
    expect(formatContinueCaption(t, 0, ticks(45), 1, 3)).toBe("upNext · S1 E3");
  });

  it("un film : le temps restant seul, en heures au-delà d'une heure", async () => {
    const { formatContinueCaption } = await import("@/lib/cinemaContinueLabel");
    const tr = (key: string, vars?: Record<string, unknown>) => (key === "cinema.timeRemaining" ? `${vars?.time} restantes` : key);
    expect(formatContinueCaption(tr, ticks(30), ticks(100))).toBe("1h10 restantes");
  });
});
