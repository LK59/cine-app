// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const play = vi.fn();
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ play }) }));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
}));
const playerEnabled = vi.fn();
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => playerEnabled() }));

import { PlayButton } from "@/components/PlayButton";

/** Une heure de film, en unités Jellyfin. */
const HOUR = 3600 * 10_000_000;

afterEach(() => cleanup());
beforeEach(() => {
  play.mockClear();
  playerEnabled.mockReturnValue(true);
});

describe("PlayButton", () => {
  it("dit « lire » et part du début quand rien n'a été vu", async () => {
    const user = userEvent.setup();
    render(<PlayButton itemId="a" title="Un Film" />);

    expect(screen.getByText("common.play")).toBeInTheDocument();
    await user.click(screen.getByRole("button"));
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: "a", resumeAt: undefined }));
  });

  it("dit « reprendre » et repart où on s'était arrêté", async () => {
    const user = userEvent.setup();
    render(<PlayButton itemId="a" title="Un Film" resumeTicks={HOUR / 2} />);

    await user.click(screen.getByRole("button"));
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ resumeAt: 1800 }));
  });

  /**
   * Le point de « recommencer » : la position de reprise sert à décider s'il faut afficher le
   * bouton, jamais à décider où la lecture démarre.
   */
  it("recommence bien depuis le début, malgré une reprise enregistrée", async () => {
    const user = userEvent.setup();
    render(<PlayButton restart itemId="a" title="Un Film" resumeTicks={HOUR / 2} />);

    expect(screen.getByText("common.restart")).toBeInTheDocument();
    await user.click(screen.getByRole("button"));
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ resumeAt: 0 }));
  });

  it("ne montre rien à recommencer quand il n'y a rien de commencé", () => {
    const { container } = render(<PlayButton restart itemId="a" title="Un Film" />);
    expect(container).toBeEmptyDOMElement();

    cleanup();
    const zero = render(<PlayButton restart itemId="a" title="Un Film" resumeTicks={0} />);
    expect(zero.container).toBeEmptyDOMElement();
  });

  it("laisse l'appelant nommer le bouton — « recommencer l'épisode », par exemple", () => {
    render(<PlayButton restart itemId="a" title="Un Épisode" resumeTicks={HOUR / 3} label="Recommencer l'épisode" />);
    expect(screen.getByText("Recommencer l'épisode")).toBeInTheDocument();
  });

  it("disparaît entièrement quand le compte n'a pas accès au lecteur", () => {
    playerEnabled.mockReturnValue(false);
    const { container } = render(<PlayButton itemId="a" title="Un Film" resumeTicks={HOUR / 2} />);
    expect(container).toBeEmptyDOMElement();
  });
});
