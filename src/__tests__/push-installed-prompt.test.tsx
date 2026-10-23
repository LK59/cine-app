// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
const onboarding = vi.hoisted(() => ({ value: { pending: false } as { pending: boolean } | undefined }));
vi.mock("swr", () => ({ default: () => ({ data: onboarding.value }) }));
vi.mock("@/components/PushToggle", () => ({ PushToggle: () => <button type="button">toggle</button> }));
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => "alice" }));
const wasOn = vi.hoisted(() => ({ value: false, forget: vi.fn() }));
vi.mock("@/lib/pushOnSignOut", () => ({ pushWasOn: () => wasOn.value, forgetPushWasOn: (...a: unknown[]) => wasOn.forget(...a) }));

import { PushResumePrompt, INSTALLED_PUSH_OFFERED_KEY } from "@/components/player/PushResumePrompt";

/**
 * L'invitation aux notifications de l'application installée (23/10/2026) : réglées dans un onglet
 * de Safari, les notifications n'abonnent pas l'application installée ensuite — ni une nouvelle
 * adresse. Une fois par appareil, jamais avec l'invitation de reprise.
 */
let standalone = true;
let subscription: object | null = null;
let permission: NotificationPermission = "default";

beforeEach(() => {
  vi.useFakeTimers();
  standalone = true;
  subscription = null;
  permission = "default";
  wasOn.value = false;
  wasOn.forget.mockClear();
  onboarding.value = { pending: false };
  localStorage.clear();
  window.matchMedia = ((query: string) => ({ matches: query.includes("standalone") && standalone, media: query })) as never;
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) },
  });
  (window as unknown as { PushManager: unknown }).PushManager = function PushManager() {};
  (globalThis as unknown as { Notification: unknown }).Notification = { get permission() { return permission; } };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function launch() {
  const view = render(<PushResumePrompt />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  return view;
}

const shown = () => document.querySelector("[data-push-prompt]")?.getAttribute("data-push-prompt") ?? null;

describe("l'invitation aux notifications de l'application installée", () => {
  it("s'affiche dans l'application installée sans abonnement, après le délai du lancement", async () => {
    render(<PushResumePrompt />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2900);
    });
    expect(shown()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(shown()).toBe("installed");
    expect(screen.getByText("player.pushInstalled.body")).toBeInTheDocument();
    expect(localStorage.getItem(INSTALLED_PUSH_OFFERED_KEY)).not.toBeNull();
  });

  it("ne s'affiche pas dans un onglet", async () => {
    standalone = false;
    await launch();
    expect(shown()).toBeNull();
  });

  it("vaut aussi pour navigator.standalone (iOS)", async () => {
    standalone = false;
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    await launch();
    expect(shown()).toBe("installed");
    Object.defineProperty(navigator, "standalone", { configurable: true, value: undefined });
  });

  it("ne s'affiche pas avec un abonnement déjà actif", async () => {
    subscription = { endpoint: "https://push.example/1" };
    await launch();
    expect(shown()).toBeNull();
  });

  it("ne s'affiche pas quand la permission est refusée", async () => {
    permission = "denied";
    await launch();
    expect(shown()).toBeNull();
  });

  it("ne s'affiche pas sans PushManager", async () => {
    delete (window as unknown as { PushManager?: unknown }).PushManager;
    await launch();
    expect(shown()).toBeNull();
  });

  it("attend la fin de l'écran d'accueil, et ne compte pas comme faite tant qu'il est là", async () => {
    onboarding.value = { pending: true };
    const view = await launch();
    expect(shown()).toBeNull();
    expect(localStorage.getItem(INSTALLED_PUSH_OFFERED_KEY)).toBeNull();
    onboarding.value = { pending: false };
    view.rerender(<PushResumePrompt />);
    expect(shown()).toBe("installed");
  });

  it("une seule fois par appareil : fermée, elle ne revient pas au lancement suivant", async () => {
    const first = await launch();
    fireEvent.click(screen.getByLabelText("player.pushInstalled.later"));
    expect(shown()).toBeNull();
    first.unmount();
    await launch();
    expect(shown()).toBeNull();
  });

  it("jamais avec l'invitation de reprise : celle-ci passe seule, et l'autre reste à faire", async () => {
    wasOn.value = true;
    await launch();
    expect(shown()).toBe("resume");
    expect(document.querySelectorAll("[data-push-prompt]")).toHaveLength(1);
    expect(screen.queryByText("player.pushInstalled.body")).toBeNull();
    expect(localStorage.getItem(INSTALLED_PUSH_OFFERED_KEY)).toBeNull();
  });
});
