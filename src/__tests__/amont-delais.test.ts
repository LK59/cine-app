import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

// Un service qui accepte la connexion sans jamais répondre n'était borné que par undici — 300 s
// pour les en-têtes. La connexion à cine-app attendait ainsi Jellyseerr, que son propre
// commentaire disait « best-effort », et chaque tick du suivi des torrents empilait un appel
// pendant vers qBittorrent. Le `fetch` simulé ici ne répond jamais : seule l'annulation le libère.

vi.mock("@/lib/config", () => ({
  config: {
    jellyfin: { url: "http://jellyfin.local" },
    jellyseerr: { url: "http://jellyseerr.local", apiKey: "seerr-key" },
    qbittorrent: { url: "http://qb.local", username: "admin", password: "x" },
    bazarr: { url: "http://bazarr.local", apiKey: "bz-key" },
    app: { cookieSecure: false, language: "fr" },
  },
}));
vi.mock("@/lib/auth", () => ({
  createSessionToken: vi.fn(async () => ({ token: "signed-token", jti: "jti-1" })),
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 3600,
}));
vi.mock("@/lib/db", () => ({
  sessionDb: { create: vi.fn((): string[] => []) },
  userPrefsDb: { getLang: vi.fn(() => "fr") },
}));
vi.mock("@/lib/rateLimiter", () => ({ checkRateLimit: () => true }));
vi.mock("@/lib/i18n", () => ({ LOCALE_COOKIE: "cine-lang" }));
vi.mock("@/lib/api-helpers", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/eventLogs", () => ({ logAuthEvent: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/jellyfinRevoke", () => ({ revokeJellyfinDevices: vi.fn(async () => {}) }));

/** Ne répond jamais ; rejette seulement quand le signal de l'appel est annulé. */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
  });
}

const jellyfinOk = () =>
  new Response(JSON.stringify({ User: { Name: "louis", Id: "jf-1", Policy: { IsAdministrator: false } }, AccessToken: "tok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function fakeReq(body: unknown): NextRequest {
  return { json: async () => body, headers: new Headers({ "user-agent": "test" }) } as unknown as NextRequest;
}

/** L'issue d'une promesse au bout de `ms` de temps simulé : réglée, ou encore pendante. */
async function settledWithin<T>(p: Promise<T>, ms: number) {
  let outcome: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (value) => (outcome = { done: true, value }),
    (error) => (outcome = { done: true, error })
  );
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("appels amont bornés", () => {
  it("la connexion aboutit quand Jellyseerr ne répond jamais", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) =>
      String(url).startsWith("http://jellyfin.local") ? Promise.resolve(jellyfinOk()) : hang(init)
    ));
    const { POST } = await import("@/app/api/auth/jellyfin/route");
    const outcome = await settledWithin(POST(fakeReq({ username: "louis", password: "x" })), 6000);
    expect(outcome.done).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect((outcome.value as Response).status).toBe(200);
  });

  it("la connexion répond 502 quand Jellyfin ne répond jamais", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => hang(init)));
    const { POST } = await import("@/app/api/auth/jellyfin/route");
    const outcome = await settledWithin(POST(fakeReq({ username: "louis", password: "x" })), 11_000);
    expect(outcome.done).toBe(true);
    expect((outcome.value as Response).status).toBe(502);
  });

  it("un appel qBittorrent qui pend est rejeté (connexion puis requête)", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => hang(init)));
    let { qbittorrent } = await import("@/lib/clients/qbittorrent");
    const outcome = await settledWithin(qbittorrent.getTorrents(), 6000);
    expect(outcome.done && outcome.error).toBeTruthy();

    // Connexion acceptée, requête qui pend.
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) =>
      String(url).endsWith("/auth/login")
        ? Promise.resolve(new Response("Ok.", { status: 200, headers: { "set-cookie": "SID=abc; path=/" } }))
        : hang(init)
    ));
    ({ qbittorrent } = await import("@/lib/clients/qbittorrent"));
    const transfer = await settledWithin(qbittorrent.getTransferInfo(), 6000);
    expect(transfer.done && transfer.error).toBeTruthy();
  });

  it("un téléchargement de sous-titre Bazarr qui pend est rejeté", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => hang(init)));
    const { bazarr } = await import("@/lib/clients/bazarr");
    const candidate = { hearing_impaired: "False", forced: "False", original_format: "False", provider: "p", subtitle: "s" };
    const outcome = await settledWithin(
      Promise.resolve(bazarr.downloadMovieSubtitle({ radarrId: 1, candidate } as never)),
      31_000
    );
    expect(outcome.done && outcome.error).toBeTruthy();
  });
});
