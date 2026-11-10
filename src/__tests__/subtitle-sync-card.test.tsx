// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SyncSeriesPayload, SyncTreePayload } from "@/lib/subtitleSync/types";

/**
 * La page Configuration → Synchro des sous-titres (DECISIONS.md §141) : coupée sans le service, sinon les
 * compteurs, les films et leurs pistes (verdict, décalage, dérive, état), une série qui s'ouvre sur ses saisons ;
 * « Scanner » et « Recaler » envoient la portée et le geste, et rien ne part sans un clic.
 */

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k} ${JSON.stringify(v)}` : k) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));

const MOVIE = "a".repeat(32);
const SERIES = "5".repeat(32);
const EP = "1".repeat(32);
const counts = { items: 1, measured: 1, affected: 1, applied: 0, pending: 0 };
const trackView = {
  trackKey: "emb:3", kind: "embedded", codec: "subrip", language: "fre", title: null, forced: false, hi: true, offset: 2.44, scale: 25 / 24,
  scaleLabel: "25→24", z: 8, madMs: 20, windows: 12, inliers: 1, maxErrorS: 300, confidence: "high", verdict: "dérive", reliable: true,
  status: "measured", measuredAt: 1, decidedAt: null, decidedBy: null, stale: false,
};
const tree: SyncTreePayload = {
  configured: true,
  filter: "affected",
  totals: counts,
  pending: 0,
  movies: [{ itemId: MOVIE, kind: "Movie", title: "Prisoners (2013)", season: null, episode: null, job: null, tracks: [trackView as never] }],
  series: [{ seriesId: SERIES, title: "Show", counts, seasons: [{ season: 1, counts }] }],
};
const seriesPayload: SyncSeriesPayload = {
  configured: true,
  seriesId: SERIES,
  seasons: [{ season: 1, counts, episodes: [{ itemId: EP, kind: "Episode", title: "S01E01 · Pilote", season: 1, episode: 1, job: { state: "queued", error: null, launchedAt: 1 }, tracks: [] }] }],
};

async function mount(payload: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = init?.method === "POST" ? (url.endsWith("/scan") ? { queued: 1, failed: 0 } : { changed: 1 }) : url.includes("&series=") ? seriesPayload : payload;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const { SWRConfig } = await import("swr");
  const { SubtitleSyncCard } = await import("@/components/settings/SubtitleSyncCard");
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SubtitleSyncCard />
    </SWRConfig>
  );
  return calls;
}

describe("la carte", () => {
  it("sans le service : le dit, et rien d'autre", async () => {
    await mount({ configured: false, filter: "affected", totals: counts, pending: 0, movies: [], series: [] });
    expect(await screen.findByTestId("subsync-off")).toBeTruthy();
    expect(screen.queryByTestId("subsync-scan")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("les pistes, la série qui s'ouvre, et les gestes", async () => {
    const calls = await mount(tree);
    await screen.findByText("Prisoners (2013)");
    expect(screen.getByText(/FRE/)).toBeTruthy();
    expect(screen.getByText("subSync.verdict.drift")).toBeTruthy();
    expect(screen.getByText(/subSync\.drift .*25→24/)).toBeTruthy();
    // Rien n'est parti au chargement : seules des lectures.
    expect(calls.every((c) => !c.init?.method || c.init.method === "GET")).toBe(true);

    fireEvent.click(screen.getByText("Show"));
    // La série s'ouvre sur ses saisons ; une saison se déplie d'un clic de plus.
    fireEvent.click(await screen.findByText('subSync.season {"n":1}'));
    await screen.findByText("S01E01 · Pilote");
    expect(screen.getByText("subSync.job.queued")).toBeTruthy();
    expect(calls.some((c) => c.url.includes(`&series=${SERIES}`))).toBe(true);

    const movieRow = screen.getAllByTestId("subsync-item")[0];
    fireEvent.click(movieRow.querySelector("[data-testid=subsync-scan]")!);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('subSync.scanned {"n":1}'));
    const scan = calls.find((c) => c.url === "/api/admin/subsync/scan");
    expect(JSON.parse(String(scan?.init?.body))).toEqual({ scope: "item", itemId: MOVIE });

    fireEvent.click(movieRow.querySelector("[data-testid=subsync-apply]")!);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('subSync.changed {"n":1}'));
    const decide = calls.find((c) => c.url === "/api/admin/subsync/decide");
    expect(JSON.parse(String(decide?.init?.body))).toEqual({ scope: "item", itemId: MOVIE, action: "apply" });
    vi.unstubAllGlobals();
  });
});
