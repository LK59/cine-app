// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, string>) => (v ? `${k} ${JSON.stringify(v)}` : k),
  useLocale: () => ({ locale: "en", setLocale: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { DashboardClient } from "@/app/(dashboard)/DashboardClient";
import type { DashboardPayload } from "@/app/api/dashboard/route";

/**
 * La vue d'ensemble d'une installation neuve (13/10/2026) : « 9 sur 9 hors ligne », un grand encart
 * jaune « qBittorrent indisponible », et « — libres sur 1.0 B » sans dossier de médias. Un service
 * non configuré n'est pas une panne, et un disque absent n'est pas un disque de 1 octet.
 */
const section = <T,>(data: T | null, extra: object = {}) => ({ data, available: data !== null, error: null, updatedAt: null, stale: false, ...extra });

function payload(overrides: Partial<DashboardPayload> = {}): DashboardPayload {
  return {
    services: section([
      { name: "radarr", up: true, detail: "v5", stats: {} },
      { name: "sonarr", up: false, detail: "fetch failed" },
      { name: "bazarr", up: false, configured: false, detail: "Non configuré — BAZARR_API_KEY" },
      { name: "qbittorrent", up: false, configured: false, detail: "Non configuré — QBITTORRENT_URL" },
    ]),
    activity: section([]),
    torrents: section(null, { notConfigured: true }),
    disk: section({ moviesBytes: 0, tvBytes: 0, seedsBytes: 0, disk: { total: -1, used: -1, free: -1 }, computedAt: 1, computing: false, error: null, mediaMissing: true }),
    ...overrides,
  } as DashboardPayload;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDashboard(data: DashboardPayload) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, revalidateOnMount: false }}>
      <DashboardClient initialData={data} />
    </SWRConfig>,
  );
}

describe("la vue d'ensemble d'une installation incomplète", () => {
  it("ne compte pas les services non configurés comme hors ligne, et les nomme à part", () => {
    renderDashboard(payload());
    // Une panne sur deux services configurés — pas « 3 sur 4 ».
    expect(screen.getByText(`dashboard.servicesSomeDown ${JSON.stringify({ n: "1", total: "2" })}`)).toBeTruthy();
    const line = screen.getByTestId("services-not-configured");
    expect(line.textContent).toContain("Bazarr, qBittorrent");
    expect(line.querySelector("a")?.getAttribute("href")).toBe("/parametres");
  });

  it("montre qBittorrent non configuré sans encart d'indisponibilité", () => {
    renderDashboard(payload());
    expect(screen.getByText("dashboard.torrentsNotConfigured")).toBeTruthy();
    expect(screen.queryByText("dashboard.unavailableWord", { exact: false })).toBeNull();
  });

  it("dit de monter le dossier des médias au lieu de « — libres sur 1.0 B »", () => {
    renderDashboard(payload());
    expect(screen.getByText("dashboard.storageNoMedia")).toBeTruthy();
    expect(screen.queryByText(/dashboard\.storageFree/)).toBeNull();
    expect(screen.getByText("dashboard.storageHowTo").closest("a")?.getAttribute("href")).toBe("/parametres/deploiement");
  });

  it("dit « aucun service configuré » plutôt que « tous en ligne » quand rien n'est branché", () => {
    renderDashboard(
      payload({ services: section([{ name: "bazarr", up: false, configured: false, detail: "Non configuré" }]) as DashboardPayload["services"] }),
    );
    expect(screen.getByText("dashboard.servicesNoneConfigured")).toBeTruthy();
  });
});
