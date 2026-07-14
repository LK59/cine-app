import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchJson, HttpError } from "@/lib/http";

const originalFetch = global.fetch;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: { get: () => "text/plain" },
    json: async () => { throw new Error("not json"); },
    text: async () => body,
  } as unknown as Response;
}

describe("fetchJson", () => {
  it("parses a JSON response", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ hello: "world" }));
    const result = await fetchJson<{ hello: string }>("http://example.test/api");
    expect(result.hello).toBe("world");
  });

  it("returns raw text for non-JSON content types", async () => {
    global.fetch = vi.fn().mockResolvedValue(textResponse("plain body"));
    const result = await fetchJson<string>("http://example.test/api");
    expect(result).toBe("plain body");
  });

  it("throws HttpError with status on a non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 404));
    const error = await fetchJson("http://example.test/missing").catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
  });

  it("passes through method, headers and body to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    global.fetch = fetchMock;
    await fetchJson("http://example.test/api", {
      method: "POST",
      headers: { "X-Api-Key": "abc" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.test/api",
      expect.objectContaining({
        method: "POST",
        headers: { "X-Api-Key": "abc" },
        body: JSON.stringify({ a: 1 }),
        cache: "no-store",
      })
    );
  });

  it("aborts the request when it exceeds the timeout", async () => {
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const promise = fetchJson("http://example.test/slow", {}, 1000);
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});
