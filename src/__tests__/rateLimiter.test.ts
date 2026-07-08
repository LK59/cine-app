import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRateLimiter } from "@/lib/rateLimiter";

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the max", () => {
    const limit = createRateLimiter(3, 60_000);
    expect(limit("ip-a")).toBe(true);
    expect(limit("ip-a")).toBe(true);
    expect(limit("ip-a")).toBe(true);
  });

  it("blocks the request that exceeds the max", () => {
    const limit = createRateLimiter(3, 60_000);
    limit("ip-b");
    limit("ip-b");
    limit("ip-b");
    expect(limit("ip-b")).toBe(false);
  });

  it("continues blocking after the max is exceeded", () => {
    const limit = createRateLimiter(2, 60_000);
    limit("ip-c");
    limit("ip-c");
    expect(limit("ip-c")).toBe(false);
    expect(limit("ip-c")).toBe(false);
  });

  it("resets counter after the window expires", () => {
    const limit = createRateLimiter(2, 60_000);
    limit("ip-d");
    limit("ip-d");
    expect(limit("ip-d")).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(60_001);

    // Should be allowed again
    expect(limit("ip-d")).toBe(true);
    expect(limit("ip-d")).toBe(true);
    expect(limit("ip-d")).toBe(false);
  });

  it("tracks different keys independently", () => {
    const limit = createRateLimiter(1, 60_000);
    expect(limit("key-1")).toBe(true);
    expect(limit("key-1")).toBe(false);
    // key-2 has its own counter
    expect(limit("key-2")).toBe(true);
    expect(limit("key-2")).toBe(false);
  });

  it("first request after window reset is allowed (resets to 1)", () => {
    const limit = createRateLimiter(3, 60_000);
    limit("ip-e");
    limit("ip-e");
    vi.advanceTimersByTime(60_001);
    // First request starts a fresh window
    expect(limit("ip-e")).toBe(true);
  });
});

describe("checkRateLimit (login limiter)", () => {
  // Uses module-level state — use unique IPs per test to avoid cross-test pollution

  it("allows the first request for a new IP", async () => {
    // Dynamic import to get the exported function
    const { checkRateLimit } = await import("@/lib/rateLimiter");
    expect(checkRateLimit("10.0.0.1")).toBe(true);
  });

  it("tracks different IPs independently", async () => {
    const { checkRateLimit } = await import("@/lib/rateLimiter");
    const ip1 = "10.1.1.1";
    const ip2 = "10.1.1.2";
    // Exhaust ip1 (10 attempts)
    for (let i = 0; i < 10; i++) checkRateLimit(ip1);
    expect(checkRateLimit(ip1)).toBe(false);
    // ip2 is still fresh
    expect(checkRateLimit(ip2)).toBe(true);
  });

  it("blocks after 10 attempts", async () => {
    const { checkRateLimit } = await import("@/lib/rateLimiter");
    const ip = "10.2.2.2";
    for (let i = 0; i < 10; i++) checkRateLimit(ip);
    expect(checkRateLimit(ip)).toBe(false);
  });
});
