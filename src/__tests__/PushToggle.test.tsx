// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
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
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("PushToggle", () => {
  it("shows the unsupported state when the browser has no PushManager", async () => {
    stubNotification("default");
    render(<PushToggle />);

    await waitFor(() => expect(screen.getByText("notifications.pushToggle.unsupported")).toBeInTheDocument());
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
});
