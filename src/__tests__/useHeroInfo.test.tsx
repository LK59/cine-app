// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

const fetched: string[] = [];
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async (url: string) => {
    fetched.push(url);
    return { tmdb: { overview: `réponse de ${url}`, cast: [] } };
  },
}));

import { useHeroInfo, heroInfoKey } from "@/lib/useHeroInfo";

/**
 * La bannière du bureau rend tout de suite un synopsis déjà là — préchargé par la rotation —, au
 * lieu d'attendre ses deux cents millisecondes (23/09/2026).
 */
afterEach(() => {
  fetched.length = 0;
  vi.useRealTimers();
});

function withCache(cache: Map<string, unknown>) {
  return function CacheWrapper({ children }: { children: ReactNode }) {
    return <SWRConfig value={{ provider: () => cache as never, dedupingInterval: 0 }}>{children}</SWRConfig>;
  };
}

describe("useHeroInfo", () => {
  it("rend aussitôt ce qui est déjà en cache, sans rien demander", () => {
    const cache = new Map<string, unknown>([[heroInfoKey("movie", 42), { data: { tmdb: { overview: "Déjà là.", cast: [] } } }]]);
    const { result } = renderHook(() => useHeroInfo("movie", 42), { wrapper: withCache(cache) });
    expect(result.current?.tmdb?.overview).toBe("Déjà là.");
  });

  it("en changeant de titre, rend sans attendre un titre déjà préchargé", () => {
    vi.useFakeTimers();
    const cache = new Map<string, unknown>([[heroInfoKey("movie", 42), { data: { tmdb: { overview: "Préchargé.", cast: [] } } }]]);
    const { result, rerender } = renderHook(({ id }) => useHeroInfo("movie", id), {
      wrapper: withCache(cache),
      initialProps: { id: 1 },
    });
    rerender({ id: 42 });
    // Aucune minuterie avancée : le synopsis arrive avec le logo, pas deux cents millisecondes après.
    expect(result.current?.tmdb?.overview).toBe("Préchargé.");
  });

  it("attend un instant avant de demander ce qui n'y est pas", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, rerender } = renderHook(({ id }) => useHeroInfo("movie", id), {
      wrapper: withCache(new Map()),
      initialProps: { id: 1 },
    });
    rerender({ id: 2 });
    // Pendant l'attente : rien du titre d'avant.
    expect(result.current).toBeUndefined();
    act(() => void vi.advanceTimersByTime(250));
    await waitFor(() => expect(result.current?.tmdb?.overview).toBe(`réponse de ${heroInfoKey("movie", 2)}`));
  });

  it("un titre sans identifiant TMDB vaut « pas de traduction »", () => {
    const { result } = renderHook(() => useHeroInfo("series", null), { wrapper: withCache(new Map()) });
    expect(result.current).toEqual({ tmdb: null });
    expect(fetched).toEqual([]);
  });
});
