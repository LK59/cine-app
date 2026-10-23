// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
const passage = vi.hoisted(() => ({ target: "https://app.example.org" as string | null, mode: "closed" as "closed" | "full" | "mini", onboarding: false }));
vi.mock("swr", () => ({ default: (key: string) => ({ data: key === "/api/onboarding" ? { pending: passage.onboarding } : { target: passage.target } }) }));
vi.mock("@/components/PlaybackProvider", () => ({ usePlaybackMode: () => passage.mode }));
// La fenêtre elle-même demande un passage au serveur : ici, seulement savoir qu'elle s'ouvre.
vi.mock("@/components/passage/PassageDialog", () => ({ PassageDialog: () => <div data-testid="passage-dialog" /> }));

import { PassageBanner } from "@/components/passage/PassageBanner";
import { PASSAGE_BANNER_CLOSED_KEYS, openPassageFor } from "@/lib/passage/client";

/**
 * Le bandeau « CineApp devient Laterna — Y aller » (DECISIONS.md §119) : sur l'ancienne adresse
 * seulement, refermé pour ce lancement, jamais pendant un film, absent sans réglage.
 */
beforeEach(() => {
  passage.target = "https://app.example.org";
  passage.mode = "closed";
  passage.onboarding = false;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

const banner = () => document.querySelector("[data-passage-banner]");

describe("PassageBanner", () => {
  it("s'affiche sur l'ancienne adresse, et « Passer » ouvre la fenêtre du passage", () => {
    render(<PassageBanner />);
    expect(banner()).not.toBeNull();
    fireEvent.click(screen.getByText("passage.banner.action"));
    expect(screen.getByTestId("passage-dialog")).toBeTruthy();
  });

  // 24/10/2026 (souhait du propriétaire) : refermé, il revient au lancement suivant — plus rien
  // n'est gardé sur l'appareil.
  describe("à chaque lancement", () => {
    const relaunch = () => {
      cleanup();
      render(<PassageBanner />);
    };

    it("fermé à la croix : caché pour ce lancement, de retour au suivant", () => {
      render(<PassageBanner />);
      fireEvent.click(screen.getByLabelText("passage.banner.close"));
      expect(banner()).toBeNull();
      expect(localStorage.length).toBe(0);
      relaunch();
      expect(banner()).not.toBeNull();
    });

    it("« Y aller » vaut une fermeture pour ce lancement", () => {
      render(<PassageBanner />);
      fireEvent.click(screen.getByText("passage.banner.action"));
      expect(screen.getByTestId("passage-dialog")).toBeTruthy();
      expect(banner()).toBeNull();
      relaunch();
      expect(banner()).not.toBeNull();
    });

    it("une fermeture gardée par une 10.0.x ne cache rien, et ses clés sont effacées", () => {
      for (const key of PASSAGE_BANNER_CLOSED_KEYS) localStorage.setItem(key, "2026-10-24|2");
      relaunch();
      expect(banner()).not.toBeNull();
      for (const key of PASSAGE_BANNER_CLOSED_KEYS) expect(localStorage.getItem(key)).toBeNull();
    });
  });

  it("absent sur la nouvelle adresse elle-même", () => {
    passage.target = `${window.location.protocol}//${window.location.host}`;
    render(<PassageBanner />);
    expect(banner()).toBeNull();
  });

  it("absent sur une installation sans nouvelle adresse", () => {
    passage.target = null;
    render(<PassageBanner />);
    expect(banner()).toBeNull();
  });

  it("jamais pendant un film, plein écran ou réduit", () => {
    for (const mode of ["full", "mini"] as const) {
      passage.mode = mode;
      const view = render(<PassageBanner />);
      expect(banner()).toBeNull();
      view.unmount();
    }
  });

  it("le lien de la page Nouveautés vers la nouvelle adresse ouvre le passage, même bandeau refermé", () => {
    render(<PassageBanner />);
    fireEvent.click(screen.getByLabelText("passage.banner.close"));
    expect(banner()).toBeNull();
    let handled = false;
    act(() => {
      handled = openPassageFor("https://app.example.org/");
    });
    expect(handled).toBe(true);
    expect(screen.getByTestId("passage-dialog")).toBeTruthy();
    // Une autre adresse n'est pas le passage : le lien s'ouvre comme avant.
    expect(openPassageFor("https://ailleurs.example.org/")).toBe(false);
  });

  it("pas par-dessus l'écran d'accueil d'un premier lancement", () => {
    passage.onboarding = true;
    render(<PassageBanner />);
    expect(banner()).toBeNull();
  });

  it("sans bandeau monté, le lien n'est pas pris en charge", () => {
    expect(openPassageFor("https://app.example.org/")).toBe(false);
  });
});
