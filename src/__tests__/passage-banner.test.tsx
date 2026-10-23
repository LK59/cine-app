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
import { PASSAGE_BANNER_CLOSED_KEY, openPassageFor } from "@/lib/passage/client";

/**
 * Le bandeau « Laterna a une nouvelle adresse — Passer » (DECISIONS.md §119) : sur l'ancienne adresse
 * seulement, refermé pour la journée, jamais pendant un film, absent sans réglage.
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

  // 23/10/2026 (souhait du propriétaire) : refermé, il revient le lendemain, une fois par jour.
  describe("une fois par jour", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 23, 22, 30));
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const relaunch = () => {
      cleanup();
      render(<PassageBanner />);
    };

    it("fermé à la croix : caché aujourd'hui, de retour le lendemain", () => {
      render(<PassageBanner />);
      fireEvent.click(screen.getByLabelText("passage.banner.close"));
      expect(banner()).toBeNull();
      expect(localStorage.getItem(PASSAGE_BANNER_CLOSED_KEY)).toBe("2026-10-23");
      relaunch();
      expect(banner()).toBeNull();
      vi.setSystemTime(new Date(2026, 9, 23, 23, 59));
      relaunch();
      expect(banner()).toBeNull();
      vi.setSystemTime(new Date(2026, 9, 24, 0, 1));
      relaunch();
      expect(banner()).not.toBeNull();
    });

    it("« Passer » vaut une fermeture pour la journée", () => {
      render(<PassageBanner />);
      fireEvent.click(screen.getByText("passage.banner.action"));
      expect(screen.getByTestId("passage-dialog")).toBeTruthy();
      expect(localStorage.getItem(PASSAGE_BANNER_CLOSED_KEY)).toBe("2026-10-23");
      relaunch();
      expect(banner()).toBeNull();
      vi.setSystemTime(new Date(2026, 9, 25, 9, 0));
      relaunch();
      expect(banner()).not.toBeNull();
    });

    it("une valeur d'avant (« 1 », une date en ms) : cachée aujourd'hui seulement", () => {
      for (const old of ["1", String(Date.now() - 86_400_000 * 10)]) {
        vi.setSystemTime(new Date(2026, 9, 23, 12, 0));
        localStorage.setItem(PASSAGE_BANNER_CLOSED_KEY, old);
        relaunch();
        expect([old, banner()]).toEqual([old, null]);
        vi.setSystemTime(new Date(2026, 9, 24, 8, 0));
        relaunch();
        expect([old, banner() !== null]).toEqual([old, true]);
        localStorage.clear();
      }
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
    localStorage.setItem(PASSAGE_BANNER_CLOSED_KEY, "1");
    render(<PassageBanner />);
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
