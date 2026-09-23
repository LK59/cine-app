// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { clearDeliveredNotifications } from "@/lib/clearDeliveredNotifications";

/**
 * La pastille « 1 » restait sur l'icône et la notification dans le centre de notifications
 * (23/09/2026) : rien ne les effaçait. Ouvrir l'application vaut lecture.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  // @ts-expect-error — nettoyage des doublures posées sur navigator
  delete navigator.clearAppBadge;
  // @ts-expect-error — idem
  delete navigator.serviceWorker;
});

describe("clearDeliveredNotifications", () => {
  it("efface la pastille et retire les notifications affichées", async () => {
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    const closes = [vi.fn(), vi.fn()];
    Object.defineProperty(navigator, "clearAppBadge", { value: clearAppBadge, configurable: true });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: async () => ({ getNotifications: async () => closes.map((close) => ({ close })) }) },
    });
    await clearDeliveredNotifications();
    expect(clearAppBadge).toHaveBeenCalled();
    for (const close of closes) expect(close).toHaveBeenCalled();
  });

  it("ne lève jamais, même sans aucune de ces API", async () => {
    await expect(clearDeliveredNotifications()).resolves.toBeUndefined();
    Object.defineProperty(navigator, "clearAppBadge", { value: () => Promise.reject(new Error("refusé")), configurable: true });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: async () => { throw new Error("pas de worker"); } },
    });
    await expect(clearDeliveredNotifications()).resolves.toBeUndefined();
  });
});
