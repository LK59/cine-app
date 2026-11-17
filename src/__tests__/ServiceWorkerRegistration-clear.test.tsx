// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const clear = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/clearDeliveredNotifications", () => ({ clearDeliveredNotifications: clear }));
vi.mock("@/lib/chunkError", () => ({ forgetChunkReload: vi.fn() }));

import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";

afterEach(() => {
  cleanup();
  clear.mockClear();
});

const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => void document.dispatchEvent(new Event("visibilitychange")));
};

describe("les notifications lues à l'ouverture (23/09/2026)", () => {
  it("à l'ouverture, puis à chaque retour au premier plan — pas en le quittant", () => {
    render(<ServiceWorkerRegistration />);
    expect(clear).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    expect(clear).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    expect(clear).toHaveBeenCalledTimes(2);
  });
});

describe("les clés d'options retirées effacées au lancement (Lumen serveur archivé, DECISIONS.md §196)", () => {
  it("l'option, le débit retenu et les essais retirés disparaissent ; le reste de l'appareil est intact", () => {
    const retired = ["cine:lumen-serveur", "cine:lumen-debit", "cine:lumen-test-serie", "cine:lumen-reprise-saut", "cine:lumen-son-eveille"];
    for (const key of [...retired, "cine:ipad-simulator"]) localStorage.setItem(key, "1");
    render(<ServiceWorkerRegistration />);
    for (const key of retired) expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem("cine:ipad-simulator")).toBe("1");
    localStorage.clear();
  });
});
