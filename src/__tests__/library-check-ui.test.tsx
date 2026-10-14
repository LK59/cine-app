// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, string>) => (v ? `${k} ${JSON.stringify(v)}` : k),
  useLocale: () => ({ locale: "fr", setLocale: vi.fn() }),
}));

import { LibraryCheck } from "@/components/gestion/LibraryCheck";
import SetupPage from "@/app/setup/page";
import type { LibraryCheckStatus } from "@/lib/libraryCheck/types";
import type { SettingView } from "@/lib/settings/schema";

/**
 * Les écrans du 14/10/2026 : le contrôle de la bibliothèque (§90) — l'arbitrage conseille
 * l'exception, il ne la pose jamais seul — et l'assistant sans Radarr ni Sonarr (§89).
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const status: LibraryCheckStatus = {
  running: false,
  startedAt: null,
  progress: null,
  error: null,
  trusted: [],
  result: {
    version: 1,
    computedAt: Date.parse("2026-10-14T12:00:00Z"),
    durationMs: 42_000,
    sources: { radarr: "ok", sonarr: "ok", jellyfin: "ok", tmdb: "ok", media: "ok" },
    counts: { jellyfinOnly: 0, identity: 0, numbering: 1, misfiled: 0, hardlinks: 0 },
    findings: [
      {
        category: "numbering",
        key: "numbering:series:12",
        kind: "series",
        title: "Frieren",
        year: 2023,
        folder: "Frieren",
        verdict: "jellyfin",
        sonarrId: 12,
        seriesType: "anime",
        mismatched: 4,
        compared: 28,
        unattached: 0,
        trusted: false,
        arbiter: {
          verdict: "jellyfin",
          score: 1.1,
          jellyfinTitles: 0.9,
          sonarrTitles: 0.05,
          seasonCounts: { compared: 1, tmdb: 1, sonarr: 0 },
          examples: [{ disk: "S01E13", jellyfin: "Le retour", tmdbAtDisk: "Le retour", sonarr: ["S02E01"], sonarrTitle: "Another", jellyfinScore: 1, sonarrScore: 0 }],
        },
      },
    ],
  },
};

function renderPage(calls: { url: string; method?: string; body?: string }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string | undefined });
      if (url === "/api/admin/library-check/trust") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify(status), { status: 200 });
    })
  );
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <LibraryCheck />
    </SWRConfig>
  );
}

describe("le contrôle de la bibliothèque", () => {
  it("dit ce que dit chaque source, qui a probablement raison, l'arbitrage et le geste", async () => {
    renderPage([]);
    expect(await screen.findByText("Frieren")).toBeTruthy();
    expect(screen.getByText("libraryCheck.verdict.jellyfin {\"service\":\"Sonarr\"}")).toBeTruthy();
    expect(screen.getByText(/libraryCheck\.numbering\.summary/)).toBeTruthy();
    expect(screen.getByText(/S01E13/)).toBeTruthy();
    expect(screen.getByText(/libraryCheck\.gesture\.numberingJellyfin/)).toBeTruthy();
  });

  it("met en avant l'exception conseillée sans la poser — c'est le clic qui la pose", async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    renderPage(calls);
    const button = await screen.findByText("libraryCheck.trust.on");
    expect(button.closest("button")!.className).toContain("btn-primary");
    expect(screen.getByText("libraryCheck.trust.suggested")).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/trust"))).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/trust"))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/trust"))!.body!)).toEqual({ sonarrId: 12, trusted: true, title: "Frieren" });
  });
});

describe("l'assistant sans Radarr ni Sonarr (§89)", () => {
  const view = (key: string, o: Partial<SettingView> = {}): SettingView => ({ key, source: "default", value: "", set: false, hint: null, envPresent: false, ...o });
  const settings = [view("JELLYFIN_API_KEY", { source: "app", set: true }), view("TMDB_API_KEY", { source: "app", set: true })];

  it("l'écran de fin résume ce qui sera là et ce qui ne le sera pas, et laisse terminer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/setup/status") return new Response(JSON.stringify({ done: false, needsAdmin: false }), { status: 200 });
        if (url === "/api/settings") return new Response(JSON.stringify({ settings, missing: [], setupDone: false }), { status: 200 });
        return new Response("{}", { status: 404 });
      })
    );
    localStorage.setItem("cine:setup-step", "7");
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SetupPage />
      </SWRConfig>
    );
    expect(await screen.findByText("setup.features.cinema.on")).toBeTruthy();
    expect(screen.getByText("setup.features.movies.off")).toBeTruthy();
    expect(screen.getByText("setup.features.series.off")).toBeTruthy();
    expect((screen.getByText("setup.finish").closest("button") as HTMLButtonElement).disabled).toBe(false);
  });
});
