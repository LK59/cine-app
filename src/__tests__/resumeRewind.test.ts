// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { awayFrom, noteWatching, openingPosition, openingSpan, rewound, AWAY_MS } from "@/lib/resumeRewind";

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

describe("openingSpan — ce qu'on garde d'avance couvre toutes les ouvertures possibles", () => {
  it("de la position reculée à la position exacte, que le titre vienne d'être joué ou non", () => {
    // 28/09/2026 : calculé juste après l'avoir quitté, le passage gardait la position exacte ; le
    // lecteur, ouvert une heure plus tard, reculait de cinq secondes vers une image clé absente.
    noteWatching("a");
    expect(openingPosition("a", 600, 3600)).toBe(600);
    expect(openingSpan(600, 3600)).toEqual({ from: 595, position: 600 });
    expect(openingSpan(0, 3600)).toEqual({ from: 0, position: 0 });
    expect(openingSpan(20, 3600)).toEqual({ from: 20, position: 20 });
  });

  it("targetsFrom vise l'intervalle, pas l'ouverture du moment", async () => {
    noteWatching("film");
    const { targetsFrom } = await import("@/lib/resumeCache/useResumeCache");
    const [target] = targetsFrom(
      [{ id: "film", type: "Movie", positionTicks: 600 * 1e7, runtimeTicks: 3600 * 1e7 } as never],
      []
    );
    expect(target).toMatchObject({ itemId: "film", startSeconds: 595, positionSeconds: 600, started: true });
  });
});
