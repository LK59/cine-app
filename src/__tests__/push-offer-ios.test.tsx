// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";

/**
 * Où l'on propose d'activer les notifications (DECISIONS.md §17, `canOfferPush`).
 *
 * 23/10/2026, iPhone du propriétaire en 10.0.0 : « Passer » ouvre la nouvelle adresse dans la vue
 * intégrée de l'ancienne application installée ; la session s'ouvre, puis la bannière « l'application
 * installée ne reçoit pas encore de notifications » s'affiche — dans une vue qu'on va quitter, et à la
 * place de l'aide à l'installation. Cette vue se dit « standalone » et expose `PushManager`.
 */

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key, useLocale: () => ({ locale: "fr", setLocale: () => {} }) }));
const onboarding = vi.hoisted(() => ({ value: { pending: false } as { pending: boolean } | undefined }));
// `/api/onboarding` pour la bannière, `/api/config/public` (aucune nouvelle adresse annoncée) pour la
// phrase d'installation.
vi.mock("swr", () => ({ default: (key: string) => ({ data: key === "/api/onboarding" ? onboarding.value : { passageHost: null } }) }));
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => "alice" }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }));
const wasOn = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/pushOnSignOut", () => ({ pushWasOn: () => wasOn.value, forgetPushWasOn: () => {} }));

import { canOfferPush, isInstalledApp, isIosSafariBrowserTab, noteOpenedByPassageLink, PASSAGE_LINK_TAB_KEY } from "@/lib/iosInstall";
import { PushResumePrompt } from "@/components/player/PushResumePrompt";
import { PushToggle } from "@/components/PushToggle";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

let standalone = false;

function device(ua: string, opts: { standalone?: boolean; touch?: boolean } = {}) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => ua });
  standalone = opts.standalone ?? false;
  if (opts.touch) Object.defineProperty(document, "ontouchend", { configurable: true, value: null, writable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  wasOn.value = false;
  onboarding.value = { pending: false };
  localStorage.clear();
  sessionStorage.clear();
  standalone = false;
  window.matchMedia = ((query: string) => ({ matches: query.includes("standalone") && standalone, media: query })) as never;
  // Le cas le plus défavorable : un navigateur qui sait s'abonner, sans abonnement, permission ouverte.
  const reg = { pushManager: { getSubscription: async () => null } };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => reg, ready: Promise.resolve(reg) },
  });
  (window as unknown as { PushManager: unknown }).PushManager = function PushManager() {};
  (globalThis as unknown as { Notification: unknown }).Notification = { permission: "default" };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (navigator as unknown as { userAgent?: string }).userAgent;
  delete (document as unknown as { ontouchend?: unknown }).ontouchend;
});

describe("canOfferPush : la règle commune", () => {
  it("iPhone hors de l'application installée : jamais, même avec PushManager", () => {
    device(IPHONE);
    expect(canOfferPush()).toBe(false);
    expect(isIosSafariBrowserTab()).toBe(true);
  });

  it("iPad qui se dit Mac, hors de l'application installée : jamais", () => {
    device(IPAD_AS_MAC, { touch: true });
    expect(canOfferPush()).toBe(false);
  });

  it("iPhone dans l'application installée : oui", () => {
    device(IPHONE, { standalone: true });
    expect(canOfferPush()).toBe(true);
  });

  it("Android et ordinateur : inchangé — oui dans un onglet comme installé, si le navigateur sait s'abonner", () => {
    for (const ua of [ANDROID, DESKTOP]) {
      for (const s of [false, true]) {
        device(ua, { standalone: s });
        expect([ua, s, canOfferPush()]).toEqual([ua, s, true]);
      }
    }
    delete (window as unknown as { PushManager?: unknown }).PushManager;
    device(DESKTOP);
    expect(canOfferPush()).toBe(false);
  });
});

describe("isInstalledApp après un lien de passage", () => {
  it("sur iPhone, un onglet ouvert par le lien n'est pas l'application de l'écran d'accueil, même « standalone »", () => {
    device(IPHONE, { standalone: true });
    expect(isInstalledApp()).toBe(true);
    noteOpenedByPassageLink();
    expect(sessionStorage.getItem(PASSAGE_LINK_TAB_KEY)).not.toBeNull();
    expect(isInstalledApp()).toBe(false);
    expect(canOfferPush()).toBe(false);
  });

  it("sur Android, rien ne change : un lien peut y ouvrir l'application installée", () => {
    device(ANDROID, { standalone: true });
    noteOpenedByPassageLink();
    expect(isInstalledApp()).toBe(true);
  });
});

async function launchPrompt() {
  const view = render(<PushResumePrompt />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3100);
  });
  return view;
}
const promptShown = () => document.querySelector("[data-push-prompt]")?.getAttribute("data-push-prompt") ?? null;

describe("la bannière des notifications (PushResumePrompt)", () => {
  it("iPhone, vue intégrée arrivée par le lien de passage (« standalone ») : rien — ce qu'a vu le propriétaire", async () => {
    device(IPHONE, { standalone: true });
    noteOpenedByPassageLink();
    await launchPrompt();
    expect(promptShown()).toBeNull();
  });

  it("iPhone hors de l'application installée : ni l'invitation de l'application installée, ni la reprise", async () => {
    device(IPHONE);
    wasOn.value = true;
    await launchPrompt();
    expect(promptShown()).toBeNull();
  });

  it("iPhone dans l'application installée : l'invitation s'affiche", async () => {
    device(IPHONE, { standalone: true });
    await launchPrompt();
    expect(promptShown()).toBe("installed");
  });

  it("Android dans un onglet : la reprise s'affiche comme avant ; ordinateur installé : l'invitation aussi", async () => {
    device(ANDROID);
    wasOn.value = true;
    const first = await launchPrompt();
    expect(promptShown()).toBe("resume");
    first.unmount();
    wasOn.value = false;
    device(DESKTOP, { standalone: true });
    await launchPrompt();
    expect(promptShown()).toBe("installed");
  });
});

describe("l'interrupteur des notifications (PushToggle)", () => {
  it("iPhone hors de l'application installée : la phrase d'installation, pas de bouton qui demanderait la permission", async () => {
    vi.useRealTimers();
    device(IPHONE);
    render(<PushToggle />);
    await waitFor(() => expect(screen.getByText("player.onboarding.notifInstall")).toBeInTheDocument());
    expect(screen.queryByText("notifications.pushToggle.enable")).toBeNull();
  });

  it("iPhone, vue intégrée arrivée par le lien : la phrase d'installation aussi", async () => {
    vi.useRealTimers();
    device(IPHONE, { standalone: true });
    noteOpenedByPassageLink();
    render(<PushToggle />);
    await waitFor(() => expect(screen.getByText("player.onboarding.notifInstall")).toBeInTheDocument());
  });

  it("iPhone installé, Android et ordinateur dans un onglet : le bouton « Activer »", async () => {
    vi.useRealTimers();
    for (const [ua, s] of [[IPHONE, true], [ANDROID, false], [DESKTOP, false]] as const) {
      device(ua, { standalone: s });
      const view = render(<PushToggle />);
      await waitFor(() => expect(screen.getByText("notifications.pushToggle.enable")).toBeInTheDocument());
      view.unmount();
    }
  });
});
