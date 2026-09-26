import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockJellyfin = { getLibraryCounts: vi.fn(), getSystemInfo: vi.fn(), refreshLibrary: vi.fn(), getSessions: vi.fn() };
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function fakeReq(cookie = "t"): NextRequest {
  return { cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) } } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/jellyfin/library", () => {
  it("combines counts and systemInfo", async () => {
    mockJellyfin.getLibraryCounts.mockResolvedValue({ movies: 10 });
    mockJellyfin.getSystemInfo.mockResolvedValue({ ServerName: "maison", Version: "12.0.0" });
    const { GET } = await import("@/app/api/jellyfin/library/route");
    const body = await (await GET()).json();
    expect(body).toEqual({ counts: { movies: 10 }, systemInfo: { ServerName: "maison", Version: "12.0.0" } });
  });

  it("ne renvoie de /System/Info que le nom et la version (26/09/2026)", async () => {
    mockJellyfin.getLibraryCounts.mockResolvedValue({ MovieCount: 1 });
    mockJellyfin.getSystemInfo.mockResolvedValue({
      ServerName: "maison",
      Version: "12.0.0",
      LocalAddress: "http://172.18.0.5:8096",
      LogPath: "/config/log",
      TranscodingTempPath: "/cache/transcodes",
      OperatingSystem: "Linux",
      Id: "abcdef",
    });
    const { GET } = await import("@/app/api/jellyfin/library/route");
    const body = await (await GET()).json();
    expect(Object.keys(body.systemInfo).sort()).toEqual(["ServerName", "Version"]);
    expect(JSON.stringify(body)).not.toContain("172.18");
  });
});

describe("POST /api/jellyfin/library/refresh", () => {
  it("returns 403 for a non-admin session", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "user" });
    const { POST } = await import("@/app/api/jellyfin/library/refresh/route");
    const res = await POST(fakeReq());
    expect(res.status).toBe(403);
    expect(mockJellyfin.refreshLibrary).not.toHaveBeenCalled();
  });

  it("triggers a refresh for an admin session", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "admin" });
    mockJellyfin.refreshLibrary.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/jellyfin/library/refresh/route");
    const res = await POST(fakeReq());
    expect((await res.json()).ok).toBe(true);
  });
});

describe("GET /api/jellyfin/sessions", () => {
  it("returns jellyfin.getSessions()'s result to an administrator", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    mockJellyfin.getSessions.mockResolvedValue([{ Id: "s1" }]);
    const { GET } = await import("@/app/api/jellyfin/sessions/route");
    expect(await (await GET(fakeReq())).json()).toEqual([{ Id: "s1" }]);
  });

  // Qui regarde quoi, sur quel appareil, depuis quelle adresse — de tous les comptes. Elle était
  // ouverte à toute session : le proxy ne filtre que les écritures.
  it("refuse un compte ordinaire, et ne demande rien à Jellyfin", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "mathis", role: "user" });
    const { GET } = await import("@/app/api/jellyfin/sessions/route");
    expect((await GET(fakeReq())).status).toBe(403);
    expect(mockJellyfin.getSessions).not.toHaveBeenCalled();
  });
});
