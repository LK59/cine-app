// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFakeCast } from "./helpers/fakeCast";
import {
  CAST_SENDER_URL,
  chromecastConfig,
  chromecastSnapshot,
  errorCode,
  requestChromecastSession,
  resetChromecastForTests,
  startChromecastSender,
  subscribeChromecast,
  endChromecastSession,
} from "@/lib/chromecast/framework";
import { chromecastSenderEligible } from "@/lib/chromecast/eligible";
import { DEFAULT_MEDIA_RECEIVER_APP_ID, receiverAppIdOf } from "@/lib/chromecast/receiverAppId";

// DECISIONS.md §64 — le kit d'émission de Google, simulé : aucun récepteur n'est là pour l'éprouver.

const mockFetch = vi.fn();

beforeEach(() => {
  resetChromecastForTests();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ allowed: true, receiverAppId: "ABCDEF12" }) });
  const w = window as unknown as { cast?: unknown; chrome?: unknown; __onGCastApiAvailable?: unknown };
  delete w.cast;
  delete w.chrome;
  delete w.__onGCastApiAvailable;
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chromecastSenderEligible — qui peut émettre depuis une page", () => {
  const ua = {
    chromeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0",
    chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    chromeAndroid: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36",
    safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1",
    chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/152.0 Mobile/15E148 Safari/604.1",
    safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    silk: "Mozilla/5.0 (Linux; Android 11; AFTT) AppleWebKit/537.36 (KHTML, like Gecko) Silk/152.4.7 like Chrome/152.0.7977.140 Safari/537.36",
    samsung: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0 Mobile Safari/537.36",
    webview: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/152.0 Mobile Safari/537.36",
  };

  it("Chrome et Edge, sur ordinateur et sur Android", () => {
    for (const agent of [ua.chromeWindows, ua.edge, ua.chromeMac, ua.chromeAndroid]) expect(chromecastSenderEligible(agent), agent).toBe(true);
  });

  it("jamais l'iPhone (Safari comme Chrome), Safari sur Mac, Firefox, la Fire TV, Samsung Internet, une vue web", () => {
    for (const agent of [ua.safariIphone, ua.chromeIphone, ua.safariMac, ua.firefox, ua.silk, ua.samsung, ua.webview, "", null, undefined]) {
      expect(chromecastSenderEligible(agent), String(agent)).toBe(false);
    }
  });
});

describe("receiverAppIdOf — l'application du Chromecast", () => {
  it("le récepteur public de Google par défaut, ou une valeur bien formée", () => {
    expect(DEFAULT_MEDIA_RECEIVER_APP_ID).toBe("CC1AD845");
    expect(receiverAppIdOf("")).toBe("CC1AD845");
    expect(receiverAppIdOf(null)).toBe("CC1AD845");
    expect(receiverAppIdOf(" abcdef12 ")).toBe("ABCDEF12");
    // Une faute de frappe ne fait pas disparaître la diffusion.
    expect(receiverAppIdOf("ABC")).toBe("CC1AD845");
    expect(receiverAppIdOf("ZZZZZZZZ")).toBe("CC1AD845");
  });
});

describe("chargement du kit", () => {
  it("rien ne se charge tant que personne ne le demande", () => {
    expect(chromecastSnapshot().phase).toBe("off");
    expect(document.head.querySelector("script")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("injecte le script de Google une fois, attend __onGCastApiAvailable, applique le récepteur réglé", async () => {
    const fake = createFakeCast();
    const ready = startChromecastSender();
    expect(chromecastSnapshot().phase).toBe("loading");
    const script = document.head.querySelector("script");
    expect(script?.src).toBe(CAST_SENDER_URL);
    expect(startChromecastSender()).toBe(ready);
    fake.install();
    (window as unknown as { __onGCastApiAvailable: (ok: boolean) => void }).__onGCastApiAvailable(true);
    expect(await ready).toBe(true);
    expect(fake.options).toEqual([{ receiverApplicationId: "ABCDEF12", autoJoinPolicy: "origin_scoped" }]);
    expect(document.head.querySelectorAll("script")).toHaveLength(1);
  });

  it("le kit absent (délai dépassé) : indisponible, sans exception, et un nouvel essai reste possible", async () => {
    vi.useFakeTimers();
    const ready = startChromecastSender(1000);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await ready).toBe(false);
    expect(chromecastSnapshot().phase).toBe("unavailable");
    expect(startChromecastSender(1000)).not.toBe(ready);
  });

  it("un navigateur sans routeur de médias (le kit répond « non ») : indisponible", async () => {
    const ready = startChromecastSender();
    (window as unknown as { __onGCastApiAvailable: (ok: boolean) => void }).__onGCastApiAvailable(false);
    expect(await ready).toBe(false);
  });

  it("suit la disponibilité des récepteurs : le bouton n'a lieu d'être qu'avec au moins un", async () => {
    const fake = createFakeCast();
    fake.install();
    fake.setCastState("NO_DEVICES_AVAILABLE");
    await startChromecastSender();
    expect(chromecastSnapshot()).toMatchObject({ phase: "ready", devices: false, connected: false });
    const seen: boolean[] = [];
    const off = subscribeChromecast(() => seen.push(chromecastSnapshot().devices));
    fake.setCastState("NOT_CONNECTED");
    expect(chromecastSnapshot().devices).toBe(true);
    fake.connect("Salon");
    expect(chromecastSnapshot()).toMatchObject({ connected: true, device: "Salon" });
    off();
    expect(seen).toContain(true);
  });
});

describe("requestChromecastSession", () => {
  it("ouvre la session et rend le nom du récepteur", async () => {
    const fake = createFakeCast();
    fake.install();
    await startChromecastSender();
    expect(await requestChromecastSession()).toEqual({ ok: true, device: "Salon" });
  });

  it("la liste fermée sans choix : `cancel`, rien d'autre", async () => {
    const fake = createFakeCast();
    fake.install();
    await startChromecastSender();
    fake.requestSession.next = () => Promise.reject("cancel");
    expect(await requestChromecastSession()).toEqual({ ok: false, code: "cancel" });
    fake.requestSession.next = () => Promise.reject({ code: "receiver_unavailable" });
    expect(await requestChromecastSession()).toEqual({ ok: false, code: "receiver_unavailable" });
  });

  it("sans kit chargé : refusée, sans exception", async () => {
    expect(await requestChromecastSession()).toEqual({ ok: false, code: "api_not_initialized" });
    expect(() => endChromecastSession(true)).not.toThrow();
  });

  it("errorCode lit une chaîne, un objet chrome.cast.Error, ou rien", () => {
    expect(errorCode("timeout")).toBe("timeout");
    expect(errorCode({ code: "session_error" })).toBe("session_error");
    expect(errorCode(new Error("x"))).toBe("unknown");
  });
});

describe("chromecastConfig — la réponse de l'installation pour ce compte", () => {
  it("demandée une fois par page", async () => {
    await chromecastConfig();
    await chromecastConfig();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/player/cast");
  });

  it("un échec : pas de bouton, récepteur de Google, et la question sera reposée", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502 });
    expect(await chromecastConfig()).toEqual({ allowed: false, receiverAppId: "CC1AD845" });
    expect(await chromecastConfig()).toEqual({ allowed: true, receiverAppId: "ABCDEF12" });
  });
});
