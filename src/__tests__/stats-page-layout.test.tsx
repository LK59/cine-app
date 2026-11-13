// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, string>) => (v ? `${k} ${JSON.stringify(v)}` : k),
  useLocale: () => ({ locale: "fr", setLocale: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/useRole", () => ({ useRole: () => ({ role: "admin" }) }));
vi.mock("@/components/ServiceNotConfigured", () => ({ NotConfiguredNote: () => null }));

import StatsPage from "@/app/(dashboard)/stats/page";

/**
 * La page Statistiques (13/11/2026) : la prévision dite une seule fois, une place tenue pour chaque
 * bloc qui arrive tard, et une panne de Radarr ou Sonarr dite au lieu de zéros muets.
 */

const LIB = {
  movies: { total: 0, withFile: 0 },
  series: { total: 4, totalEpisodes: 10, episodesWithFile: 9 },
  quality: {}, languages: { vf: 0, vfvo: 0, vo: 0, vofr: 0, other: 0 }, codecs: { hevc: 0, h264: 0, other: 0 },
  hdr: 0, monthlyMovies: {}, monthlySeries: {}, genres: {}, decades: {},
  unavailable: ["radarr"],
};
const DISK_READY = { moviesBytes: 10e12, tvBytes: 5e12, seedsBytes: 1e12, disk: { total: 30e12, used: 18e12, free: 12e12 }, computing: false };
const DISK_PENDING = { moviesBytes: -1, tvBytes: -1, seedsBytes: -1, disk: { total: -1, used: -1, free: -1 }, computing: true };
const EMPTY_STORAGE = {
  movieFiles: { total: 0, hardlinked: 0, totalBytes: 0 }, seriesFiles: { total: 0, hardlinked: 0, totalBytes: 0 },
  notHardlinked: [], seedOrphans: [], seedOrphanBytes: 0, crossSeedByTracker: [], duplicates: [], heaviestH264: [], monthlyGrowth: [],
};
const FORECAST = {
  trend: "growing", growthBytesPerDay: 20e9, daysUntilFull: 600, monthsUsed: 0, method: "samples", sampleDays: 29, minSampleDays: 14, pending: false,
  monthlyGrowth: [{ month: "2026-10", bytes: 4.36e12 }, { month: "2026-11", bytes: 1e11 }],
};

function serve(routes: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = routes[url.split("?")[0]];
    return new Response(JSON.stringify(body ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><StatsPage /></SWRConfig>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("page Statistiques", () => {
  it("dit la prévision une seule fois, sous la barre du disque, avec la méthode employée", async () => {
    serve({
      "/api/stats/library": LIB,
      "/api/stats": DISK_READY,
      "/api/stats/storage": { ...EMPTY_STORAGE, computedAt: 1, computing: false, error: null },
      "/api/stats/people": { topActors: [], topDirectors: [], computedAt: 1, computing: false },
      "/api/stats/storage-forecast": FORECAST,
    });
    const block = await screen.findByTestId("disk-forecast");
    await screen.findAllByText(/stats\.storage\.forecastGrowing/);
    expect(screen.getAllByText(/stats\.storage\.forecastGrowing/)).toHaveLength(1);
    expect(block.textContent).toContain("stats.storage.forecastGrowing");
    expect(block.textContent).toContain("stats.storage.forecastMethodSamples");
    // La section Stockage est là, sans seconde prévision.
    expect(await screen.findByText("stats.storage.title")).toBeTruthy();
    expect(screen.queryByText("stats.storage.forecastTitle")).toBeNull();
    expect(screen.queryByTestId("storage-placeholder")).toBeNull();
  });

  it("tient la place du disque, du stockage et des acteurs tant qu'ils se calculent", async () => {
    serve({
      "/api/stats/library": LIB,
      "/api/stats": DISK_PENDING,
      "/api/stats/storage": { ...EMPTY_STORAGE, computedAt: 0, computing: true, error: null },
      "/api/stats/people": { topActors: [], topDirectors: [], computedAt: 0, computing: true },
      "/api/stats/storage-forecast": { ...FORECAST, pending: true, method: null, trend: "insufficient_data" },
    });
    const storage = await screen.findByTestId("storage-placeholder");
    expect(storage.textContent).toContain("stats.storage.scanPending");
    expect((await screen.findByTestId("disk-placeholder")).textContent).toContain("stats.diskPending");
    expect((await screen.findByTestId("people-placeholder")).textContent).toContain("stats.peoplePending");
  });

  it("dit que Radarr ne répond pas, au lieu d'un zéro muet", async () => {
    serve({
      "/api/stats/library": LIB,
      "/api/stats": DISK_READY,
      "/api/stats/storage": { ...EMPTY_STORAGE, computedAt: 1, computing: false, error: null },
      "/api/stats/people": { topActors: [], topDirectors: [], computedAt: 1, computing: false },
      "/api/stats/storage-forecast": FORECAST,
    });
    expect((await screen.findByTestId("unavailable-radarr")).textContent).toContain("stats.unavailable.radarr");
    expect(screen.queryByTestId("unavailable-sonarr")).toBeNull();
  });
});
