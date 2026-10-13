// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// La mesure de fluidité : armée depuis le Lab, branchée sur la grille, envoyée comme une ligne
// `fluidite` que la route accepte.
describe("Lab — mesure de fluidité", () => {
  it("la grille porte la mesure, et le journal accepte la ligne", async () => {
    expect(readFileSync("src/components/cinema/CinemaBrowseSheet.tsx", "utf8")).toMatch(/useScrollProbe\(gridRef, mediaType, grid\.length\)/);
    const { isPlayerEventKind } = await import("@/lib/playerLog");
    expect(isPlayerEventKind("fluidite")).toBe(true);
  });

  it("armer la mesure la garde sur l'appareil jusqu'à son envoi", async () => {
    const { armScrollProbe, disarmScrollProbe } = await import("@/lib/scrollProbe");
    armScrollProbe();
    expect(localStorage.getItem("cine:lab:probe")).toBe("1");
    disarmScrollProbe();
    expect(localStorage.getItem("cine:lab:probe")).toBeNull();
  });
});

// Le fondu sous l'en-tête n'est plus dans la zone qui défile (13/10/2026) : collé (`sticky`), iOS le
// recalait avec retard et une bande d'affiche passait entre le haut de la zone et lui.
describe("PlayerPanelFrame — fondu hors de la zone qui défile", () => {
  it("n'a plus d'élément collé en haut du corps", () => {
    const src = readFileSync("src/components/player/PlayerPanelFrame.tsx", "utf8");
    expect(src).not.toMatch(/sticky -?top/);
    expect(src).toMatch(/absolute inset-x-0 top-0 bg-gradient-to-b from-\(--panel-bg\)/);
  });
});
