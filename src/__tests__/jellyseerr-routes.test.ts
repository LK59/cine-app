import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockJellyseerr = {
  getMovieMedia: vi.fn(),
  getTvMedia: vi.fn(),
  getRequests: vi.fn(),
  getRequestsByUser: vi.fn(),
  getUsers: vi.fn(),
  approveRequest: vi.fn(),
  declineRequest: vi.fn(),
  createRequest: vi.fn(),
};
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: mockJellyseerr }));
vi.mock("@/lib/jellyseerr-enrich", () => ({ enrichRequests: async (r: unknown[]) => r }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
vi.mock("@/lib/server-cache", () => ({
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function fakeReq(opts: { params?: Record<string, string>; body?: unknown; cookie?: string } = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(opts.params ?? {}) },
    cookies: { get: (name: string) => (name === "cine_session" && opts.cookie ? { value: opts.cookie } : undefined) },
    json: async () => opts.body ?? null,
  } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/jellyseerr/media", () => {
  it("returns 400 when tmdbId or type is missing", async () => {
    const { GET } = await import("@/app/api/jellyseerr/media/route");
    const res = await GET(fakeReq({ params: { tmdbId: "42" } }));
    expect(res.status).toBe(400);
  });

  it("returns status 1 (not requested) when Jellyseerr call fails", async () => {
    mockJellyseerr.getMovieMedia.mockRejectedValue(new Error("down"));
    const { GET } = await import("@/app/api/jellyseerr/media/route");
    const res = await GET(fakeReq({ params: { tmdbId: "42", type: "movie" } }));
    expect((await res.json()).status).toBe(1);
  });

  it("routes to getTvMedia for type=series", async () => {
    mockJellyseerr.getTvMedia.mockResolvedValue({ mediaInfo: { status: 4 } });
    const { GET } = await import("@/app/api/jellyseerr/media/route");
    const res = await GET(fakeReq({ params: { tmdbId: "7", type: "tv" } }));
    expect(mockJellyseerr.getTvMedia).toHaveBeenCalledWith(7);
    expect((await res.json()).status).toBe(4);
  });
});

describe("GET /api/jellyseerr/my-requests", () => {
  it("returns all pending requests for an admin with no Jellyfin account", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "admin" });
    mockJellyseerr.getRequests.mockResolvedValue({ results: [{ id: 1 }] });
    const { GET } = await import("@/app/api/jellyseerr/my-requests/route");
    const res = await GET(fakeReq());
    expect(mockJellyseerr.getRequests).toHaveBeenCalledWith("all");
    expect((await res.json()).results).toEqual([{ id: 1 }]);
  });

  it("returns empty results for a non-admin with no Jellyfin account", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "guest" });
    const { GET } = await import("@/app/api/jellyseerr/my-requests/route");
    const res = await GET(fakeReq());
    expect((await res.json()).results).toEqual([]);
  });

  it("matches the Jellyfin username to a Jellyseerr user (case-insensitive)", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "guest", jfUser: "Louis" });
    mockJellyseerr.getUsers.mockResolvedValue({ results: [{ id: 5, jellyfinUsername: "louis" }] });
    mockJellyseerr.getRequestsByUser.mockResolvedValue({ results: [{ id: 9 }] });
    const { GET } = await import("@/app/api/jellyseerr/my-requests/route");
    const res = await GET(fakeReq());
    expect(mockJellyseerr.getRequestsByUser).toHaveBeenCalledWith(5);
    expect((await res.json()).results).toEqual([{ id: 9 }]);
  });

  it("returns empty results when no Jellyseerr user matches the Jellyfin username", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "guest", jfUser: "Louis" });
    mockJellyseerr.getUsers.mockResolvedValue({ results: [] });
    const { GET } = await import("@/app/api/jellyseerr/my-requests/route");
    const res = await GET(fakeReq());
    expect((await res.json()).results).toEqual([]);
  });
});

