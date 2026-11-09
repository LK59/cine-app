// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

/**
 * Configuration → Acteurs à l'écran (DECISIONS.md §138, revue du 09/11/2026) : « Tout mettre en pause »
 * compte la liste de priorité (palier 0) avec les trois autres, et la barre d'un palier compte ses
 * échecs comme traités — à part, dans leur couleur — au lieu de rester sous 100 % pour toujours.
 */

const swr = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("swr", () => ({ default: (key: string | null) => ({ data: key === "/api/admin/xray/scan" ? swr.data : undefined, error: undefined, mutate: vi.fn() }) }));
vi.mock("@/lib/swr", () => ({ fetcher: vi.fn(), MOVIES_CATALOGUE_KEY: "m", SERIES_CATALOGUE_KEY: "s" }));
vi.mock("@/lib/cinemaPayload", () => ({ cinemaFetcher: vi.fn() }));
vi.mock("@/lib/cinemaSearch", () => ({ searchCinemaLibrary: () => [] }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key, useLocale: () => ({ locale: "fr" }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { scanBar, XrayScanCard } from "@/components/settings/XrayScanCard";

const tier = (n: 1 | 2 | 3, over: Record<string, unknown> = {}) => ({
  tier: n,
  total: 10,
  done: 9,
  queued: 0,
  failed: 1,
  excluded: 0,
  hoursTotal: 10,
  hoursDone: 9,
  remainingHours: 0,
  etaS: 0,
  paused: true,
  forced: false,
  ...over,
});

const status = (priorityPaused: boolean) => ({
  configured: true,
  phase: "paused",
  playbackBy: null,
  plannedAt: null,
  lastTickAt: 0,
  lastError: null,
  current: null,
  speed: null,
  tiers: [tier(1), tier(2), tier(3)],
  priority: { paused: priorityPaused, items: [] },
  etaAllS: 0,
  errors: [],
});

describe("la carte de l'analyse de la bibliothèque", () => {
  it("« Tout reprendre » seulement quand la liste de priorité est en pause elle aussi", () => {
    swr.data = status(false);
    const { unmount } = render(<XrayScanCard />);
    expect(within(screen.getByTestId("xray-scan-overview")).getByRole("button").textContent).toContain("xrayScan.pauseAll");
    unmount();
    swr.data = status(true);
    render(<XrayScanCard />);
    expect(within(screen.getByTestId("xray-scan-overview")).getByRole("button").textContent).toContain("xrayScan.resumeAll");
  });

  it("un palier fini avec un échec : la barre est pleine, l'échec y a sa part", () => {
    swr.data = status(true);
    render(<XrayScanCard />);
    const card = screen.getByTestId("xray-scan-tier-1");
    expect(within(card).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(within(card).getByTestId("xray-scan-bar-failed").style.width).toBe("10%");
  });

  it("scanBar : analysés et échecs sur le total, jamais au-delà de 100", () => {
    expect(scanBar(9, 1, 10)).toEqual({ done: 90, failed: 10 });
    expect(scanBar(0, 0, 0)).toEqual({ done: 0, failed: 0 });
    expect(scanBar(12, 3, 10)).toEqual({ done: 100, failed: 0 });
  });
});
