import { describe, it, expect, vi, afterEach } from "vitest";
import { logError } from "@/lib/logger";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logError", () => {
  it("writes a single JSON line to console.error with the expected fields", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("watchlist", new Error("boom"), { status: 502 });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.level).toBe("error");
    expect(parsed.scope).toBe("watchlist");
    expect(parsed.message).toBe("boom");
    expect(parsed.status).toBe(502);
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("stringifies non-Error values", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("scope", "plain string error");
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.message).toBe("plain string error");
  });
});
