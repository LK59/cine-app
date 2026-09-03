import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockNotificationPrefsDb = { getForUser: vi.fn(), set: vi.fn() };
const mockPushDb = { getByUser: vi.fn(), remove: vi.fn() };
const mockUserPrefsDb = {
  getLang: vi.fn(),
  setLang: vi.fn(),
  getExperimentalPlayer: vi.fn(() => ({ enabled: false, hdr: false })),
  setExperimentalPlayer: vi.fn(),
};
const mockSessionDb = { countOthers: vi.fn(), deleteOthers: vi.fn() };
vi.mock("@/lib/db", () => ({
  notificationPrefsDb: mockNotificationPrefsDb,
  pushDb: mockPushDb,
  userPrefsDb: mockUserPrefsDb,
  sessionDb: mockSessionDb,
}));
vi.mock("@/lib/notifications", () => ({ isNotificationCategory: (c: string) => ["push-torrent", "watchlist-available"].includes(c) }));
const mockIsWebPushConfigured = vi.fn();
const mockSendWebPush = vi.fn();
const mockShouldRemovePushSubscription = vi.fn();
vi.mock("@/lib/webPush", () => ({
  isWebPushConfigured: () => mockIsWebPushConfigured(),
  sendWebPush: (...a: unknown[]) => mockSendWebPush(...a),
  shouldRemovePushSubscription: (...a: unknown[]) => mockShouldRemovePushSubscription(...a),
}));
vi.mock("@/lib/config", () => ({ config: { app: { language: "fr", cookieSecure: false } } }));
vi.mock("@/lib/i18n", () => ({ LOCALE_COOKIE: "cine-lang", LOCALES: ["fr", "en", "es", "de"] }));
const mockTmdb = { getMovie: vi.fn(), getTv: vi.fn() };
const mockOmdb = { isEnabled: vi.fn(() => true), getRating: vi.fn() };
vi.mock("@/lib/clients/tmdb", () => ({ tmdb: mockTmdb }));
vi.mock("@/lib/clients/omdb", () => ({ omdb: mockOmdb }));
vi.mock("@/lib/server-cache", () => ({
  withPersistentCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  cachedMovies: vi.fn(async () => []),
  cachedSeries: vi.fn(async () => []),
}));
vi.mock("@/lib/vip-persons", () => ({ VIP_PERSONS: { 1: { id: 1, name: "Clara", bio: "..." } } }));

function fakeReq(opts: { params?: Record<string, string>; body?: unknown; cookie?: string } = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(opts.params ?? {}) },
    cookies: { get: (name: string) => (name === "cine_session" && opts.cookie !== undefined ? (opts.cookie ? { value: opts.cookie } : undefined) : { value: "t" }) },
    json: async () => opts.body ?? null,
  } as unknown as NextRequest;
}

const originalEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv };
});
afterEach(() => {
  process.env = originalEnv;
});

describe("/api/notifications/settings", () => {
  it("GET returns 401 without a session", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/notifications/settings/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(401);
  });

  it("PUT only applies known notification categories, ignoring unknown keys", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    mockNotificationPrefsDb.getForUser.mockReturnValue({});
    const { PUT } = await import("@/app/api/notifications/settings/route");
    await PUT(fakeReq({ body: { preferences: { "push-torrent": false, "not-a-real-category": true } } }));
    expect(mockNotificationPrefsDb.set).toHaveBeenCalledWith("louis", "push-torrent", false);
    expect(mockNotificationPrefsDb.set).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/push/test", () => {
  it("returns 503 when VAPID isn't configured", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    mockIsWebPushConfigured.mockReturnValue(false);
    const { POST } = await import("@/app/api/push/test/route");
    const res = await POST(fakeReq());
    expect(res.status).toBe(503);
  });

  it("returns 404 when the user has no push subscriptions", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    mockIsWebPushConfigured.mockReturnValue(true);
    mockPushDb.getByUser.mockReturnValue([]);
    const { POST } = await import("@/app/api/push/test/route");
    const res = await POST(fakeReq());
    expect(res.status).toBe(404);
  });

  it("removes a subscription that Jellyfin/the browser reports as gone", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    mockIsWebPushConfigured.mockReturnValue(true);
    mockPushDb.getByUser.mockReturnValue([{ endpoint: "https://push.example/abc", p256dh: "x", auth: "y" }]);
    mockSendWebPush.mockRejectedValue({ statusCode: 410 });
    mockShouldRemovePushSubscription.mockReturnValue(true);
    const { POST } = await import("@/app/api/push/test/route");
    const res = await POST(fakeReq());
    const body = await res.json();
    expect(mockPushDb.remove).toHaveBeenCalledWith("https://push.example/abc");
    expect(body.ok).toBe(false);
  });
});

