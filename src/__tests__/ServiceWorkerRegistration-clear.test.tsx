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
