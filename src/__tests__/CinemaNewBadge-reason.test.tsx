// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CinemaNewBadge } from "@/components/cinema/CinemaNewBadge";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));

afterEach(cleanup);

// Sur « Récemment ajoutés » et « À la une », la pastille était coupée — c'est pourtant là que remonte
// une série pour un nouvel épisode (12/10/2026). En mode « raison », seule la raison d'une remontée
// s'affiche : ni « Nouveau » d'un film, ni « Nouvelle série ».
describe("CinemaNewBadge en mode raison", () => {
  const recent = new Date().toISOString();
  it("dit « Nouvel épisode » et « Nouvelle saison »", () => {
    expect(render(<CinemaNewBadge addedAt={recent} arrival="episode" reasonOnly />).container.textContent).toBe("cinema.newEpisodeBadge");
    cleanup();
    expect(render(<CinemaNewBadge addedAt={recent} arrival="season" reasonOnly />).container.textContent).toBe("cinema.newSeasonBadge");
  });
  it("reste muet pour un film et pour une série elle-même nouvelle", () => {
    expect(render(<CinemaNewBadge addedAt={recent} reasonOnly />).container.textContent).toBe("");
    cleanup();
    expect(render(<CinemaNewBadge addedAt={recent} arrival="series" reasonOnly />).container.textContent).toBe("");
  });
  it("garde le comportement d'avant hors mode raison", () => {
    expect(render(<CinemaNewBadge addedAt={recent} />).container.textContent).toBe("cinema.newBadge");
    cleanup();
    expect(render(<CinemaNewBadge addedAt={recent} arrival="series" />).container.textContent).toBe("cinema.newSeriesBadge");
  });
});
