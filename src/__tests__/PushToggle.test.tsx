// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => ({ locale: "fr", setLocale: () => {} }),
}));
const toastError = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}));

let pageAccount: string | null = null;
vi.mock("@/lib/persistentCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/persistentCache")>()),
  persistedCacheAccount: () => pageAccount,
}));

import { PushToggle } from "@/components/PushToggle";

function stubServiceWorker(pushManager: {
  getSubscription: () => Promise<unknown>;
  subscribe?: (opts: unknown) => Promise<unknown>;
}) {
  // navigator.serviceWorker isn't writable by default in jsdom — redefine it directly rather
  // than replacing the whole `navigator` global (which testing-library relies on elsewhere).
  Object.defineProperty(navigator, "serviceWorker", {
    value: { ready: Promise.resolve({ pushManager }) },
    configurable: true,
  });
  // "PushManager" in window is how the component detects support.
  (window as unknown as { PushManager: unknown }).PushManager = class {};
}

function stubNotification(permission: NotificationPermission, requestPermission?: () => Promise<NotificationPermission>) {
  vi.stubGlobal("Notification", {
    permission,
    requestPermission: requestPermission ?? vi.fn().mockResolvedValue(permission),
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { PushManager?: unknown }).PushManager;
});

beforeEach(() => {
  toastError.mockClear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("PushToggle", () => {
  it("shows the unsupported state when the browser has no PushManager", async () => {
    stubNotification("default");
    render(<PushToggle />);

    await waitFor(() => expect(screen.getByText("notifications.pushToggle.unsupported")).toBeInTheDocument());
  });

  // 15/10/2026 (passe de nuit, MOBILE-4) : sur iPhone dans Safari, « non supportées sur ce
  // navigateur » contredisait l'accueil, qui renvoyait au Compte une fois l'app installée.
  it("sur iPhone hors de l'app installée, dit d'installer l'application", async () => {
    stubNotification("default");
    vi.stubGlobal("navigator", { ...window.navigator, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1" });
    render(<PushToggle />);
    await waitFor(() => expect(screen.getByText("player.onboarding.notifInstall")).toBeInTheDocument());
    expect(screen.queryByText("notifications.pushToggle.unsupported")).toBeNull();
  });

  it("shows the blocked state when notification permission was already denied", async () => {
    stubServiceWorker({ getSubscription: () => Promise.resolve(null) });
    stubNotification("denied");
    render(<PushToggle />);

    await waitFor(() => expect(screen.getByText("notifications.pushToggle.blocked")).toBeInTheDocument());
  });

  it("shows the enabled state when a push subscription already exists", async () => {
    stubServiceWorker({ getSubscription: () => Promise.resolve({ endpoint: "https://push.example/1" }) });
    stubNotification("granted");
    render(<PushToggle />);

    await waitFor(() => expect(screen.getByText("notifications.pushToggle.enabled")).toBeInTheDocument());
  });

  it("shows the enable button when supported but not yet subscribed", async () => {
    stubServiceWorker({ getSubscription: () => Promise.resolve(null) });
    stubNotification("default");
    render(<PushToggle />);

    await waitFor(() => expect(screen.getByText("notifications.pushToggle.enable")).toBeInTheDocument());
  });

  it("subscribes and posts the subscription to the server on click", async () => {
    const subscription = { endpoint: "https://push.example/1", toJSON: () => ({ endpoint: "https://push.example/1" }) };
    stubServiceWorker({
      getSubscription: () => Promise.resolve(null),
      subscribe: () => Promise.resolve(subscription),
    });
    stubNotification("default", vi.fn().mockResolvedValue("granted"));
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/push/vapid-key") return Promise.resolve({ ok: true, json: async () => ({ publicKey: "AAAA" }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PushToggle />);

    await screen.findByText("notifications.pushToggle.enable");
    await user.click(screen.getByText("notifications.pushToggle.enable"));

    await waitFor(() => expect(screen.getByText("notifications.pushToggle.enabled")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/subscribe",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("falls back to unsubscribed state when the VAPID key fetch fails", async () => {
    stubServiceWorker({ getSubscription: () => Promise.resolve(null) });
    stubNotification("default");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    const user = userEvent.setup();
    render(<PushToggle />);

    await screen.findByText("notifications.pushToggle.enable");
    await user.click(screen.getByText("notifications.pushToggle.enable"));

    await waitFor(() => expect(screen.getByText("notifications.pushToggle.enable")).toBeInTheDocument());
  });

  it("unsubscribes and deletes the subscription on the server on click", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    stubServiceWorker({
      getSubscription: () => Promise.resolve({ endpoint: "https://push.example/1", unsubscribe }),
    });
    stubNotification("granted");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PushToggle />);

    await screen.findByText("notifications.pushToggle.enabled");
    await user.click(screen.getByText("notifications.pushToggle.disable"));

    await waitFor(() => expect(screen.getByText("notifications.pushToggle.enable")).toBeInTheDocument());
    expect(unsubscribe).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/subscribe",
      expect.objectContaining({ method: "DELETE" })
    );
  });
  /**
   * Le navigateur peut très bien créer l'abonnement pendant que le serveur, lui, le refuse.
   * Sans annulation ni message, l'interrupteur s'affichait « activé » pour un abonnement que
   * personne n'écoutait — et l'utilisateur n'aurait jamais reçu la moindre notification.
   */
  it("undoes the browser subscription and speaks up when the server refuses it", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscription = {
      endpoint: "https://push.example/1",
      toJSON: () => ({ endpoint: "https://push.example/1" }),
      unsubscribe,
    };
    stubServiceWorker({
      getSubscription: () => Promise.resolve(null),
      subscribe: () => Promise.resolve(subscription),
    });
    stubNotification("default", vi.fn().mockResolvedValue("granted"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "/api/push/vapid-key") return Promise.resolve({ ok: true, json: async () => ({ publicKey: "AAAA" }) });
        return Promise.resolve({ ok: false, status: 500, statusText: "Server Error", json: async () => ({ error: "Stockage indisponible" }) });
      })
    );
    const user = userEvent.setup();
    render(<PushToggle />);

    await screen.findByText("notifications.pushToggle.enable");
    await user.click(screen.getByText("notifications.pushToggle.enable"));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Stockage indisponible"));
    expect(unsubscribe).toHaveBeenCalled();
    expect(screen.getByText("notifications.pushToggle.enable")).toBeInTheDocument();
  });

  /**
   * « Déjà renvoyé aujourd'hui » se retient par compte (revue de sécurité du 20/10/2026).
   *
   * Le serveur range un point de terminaison sous le compte qui l'a envoyé en dernier. Avec une seule
   * clé pour l'appareil, un second compte ouvrant son panneau le même jour ne renvoyait rien :
   * l'abonnement restait rangé sous le premier, qui recevait les notifications de l'autre.
   */
  it("un autre compte sur le même appareil renvoie l'abonnement sous son nom", async () => {
    localStorage.clear();
    const existing = { endpoint: "https://push.example/1", toJSON: () => ({ endpoint: "https://push.example/1" }), unsubscribe: vi.fn() };
    stubServiceWorker({ getSubscription: () => Promise.resolve(existing) });
    stubNotification("granted");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const posts = () => fetchMock.mock.calls.filter(([url, init]) => url === "/api/push/subscribe" && init?.method === "POST").length;

    pageAccount = "louis";
    render(<PushToggle />);
    await waitFor(() => expect(posts()).toBe(1));
    await waitFor(() => expect(localStorage.getItem("cine-push-sent:louis")).not.toBeNull());
    cleanup();

    // Le même compte, le même jour : rien à redire.
    render(<PushToggle />);
    await screen.findByText("notifications.pushToggle.enabled");
    await new Promise((r) => setTimeout(r, 20));
    expect(posts()).toBe(1);
    cleanup();

    // Un autre compte : il réenregistre le point de terminaison sous lui.
    pageAccount = "lucas";
    render(<PushToggle />);
    await waitFor(() => expect(posts()).toBe(2));
    pageAccount = null;
    localStorage.clear();
  });
});
