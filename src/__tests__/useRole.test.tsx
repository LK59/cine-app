// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { useRole } from "@/lib/useRole";

// A fresh Map-backed cache per test, so SWR's global cache (keyed on the fixed "/api/auth/me"
// URL) never leaks a cached response from one test into the next.
function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

function mockMeResponse(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    })
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useRole", () => {
  it("defaults to the most restrictive shape before the fetch resolves — isReadOnly true even for an eventual admin", () => {
    mockMeResponse({ role: "admin", username: "louis", jfId: "abc", jfUser: "louis" });
    const { result } = renderHook(() => useRole(), { wrapper });

    expect(result.current.role).toBeUndefined();
    expect(result.current.isReadOnly).toBe(true);
    expect(result.current.jfId).toBeNull();
    expect(result.current.jfUser).toBeNull();
  });

  it("derives isReadOnly=true for a guest session", async () => {
    mockMeResponse({ role: "user", username: "invite", jfId: "xyz", jfUser: "invite" });
    const { result } = renderHook(() => useRole(), { wrapper });

    await waitFor(() => expect(result.current.role).toBe("user"));
    expect(result.current.isReadOnly).toBe(true);
    expect(result.current.jfId).toBe("xyz");
    expect(result.current.jfUser).toBe("invite");
  });

  it("derives isReadOnly=false for an admin session", async () => {
    mockMeResponse({ role: "admin", username: "louis", jfId: null, jfUser: null });
    const { result } = renderHook(() => useRole(), { wrapper });

    await waitFor(() => expect(result.current.role).toBe("admin"));
    expect(result.current.isReadOnly).toBe(false);
  });

  it("falls back jfId/jfUser to null when the API omits them (local-admin login)", async () => {
    mockMeResponse({ role: "admin", username: "admin" });
    const { result } = renderHook(() => useRole(), { wrapper });

    await waitFor(() => expect(result.current.role).toBe("admin"));
    expect(result.current.jfId).toBeNull();
    expect(result.current.jfUser).toBeNull();
  });
});
