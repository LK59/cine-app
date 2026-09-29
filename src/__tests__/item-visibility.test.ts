import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Les routes qui servent des octets de Jellyfin avec la clé d'administration demandent d'abord à
 * Jellyfin si le compte a le droit de voir l'élément (audit du 29/09/2026, A3) : un titre bloqué
 * pour un compte (`BlockedTags`, bibliothèque, contrôle parental) s'ouvrait par une adresse de flux
 * fabriquée à la main, puisque seule la présence d'une session était vérifiée.
 */

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
vi.mock("@/lib/config", () => ({
  config: { player: { enabled: true }, jellyfin: { url: "http://jf.test", apiKey: "key" } },
}));

const mockFetch = vi.fn();
const itemId = "c".repeat(32);
const jfId = "d".repeat(32);

function fakeReq(search = ""): NextRequest {
  const url = new URL(`http://app/api/jellyfin/stream/${itemId}/stream.mkv${search}`);
  return {
    method: "GET",
    cookies: { get: (name: string) => (name === "cine_session" ? { value: "t" } : undefined) },
    headers: { get: () => null },
    nextUrl: { pathname: url.pathname, search: url.search, searchParams: url.searchParams },
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

function reply(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream({ start: (c) => c.close() }),
    headers: new Headers(),
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(["x"]),
  };
}

const visibilityCalls = () =>
  mockFetch.mock.calls.filter(([u]) => String(u).startsWith(`http://jf.test/Users/${jfId}/Items/${itemId}`));

async function stream() {
  const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
  return GET(fakeReq("?static=true"), { params: Promise.resolve({ itemId, path: ["stream.mkv"] }) });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  mockVerifySessionFull.mockResolvedValue({ u: "viewer", role: "user", jti: "session-1", jfId });
  (await import("@/lib/itemVisibility")).forgetVisibility();
});

describe("assertVisible sur le relais de flux", () => {
  it("refuse un élément que Jellyfin cache à ce compte, sans rien demander avec la clé", async () => {
    mockFetch.mockImplementation(async (u: string) => (u.includes("/Users/") ? reply(404) : reply(200)));
    const res = await stream();
    expect(res.status).toBe(404);
    expect(visibilityCalls()).toHaveLength(1);
    // Le flux lui-même n'a jamais été demandé.
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes("/videos/"))).toBe(false);
  });

  it("sert un élément visible, et ne repose pas la question au segment suivant", async () => {
    mockFetch.mockResolvedValue(reply(200));
    expect((await stream()).status).toBe(200);
    expect((await stream()).status).toBe(200);
    expect(visibilityCalls()).toHaveLength(1);
  });

  it("un refus est gardé aussi : pas de nouvel appel pour chaque plage", async () => {
    mockFetch.mockImplementation(async (u: string) => (u.includes("/Users/") ? reply(404) : reply(200)));
    await stream();
    await stream();
    expect(visibilityCalls()).toHaveLength(1);
  });

  it("Jellyfin injoignable pour un titre jamais vérifié : refusé (503), jamais ouvert", async () => {
    mockFetch.mockImplementation(async (u: string) => {
      if (u.includes("/Users/")) throw new Error("down");
      return reply(200);
    });
    expect((await stream()).status).toBe(503);
  });

  it("Jellyfin injoignable pour un titre déjà vérifié : le film continue", async () => {
    const { assertVisible } = await import("@/lib/itemVisibility");
    const session = { role: "user" as const, jti: "session-1", jfId };
    mockFetch.mockResolvedValue(reply(200));
    expect(await assertVisible(session, itemId, 0)).toBeNull();
    // Sept heures plus tard, verdict périmé, Jellyfin en panne : l'ancien verdict vaut encore.
    mockFetch.mockRejectedValue(new Error("down"));
    expect(await assertVisible(session, itemId, 7 * 3600_000)).toBeNull();
  });

  it("le verdict appartient à une séance : une autre session repose la question", async () => {
    const { assertVisible } = await import("@/lib/itemVisibility");
    mockFetch.mockResolvedValue(reply(200));
    await assertVisible({ role: "user", jti: "a", jfId }, itemId);
    await assertVisible({ role: "user", jti: "b", jfId }, itemId);
    expect(visibilityCalls()).toHaveLength(2);
  });
});

describe("assertVisible sur les sous-titres, les images et les vignettes", () => {
  beforeEach(() => {
    mockFetch.mockImplementation(async (u: string) => (u.includes("/Users/") ? reply(404) : reply(200)));
  });

  function req(search: string): NextRequest {
    const url = new URL(`http://app/x?${search}`);
    return {
      method: "GET",
      cookies: { get: (name: string) => (name === "cine_session" ? { value: "t" } : undefined) },
      headers: { get: () => null },
      nextUrl: { pathname: `/api/jellyfin/stream/subtitle/${itemId}`, search: url.search, searchParams: url.searchParams },
      signal: new AbortController().signal,
    } as unknown as NextRequest;
  }

  it("sous-titres", async () => {
    const { GET } = await import("@/app/api/jellyfin/stream/subtitle/[itemId]/route");
    const res = await GET(req(`mediaSourceId=${itemId}&index=3`), { params: Promise.resolve({ itemId }) });
    expect(res.status).toBe(404);
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes("/Subtitles/"))).toBe(false);
  });

  it("image", async () => {
    const { GET } = await import("@/app/api/jellyfin/image/route");
    const res = await GET(req(`itemId=${itemId}`));
    expect(res.status).toBe(404);
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes("/Images/"))).toBe(false);
  });

  it("image demandée par l'administrateur : pas de question, la gestion voit tout", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "admin", role: "admin", jti: "s-admin" });
    const { GET } = await import("@/app/api/jellyfin/image/route");
    const res = await GET(req(`itemId=${itemId}`));
    expect(res.status).toBe(200);
    expect(visibilityCalls()).toHaveLength(0);
  });

  it("vignette de la barre", async () => {
    const { GET } = await import("@/app/api/jellyfin/trickplay/tile/route");
    const res = await GET(req(`itemId=${itemId}&width=320&index=0`));
    expect(res.status).toBe(404);
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes("/Trickplay/"))).toBe(false);
  });
});
