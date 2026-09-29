// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "fs";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false }));
vi.mock("@/lib/cinemaRoute", () => ({
  cinemaClose: vi.fn(),
  cinemaNavigate: vi.fn(),
  useCinemaRoute: () => ({ film: null, serie: null, discover: null, person: null }),
}));
vi.mock("@/components/PosterImage", () => ({ PosterImage: ({ alt }: { alt: string }) => <span>{alt}</span> }));

import { CinemaBrowseSheet } from "@/components/cinema/CinemaBrowseSheet";
import { browseSheetKey } from "@/lib/cinemaBrowse";

/**
 * La grille « Voir tout » du téléphone n'avait pas de clé par genre (audit A20, 29/09/2026).
 *
 * `useExitDelay` garde la grille montée pendant sa sortie ; rouvrir « Voir tout » sur un autre
 * genre à ce moment-là reprenait la même instance, et avec elle le tri, la décennie et la
 * recherche de la grille précédente. Le bureau avait la clé, avec un commentaire décrivant ce
 * défaut ; le téléphone l'avait oubliée.
 *
 * Monter le client téléphone entier demanderait l'adresse, SWR, la lecture et une quarantaine de
 * modules : le test rejoue donc son rendu tel qu'il est écrit — la grille, sa clé, le genre qui
 * change pendant la sortie — et vérifie dans la source que le client passe bien cette clé-là.
 */
afterEach(cleanup);

const film = (id: number, title: string, genres: string[]) => ({
  id, title, year: 2000, genres, addedAt: null, imdbRating: null, runtimeMinutes: 100, posterUrl: null,
});
const FILMS = [film(1, "Alpha", ["Drame", "Comédie"]), film(2, "Bêta", ["Drame", "Comédie"])];

// Le rendu de `CinemaMobileClient`, réduit à ce qui décide de l'instance : la clé et le genre
// retenu (`lastBrowse`), la grille étant encore montée (`leaving`) quand le genre change.
const sheet = (genre: string, leaving: boolean) => (
  <CinemaBrowseSheet
    key={browseSheetKey("movies", genre)}
    leaving={leaving}
    genre={genre}
    mediaType="movies"
    items={FILMS}
    genres={["Drame", "Comédie"]}
    idOf={(i) => i.id}
    posterOf={() => null}
    libraryIdOf={(i) => i.id}
  />
);

describe("la grille complète du téléphone, d'un genre à l'autre", () => {
  it("rouvrir un autre genre pendant la sortie ramène le tri au défaut", () => {
    const { rerender } = render(sheet("Drame", false));
    const select = () => screen.getByLabelText("player.browse.sort") as HTMLSelectElement;
    fireEvent.change(select(), { target: { value: "title" } });
    expect(select().value).toBe("title");
    // Fermée : elle sort, encore montée.
    rerender(sheet("Drame", true));
    // Rouverte sur un autre genre avant la fin de la sortie.
    rerender(sheet("Comédie", false));
    expect(select().value).toBe("added");
  });

  it("CinemaMobileClient passe la clé de browseSheetKey à la grille", () => {
    const src = readFileSync("src/components/cinema/mobile/CinemaMobileClient.tsx", "utf8");
    const grid = src.match(/<CinemaBrowseSheet[\s\S]*?\/>/)?.[0] ?? "";
    expect(grid).toMatch(/key=\{browseSheetKey\(mediaType, lastBrowse\)\}/);
  });
});
