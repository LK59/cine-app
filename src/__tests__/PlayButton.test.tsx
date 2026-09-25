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
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => playerEnabled(), usePlayerEnabledState: () => playerEnabled() }));

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

  // La distinction qui a coûté les deux bugs : dès qu'on sait, ce que le bouton transmet est un
  // nombre — c'est l'absence que le lecteur natif traduit en « demande au serveur ».
  it("transmet toujours une position quand elle est connue", async () => {
    const user = userEvent.setup();
    for (const props of [{}, { resumeTicks: HOUR / 2 }, { resumeTicks: HOUR / 2, restart: true }]) {
      play.mockClear();
      cleanup();
      render(<PlayButton itemId="a" title="Un Film" {...props} />);
      await user.click(screen.getByRole("button"));
      expect(typeof play.mock.calls[0][0].resumeAt).toBe("number");
    }
  });

  /**
   * L'ignorance se dit, elle ne s'arrondit pas à zéro.
   *
   * `resumeTicks` absent voulait dire deux choses à la fois : « jamais commencé » et « la réponse
   * n'est pas encore arrivée ». Sur une page fraîchement chargée on clique avant que la position
   * soit revenue, et un film vu à moitié repartait du début. Laisser le champ absent rend la main
   * au serveur, qui lui sait.
   */
  it("ne prétend pas partir du début tant qu'il ignore où l'on en est", async () => {
    const user = userEvent.setup();
    render(<PlayButton itemId="a" title="Un Film" resumeKnown={false} />);

    await user.click(screen.getByRole("button"));
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ resumeAt: undefined }));
  });

  // Mais « recommencer » reste une intention, pas une observation : elle ne dépend pas de ce
  // qu'on sait de la position.
  it("recommence depuis le début même sans connaître la position", async () => {
    const user = userEvent.setup();
    render(<PlayButton itemId="a" title="Un Film" resumeTicks={HOUR / 2} resumeKnown={false} restart />);

    await user.click(screen.getByRole("button"));
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ resumeAt: 0 }));
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

// 25/09/2026 : la fiche s'ouvre complète. Le bouton ne surgit plus en poussant la fiche quand la
// configuration arrive, et ne se grise que sur un fichier dont Jellyfin a dit qu'il n'existe plus.
describe("PlayButton — fiche qui s'ouvre complète", () => {
  it("garde sa place, invisible et inerte, tant que la configuration n'est pas connue", async () => {
    playerEnabled.mockReturnValue(undefined);
    const user = userEvent.setup();
    const { container } = render(<PlayButton itemId="a" title="Un Film" variant="row" reserve />);
    const button = container.querySelector("button")!;
    expect(button).toHaveAttribute("data-play-reserved");
    expect(button).toBeDisabled();
    expect(button.className).toContain("invisible");
    // Pas dans la navigation au clavier du menu.
    expect(button).not.toHaveAttribute("data-detail-menu");
    await user.click(button);
    expect(play).not.toHaveBeenCalled();
  });

  it("ne réserve rien sans `reserve`, ni pour « Recommencer »", () => {
    playerEnabled.mockReturnValue(undefined);
    const { container } = render(
      <>
        <PlayButton itemId="a" title="Un Film" />
        <PlayButton itemId="a" title="Un Film" restart reserve resumeTicks={HOUR / 2} />
      </>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("grisé et muet sur un fichier manquant, sans barre ni « Recommencer »", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <PlayButton itemId="a" title="Un Film" variant="primary" resumeTicks={HOUR / 2} runtimeTicks={HOUR} unavailable />
        <PlayButton itemId="a" title="Un Film" restart resumeTicks={HOUR / 2} unavailable />
      </>
    );
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toBeDisabled();
    expect(buttons[0]).toHaveAttribute("data-play-unavailable");
    expect(screen.getByText("cinema.fileMissing")).toBeInTheDocument();
    expect(buttons[0].querySelector(".absolute")).toBeNull();
    await user.click(buttons[0]);
    expect(play).not.toHaveBeenCalled();
  });
});
