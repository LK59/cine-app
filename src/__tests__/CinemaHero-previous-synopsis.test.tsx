// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * En passant d'un film à l'autre sur la bannière du bureau, le synopsis de l'ancien film fondait à
 * nouveau avant d'être remplacé par le bon (23/09/2026) — une fois par film, jamais en cache.
 * `keepPreviousData` est réglé globalement (SWRProvider) : la bannière recevait la réponse du film
 * d'avant pendant que celle du nouveau arrivait. Le vrai cache, avec ce réglage, pour le prouver.
 */
const pending = new Map<string, (value: unknown) => void>();
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: (url: string) => new Promise((resolve) => pending.set(url, resolve)),
}));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/cinema/CinemaLogo", () => ({ CinemaLogo: () => null }));

import { CinemaHero } from "@/components/cinema/CinemaHero";
import { CinemaSeriesHero } from "@/components/cinema/CinemaSeriesHero";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

afterEach(() => {
  cleanup();
  pending.clear();
});

const film = (id: number) =>
  ({ radarrId: id, title: `Film ${id}`, year: 2000, logoUrl: null, overview: "", genres: [], imdbRating: null, quality: null }) as unknown as CinemaMovie;
const serie = (id: number) =>
  ({ sonarrId: id, title: `Série ${id}`, year: 2000, logoUrl: null, overview: "", genres: [], imdbRating: null }) as unknown as CinemaSeries;

// Les deux bannières, jumelles : la même erreur y vivait, la même garde doit y tenir.
const KINDS = [
  ["films", "radarr/movies", (id: number) => <CinemaHero item={film(id)} />],
  ["séries", "sonarr/series", (id: number) => <CinemaSeriesHero item={serie(id)} />],
] as const;

describe.each(KINDS)("la bannière des %s, d'un titre à l'autre", (_, path, banner) => {
  const hero = (id: number) => (
    <SWRConfig value={{ provider: () => new Map(), keepPreviousData: true, dedupingInterval: 0 }}>
      {banner(id)}
    </SWRConfig>
  );
  const url = (id: number) => `/api/${path}/${id}/info`;
  const answer = (id: number, overview: string) =>
    pending.get(url(id))?.({ tmdb: { overview, cast: [] }, trailerKey: null });

  it("ne remontre jamais le synopsis du titre précédent", async () => {
    const { rerender } = render(hero(1));
    await waitFor(() => expect(pending.has(url(1))).toBe(true));
    answer(1, "Synopsis du premier.");
    await screen.findByText("Synopsis du premier.");

    rerender(hero(2));
    await waitFor(() => expect(pending.has(url(2))).toBe(true));
    // La réponse du second n'est pas encore là : rien, plutôt que le texte du premier.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Synopsis du premier.")).toBeNull();

    answer(2, "Synopsis du second.");
    await screen.findByText("Synopsis du second.");
  });
});
