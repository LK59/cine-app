// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false }));
vi.mock("@/lib/cinemaRoute", () => ({
  cinemaClose: vi.fn(),
  cinemaNavigate: vi.fn(),
  useCinemaRoute: () => ({ film: null, serie: null, discover: null, person: null }),
}));
vi.mock("@/components/PosterImage", () => ({ PosterImage: ({ alt }: { alt: string }) => <span>{alt}</span> }));

import { CinemaBrowseSheet } from "@/components/cinema/CinemaBrowseSheet";
import { BROWSE_ALL } from "@/lib/cinemaBrowse";

/** Le filtre de durée de la grille complète — pour les films seulement (23/09/2026). */
afterEach(cleanup);

const film = (id: number, title: string, runtimeMinutes: number | null) => ({
  id, title, year: 2000, genres: ["Drame"], addedAt: null, imdbRating: null, runtimeMinutes, posterUrl: null,
});
const FILMS = [film(1, "Court", 85), film(2, "Fleuve", 190)];

const sheet = (mediaType: "movies" | "series", items = FILMS) => (
  <CinemaBrowseSheet
    genre={BROWSE_ALL}
    mediaType={mediaType}
    items={items}
    genres={[]}
    idOf={(i) => i.id}
    posterOf={() => null}
    libraryIdOf={(i) => i.id}
  />
);

describe("CinemaBrowseSheet — la durée", () => {
  it("propose la durée pour les films, et filtre", () => {
    render(sheet("movies"));
    const select = screen.getByLabelText("player.browse.duration");
    fireEvent.change(select, { target: { value: "under105" } });
    expect(screen.queryByText("Court")).not.toBeNull();
    expect(screen.queryByText("Fleuve")).toBeNull();
  });

  it("ne la propose pas pour les séries, qui n'ont pas de durée au catalogue", () => {
    render(sheet("series", FILMS.map((f) => ({ ...f, runtimeMinutes: null }))));
    expect(screen.queryByLabelText("player.browse.duration")).toBeNull();
  });
});
