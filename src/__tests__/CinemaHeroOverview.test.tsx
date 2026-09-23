// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/**
 * Le synopsis des deux bannières du bureau.
 *
 * La bannière des films attendait le texte traduit de TMDB et réservait sa hauteur ; celle des
 * séries, sa copie, montrait d'abord l'anglais de Sonarr puis sautait au français — et toute la
 * bannière sautait avec, faute de hauteur réservée. Relevé le 21/09/2026.
 */

let info: unknown = undefined;
vi.mock("swr", () => ({ default: () => ({ data: info }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));

import { CinemaSeriesHero } from "@/components/cinema/CinemaSeriesHero";
import { CinemaHero } from "@/components/cinema/CinemaHero";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

afterEach(() => {
  cleanup();
  info = undefined;
});

const serie = {
  sonarrId: 3,
  jellyfinItemId: "s3",
  tvdbId: 30,
  tmdbId: 300,
  title: "Dark",
  year: 2017,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  posterTextlessUrl: null,
  overview: "A family saga with a supernatural twist.",
  imdbRating: null,
  genres: [],
  addedAt: null,
} as CinemaSeries;

const film = {
  radarrId: 4,
  title: "Sunshine",
  year: 2007,
  logoUrl: null,
  overview: "The sun is dying.",
  genres: [],
  imdbRating: null,
  quality: null,
} as unknown as CinemaMovie;

const HEROES = [
  ["séries", () => <CinemaSeriesHero item={serie} />, serie.overview!],
  ["films", () => <CinemaHero item={film} />, film.overview as string],
] as const;

describe.each(HEROES)("la bannière des %s", (_, hero, english) => {
  it("ne montre pas l'anglais du catalogue en attendant le texte traduit", () => {
    render(hero());
    expect(screen.queryByText(english)).toBeNull();
  });

  it("réserve deux lignes, pour que la bannière ne saute pas à l'arrivée du texte", () => {
    const { container } = render(hero());
    expect(container.querySelector("p[data-hero-overview]")?.className).toContain("min-h-[2lh]");
  });

  it("montre le texte traduit dès qu'il est là", () => {
    info = { tmdb: { overview: "Une saga traduite.", cast: [] }, trailerKey: null };
    render(hero());
    expect(screen.getByText("Une saga traduite.")).toBeInTheDocument();
  });

  it("garde la ligne de distribution en place avant l'arrivée de la réponse", () => {
    // Elle apparaissait deux cents millisecondes après le titre, dans une colonne calée en bas :
    // tout le texte de la bannière descendait d'une ligne puis remontait (23/09/2026).
    const { container } = render(hero());
    const line = container.querySelector("p.min-h-\\[1lh\\]");
    expect(line).not.toBeNull();
    expect(line?.textContent).toBe("");
  });

  it("remplit la même ligne quand la distribution arrive", () => {
    info = { tmdb: { overview: "x", cast: [{ name: "Cillian Murphy" }, { name: "Rose Byrne" }] }, trailerKey: null };
    const { container } = render(hero());
    expect(container.querySelector("p.min-h-\\[1lh\\]")?.textContent).toBe("Cillian Murphy, Rose Byrne");
  });

  it("fait fondre le texte à son arrivée, sans animer une place vide", () => {
    // 23/09/2026 : le synopsis et la distribution surgissaient dans la place réservée.
    const { container, rerender } = render(hero());
    expect(container.querySelector("p[data-hero-overview] span:not([data-hero-probe])")).toBeNull();
    info = { tmdb: { overview: "Arrivé.", cast: [{ name: "Cillian Murphy" }] }, trailerKey: null };
    rerender(hero());
    expect(screen.getByText("Arrivé.").className).toContain("animate-fade-in");
    expect(screen.getByText("Cillian Murphy").className).toContain("animate-fade-in");
  });

  it("se replie sur le catalogue une fois la réponse arrivée sans traduction", () => {
    info = { tmdb: null, trailerKey: null };
    render(hero());
    expect(screen.getByText(english)).toBeInTheDocument();
  });
});
