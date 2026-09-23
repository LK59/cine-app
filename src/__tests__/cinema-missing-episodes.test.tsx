// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars?.n !== undefined ? `${key}:${vars.n}` : key),
}));
vi.mock("@/components/cinema/CinemaDetailExtras", () => ({ CinemaDownloading: () => <span>downloading</span> }));

import { CinemaMissingEpisodes } from "@/components/cinema/CinemaMissingEpisodes";

const ep = (id: number, released: boolean) => ({
  id, seasonNumber: 2, episodeNumber: id, title: `Épisode ${id}`,
  airDate: released ? "2020-01-01" : "2099-01-01", released, downloading: null,
});
const draw = (episodes: ReturnType<typeof ep>[]) =>
  render(
    <CinemaMissingEpisodes
      season={{ seasonNumber: 2, requestable: false, episodes } as never}
      asked={new Set()}
      busy={false}
      onRequestSeason={() => {}}
      onRequestEpisode={() => {}}
    />
  );

afterEach(cleanup);

// Le 23/09/2026 : « 10 épisode(s) manquant(s) » pour une saison dont aucun épisode n'était sorti.
describe("CinemaMissingEpisodes", () => {
  it("dit « à venir » quand rien n'est encore sorti, sans bouton grisé qui répète la date", () => {
    draw([ep(1, false), ep(2, false)]);
    expect(screen.getByText("cinema.missing.upcoming:2")).toBeTruthy();
    expect(screen.queryByText(/cinema\.missing\.count/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("distingue ce qui manque de ce qui arrive", () => {
    draw([ep(1, true), ep(2, false), ep(3, false)]);
    expect(screen.getByText("cinema.missing.count:1 · cinema.missing.upcoming:2")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
