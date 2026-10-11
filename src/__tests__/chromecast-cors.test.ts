import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// DECISIONS.md §64 — le récepteur Chromecast lit le flux depuis le domaine de Google : CORS, mais
// seulement avec un laissez-passer valable, et rien de changé pour une lecture dans la page.

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: async () => null }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
vi.mock("@/lib/config", () => ({
  config: {
    player: { enabled: true },
    jellyfin: { url: "http://jf.test", apiKey: "key" },
    app: { sessionSecret: "secret-de-test-assez-long-pour-signer" },
  },
}));

// Le relais de position : seulement les segments servis à un laissez-passer (castProgress.test.ts
// éprouve ses règles ; ici, qui l'appelle et avec quoi).
const noteCastSegment = vi.fn();
vi.mock("@/lib/castProgress", () => ({ castProgressRelay: () => ({ noteCastSegment, notePageReport: vi.fn() }) }));

const mockFetch = vi.fn();
const itemId = "c".repeat(32);
const otherId = "d".repeat(32);

function req(method: string, url: string, cookie: string | null): NextRequest {
  const parsed = new URL(url);
  return {
    method,
    url: parsed.toString(),
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
    headers: new Headers({ host: "cine.example" }),
    nextUrl: parsed,
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

function upstream(body = "", headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({ start: (c) => c.close() }),
    headers: new Headers({ "Content-Type": "application/vnd.apple.mpegurl", ...headers }),
    text: async () => body,
    blob: async () => new Blob([body]),
  };
}

async function pass(id = itemId) {
  const { signCastToken } = await import("@/lib/castToken");
  return encodeURIComponent(await signCastToken(id, "louis"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  mockVerifySessionFull.mockResolvedValue(null);
});

describe("route des segments — GET", () => {
  const segment = ["hls1", "main", "0.mp4"];

  it("avec un laissez-passer : Access-Control-Allow-Origin *, sans identifiants", async () => {
    mockFetch.mockResolvedValue(upstream());
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await GET(req("GET", `https://cine.example/api/jellyfin/stream/${itemId}/hls1/main/0.mp4?castToken=${await pass()}`, null), {
      params: Promise.resolve({ itemId, path: segment }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Content-Range");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("le manifeste aussi, avec le laissez-passer reporté dans ses adresses", async () => {
    mockFetch.mockResolvedValue(upstream(`#EXTM3U\nhls1/main/0.mp4\n`));
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await GET(req("GET", `https://cine.example/api/jellyfin/stream/${itemId}/main.m3u8?castToken=${await pass()}`, null), {
      params: Promise.resolve({ itemId, path: ["main.m3u8"] }),
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.text()).toMatch(/hls1\/main\/0\.mp4\?castToken=/);
  });

  it("avec un cookie de session et sans laissez-passer : en-têtes strictement inchangés", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockFetch.mockResolvedValue(upstream());
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await GET(req("GET", `https://cine.example/api/jellyfin/stream/${itemId}/hls1/main/0.mp4`, "t"), {
      params: Promise.resolve({ itemId, path: segment }),
    });
    expect(res.status).toBe(200);
    for (const name of ["Access-Control-Allow-Origin", "Access-Control-Expose-Headers"]) expect(res.headers.get(name)).toBeNull();
  });

  it("un laissez-passer pour un autre titre n'ouvre rien", async () => {
    mockFetch.mockResolvedValue(upstream());
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await GET(req("GET", `https://cine.example/api/jellyfin/stream/${itemId}/hls1/main/0.mp4?castToken=${await pass(otherId)}`, null), {
      params: Promise.resolve({ itemId, path: segment }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("route des segments — la position notée pour le relais du serveur", () => {
  const segment = ["hls1", "main", "40.mp4"];
  const url = (token?: string) =>
    `https://cine.example/api/jellyfin/stream/${itemId}/hls1/main/40.mp4?PlaySessionId=p&runtimeTicks=1200000000${token ? `&castToken=${token}` : ""}`;

  it("un segment servi à un laissez-passer est noté, avec le compte et l'identifiant Jellyfin signés", async () => {
    mockFetch.mockResolvedValue(upstream());
    const { signCastToken } = await import("@/lib/castToken");
    const token = encodeURIComponent(await signCastToken(itemId, "louis", Date.now(), undefined, "jf-louis"));
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    await GET(req("GET", url(token), null), { params: Promise.resolve({ itemId, path: segment }) });
    expect(noteCastSegment).toHaveBeenCalledTimes(1);
    const noted = noteCastSegment.mock.calls[0][0] as { jfId: string; user: string; itemId: string; restPath: string; search: URLSearchParams };
    expect(noted).toMatchObject({ jfId: "jf-louis", user: "louis", itemId, restPath: "hls1/main/40.mp4" });
    expect(noted.search.get("runtimeTicks")).toBe("1200000000");
  });

  it("un laissez-passer d'avant (sans identifiant Jellyfin) : noté sans compte Jellyfin, donc sans relais", async () => {
    mockFetch.mockResolvedValue(upstream());
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    await GET(req("GET", url(await pass()), null), { params: Promise.resolve({ itemId, path: segment }) });
    expect(noteCastSegment.mock.calls[0][0]).toMatchObject({ jfId: null });
  });

  it("le lecteur serveur de la page (cookie ET laissez-passer, `castUrl`) ne passe pas par le relais — chasse aux bugs 11/10/2026", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockFetch.mockResolvedValue(upstream());
    const { signCastToken } = await import("@/lib/castToken");
    const token = encodeURIComponent(await signCastToken(itemId, "louis", Date.now(), undefined, "jf-louis"));
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    await GET(req("GET", url(token), "t"), { params: Promise.resolve({ itemId, path: segment }) });
    expect(noteCastSegment).not.toHaveBeenCalled();
  });

  it("une lecture dans la page (cookie, pas de laissez-passer) ne passe jamais par le relais", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockFetch.mockResolvedValue(upstream());
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    await GET(req("GET", url(), "t"), { params: Promise.resolve({ itemId, path: segment }) });
    expect(noteCastSegment).not.toHaveBeenCalled();
  });
});

describe("route des segments — OPTIONS (question préalable)", () => {
  it("répond 204 avec GET et Range autorisés quand le laissez-passer nomme ce titre", async () => {
    const { OPTIONS } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await OPTIONS(req("OPTIONS", `https://cine.example/api/jellyfin/stream/${itemId}/main.m3u8?castToken=${await pass()}`, null), {
      params: Promise.resolve({ itemId, path: ["main.m3u8"] }),
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Range");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuse sans laissez-passer, ou avec celui d'un autre titre", async () => {
    const { OPTIONS } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const bare = await OPTIONS(req("OPTIONS", `https://cine.example/api/jellyfin/stream/${itemId}/main.m3u8`, null), {
      params: Promise.resolve({ itemId, path: ["main.m3u8"] }),
    });
    expect(bare.status).toBe(403);
    const other = await OPTIONS(req("OPTIONS", `https://cine.example/api/jellyfin/stream/${itemId}/main.m3u8?castToken=${await pass(otherId)}`, null), {
      params: Promise.resolve({ itemId, path: ["main.m3u8"] }),
    });
    expect(other.status).toBe(403);
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("route des sous-titres", () => {
  const subtitleUrl = (token?: string) =>
    `https://cine.example/api/jellyfin/stream/subtitle/${itemId}?mediaSourceId=${itemId}&index=3${token ? `&castToken=${token}` : ""}`;

  it("GET avec un laissez-passer : CORS posé", async () => {
    mockFetch.mockResolvedValue(upstream("WEBVTT\n"));
    const { GET } = await import("@/app/api/jellyfin/stream/subtitle/[itemId]/route");
    const res = await GET(req("GET", subtitleUrl(await pass()), null), { params: Promise.resolve({ itemId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("GET avec une session : rien de changé", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockFetch.mockResolvedValue(upstream("WEBVTT\n"));
    const { GET } = await import("@/app/api/jellyfin/stream/subtitle/[itemId]/route");
    const res = await GET(req("GET", subtitleUrl(), "t"), { params: Promise.resolve({ itemId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("OPTIONS : 204 avec laissez-passer, 403 sans", async () => {
    const { OPTIONS } = await import("@/app/api/jellyfin/stream/subtitle/[itemId]/route");
    expect((await OPTIONS(req("OPTIONS", subtitleUrl(await pass()), null), { params: Promise.resolve({ itemId }) })).status).toBe(204);
    expect((await OPTIONS(req("OPTIONS", subtitleUrl(), null), { params: Promise.resolve({ itemId }) })).status).toBe(403);
  });
});

describe("le proxy laisse passer la question préalable munie d'un laissez-passer, et elle seule", () => {
  it("OPTIONS + laissez-passer valable : transmis à la route", async () => {
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("OPTIONS", `https://cine.example/api/jellyfin/stream/${itemId}/main.m3u8?castToken=${await pass()}`, null));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("OPTIONS sans laissez-passer ni session : 401, comme avant", async () => {
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("OPTIONS", `https://cine.example/api/jellyfin/stream/${itemId}/main.m3u8`, null));
    expect(res.status).toBe(401);
  });

  it("OPTIONS avec laissez-passer hors de la route du flux : refusé", async () => {
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("OPTIONS", `https://cine.example/api/watchlist?castToken=${await pass()}`, null));
    expect(res.status).toBe(401);
  });

  it("un laissez-passer ne permet toujours aucune écriture", async () => {
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("POST", `https://cine.example/api/jellyfin/stream/${itemId}/main.m3u8?castToken=${await pass()}`, null));
    expect(res.status).toBe(401);
  });
});
