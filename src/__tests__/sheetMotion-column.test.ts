import { describe, it, expect } from "vitest";
import { detailColumnMotion } from "@/lib/sheetMotion";

describe("detailColumnMotion", () => {
  it("entre à l'ouverture", () => {
    expect(detailColumnMotion({ leaving: false, revealed: false })).toBe("animate-fade-in-up");
  });
  it("ne rejoue rien au retour arrière", () => {
    // La fiche se découvre sous celle qu'on quitte : rien ne doit bouger (CLAUDE.md, cycle de vie).
    expect(detailColumnMotion({ leaving: false, revealed: true })).toBe("");
  });
  it("sort, qu'elle soit arrivée par un retour ou non", () => {
    expect(detailColumnMotion({ leaving: true, revealed: false })).toBe("animate-fade-out-down");
    expect(detailColumnMotion({ leaving: true, revealed: true })).toBe("animate-fade-out-down");
  });
});
