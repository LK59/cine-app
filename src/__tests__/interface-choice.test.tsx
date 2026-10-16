// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useIsMobile, canChooseInterface, resetInterfaceForTests } from "@/lib/useIsMobile";

/**
 * L'interface tactile ou ordinateur (16/10/2026) : un appareil touché reçoit l'interface tactile
 * quelle que soit sa taille, sauf une Fire TV ; le choix Compte → Interface ne vaut que là où il
 * est proposé.
 */
type Device = { narrow?: boolean; touch?: boolean; anyCoarse?: boolean; screen?: [number, number]; ua?: string };

function device({ narrow = false, touch = false, anyCoarse = touch, screen = [1194, 834], ua = "Mozilla/5.0 (Macintosh)" }: Device) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width: 767px") ? narrow : query.includes("hover: none") ? touch : query.includes("any-pointer: coarse") ? anyCoarse : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  Object.defineProperty(window, "screen", { configurable: true, value: { width: screen[0], height: screen[1] } });
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: ua });
}

const mobile = () => renderHook(() => useIsMobile()).result.current;

describe("l'interface de l'appareil", () => {
  beforeEach(() => {
    resetInterfaceForTests();
    window.localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("un écran étroit a toujours l'interface tactile", () => {
    device({ narrow: true, screen: [390, 844], touch: true });
    expect(mobile()).toBe(true);
  });

  it("un iPad, large et touché, a l'interface tactile", () => {
    device({ touch: true });
    expect(mobile()).toBe(true);
  });

  it("un ordinateur à souris garde l'interface ordinateur, et n'a pas le choix", () => {
    device({ touch: false, anyCoarse: false, screen: [1920, 1080] });
    expect(mobile()).toBe(false);
    expect(canChooseInterface()).toBe(false);
  });

  it("une Fire TV garde l'interface ordinateur, et n'a pas le choix", () => {
    device({ touch: true, screen: [1920, 1080], ua: "Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) AppleWebKit/537.36 (KHTML, like Gecko) Silk/112.3.1 like Chrome/112.0 Safari/537.36" });
    expect(mobile()).toBe(false);
    expect(canChooseInterface()).toBe(false);
  });

  it("sur un iPad, « Ordinateur » donne l'interface ordinateur", () => {
    device({ touch: true });
    window.localStorage.setItem("cine:interface", "desktop");
    expect(canChooseInterface()).toBe(true);
    expect(mobile()).toBe(false);
  });

  it("sur un PC à écran tactile, « Tactile » donne l'interface tactile", () => {
    device({ touch: false, anyCoarse: true, screen: [1920, 1080] });
    expect(mobile()).toBe(false);
    window.localStorage.setItem("cine:interface", "touch");
    expect(mobile()).toBe(true);
  });

  it("un choix rangé sur un téléphone est sans effet : l'interface ordinateur n'y est pas proposée", () => {
    device({ narrow: true, touch: true, screen: [390, 844] });
    window.localStorage.setItem("cine:interface", "desktop");
    expect(canChooseInterface()).toBe(false);
    expect(mobile()).toBe(true);
  });
});
