// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) =>
    vars?.n !== undefined ? `${key}:${vars.n}` : key === "cinema.episodeShort" ? `S${vars?.season} · É${vars?.episode}` : key,
  useLocale: () => ({ locale: "fr", setLocale: vi.fn() }),
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
    />
  );

afterEach(cleanup);

// Le 23/09/2026 : « 10 épisode(s) manquant(s) » pour une saison dont aucun épisode n'était sorti.
describe("CinemaMissingEpisodes", () => {
  it("dit « à venir » quand rien n'est encore sorti", () => {
    draw([ep(1, false), ep(2, false)]);
    expect(screen.getByText("cinema.missing.upcoming:2")).toBeTruthy();
    expect(screen.queryByText(/cinema\.missing\.count/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("distingue ce qui manque de ce qui arrive", () => {
    draw([ep(1, true), ep(2, false), ep(3, false)]);
    expect(screen.getByText("cinema.missing.count:1 · cinema.missing.upcoming:2")).toBeTruthy();
    // Plus aucun bouton : une série se demande en entier (23/09/2026).
    expect(screen.queryByRole("button")).toBeNull();
  });
});

// Relevé le 23/09/2026 : la date suivait la langue du navigateur (« le Sep 30, 2026 » dans une page
// en français) et le code d'épisode était écrit en dur (« S02E01 »), là où le reste de l'app dit
// « S2 · É1 », et « T2 · E1 » en espagnol.
describe("CinemaMissingEpisodes — dans la langue de l'app", () => {
  it("écrit la date et le code d'épisode comme le reste de la page", () => {
    draw([{ ...ep(1, true), airDate: "2025-10-31" }]);
    expect(screen.getByText("S2 · É1")).toBeTruthy();
    expect(screen.getByText(/31 oct\. 2025/)).toBeTruthy();
  });
});
