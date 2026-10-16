// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { ipadSimulatorScript, IPAD_SIMULATOR_KEY } from "@/lib/ipadSimulator";

const DEVICE = "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover";

function viewport(): string | null {
  return document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null;
}

describe("le simulateur d'iPad", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.head.innerHTML = `<meta name="viewport" content="${DEVICE}">`;
  });

  it("inactif, la page garde la largeur de l'appareil", () => {
    new Function(ipadSimulatorScript())();
    expect(viewport()).toBe(DEVICE);
  });

  it("actif sur cet appareil, la page est dessinée sur la largeur d'un iPad", () => {
    window.localStorage.setItem(IPAD_SIMULATOR_KEY, "1");
    new Function(ipadSimulatorScript())();
    expect(viewport()).toBe("width=1180, viewport-fit=cover");
  });

  it("une méta `viewport` ajoutée après coup (Next en réécrit une) est corrigée aussi", async () => {
    window.localStorage.setItem(IPAD_SIMULATOR_KEY, "1");
    new Function(ipadSimulatorScript())();
    const late = document.createElement("meta");
    late.name = "viewport";
    late.content = DEVICE;
    document.head.append(late);
    await Promise.resolve();
    expect(late.getAttribute("content")).toBe("width=1180, viewport-fit=cover");
  });
});
