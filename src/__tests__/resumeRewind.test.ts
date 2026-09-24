// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { awayFrom, noteWatching, rewound, AWAY_MS } from "@/lib/resumeRewind";

beforeEach(() => window.localStorage.clear());

describe("rewound", () => {
  it("recule de cinq secondes loin des bords", () => {
    expect(rewound(1200, 5400)).toBe(1195);
  });

  it("ne touche ni au début ni à la fin", () => {
    expect(rewound(20, 5400)).toBe(20);
    expect(rewound(0, 5400)).toBe(0);
    expect(rewound(5390, 5400)).toBe(5390);
  });

  it("se passe de la durée quand elle manque", () => {
    expect(rewound(1200, null)).toBe(1195);
  });
});

describe("awayFrom", () => {
  it("dit « éloigné » d'un titre jamais joué ici", () => {
    expect(awayFrom("a")).toBe(true);
  });

  it("ne le dit pas dans les dix minutes, et le dit après", () => {
    noteWatching("a", 1_000_000);
    expect(awayFrom("a", 1_000_000 + AWAY_MS - 1)).toBe(false);
    expect(awayFrom("a", 1_000_000 + AWAY_MS + 1)).toBe(true);
  });

  it("ne garde que les cinquante derniers titres", () => {
    for (let i = 0; i < 60; i++) noteWatching(`t${i}`, 1000 + i);
    const kept = Object.keys(JSON.parse(window.localStorage.getItem("cine:last-watched")!));
    expect(kept).toHaveLength(50);
    expect(kept).not.toContain("t0");
    expect(kept).toContain("t59");
  });
});
