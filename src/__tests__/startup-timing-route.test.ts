import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockLog = vi.fn();
vi.mock("@/lib/eventLogs", () => ({ logStartupTiming: (...a: unknown[]) => mockLog(...a) }));

/**
 * Ce que l'ouverture du cinéma a coûté, cache de l'appareil ou réseau (25/09/2026) : mesuré plutôt
 * que supposé, au nom du compte de la session et de lui seul.
 */
function fakeReq(body: unknown, cookie = "t"): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" && cookie ? { value: cookie } : undefined) },
    headers: new Headers({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1" }),
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  } as unknown as NextRequest;
}

const post = async (body: unknown, cookie?: string) => {
  const { POST } = await import("@/app/api/startup-timing/route");
  return POST(fakeReq(body, cookie));
};

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySessionFull.mockResolvedValue({ u: "louis", jfUser: "Louis", role: "admin" });
});

describe("POST /api/startup-timing", () => {
  it("écrit la mesure au nom du compte de la session, avec l'appareil", async () => {
    const res = await post({ user: "lucas", build: "b1", version: "8.1.0", cacheUsed: true, cacheAgeMs: 3600_000, cacheMs: 212.4, networkMs: 1480, standalone: true });
    expect(res.status).toBe(204);
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ user: "Louis", build: "b1", version: "8.1.0", cacheUsed: true, cacheAgeMs: 3600_000, cacheMs: 212, networkMs: 1480, standalone: true })
    );
    expect(mockLog.mock.calls[0][0].device).toBeTruthy();
  });

  it("nomme un iPad d'après l'indice tactile, et non d'après sa signature de Mac", async () => {
    const { POST } = await import("@/app/api/startup-timing/route");
    const req = fakeReq({ cacheUsed: false });
    (req as unknown as { headers: Headers }).headers = new Headers({
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15",
      "x-cine-touch": "1",
    });
    await POST(req);
    expect(mockLog.mock.calls[0][0].device).toBe("iPad · Safari");
  });

  it("dit quand la page est passée en arrière-plan pendant l'ouverture", async () => {
    await post({ cacheUsed: true, cacheMs: 400, networkMs: null, hiddenAtMs: 1200 });
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ cacheMs: 400, networkMs: null, hiddenAtMs: 1200 }));
    await post({ cacheUsed: true, cacheMs: 400, networkMs: 900 });
    expect(mockLog.mock.calls[1][0]).not.toHaveProperty("hiddenAtMs");
  });

  it("borne ce qui vient du navigateur", async () => {
    await post({ cacheUsed: "oui", cacheMs: -5, networkMs: Number.NaN, build: "x".repeat(200) });
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ cacheUsed: false, cacheMs: null, networkMs: null }));
    expect(mockLog.mock.calls[0][0].build).toHaveLength(40);
  });

  it("écrit le stockage de l'appareil, borné, et rien d'autre de ce qu'il contient", async () => {
    // 28/09/2026 : la persistance était demandée et sa réponse jetée ; le quota, jamais mesuré.
    await post({
      cacheUsed: true,
      storage: { persist: "accordé", persisted: true, quotaMB: 61234.56, usageMB: 212.3, opfsMB: 180, resumeTitles: 4, resumeMB: 96, intrus: "x" },
    });
    const line = mockLog.mock.calls[0][0];
    expect(line).toMatchObject({ persist: "accordé", persisted: true, quotaMB: 61234.6, usageMB: 212.3, opfsMB: 180, resumeTitles: 4, resumeMB: 96 });
    expect(line.intrus).toBeUndefined();
  });

  it("jette un stockage qui ment", async () => {
    await post({ storage: { persist: "<script>", persisted: "oui", quotaMB: -1, usageMB: Number.POSITIVE_INFINITY, resumeTitles: 2.5 } });
    const line = mockLog.mock.calls[0][0];
    for (const key of ["persist", "persisted", "quotaMB", "usageMB", "resumeTitles"]) expect(line[key]).toBeUndefined();
  });

  it("n'écoute pas un visiteur sans session", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    expect((await post({ cacheUsed: true }, "")).status).toBe(401);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("refuse un corps illisible", async () => {
    expect((await post(new Error("pas du JSON"))).status).toBe(400);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("garde les requêtes de l'ouverture connues, bornées, et rien d'autre (15/10/2026)", async () => {
    await post({
      cacheUsed: false,
      routes: {
        movies: { startMs: 410, waitMs: 1240, appMs: 313, readMs: 241, kB: 118, extra: 5 },
        resume: { startMs: -1, waitMs: "200" },
        hero: { startMs: 3 },
        nextUp: "non",
      },
    });
    const line = mockLog.mock.calls.at(-1)![0];
    expect(line.routes).toEqual({ movies: { startMs: 410, waitMs: 1240, appMs: 313, readMs: 241, kB: 118 } });
  });

  it("n'écrit pas de champ `routes` quand rien n'y est lisible", async () => {
    await post({ cacheUsed: false, routes: { resume: { startMs: -1 } } });
    expect(mockLog.mock.calls.at(-1)![0]).not.toHaveProperty("routes");
  });
});

/**
 * L'adresse par laquelle l'application a été ouverte (23/10/2026, DECISIONS.md §119) : lue dans la
 * requête par le serveur, jamais dans le corps ; `X-Forwarded-Host` seulement d'un relais de confiance.
 */
describe("POST /api/startup-timing — l'adresse ouverte", () => {
  const withHeaders = async (headers: Record<string, string>, body: unknown = { cacheUsed: false }) => {
    const { POST } = await import("@/app/api/startup-timing/route");
    const req = fakeReq(body);
    (req as unknown as { headers: Headers }).headers = new Headers(headers);
    await POST(req);
    return mockLog.mock.calls.at(-1)![0] as Record<string, unknown>;
  };
  // Un compte neuf par test : la limite d'ouvertures par compte (`startupTimingAllowed`) ne s'en mêle pas.
  let n = 0;
  beforeEach(() => {
    n += 1;
    mockVerifySessionFull.mockResolvedValue({ u: `adresse-${n}`, jfUser: `Adresse${n}`, role: "user" });
  });
  afterEach(() => {
    delete process.env.CINE_PEER_HEADER;
  });

  it("écrit le nom d'hôte de la requête, sans port, et ignore celui du corps", async () => {
    const line = await withHeaders({ host: "App.Example.org:443" }, { cacheUsed: false, host: "menteur.example" });
    expect(line.host).toBe("app.example.org");
  });

  it("croit le relais de confiance, pas un client direct", async () => {
    process.env.CINE_PEER_HEADER = "1";
    // Le relais du réseau Docker (sans `TRUSTED_PROXIES` : une connexion privée).
    expect((await withHeaders({ "x-cine-peer": "172.20.0.9", host: "cine-app:3000", "x-forwarded-host": "app.example.org" })).host).toBe("app.example.org");
    // Un client joint directement écrit ce qu'il veut dans `X-Forwarded-Host` : on garde `Host`.
    expect((await withHeaders({ "x-cine-peer": "203.0.113.7", host: "old.example.org", "x-forwarded-host": "app.example.org" })).host).toBe("old.example.org");
  });

  it("n'écrit rien d'un hôte qui n'est pas un nom", async () => {
    for (const host of ["bad_host.example", "[::1]:3000", `${"a".repeat(300)}.example`]) {
      expect(await withHeaders({ host })).not.toHaveProperty("host");
    }
  });
});
