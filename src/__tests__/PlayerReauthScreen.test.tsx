// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));

import { PlayerReauthScreen } from "@/components/player/PlayerReauthScreen";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

// 15/10/2026 (passe de nuit, BUREAU-22) : l'écran « Ta session Jellyfin a expiré » n'avait aucune
// sortie — ni croix, ni Échap — et la reconnexion ramenait à l'accueil au lieu de la fiche.
describe("le lecteur, session Jellyfin expirée", () => {
  it("se referme par « Quitter » et par Échap", () => {
    const onClose = vi.fn();
    render(<PlayerReauthScreen onClose={onClose} keyboard />);
    fireEvent.click(screen.getByText("player.quit"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("laisse Échap à l'écran parcouru quand il n'est qu'un mini-lecteur", () => {
    const onClose = vi.fn();
    render(<PlayerReauthScreen onClose={onClose} keyboard={false} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ramène à la fiche après la reconnexion", () => {
    window.history.replaceState(null, "", "/#film=913&liste=1");
    render(<PlayerReauthScreen onClose={() => {}} keyboard />);
    const href = screen.getByText("player.reconnect").getAttribute("href")!;
    const next = new URL(href, "https://cine.example").searchParams.get("next");
    expect(next).toBe("/#film=913&liste=1");
  });

  // Que ce soit l'écran du lecteur serveur, refermé par sa croix et par Échap hors mini-lecteur, se
  // vérifie sur le lecteur rendu : PlayerHost-gardes.test.tsx (22/10/2026, plus sur son texte).
});
