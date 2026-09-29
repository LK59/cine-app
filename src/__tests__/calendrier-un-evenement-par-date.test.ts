import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

// B6 — un film de la bibliothèque était toujours placé sur `digitalRelease || physicalRelease ||
// inCinemas` : sorti en salle ce mois-ci avec une date numérique plus tard, il disparaissait du
// mois affiché, et son étiquette ne disait jamais « Au cinéma ». Désormais : un événement par
// date, émis seulement si elle tombe dans [start, end].

const mockRadarr = { getCalendar: vi.fn() };
const mockSonarr = { getCalendar: vi.fn() };
vi.mock("@/lib/clients/radarr", () => ({ radarr: mockRadarr }));
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: mockSonarr }));
vi.mock("@/lib/config", () => ({ config: { tmdb: { apiKey: "" } } }));
vi.mock("@/lib/images", () => ({ posterUrl: () => null }));
vi.mock("@/lib/server-cache", () => ({
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  TTL: { SHORT: 60_000 },
}));

function fakeReq(params: Record<string, string>): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as unknown as NextRequest;
}

const originalFetch = global.fetch;
beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
  mockSonarr.getCalendar.mockResolvedValue([]);
});
afterEach(() => { global.fetch = originalFetch; });

type Ev = { id: string; date: string; release: string | null };

describe("calendrier — un événement par date de sortie (B6)", () => {
  it("un film en salle dans la fenêtre, numérique après : un seul événement « cinema »", async () => {
    mockRadarr.getCalendar.mockResolvedValue([
      { id: 7, tmdbId: 70, title: "Film", inCinemas: "2026-09-10T00:00:00Z", digitalRelease: "2026-12-01T00:00:00Z", images: [] },
    ]);
    const { GET } = await import("@/app/api/calendar/route");
    const body = await (await GET(fakeReq({ start: "2026-09-01", end: "2026-10-31" }))).json();
    const evs = body.events as Ev[];
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ date: "2026-09-10", release: "cinema" });
  });

  it("les trois dates dans la fenêtre : trois événements, identifiants distincts", async () => {
    mockRadarr.getCalendar.mockResolvedValue([
      {
        id: 8, tmdbId: 80, title: "Film",
        inCinemas: "2026-09-02T00:00:00Z", digitalRelease: "2026-10-05T00:00:00Z", physicalRelease: "2026-10-20T00:00:00Z",
        images: [],
      },
    ]);
    const { GET } = await import("@/app/api/calendar/route");
    const body = await (await GET(fakeReq({ start: "2026-09-01", end: "2026-10-31" }))).json();
    const evs = body.events as Ev[];
    expect(evs.map((e) => [e.date, e.release])).toEqual([
      ["2026-09-02", "cinema"],
      ["2026-10-05", "digital"],
      ["2026-10-20", "physical"],
    ]);
    // Clé React et déduplication de la route se font par `id` : il doit rester unique.
    expect(new Set(evs.map((e) => e.id)).size).toBe(3);
  });

  it("bornes incluses, dates hors fenêtre écartées", async () => {
    mockRadarr.getCalendar.mockResolvedValue([
      { id: 9, tmdbId: 90, title: "Film", inCinemas: "2026-08-31", digitalRelease: "2026-09-01", physicalRelease: "2026-11-01", images: [] },
    ]);
    const { GET } = await import("@/app/api/calendar/route");
    const body = await (await GET(fakeReq({ start: "2026-09-01", end: "2026-10-31" }))).json();
    expect((body.events as Ev[]).map((e) => e.release)).toEqual(["digital"]);
  });
});
