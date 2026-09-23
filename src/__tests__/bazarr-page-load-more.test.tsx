// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/**
 * « Charger plus » ne vide plus la liste (23/09/2026).
 *
 * La clé change à chaque page ; sans `keepPreviousData` la liste disparaissait le temps de la
 * requête, et SWR compte `isLoading` sur le cache de la nouvelle clé même quand les données
 * d'avant sont gardées. L'indicateur n'appartient qu'au premier chargement.
 */
let swr: { data: unknown; error?: unknown; isLoading: boolean; isValidating: boolean; mutate: () => void };
let swrOptions: unknown;
vi.mock("swr", () => ({
  default: (_key: string, _f: unknown, options: unknown) => {
    swrOptions = options;
    return swr;
  },
}));
vi.mock("@/lib/useConfiguredServices", () => ({ useConfiguredServices: () => ({ isConfigured: () => true }) }));
vi.mock("@/lib/useRole", () => ({ useRole: () => ({ isReadOnly: false }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/SubtitleSearchModal", () => ({ SubtitleSearchModal: () => null }));

import BazarrPage from "@/app/(dashboard)/bazarr/page";

afterEach(cleanup);

const movie = (i: number) => ({ radarrId: i, title: `Film ${i}`, missing_subtitles: [{ name: "French", code2: "fr" }] });
const page = { movies: { data: [movie(1), movie(2)], total: 60 }, episodes: { data: [], total: 0 } };

describe("Bazarr, page des sous-titres manquants", () => {
  it("garde la liste affichée pendant qu'elle s'allonge", () => {
    swr = { data: page, isLoading: true, isValidating: true, mutate: () => {} };
    render(<BazarrPage />);
    expect(screen.getByText("Film 1")).toBeInTheDocument();
    expect(swrOptions).toMatchObject({ keepPreviousData: true });
  });

  it("n'affiche l'indicateur qu'au premier chargement", () => {
    swr = { data: undefined, isLoading: true, isValidating: true, mutate: () => {} };
    const { container } = render(<BazarrPage />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    cleanup();
    swr = { data: page, isLoading: true, isValidating: true, mutate: () => {} };
    const again = render(<BazarrPage />);
    expect(again.container.querySelector(".animate-spin")).toBeNull();
  });

  it("le bouton dit qu'on attend la suite", () => {
    swr = { data: page, isLoading: true, isValidating: true, mutate: () => {} };
    render(<BazarrPage />);
    const more = screen.getByRole("button", { name: "bazarr.loadMore" });
    expect(more).toBeDisabled();
    expect(more).toHaveAttribute("aria-busy", "true");
  });
});

describe("le calendrier, en changeant de mois", () => {
  // Même piège : `keepPreviousData` était demandé, mais le calendrier se démontait quand même au
  // profit de l'indicateur, puisque `isLoading` vaut vrai sur chaque mois pas encore en cache.
  it("ne remplace le calendrier par l'indicateur qu'au premier chargement", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../app/(dashboard)/calendar/page.tsx"), "utf8");
    expect(src).toContain("const firstLoad = isLoading && !data;");
    expect(src).not.toMatch(/\{!?isLoading && /);
  });
});
