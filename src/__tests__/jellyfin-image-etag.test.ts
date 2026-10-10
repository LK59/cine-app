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

  it("le grand visuel d'une série : le fond de Jellyfin à 1 280 px, immuable comme une affiche", async () => {
    // L'original de TheTVDB pesait jusqu'à 2 Mo, sans consigne de cache (10/10/2026).
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/jpeg" } }));
    const { GET } = await import("@/app/api/jellyfin/image/route");
    const res = await GET(req(`itemId=${ITEM}&kind=backdrop&tag=bd1`));
    const called = String(fetchSpy.mock.calls[0][0]);
    expect(called).toContain(`/Items/${ITEM}/Images/Backdrop/0?`);
    expect(called).toContain("maxWidth=1280");
    expect(called).toContain("tag=bd1");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("sans `kind`, l'affiche reste l'image principale à 300 px", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/jpeg" } }));
    const { GET } = await import("@/app/api/jellyfin/image/route");
    await GET(req(`itemId=${ITEM}&tag=p1`));
    const called = String(fetchSpy.mock.calls[0][0]);
    expect(called).toContain("/Images/Primary?");
    expect(called).toContain("maxWidth=300");
  });
});

describe("seriesBackdrop — une adresse pour le grand visuel d'une série", async () => {
  const { seriesBackdrop } = await import("@/lib/images");
  const tvdb = [{ coverType: "fanart", remoteUrl: "https://artworks.thetvdb.com/banners/fanart/original/1.jpg" }];

  it("Jellyfin d'abord : le fond redimensionné par notre relais, étiqueté", () => {
    expect(seriesBackdrop({ Id: ITEM, BackdropImageTags: ["t1", "t2"] }, tvdb)).toBe(`/api/jellyfin/image?itemId=${ITEM}&kind=backdrop&tag=t1`);
  });

  it("sans fond chez Jellyfin, l'adresse de TheTVDB comme avant", () => {
    expect(seriesBackdrop({ Id: ITEM, BackdropImageTags: [] }, tvdb)).toBe(tvdb[0].remoteUrl);
    expect(seriesBackdrop(undefined, tvdb)).toBe(tvdb[0].remoteUrl);
  });

  it("rien du tout : null", () => {
    expect(seriesBackdrop({ Id: ITEM }, [])).toBeNull();
  });
});
