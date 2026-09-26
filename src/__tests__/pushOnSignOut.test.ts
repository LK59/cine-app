// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dropPushOnSignOut, pushWasOn, forgetPushWasOn } from "@/lib/pushOnSignOut";

// 26/09/2026 : se déconnecter laissait l'abonnement push de l'appareil au compte qui partait —
// sur un iPad partagé, le suivant recevait ses notifications.

function withSubscription(sub: { endpoint: string; unsubscribe: () => Promise<boolean> } | null) {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }) },
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("dropPushOnSignOut", () => {
  it("désabonne l'appareil, prévient le serveur et retient que c'était activé", async () => {
    const unsubscribe = vi.fn(async () => true);
    withSubscription({ endpoint: "https://web.push.apple.com/abc", unsubscribe });
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await dropPushOnSignOut("louis");

    expect(unsubscribe).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/push/subscribe", expect.objectContaining({ method: "DELETE" }));
    expect(pushWasOn("louis")).toBe(true);
    expect(pushWasOn("timeo")).toBe(false);
    forgetPushWasOn("louis");
    expect(pushWasOn("louis")).toBe(false);
  });

  it("sans abonnement, ne retient rien et n'appelle personne", async () => {
    withSubscription(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await dropPushOnSignOut("louis");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pushWasOn("louis")).toBe(false);
  });

  it("ne lève jamais, même si le navigateur refuse", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: async () => { throw new Error("non"); } },
    });
    await expect(dropPushOnSignOut("louis")).resolves.toBeUndefined();
  });
});
