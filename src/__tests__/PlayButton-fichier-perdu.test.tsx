// @vitest-environment jsdom
/**
 * Un appui retenu sur une supposition ne part pas si la réponse dit que le fichier manque
 * (DECISIONS §117.7, tranché le 23/10/2026).
 *
 * Fiche d'une série jamais commencée : « Lire S1·É1 » s'affiche d'après le catalogue et un appui
 * avant la réponse du serveur est retenu (`waitForServer`). Si la réponse désigne un épisode dont le
 * fichier a disparu, le bouton du téléphone ne lançait rien ; celui du bureau et de l'invité lançait
 * quand même l'épisode, qui échouait dans le lecteur. Les deux suivent désormais le téléphone.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const play = vi.fn();
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ play }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true }));

import { PlayButton } from "@/components/PlayButton";

afterEach(() => cleanup());
beforeEach(() => play.mockClear());

describe("PlayButton : l'appui retenu revérifie le fichier au départ", () => {
  it("ne lance rien quand la réponse arrive avec un fichier introuvable", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PlayButton itemId="s1e1" title="Une série" waitForServer />);
    await user.click(screen.getByRole("button"));
    expect(play).not.toHaveBeenCalled();
    rerender(<PlayButton itemId="s1e3" title="Une série" unavailable />);
    expect(play).not.toHaveBeenCalled();
  });

  it("lance l'épisode répondu quand son fichier est là", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PlayButton itemId="s1e1" title="Une série" waitForServer />);
    await user.click(screen.getByRole("button"));
    rerender(<PlayButton itemId="s1e3" title="Une série" />);
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: "s1e3" }));
  });
});
