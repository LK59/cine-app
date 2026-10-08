import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jf", apiKey: "k" } } }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => ({ u: "a", role: "user", jfId: "j" }) }));
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: async () => null }));

const ITEM = "0123456789abcdef0123456789abcdef";
function req(query: string, headers: Record<string, string> = {}): NextRequest {
  const url = new URL(`http://app/api/jellyfin/image?${query}`);
  return {
    nextUrl: url,
    cookies: { get: () => undefined },
    headers: new Headers(headers),
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/**
 * Une image désignée par son `tag` (l'empreinte de son contenu) se garde un an, et une
 * revalidation reçoit un 304 sans repasser par Jellyfin (08/10/2026) — l'iPhone redemandait la même
 * affiche plusieurs fois par minute.
 */
describe("GET /api/jellyfin/image", () => {
  it("répond 304 à une revalidation de la même image, sans appeler Jellyfin", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { GET } = await import("@/app/api/jellyfin/image/route");
    const res = await GET(req(`itemId=${ITEM}&tag=abc123`, { "if-none-match": '"abc123"' }));
    expect(res.status).toBe(304);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sert une image étiquetée comme immuable", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } }));
    const { GET } = await import("@/app/api/jellyfin/image/route");
    const res = await GET(req(`itemId=${ITEM}&tag=abc123`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("etag")).toBe('"abc123"');
  });

  it("sans étiquette, garde l'ancienne durée", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/jpeg" } }));
    const { GET } = await import("@/app/api/jellyfin/image/route");
    const res = await GET(req(`itemId=${ITEM}`));
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
    expect(res.headers.get("etag")).toBeNull();
  });
});
