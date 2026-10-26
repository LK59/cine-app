// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { createRef } from "react";

// L'écran de l'épisode suivant (26/10/2026) : l'image réduite par une classe sur sa surface, l'épisode
// mis en avant, « Lire » et « Regarder le générique ».

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string, p?: Record<string, unknown>) => (p ? `${key}:${JSON.stringify(p)}` : key) }));
const episodes = vi.hoisted(() => ({
  data: {
    seasons: [
      {
        seasonNumber: 2,
        episodes: [
          { jellyfinItemId: "e9", seasonNumber: 2, episodeNumber: 9, title: "La Néra", overview: null, thumbnailUrl: null, runtimeMinutes: 55, runtimeTicks: null, watched: true, resumeTicks: null },
          { jellyfinItemId: "e10", seasonNumber: 2, episodeNumber: 10, title: "Valar Morghulis", overview: "Fin de saison.", thumbnailUrl: "/thumb/e10.jpg", runtimeMinutes: 63, runtimeTicks: null, watched: false, resumeTicks: null },
        ],
      },
    ],
    nextEpisode: null,
  } as unknown,
}));
vi.mock("swr", () => ({ default: (key: string | null) => ({ data: key ? episodes.data : undefined }) }));
vi.mock("@/lib/swr", () => ({ fetcher: vi.fn(), playerBootstrapOptions: {} }));

import { PlayerNextUp, splitEpisodeTitle } from "@/components/playerControls/PlayerNextUp";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(seriesId: string | null = "serie") {
  const frame = document.createElement("div");
  const picture = document.createElement("div");
  picture.setAttribute("data-player-picture", "");
  const video = document.createElement("video");
  picture.append(video);
  frame.append(picture);
  document.body.append(frame);
  const videoRef = createRef<HTMLVideoElement | null>() as { current: HTMLVideoElement | null };
  videoRef.current = video;
  const onPlay = vi.fn();
  const onWatchCredits = vi.fn();
  const view = render(
    <PlayerNextUp
      videoRef={videoRef}
      seriesId={seriesId}
      nextEpisode={{ itemId: "e10", title: "Game of Thrones — S02E10 · Valar Morghulis" }}
      countdown={7}
      total={10}
      running
      onPlay={onPlay}
      onWatchCredits={onWatchCredits}
    />
  );
  return { picture, onPlay, onWatchCredits, ...view };
}

describe("PlayerNextUp", () => {
  it("réduit la surface de l'image, et la rend entière en partant", async () => {
    vi.useFakeTimers();
    const { picture, unmount } = setup();
    expect(picture.classList.contains("player-squeezable")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(picture.classList.contains("player-squeezed")).toBe(true);
    unmount();
    expect(picture.classList.contains("player-squeezed")).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(picture.classList.contains("player-squeezable")).toBe(false);
  });

  it("met l'épisode en avant : série, code, titre, résumé, durée, miniature, décompte", () => {
    const { container } = setup();
    const text = container.textContent ?? "";
    expect(text).toContain("Game of Thrones");
    expect(text).toContain("S2E10");
    expect(text).toContain("Valar Morghulis");
    expect(text).toContain("Fin de saison.");
    expect(text).toContain('player.nextUp.runtime:{"n":63}');
    expect(text).toContain("7");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/thumb/e10.jpg");
  });

  it("sans la liste des épisodes, le titre seul", () => {
    const { container } = setup(null);
    expect(container.textContent).toContain("Valar Morghulis");
    expect(container.querySelector("img")).toBeNull();
  });

  it("« Lire » enchaîne ; « Regarder le générique » et un appui sur l'image réduite y reviennent", () => {
    const { container, onPlay, onWatchCredits } = setup();
    act(() => (container.querySelector("[data-player-next-up-play]") as HTMLButtonElement).click());
    expect(onPlay).toHaveBeenCalledTimes(1);
    act(() => (container.querySelector("[data-player-next-up-credits]") as HTMLButtonElement).click());
    act(() => (container.querySelector(".player-next-up-picture") as HTMLButtonElement).click());
    expect(onWatchCredits).toHaveBeenCalledTimes(2);
  });
});

describe("splitEpisodeTitle", () => {
  it("sépare la série et le nom de l'épisode", () => {
    expect(splitEpisodeTitle("Lucifer — S03E16 · Cobaye des enfers")).toEqual({ series: "Lucifer", name: "Cobaye des enfers" });
    expect(splitEpisodeTitle("Un titre seul")).toEqual({ series: null, name: "Un titre seul" });
    expect(splitEpisodeTitle("Série — Sans code")).toEqual({ series: "Série", name: "Sans code" });
  });
});
