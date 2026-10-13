// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SmoothnessLot } from "@/components/animlab/SmoothnessLot";
import { setLabFlag } from "@/lib/labFlags";

// Les essais de fluidité de « Tous les films » (Lab → Tests divers, 13/10/2026) : trois
// interrupteurs gardés sur l'appareil, éteints par défaut, chacun branché sur son suspect.
describe("Lab — fluidité de la grille", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    for (const f of ["filtersNoScroll", "noHeaderFade", "noDecodeAhead"] as const) setLabFlag(f, false);
  });

  it("trois interrupteurs éteints par défaut, gardés sur l'appareil une fois allumés", () => {
    render(<SmoothnessLot />);
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(3);
    expect(switches.every((s) => s.getAttribute("aria-checked") === "false")).toBe(true);
    fireEvent.click(switches[0]);
    expect(localStorage.getItem("cine:lab:filtersNoScroll")).toBe("1");
  });

  it("chaque essai est branché sur son suspect", () => {
    const sheet = readFileSync("src/components/cinema/CinemaBrowseSheet.tsx", "utf8");
    expect(sheet).toMatch(/lab\.filtersNoScroll \? "flex-wrap" : "overflow-x-auto"/);
    expect(sheet).toMatch(/useDecodeAhead\(gridRef, grid, !lab\.noDecodeAhead\)/);
    expect(readFileSync("src/components/player/PlayerPanelFrame.tsx", "utf8")).toMatch(/!lab\.noHeaderFade &&/);
  });
});

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
