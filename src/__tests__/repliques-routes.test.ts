import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * La route de recherche des répliques (DECISIONS.md §88) : session exigée, absente tant que
 * l'option est coupée ou l'index vide, films cachés par les tags bloqués retirés, borne par compte.
 */

const state = vi.hoisted(() => ({
  session: { jfId: "u1", u: "louis", role: "user" } as Record<string, unknown> | null,
  hasLines: true,
  blocked: [] as string[],
  search: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ verifySessionFull: async () => state.session }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/repliques/search", () => ({
  dialogueIndexHasLines: () => state.hasLines,
  searchDialogue: (...args: unknown[]) => state.search(...args),
}));
vi.mock("@/lib/blockedTags", () => ({
  blockedTagsOf: async () => state.blocked,
  carriesBlockedTag: (tags: string[] | undefined, blocked: string[]) => !!tags?.some((t) => blocked.includes(t.toLowerCase())),
}));
vi.mock("@/lib/server-cache", () => ({
  cachedJellyfinMoviesAdmin: async () => [
    { Id: "a".repeat(32), Tags: ["prive"] },
    { Id: "b".repeat(32), Tags: [] },
  ],
}));

import { GET } from "@/app/api/repliques/route";

function req(params: Record<string, string>): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(params) },
    cookies: { get: () => ({ value: "tok" }) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  state.session = { jfId: "u1", u: "louis", role: "user" };
  state.hasLines = true;
  state.blocked = [];
  state.search.mockReset();
  state.search.mockReturnValue({ terms: ["pere"], prefixes: [], films: [] });
  process.env.REPLIQUES_ENABLED = "true";
});

describe("GET /api/repliques", () => {
  it("exige une session", async () => {
    state.session = null;
    expect((await GET(req({ q: "je suis ton pere" }))).status).toBe(401);
  });

  it("n'existe pas tant que l'option est coupée ou l'index vide", async () => {
    delete process.env.REPLIQUES_ENABLED;
    expect(await (await GET(req({}))).json()).toEqual({ available: false });
    process.env.REPLIQUES_ENABLED = "true";
    state.hasLines = false;
    expect(await (await GET(req({ q: "je suis ton pere" }))).json()).toEqual({ available: false });
    expect(state.search).not.toHaveBeenCalled();
  });

  it("retire dans la requête les films que les tags bloqués cachent au compte", async () => {
    state.blocked = ["prive"];
    const res = await GET(req({ q: "je suis ton pere" }));
    expect(res.status).toBe(200);
    expect(state.search).toHaveBeenCalledWith("je suis ton pere", { hidden: ["a".repeat(32)] });
    // « Voir plus » sur un film caché : rien, sans même chercher.
    state.search.mockClear();
    const hidden = await (await GET(req({ q: "je suis", film: "a".repeat(32) }))).json();
    expect(hidden.films).toEqual([]);
    expect(state.search).not.toHaveBeenCalled();
  });

  it("refuse un identifiant de film mal formé", async () => {
    expect((await GET(req({ q: "je suis", film: "../x" }))).status).toBe(400);
  });

  it("borne à 120 recherches par minute et par compte", async () => {
    state.session = { jfId: "bavard", u: "bavard", role: "user" };
    let last = 200;
    for (let i = 0; i < 121; i++) last = (await GET(req({ q: `phrase ${i}` }))).status;
    expect(last).toBe(429);
  });
});
