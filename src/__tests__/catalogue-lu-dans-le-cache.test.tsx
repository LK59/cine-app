// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { ReactNode } from "react";
import useSWR, { SWRConfig } from "swr";

/**
 * Ouvrir la recherche redemandait le catalogue entier (audit P2, 29/09/2026).
 *
 * Son commentaire promettait « zéro réseau », mais ses deux lectures du catalogue prenaient les
 * options par défaut : passé la fenêtre de dédoublonnage (10 s), `revalidateIfStale` relançait
 * la requête au montage — et la réponse, un objet neuf, faisait redessiner toute la grille de
 * l'accueil. L'assistant de signalement faisait la même chose. Les écrans qui lisaient déjà le
 * catalogue « dans le cache » recopiaient chacun les trois options à la main.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => ({ locale: "fr" }),
}));
const catalogueFetcher = vi.fn(async (url: string) =>
  url.includes("/series")
    ? { items: [], rows: {}, spotlight: [], recentlyAdded: [], top10: [] }
    : { items: [], rows: {}, spotlight: [], recentlyAdded: [], top10: [] }
);
vi.mock("@/lib/cinemaPayload", async (importOriginal) => ({
  catalogueTitles: (await importOriginal<typeof import("@/lib/cinemaPayload")>()).catalogueTitles,
  cinemaFetcher: (url: string) => catalogueFetcher(url),
}));
vi.mock("@/components/PosterImage", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  PosterImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock("@/lib/cinemaRoute", () => ({
  cinemaNavigate: vi.fn(),
  cinemaClose: vi.fn(),
  openLibraryTitle: vi.fn(),
}));
vi.mock("@/components/player/PlayerPanelFrame", () => ({
  PlayerPanelFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY } from "@/lib/swr";
import { PlayerSearchPanel } from "@/components/player/PlayerSearchPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// La configuration de `SWRProvider`, sans la persistance.
const PROD_LIKE = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  revalidateIfStale: true,
  dedupingInterval: 10000,
  keepPreviousData: true,
};

/** L'accueil : les deux catalogues, lus comme `CinemaClient` les lit. */
function Home() {
  useSWR(MOVIES_CATALOGUE_KEY, (url: string) => catalogueFetcher(url));
  useSWR(SERIES_CATALOGUE_KEY, (url: string) => catalogueFetcher(url));
  return null;
}

describe("le catalogue lu par la recherche", () => {
  it("n'est pas redemandé quand la recherche s'ouvre onze secondes après l'accueil", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    catalogueFetcher.mockClear();
    const provider = () => new Map();
    const { rerender } = render(
      <SWRConfig value={{ ...PROD_LIKE, provider }}>
        <Home />
      </SWRConfig>
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(catalogueFetcher).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    rerender(
      <SWRConfig value={{ ...PROD_LIKE, provider }}>
        <Home />
        <PlayerSearchPanel />
      </SWRConfig>
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    // Avant le correctif : 4 (les deux catalogues redemandés à l'ouverture).
    expect(catalogueFetcher).toHaveBeenCalledTimes(2);
  });
});

describe("une seule façon de lire le catalogue dans le cache", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
    });
  // Les deux écrans qui *tiennent* le catalogue à jour — ils le demandent au montage, c'est leur rôle.
  const OWNERS = ["CinemaClient.tsx", "CinemaMobileClient.tsx"];

  it("tout autre lecteur passe `cacheOnlyOptions`, et personne ne les recopie", () => {
    const offenders: string[] = [];
    for (const f of files("src")) {
      if (f.includes("__tests__") || OWNERS.some((o) => f.endsWith(o))) continue;
      const src = readFileSync(f, "utf8");
      // Chaque appel `useSWR` dont la clé est un catalogue, jusqu'à sa parenthèse fermante.
      for (const m of src.matchAll(/useSWR(?:<[^>]*>)?\(([\s\S]*?)\);/g)) {
        if (!/(MOVIES|SERIES)_CATALOGUE_KEY/.test(m[1])) continue;
        if (!/cacheOnlyOptions/.test(m[1])) offenders.push(`${f}: ${m[0].slice(0, 80)}`);
      }
      // La copie en ligne des trois options est ce qui a permis d'en oublier deux.
      if (!f.endsWith("swr.ts") && /revalidateOnMount: false, revalidateOnFocus: false, revalidateIfStale: false/.test(src)) {
        offenders.push(`${f}: options recopiées`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
