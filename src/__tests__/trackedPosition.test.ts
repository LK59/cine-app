import { describe, it, expect } from "vitest";
import { trackedPosition } from "@/components/player/session/trackedPosition";

describe("trackedPosition — la position retenue d'un timeupdate", () => {
  it("un zéro sans saut ne remplace pas une position connue (décodeur WebKit qui lâche à 3 588 s)", () => {
    expect(trackedPosition(3588, { currentTime: 0, seeking: false })).toBe(3588);
  });
  it("un retour au début demandé (l'élément cherche) est retenu", () => {
    expect(trackedPosition(3588, { currentTime: 0, seeking: true })).toBe(0);
  });
  it("une ouverture du début, ou une position ordinaire, passe telle quelle", () => {
    expect(trackedPosition(0, { currentTime: 0, seeking: false })).toBe(0);
    expect(trackedPosition(0.5, { currentTime: 0, seeking: false })).toBe(0);
    expect(trackedPosition(3588, { currentTime: 3589.2, seeking: false })).toBe(3589.2);
    expect(trackedPosition(3588, { currentTime: 0.04, seeking: false })).toBe(0.04);
  });
});
