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
  // Zéro, et pas « rien ». Ce test attendait `undefined`, ce qui n'était pas faux du temps où le
  // seul lecteur ne sautait que sur une valeur vraie — mais le lecteur natif lit un champ absent
  // comme « prends la position dont le serveur se souvient ». Le film repartait alors là où on
  // l'avait laissé, sur un bouton qui annonçait « Lire ».
  it("dit « lire » et part explicitement du début quand rien n'a été vu", async () => {
    const user = userEvent.setup();
    render(<PlayButton itemId="a" title="Un Film" />);

    expect(screen.getByText("common.play")).toBeInTheDocument();
    await user.click(screen.getByRole("button"));
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: "a", resumeAt: 0 }));
  });

  // La distinction qui a coûté les deux bugs : ce que le bouton transmet doit être un nombre,
  // jamais une absence — c'est l'absence que le lecteur natif traduit en « demande au serveur ».
  it("transmet toujours une position, jamais une absence", async () => {
    const user = userEvent.setup();
    for (const props of [{}, { resumeTicks: HOUR / 2 }, { resumeTicks: HOUR / 2, restart: true }]) {
      play.mockClear();
      cleanup();
      render(<PlayButton itemId="a" title="Un Film" {...props} />);
      await user.click(screen.getByRole("button"));
      expect(typeof play.mock.calls[0][0].resumeAt).toBe("number");
    }
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
