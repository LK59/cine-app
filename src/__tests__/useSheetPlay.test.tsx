// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * `useSheetPlay` — ce qu'une fiche demande pour son bouton Lire (DECISIONS.md §114.7), sur les six cas
 * que les quatre fiches recopiaient : film sans réponse, réponse `known: false`, réponse connue ; série
 * supposée d'après le catalogue, série dont la liste est là, liste en panne.
 */
const S = vi.hoisted(() => ({ data: {} as Record<string, unknown>, errors: new Set<string>(), prefetched: [] as (string | null | undefined)[] }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: () => false }));
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: (id: string | null | undefined) => void S.prefetched.push(id) }));
vi.mock("@/lib/offline/useOfflineEnabled", () => ({ useOfflineDownloadsEnabled: () => false }));
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: (key: string) => (S.errors.has(key) ? Promise.reject(new Error("panne")) : key in S.data ? Promise.resolve(S.data[key]) : new Promise(() => {})),
}));

import { useSheetPlay, type SheetPlayTitle } from "@/lib/useSheetPlay";

const SERIES_ID = "b".repeat(32);
const EP1 = "e".repeat(32);
const EP2 = "f".repeat(32);
const episodesKey = `/api/cinema/series/${SERIES_ID}/episodes`;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, errorRetryCount: 0 }}>{children}</SWRConfig>
);
const movie = (progress: Extract<SheetPlayTitle, { kind: "movie" }>["progress"]): SheetPlayTitle => ({ kind: "movie", jellyfinItemId: "m".repeat(32), title: "Film", progress });
const series: SheetPlayTitle = { kind: "series", jellyfinItemId: SERIES_ID, title: "Série", sonarrId: 7, firstEpisode: { itemId: EP1, runtimeTicks: 28_200_000_000 } };

beforeEach(() => {
  S.data = {};
  S.errors = new Set();
  S.prefetched = [];
});
afterEach(cleanup);

describe("useSheetPlay — un film", () => {
  it("sans réponse : la cible est le film, rien d'affirmé", () => {
    const { result } = renderHook(() => useSheetPlay(movie(undefined)), { wrapper });
    expect(result.current.facts).toMatchObject({ targetId: "m".repeat(32), resumeKnown: false, resumeTicks: null });
    expect(result.current.playPending).toBe(false);
    expect(result.current.getNextEpisode).toBeUndefined();
    expect(result.current.episodeCode).toBeNull();
    expect(result.current.label).toBe("common.play");
  });

  it("`known: false` : Jellyfin n'a pas répondu, sa position n'est pas prise", () => {
    const { result } = renderHook(() => useSheetPlay(movie({ known: false, resumeTicks: 30_000_000_000, runtimeTicks: 81_600_000_000 } as never)), { wrapper });
    expect(result.current.facts).toMatchObject({ resumeKnown: false, resumeTicks: null, hasResume: false });
  });

  it("connue : sa position, et « Reprendre »", () => {
    const { result } = renderHook(() => useSheetPlay(movie({ known: true, resumeTicks: 30_000_000_000, runtimeTicks: 81_600_000_000 } as never)), { wrapper });
    expect(result.current.facts).toMatchObject({ resumeKnown: true, resumeTicks: 30_000_000_000, hasResume: true });
    expect(result.current.label).toContain("common.resume");
    expect(S.prefetched).toContain("m".repeat(32));
  });

  it("ne prépare rien quand on le lui dit", () => {
    renderHook(() => useSheetPlay(movie(undefined), { prefetch: false }), { wrapper });
    expect(S.prefetched.every((id) => id === null)).toBe(true);
  });
});

describe("useSheetPlay — une série", () => {
  it("supposée d'après le catalogue : S1·É1, un appui attend le serveur", () => {
    const { result } = renderHook(() => useSheetPlay(series), { wrapper });
    expect(result.current.facts).toMatchObject({ targetId: EP1, guessed: true, seasonNumber: 1, episodeNumber: 1 });
    expect(result.current.waitForServer).toBe(true);
    expect(result.current.playPending).toBe(false);
    expect(result.current.episodeCode).toBe("cinema.episodeShort");
  });

  it("jamais commencée et inconnue du catalogue : la place est tenue", () => {
    const { result } = renderHook(() => useSheetPlay({ ...series, firstEpisode: undefined } as SheetPlayTitle), { wrapper });
    expect(result.current.facts.targetId).toBeNull();
    expect(result.current.playPending).toBe(true);
  });

  it("la liste est là : l'épisode du serveur, et la suite relue dans la liste", async () => {
    S.data[episodesKey] = {
      seasons: [
        {
          seasonNumber: 1,
          episodes: [
            { jellyfinItemId: EP1, seasonNumber: 1, episodeNumber: 1, title: "Un", overview: null, thumbnailUrl: null, runtimeMinutes: 47, runtimeTicks: 1, watched: true, resumeTicks: null },
            { jellyfinItemId: EP2, seasonNumber: 1, episodeNumber: 2, title: "Deux", overview: null, thumbnailUrl: null, runtimeMinutes: 47, runtimeTicks: 1, watched: false, resumeTicks: null },
          ],
        },
      ],
      nextEpisode: { itemId: EP2, title: "Deux", seasonNumber: 1, episodeNumber: 2 },
    };
    const { result } = renderHook(() => useSheetPlay(series), { wrapper });
    await waitFor(() => expect(result.current.facts.targetId).toBe(EP2));
    expect(result.current.facts).toMatchObject({ resumeKnown: true, guessed: false, title: "Deux" });
    expect(result.current.waitForServer).toBe(false);
    expect(result.current.getNextEpisode?.(EP1)?.itemId).toBe(EP2);
  });

  it("liste en panne : la supposition part au lieu d'attendre pour toujours", async () => {
    S.errors.add(episodesKey);
    const { result } = renderHook(() => useSheetPlay(series), { wrapper });
    await waitFor(() => expect(result.current.episodesError).toBeDefined());
    expect(result.current.facts.guessed).toBe(true);
    expect(result.current.waitForServer).toBe(false);
    expect(result.current.playPending).toBe(false);
  });
});
