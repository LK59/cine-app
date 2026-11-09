// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * « Qui parle » côté Configuration (10.30, DECISIONS.md §138) : la qualité des noms par série (`GET
 * /api/admin/xray/quality`, administrateur seul), « Réinitialiser la mémoire » d'une série (`POST`, dans l'ordre
 * des épisodes), l'ordre des épisodes d'une série dans le plan, et la langue d'origine dans les commandes.
 */

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
  reissueShareSessionToken: async () => "réémis",
}));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
const svc = vi.hoisted(() => ({
  configured: true,
  quality: null as unknown,
  reset: [] as { seriesId: string; itemIds: readonly string[] }[],
  fail: false,
}));
vi.mock("@/lib/clients/xray", () => ({
  xrayConfigured: () => svc.configured,
  xray: {
    quality: async () => {
      if (svc.fail) throw new Error("injoignable");
      return svc.quality;
    },
    resetSeriesMemory: async (seriesId: string, itemIds: readonly string[]) => {
      svc.reset.push({ seriesId, itemIds });
      return { removed: 12, queued: itemIds.length };
    },
  },
}));
vi.mock("@/lib/xray/scanStore", () => ({
  seriesRows: (id: string) => (id === "5".repeat(32) ? { name: "Ted Lasso", itemIds: ["e1".repeat(16), "e2".repeat(16)] } : { name: null, itemIds: [] }),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
const mockTaskLog = vi.fn();
vi.mock("@/lib/taskLog", () => ({ taskLog: (...a: unknown[]) => mockTaskLog(...a) }));

const group = (over: Record<string, unknown> = {}) => ({
  seriesId: null,
  items: 3,
  withVoices: 3,
  speechNamed: 0.81,
  facesNamed: 0.92,
  voicesNamed: 30,
  voicesUndecided: 12,
  voicesConflict: 1,
  itemsWithConflict: 1,
  ...over,
});

function routeReq(body?: unknown): NextRequest {
  return { cookies: { get: () => ({ value: "t" }) }, nextUrl: new URL("https://cine.example/api/admin/xray/quality"), json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(svc, { configured: true, fail: false, reset: [], quality: { overall: group(), movies: group({ items: 1 }), series: [group({ seriesId: "5".repeat(32), speechNamed: 0.4 })] } });
});

describe("la route", () => {
  it("administrateur seul, lecture comprise", async () => {
    mockVerify.mockResolvedValue({ u: "compte", role: "user" });
    const { GET, POST } = await import("@/app/api/admin/xray/quality/route");
    expect((await GET(routeReq())).status).toBe(403);
    expect((await POST(routeReq({ action: "reset", seriesId: "5".repeat(32) }))).status).toBe(403);
    expect(svc.reset).toEqual([]);
  });

  it("les séries nommées d'après le plan ; service injoignable : dit, jamais une erreur", async () => {
    mockVerify.mockResolvedValue({ u: "admin", role: "admin" });
    const { GET } = await import("@/app/api/admin/xray/quality/route");
    const body = await (await GET(routeReq())).json();
    expect(body.series[0]).toMatchObject({ seriesId: "5".repeat(32), name: "Ted Lasso", speechNamed: 0.4 });
    svc.fail = true;
    const down = await GET(routeReq());
    expect(down.status).toBe(200);
    expect(await down.json()).toEqual({ configured: true, unavailable: true });
    svc.configured = false;
    expect(await (await GET(routeReq())).json()).toEqual({ configured: false });
  });

  it("réinitialiser : la mémoire de la série, puis ses épisodes renommés dans leur ordre", async () => {
    mockVerify.mockResolvedValue({ u: "admin", role: "admin" });
    const { POST } = await import("@/app/api/admin/xray/quality/route");
    expect((await POST(routeReq({ action: "reset", seriesId: "pas-un-id" }))).status).toBe(400);
    const res = await POST(routeReq({ action: "reset", seriesId: "5".repeat(32) }));
    expect(await res.json()).toEqual({ removed: 12, queued: 2 });
    expect(svc.reset).toEqual([{ seriesId: "5".repeat(32), itemIds: ["e1".repeat(16), "e2".repeat(16)] }]);
    expect(mockTaskLog).toHaveBeenCalledWith("xray", "mémoire de série réinitialisée", { série: "Ted Lasso", contributions: 12, épisodes: 2 });
  });
});

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k} ${JSON.stringify(v)}` : k) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));

describe("la carte", () => {
  it("toute la bibliothèque, puis les séries ; réinitialiser demande une confirmation", async () => {
    const payload = { configured: true, overall: group(), movies: group({ items: 1 }), series: [{ ...group({ seriesId: "5".repeat(32), speechNamed: 0.4 }), name: "Ted Lasso" }] };
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(init?.method === "POST" ? { removed: 1, queued: 2 } : payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const { SWRConfig } = await import("swr");
    const { XrayQualityCard, pct } = await import("@/components/settings/XrayQualityCard");
    expect(pct(0.404)).toBe("40 %");
    expect(pct(null)).toBe("—");
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <XrayQualityCard />
      </SWRConfig>
    );
    await screen.findByText(/Ted Lasso/);
    expect(screen.getAllByText("40 %").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("xrayQuality.reset"));
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByText("xrayQuality.resetConfirm"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("xrayQuality.resetDone"));
    const post = calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ action: "reset", seriesId: "5".repeat(32) });
    vi.unstubAllGlobals();
  });
});

describe("le plan", () => {
  it("dans un palier, les épisodes d'une série dans l'ordre de la série, à ses places", async () => {
    const { buildPlan } = await import("@/lib/xray/scanPlan");
    const NOW = Date.UTC(2026, 10, 10);
    const DAY = 86_400_000;
    const ep = (id: string, n: number, days: number) => ({ itemId: id, kind: "Episode" as const, title: `S E${n}`, seriesId: "s", durationS: 1, importedAt: NOW - days * DAY, createdAt: null, animation: false, season: 1, episode: n });
    const plan = buildPlan([ep("a", 3, 30), { ...ep("m", 0, 35), kind: "Movie" as const, seriesId: null }, ep("b", 1, 40), ep("c", 2, 50)], new Map(), NOW);
    const byRank = [...plan].sort((x, y) => x.rank - y.rank).map((p) => p.itemId);
    expect(byRank).toEqual(["b", "m", "c", "a"]);
  });
});