describe("POST /api/jellyseerr/requests/[id]", () => {
  it("approves on action=approve", async () => {
    mockJellyseerr.approveRequest.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/jellyseerr/requests/[id]/route");
    await POST(fakeReq({ body: { action: "approve" } }), { params: Promise.resolve({ id: "3" }) });
    expect(mockJellyseerr.approveRequest).toHaveBeenCalledWith(3);
  });

  it("declines on action=decline", async () => {
    mockJellyseerr.declineRequest.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/jellyseerr/requests/[id]/route");
    await POST(fakeReq({ body: { action: "decline" } }), { params: Promise.resolve({ id: "3" }) });
    expect(mockJellyseerr.declineRequest).toHaveBeenCalledWith(3);
  });

  it("returns 400 for an unknown action", async () => {
    const { POST } = await import("@/app/api/jellyseerr/requests/[id]/route");
    const res = await POST(fakeReq({ body: { action: "explode" } }), { params: Promise.resolve({ id: "3" }) });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/jellyseerr/requests", () => {
  it("scopes a guest session to only their own Jellyseerr requests", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "guest", jfUser: "louis" });
    mockJellyseerr.getUsers.mockResolvedValue({ results: [{ id: 5, jellyfinUsername: "louis" }] });
    mockJellyseerr.getRequestsByUser.mockResolvedValue({ results: [{ id: 1 }], pageInfo: { results: 1 } });
    const { GET } = await import("@/app/api/jellyseerr/requests/route");
    const res = await GET(fakeReq());
    expect(mockJellyseerr.getRequestsByUser).toHaveBeenCalledWith(5);
    expect(mockJellyseerr.getRequests).not.toHaveBeenCalled();
    expect((await res.json()).results).toEqual([{ id: 1 }]);
  });

  it("returns empty results for a guest with no matching Jellyseerr user, without calling getRequests", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "guest", jfUser: "louis" });
    mockJellyseerr.getUsers.mockResolvedValue({ results: [] });
    const { GET } = await import("@/app/api/jellyseerr/requests/route");
    const res = await GET(fakeReq());
    expect((await res.json()).results).toEqual([]);
    expect(mockJellyseerr.getRequests).not.toHaveBeenCalled();
  });

  it("uses the filter query param for an admin session", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "admin" });
    mockJellyseerr.getRequests.mockResolvedValue({ results: [], pageInfo: { results: 0 } });
    const { GET } = await import("@/app/api/jellyseerr/requests/route");
    await GET(fakeReq({ params: { filter: "approved" } }));
    expect(mockJellyseerr.getRequests).toHaveBeenCalledWith("approved");
  });
});

describe("POST /api/jellyseerr/requests", () => {
  it("returns 400 when mediaType or mediaId is missing", async () => {
    const { POST } = await import("@/app/api/jellyseerr/requests/route");
    const res = await POST(fakeReq({ body: { mediaType: "movie" } }));
    expect(res.status).toBe(400);
  });

  it("resolves the requester's Jellyseerr user id from their Jellyfin username before creating the request", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "guest", jfUser: "louis" });
    mockJellyseerr.getUsers.mockResolvedValue({ results: [{ id: 5, jellyfinUsername: "louis" }] });
    mockJellyseerr.createRequest.mockResolvedValue({ id: 1 });
    const { POST } = await import("@/app/api/jellyseerr/requests/route");
    await POST(fakeReq({ body: { mediaType: "movie", mediaId: 42 } }));
    expect(mockJellyseerr.createRequest).toHaveBeenCalledWith("movie", 42, 5);
  });

  it("creates the request with no user id for a session with no Jellyfin account", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "admin" });
    mockJellyseerr.createRequest.mockResolvedValue({ id: 1 });
    const { POST } = await import("@/app/api/jellyseerr/requests/route");
    await POST(fakeReq({ body: { mediaType: "movie", mediaId: 42 } }));
    expect(mockJellyseerr.createRequest).toHaveBeenCalledWith("movie", 42, undefined);
  });
});
