import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockGetItemUserData = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getItemUserData: (...a: unknown[]) => mockGetItemUserData(...a) } }));

function fakeReq(cookie = "t"): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
  } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cinema/progress/[itemId]", () => {
  it("returns nulls when the session has no Jellyfin account linked", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { GET } = await import("@/app/api/cinema/progress/[itemId]/route");
    const body = await (await GET(fakeReq(), { params: Promise.resolve({ itemId: "abc" }) })).json();
    expect(body).toEqual({ resumeTicks: null, runtimeTicks: null });
    expect(mockGetItemUserData).not.toHaveBeenCalled();
  });

  it("maps an item's resume position and runtime", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetItemUserData.mockResolvedValue({ UserData: { PlaybackPositionTicks: 300_000_000 }, RunTimeTicks: 1_200_000_000 });

    const { GET } = await import("@/app/api/cinema/progress/[itemId]/route");
    const body = await (await GET(fakeReq(), { params: Promise.resolve({ itemId: "abc" }) })).json();

    expect(body).toEqual({ resumeTicks: 300_000_000, runtimeTicks: 1_200_000_000 });
  });

  it("returns nulls for an item with no watch history", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetItemUserData.mockResolvedValue({ UserData: { Played: false, PlayCount: 0 }, RunTimeTicks: 1_200_000_000 });

    const { GET } = await import("@/app/api/cinema/progress/[itemId]/route");
    const body = await (await GET(fakeReq(), { params: Promise.resolve({ itemId: "abc" }) })).json();

    expect(body.resumeTicks).toBeNull();
  });

  it("falls back to nulls when the Jellyfin call fails", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetItemUserData.mockRejectedValue(new Error("jellyfin down"));

    const { GET } = await import("@/app/api/cinema/progress/[itemId]/route");
    const body = await (await GET(fakeReq(), { params: Promise.resolve({ itemId: "abc" }) })).json();

    expect(body).toEqual({ resumeTicks: null, runtimeTicks: null });
  });
});
