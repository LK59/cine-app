// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { useNextEpisodeFromCache } from "@/lib/useNextEpisodeFromCache";
import type { CinemaSeason } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";

// L'épisode suivant se lit dans le cache au moment où le film se termine, pas dans la liste que la
// fiche avait au lancement : une fiche ouverte avant l'arrivée des épisodes lançait un épisode sans
// suite, et l'enchaînement s'arrêtait (chasse aux défauts du 25/09/2026).

const KEY = "/api/cinema/series/abc/episodes";
const episode = (id: string, n: number) =>
  ({ jellyfinItemId: id, seasonNumber: 1, episodeNumber: n, title: `Épisode ${id}` }) as CinemaSeason["episodes"][number];

describe("useNextEpisodeFromCache", () => {
  it("lit les épisodes arrivés après le rendu", () => {
    const cache = new Map();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => cache }}>{children}</SWRConfig>
    );
    const { result } = renderHook(() => useNextEpisodeFromCache(KEY), { wrapper });
    expect(result.current("e1")).toBeNull();
    cache.set(KEY, { data: { seasons: [{ seasonNumber: 1, episodes: [episode("e1", 1), episode("e2", 2)] }] } });
    expect(result.current("e1")).toEqual({ itemId: "e2", title: "Épisode e2" });
  });
});
