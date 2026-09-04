import { describe, it, expect, vi, afterEach } from "vitest";
import { apiAction } from "@/lib/apiAction";

function answer(status: number, body: unknown, statusText = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => {
      if (body === undefined) throw new Error("not json");
      return body;
    },
  } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("apiAction", () => {
  it("returns what the server sent back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, { ok: true, id: 7 })));
    await expect(apiAction("/api/thing")).resolves.toEqual({ ok: true, id: 7 });
  });

  it("accepts an empty body on a success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(204, undefined)));
    await expect(apiAction("/api/thing")).resolves.toBeNull();
  });

  it("repeats the explanation the route gave", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(409, { error: "Déjà en cours" })));
    await expect(apiAction("/api/thing", { method: "POST" })).rejects.toThrow("Déjà en cours");
  });

  it("falls back to the status when the failure says nothing useful", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(502, undefined, "Bad Gateway")));
    await expect(apiAction("/api/thing")).rejects.toThrow("502 Bad Gateway");
  });

  it("falls back to the status when the body is JSON without an error field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(400, { detail: "nope" }, "Bad Request")));
    await expect(apiAction("/api/thing")).rejects.toThrow("400 Bad Request");
  });

  it("declares JSON only when it actually sends a body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await apiAction("/api/thing", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ "Content-Type": "application/json" });

    await apiAction("/api/thing", { method: "DELETE" });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toBeUndefined();
  });

  it("lets the caller keep its own headers alongside the JSON one", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    await apiAction("/api/thing", { method: "POST", body: "{}", headers: { "X-Reason": "test" } });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Reason": "test",
    });
  });

  it("does not swallow a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(apiAction("/api/thing")).rejects.toThrow("Failed to fetch");
  });
});
