import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function fakeReq(xff?: string): NextRequest {
  return { headers: { get: (name: string) => (name === "x-forwarded-for" ? xff ?? null : null) } } as unknown as NextRequest;
}

describe("getClientIp", () => {
  it("returns 'unknown' when there is no X-Forwarded-For header", async () => {
    const { getClientIp } = await import("@/lib/api-helpers");
    expect(getClientIp(fakeReq())).toBe("unknown");
  });

  it("reads the LAST hop, not the client-controlled first hop", async () => {
    // A standard reverse proxy appends its own IP rather than replacing the chain, so the
    // last entry is the one the proxy itself observed — the first is client-spoofable and
    // previously let a spoofed header defeat rate-limiting (fixed 2026-08-10).
    const { getClientIp } = await import("@/lib/api-helpers");
    expect(getClientIp(fakeReq("1.2.3.4, 10.0.0.1, 172.17.0.1"))).toBe("172.17.0.1");
  });

  it("trims whitespace around hops", async () => {
    const { getClientIp } = await import("@/lib/api-helpers");
    expect(getClientIp(fakeReq(" 1.2.3.4 ,  10.0.0.1  "))).toBe("10.0.0.1");
  });
});

describe("withErrorHandling", () => {
  it("returns the resolved data as JSON on success", async () => {
    const { withErrorHandling } = await import("@/lib/api-helpers");
    const res = await withErrorHandling(async () => ({ a: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("uses HttpError's own status code", async () => {
    const { withErrorHandling } = await import("@/lib/api-helpers");
    const { HttpError } = await import("@/lib/http");
    const res = await withErrorHandling(async () => {
      throw new HttpError("not found upstream", 404);
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not found upstream");
  });

  it("defaults to 502 for a plain error (upstream/network failure)", async () => {
    const { withErrorHandling } = await import("@/lib/api-helpers");
    const res = await withErrorHandling(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(res.status).toBe(502);
  });
});
