// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prefetchTitleSheet, resetTitleSheetPrefetch, PROGRESS_EARLY_MAX_AGE_MS } from "@/lib/prefetch";
import { fetchOrEarly } from "@/lib/earlyFetch";
import { progressKey } from "@/lib/swr";
import { prefetchBannersForTests } from "@/lib/sheetMorph/prefetchBanners";

/**
 * L'état « vu » et la position, demandés dès l'appui sur une affiche (15/10/2026) — sans jamais rendre
 * une réponse plus vieille que trois secondes à la fiche qui s'ouvre.
 */
describe("l'appui sur une affiche : état du compte et logo", () => {
  let clock = 1_000;
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({ url, n: fetchMock.mock.calls.length })));

  beforeEach(() => {
    clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    resetTitleSheetPrefetch();
    prefetchBannersForTests.reset();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    delete window.__cineEarly;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
  const press = () => prefetchTitleSheet({ kind: "movie", radarrId: 12, jellyfinItemId: "jf-12", logoUrl: "https://image.tmdb.org/t/p/w500/logo.png" });

  it("l'état part à l'appui, et la fiche montée aussitôt reprend cette requête", async () => {
    press();
    expect(urls()).toContain(progressKey("jf-12"));
    clock += 250; // le geste, puis le montage de la fiche
    const res = await fetchOrEarly(progressKey("jf-12"));
    expect(await res.json()).toMatchObject({ url: progressKey("jf-12") });
    expect(urls().filter((u) => u === progressKey("jf-12"))).toHaveLength(1);
  });

  it("passé trois secondes, la fiche refait sa requête : jamais un état plus vieux", async () => {
    press();
    clock += PROGRESS_EARLY_MAX_AGE_MS + 1;
    await fetchOrEarly(progressKey("jf-12"));
    expect(urls().filter((u) => u === progressKey("jf-12"))).toHaveLength(2);
  });

  it("prise une fois seulement : la relecture suivante de la fiche repart du réseau", async () => {
    press();
    await fetchOrEarly(progressKey("jf-12"));
    await fetchOrEarly(progressKey("jf-12"));
    expect(urls().filter((u) => u === progressKey("jf-12"))).toHaveLength(2);
  });

  it("deux appuis rapprochés ne lancent qu'une requête d'état", () => {
    press();
    clock += 100;
    press();
    expect(urls().filter((u) => u === progressKey("jf-12"))).toHaveLength(1);
  });

  it("le logo de la fiche est demandé dès l'appui", () => {
    const created: string[] = [];
    vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation((v: string) => void created.push(v));
    press();
    expect(created).toContain("https://image.tmdb.org/t/p/w500/logo.png");
  });
});