describe("GET /api/push/vapid-key", () => {
  it("returns 503 when VAPID_PUBLIC_KEY is unset", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const { GET } = await import("@/app/api/push/vapid-key/route");
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it("returns the public key when set", async () => {
    process.env.VAPID_PUBLIC_KEY = "pubkey123";
    const { GET } = await import("@/app/api/push/vapid-key/route");
    const res = await GET();
    expect((await res.json()).publicKey).toBe("pubkey123");
  });
});

describe("/api/user/preferences", () => {
  it("GET prefers jfId over username for lookup", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockUserPrefsDb.getLang.mockReturnValue("en");
    const { GET } = await import("@/app/api/user/preferences/route");
    const res = await GET(fakeReq());
    expect(mockUserPrefsDb.getLang).toHaveBeenCalledWith("jf-1", "fr");
    expect((await res.json()).lang).toBe("en");
  });

  // The experimental player's opt-in shares this route. It is admin-only, and the two flags are
  // coupled: an HDR switch on a disabled player is a setting that reads as active and does
  // nothing.
  it("PUT lets any account turn the experimental player on for itself", async () => {
    // It used to be admin-only. Opening the setting to everyone and leaving the check here meant
    // the toggle appeared for every account and answered 403 to all but one of them.
    mockVerifySessionFull.mockResolvedValue({ u: "someone", jfId: "jf-2", role: "user" });
    const { PUT } = await import("@/app/api/user/preferences/route");
    const res = await PUT(fakeReq({ body: { experimentalPlayer: true } }));
    expect(res.status).toBe(200);
    expect(mockUserPrefsDb.setExperimentalPlayer).toHaveBeenCalledWith("jf-2", true);
  });

  it("PUT turns the experimental player off again", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", role: "admin" });
    const { PUT } = await import("@/app/api/user/preferences/route");
    const res = await PUT(fakeReq({ body: { experimentalPlayer: false } }));
    expect(res.status).toBe(200);
    expect(mockUserPrefsDb.setExperimentalPlayer).toHaveBeenCalledWith("jf-1", false);
  });

  it("PUT keeps handling a plain language change", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    const { PUT } = await import("@/app/api/user/preferences/route");
    const res = await PUT(fakeReq({ body: { lang: "en" } }));
    expect(res.status).toBe(200);
    expect(mockUserPrefsDb.setLang).toHaveBeenCalledWith("jf-1", "en");
  });

  it("PUT rejects an unsupported locale", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { PUT } = await import("@/app/api/user/preferences/route");
    const res = await PUT(fakeReq({ body: { lang: "zz" } }));
    expect(res.status).toBe(400);
  });

  it("PUT sets the language and the locale cookie", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { PUT } = await import("@/app/api/user/preferences/route");
    const res = await PUT(fakeReq({ body: { lang: "es" } }));
    expect(mockUserPrefsDb.setLang).toHaveBeenCalledWith("louis", "es");
    expect(res.cookies.get("cine-lang")?.value).toBe("es");
  });
});

describe("GET /api/vip/[id]", () => {
  it("returns 404 for an unknown vip id", async () => {
    const { GET } = await import("@/app/api/vip/[id]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "999" }) });
    expect(res.status).toBe(404);
  });

  it("returns the full vip record including bio for a known id", async () => {
    const { GET } = await import("@/app/api/vip/[id]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "1" }) });
    const body = await res.json();
    expect(body).toEqual({ id: 1, name: "Clara", bio: "..." });
  });
});

describe("GET /api/watchlist/ratings", () => {
  it("returns an empty object when OMDb is disabled", async () => {
    mockOmdb.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/watchlist/ratings/route");
    const res = await GET(fakeReq());
    expect(await res.json()).toEqual({});
  });

  it("resolves a movie's IMDb rating via its TMDB imdb_id", async () => {
    mockOmdb.isEnabled.mockReturnValue(true);
    mockTmdb.getMovie.mockResolvedValue({ imdb_id: "tt123" });
    mockOmdb.getRating.mockResolvedValue({ Response: "True", imdbRating: "8.1" });
    const { GET } = await import("@/app/api/watchlist/ratings/route");
    const res = await GET(fakeReq({ params: { items: "movie:42" } }));
    const body = await res.json();
    expect(body["movie:42"]).toBe("8.1");
  });

  it("returns null for a title with no OMDb rating (N/A), not the string 'N/A'", async () => {
    mockOmdb.isEnabled.mockReturnValue(true);
    mockTmdb.getMovie.mockResolvedValue({ imdb_id: "tt123" });
    mockOmdb.getRating.mockResolvedValue({ Response: "True", imdbRating: "N/A" });
    const { GET } = await import("@/app/api/watchlist/ratings/route");
    const res = await GET(fakeReq({ params: { items: "movie:42" } }));
    const body = await res.json();
    expect(body["movie:42"]).toBeNull();
  });
});

describe("GET /api/library/map", () => {
  it("marks only movies/series with a real file in hasFileMovieIds/hasFileSeriesIds", async () => {
    const { cachedMovies, cachedSeries } = await import("@/lib/server-cache");
    vi.mocked(cachedMovies).mockResolvedValue([
      { tmdbId: 1, id: 10, hasFile: true },
      { tmdbId: 2, id: 20, hasFile: false },
    ] as any);
    vi.mocked(cachedSeries).mockResolvedValue([] as any);
    const { GET } = await import("@/app/api/library/map/route");
    const res = await GET();
    const body = await res.json();
    expect(body.movieMap).toEqual({ 1: 10, 2: 20 });
    expect(body.hasFileMovieIds).toEqual([1]);
  });
});

describe("/api/auth/me", () => {
  it("returns 401 without a session", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/auth/me/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(401);
  });

  it("returns the session's identity fields", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin", jfId: "jf-1" });
    const { GET } = await import("@/app/api/auth/me/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body).toEqual({ username: "louis", role: "admin", jfId: "jf-1", jfUser: null });
  });
});

describe("/api/auth/sessions", () => {
  it("GET counts other active sessions using jfId over username", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jti: "current-jti" });
    mockSessionDb.countOthers.mockReturnValue(2);
    const { GET } = await import("@/app/api/auth/sessions/route");
    const res = await GET(fakeReq());
    expect(mockSessionDb.countOthers).toHaveBeenCalledWith("jf-1", "current-jti");
    expect((await res.json()).count).toBe(2);
  });

  it("DELETE revokes other sessions and reports how many", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jti: "current-jti" });
    mockSessionDb.deleteOthers.mockReturnValue(3);
    const { DELETE } = await import("@/app/api/auth/sessions/route");
    const res = await DELETE(fakeReq());
    const body = await res.json();
    expect(body).toEqual({ ok: true, revoked: 3 });
  });
});
