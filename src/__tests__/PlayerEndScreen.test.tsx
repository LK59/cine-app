// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

/**
 * L'écran de fin d'un film et « la suite » de sa saga : la carte, ce qu'elle lance, et à quelle
 * position. La décision elle-même est testée dans `collectionSuite.test.ts`.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

const film = (radarrId: number, title: string) => ({ radarrId, jellyfinItemId: `jf-${radarrId}`, title, tmdbId: radarrId * 10, genres: [] });
const SUBJECT = film(1, "Part One");
const catalogue = { spotlight: [SUBJECT], rows: {} };
vi.mock("swr", () => ({ default: () => ({ data: catalogue }) }));

/** La saga telle que la rangée de la fiche la résout. */
let saga: { movie: ReturnType<typeof film> | null }[] = [];
const collectionCalls: unknown[][] = [];
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({
  useCinemaCollection: (...args: unknown[]) => {
    collectionCalls.push(args);
    return { name: "Saga", parts: [], all: saga };
  },
}));

/** L'état Jellyfin de chaque film : vu, et la position de reprise. */
let states: Record<string, { played: boolean; resumeTicks: number | null }> = {};
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: (itemId: string) => {
    const s = states[itemId];
    return { known: !!s, watched: s?.played ?? false, progress: s ? { resumeTicks: s.resumeTicks } : undefined };
  },
}));

import { PlayerEndScreen } from "@/components/player/PlayerEndScreen";

afterEach(() => {
  cleanup();
  collectionCalls.length = 0;
});

function show(onPlayNext = vi.fn()) {
  render(
    <PlayerEndScreen itemId="jf-1" title="Part One" onReplay={() => {}} onClose={() => {}} onOpenTitle={() => {}} onPlayNext={onPlayNext} />
  );
  return onPlayNext;
}

describe("PlayerEndScreen — la suite d'une saga", () => {
  it("propose le premier film suivant pas encore vu, et le lance du début", () => {
    saga = [{ movie: SUBJECT }, { movie: film(2, "Part Two") }, { movie: film(3, "Part Three") }];
    states = { "jf-2": { played: true, resumeTicks: null }, "jf-3": { played: false, resumeTicks: null } };
    const onPlayNext = show();
    expect(screen.getByText("player.end.suite")).toBeTruthy();
    expect(screen.queryByText("Part Two")).toBeNull();
    fireEvent.click(screen.getByText("player.playNow"));
    expect(onPlayNext).toHaveBeenCalledWith(expect.objectContaining({ jellyfinItemId: "jf-3" }), 0);
    // Le même chemin que la rangée de la fiche, autorisé à partir pendant le film.
    expect(collectionCalls[0]).toEqual([1, { whilePlaying: true }]);
  });

  it("reprend un film commencé là où Jellyfin l'a laissé", () => {
    saga = [{ movie: SUBJECT }, { movie: film(2, "Part Two") }];
    states = { "jf-2": { played: false, resumeTicks: 600 * 10_000_000 } };
    const onPlayNext = show();
    fireEvent.click(screen.getByText("player.playNow"));
    expect(onPlayNext).toHaveBeenCalledWith(expect.objectContaining({ jellyfinItemId: "jf-2" }), 600);
  });

  it("ne montre rien tant que l'état du film suivant n'est pas connu", () => {
    saga = [{ movie: SUBJECT }, { movie: film(2, "Part Two") }];
    states = {};
    show();
    expect(screen.queryByText("player.end.suite")).toBeNull();
  });

  it("ne montre rien pour le dernier de la saga, ni hors saga", () => {
    saga = [{ movie: film(0, "Part Zero") }, { movie: SUBJECT }];
    states = { "jf-0": { played: false, resumeTicks: null } };
    show();
    expect(screen.queryByText("player.end.suite")).toBeNull();
    cleanup();
    saga = [];
    show();
    expect(screen.queryByText("player.end.suite")).toBeNull();
  });
});
