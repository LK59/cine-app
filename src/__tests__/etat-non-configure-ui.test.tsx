// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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
vi.mock("@/lib/useRole", () => ({ useRole: () => ({ role: "admin" }) }));

import HealthPage from "@/app/(dashboard)/health/page";
import { CapabilitySection } from "@/components/CapabilityStatus";

/**
 * Le rendu des deux pages d'état quand un service n'est pas configuré (13/10/2026) : « Non
 * configuré », neutre, à part — jamais une carte rouge « Hors ligne », jamais un test d'API en échec.
 */
const cap = (id: string, extra: object = {}) => ({ id, status: "ok", note: null, dependsOn: [], softDependsOn: [], uptime7d: 100, incidents7d: [], ...extra });
const STATUS = {
  overall: "ok",
  checkedAt: "2026-10-13T10:00:00Z",
  live: false,
  capabilities: [cap("movieLibrary"), cap("subtitles", { status: "down", configured: false })],
};
const HEALTH = {
  overall: "ok",
  checkedAt: "2026-10-13T10:00:00Z",
  services: [
    { name: "Radarr", url: "http://radarr", status: "ok", latencyMs: 12, version: "5", error: null },
    { name: "Bazarr", url: "http://bazarr", status: "down", latencyMs: null, version: null, error: "Non configuré — BAZARR_URL", configured: false },
  ],
  paths: [],
  latencyHistory: [],
};
const CONFIG = {
  defaultLang: "fr",
  playerEnabled: true,
  configured: { radarr: true, sonarr: true, bazarr: false, jackett: true, jellyfin: true, jellyseerr: true, qbittorrent: true, tmdb: true },
};

const fetchSpy = vi.fn(async (url: string) => {
  const body = url.startsWith("/api/status/public") ? STATUS : url === "/api/health" ? HEALTH : url === "/api/config/public" ? CONFIG : [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchSpy.mockClear();
});

function renderWithSWR(node: React.ReactNode) {
  vi.stubGlobal("fetch", fetchSpy);
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>);
}

describe("page d'état publique", () => {
  it("présente la fonction « non configurée », sans pastille d'état ni lien d'administration", async () => {
    renderWithSWR(<CapabilitySection />);
    const card = await screen.findByTestId("capability-subtitles");
    expect(card.getAttribute("data-configured")).toBe("false");
    expect(card.textContent).toContain("health.statusNotConfigured");
    expect(card.textContent).not.toContain("health.history.uptime");
    expect(card.querySelector(".bg-red-400")).toBeNull();
    // L'état d'ensemble reste celui de la route : « ok ».
    expect(screen.getByText("health.overall.ok")).toBeTruthy();
    expect(screen.getByTestId("capabilities-not-configured").querySelector("a")).toBeNull();
  });
});

describe("page Santé de la gestion", () => {
  it("nomme les services non configurés à part, avec le lien vers Connexions, sans carte « Hors ligne »", async () => {
    renderWithSWR(<HealthPage />);
    const line = await screen.findByTestId("health-services-not-configured");
    expect(line.textContent).toContain("Bazarr");
    expect(line.querySelector("a")?.getAttribute("href")).toBe("/parametres");
    expect(screen.queryByText("health.statusOffline")).toBeNull();
    // La section des capacités porte, dans la gestion, le même lien.
    const caps = await screen.findByTestId("capabilities-not-configured");
    expect(caps.querySelector("a")?.getAttribute("href")).toBe("/parametres");
  });

  it("ne teste pas les routes d'un service non configuré, et ne les compte pas en erreur", async () => {
    renderWithSWR(<HealthPage />);
    await screen.findByTestId("health-services-not-configured");
    // La liste des services branchés doit être là avant de lancer les tests.
    await waitFor(() => expect(fetchSpy.mock.calls.some((c) => c[0] === "/api/config/public")).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByText("health.apiTests.run"));
    const group = await screen.findByTestId("api-group-not-configured");
    expect(group.textContent).toContain("health.groups.bazarr");
    expect(group.textContent).toContain("health.statusNotConfigured");
    await waitFor(() => expect(screen.queryByText(/health\.apiTests\.running/)).toBeNull());
    const called = fetchSpy.mock.calls.map((c) => c[0]);
    expect(called).toContain("/api/radarr/meta");
    expect(called).not.toContain("/api/bazarr/wanted");
    // Les dix-huit routes testées, et elles seules, sont comptées (dix-neuf moins celle de Bazarr) ;
    // la fausse réponse ne satisfait pas tous les validateurs, d'où quelques erreurs ici.
    const count = (re: RegExp) => Number(/"n":"?(\d+)/.exec(screen.queryByText(re)?.textContent ?? "")?.[1] ?? 0);
    expect(count(/health\.apiTests\.ok/) + count(/health\.apiTests\.errors/)).toBe(18);
  });
});
