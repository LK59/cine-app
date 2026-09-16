// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

// Les deux règles qui comptent ici, et qui ne se voient nulle part ailleurs : le bandeau se tait
// sous un film plein écran, et l'avis ne vise que les écrans qui jouent quelque chose.

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));

let maintenance: { active: boolean; noticeAt: number | null };
vi.mock("@/lib/useMaintenance", () => ({ useMaintenance: () => maintenance }));

let playback: { session: unknown; mode: string };
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => playback }));

import { MaintenanceNotices } from "@/components/MaintenanceNotices";

const banner = () => screen.queryByText("maintenance.bannerTitle");
const notice = () => screen.queryByText("maintenance.noticeTitle");

beforeEach(() => {
  localStorage.clear();
  maintenance = { active: false, noticeAt: null };
  playback = { session: null, mode: "closed" };
});

afterEach(cleanup);

describe("le bandeau", () => {
  it("ne dit rien tant que rien n'est en cours", () => {
    render(<MaintenanceNotices />);
    expect(banner()).toBeNull();
  });

  it("s'affiche dès que la maintenance est allumée", () => {
    maintenance = { active: true, noticeAt: null };
    render(<MaintenanceNotices />);
    expect(banner()).toBeTruthy();
  });

  it("se tait pendant qu'un film occupe tout l'écran", () => {
    // Il s'y poserait par-dessus l'image pour les deux heures du film. C'est l'avis, et lui seul,
    // qui parle à un spectateur en pleine séance.
    maintenance = { active: true, noticeAt: null };
    playback = { session: { itemId: "film-1" }, mode: "full" };
    render(<MaintenanceNotices />);
    expect(banner()).toBeNull();
  });

  it("reste visible au-dessus du mini-lecteur", () => {
    maintenance = { active: true, noticeAt: null };
    playback = { session: { itemId: "film-1" }, mode: "mini" };
    render(<MaintenanceNotices />);
    expect(banner()).toBeTruthy();
  });

  it("se referme quand on le ferme, et ne revient pas tout seul", () => {
    maintenance = { active: true, noticeAt: null };
    const { rerender } = render(<MaintenanceNotices />);
    act(() => void screen.getByLabelText("common.close").click());
    expect(banner()).toBeNull();
    rerender(<MaintenanceNotices />);
    expect(banner()).toBeNull();
  });
});

describe("l'avis de redémarrage", () => {
  it("s'affiche sur un écran qui joue un film", () => {
    maintenance = { active: false, noticeAt: 1000 };
    playback = { session: { itemId: "film-1" }, mode: "full" };
    render(<MaintenanceNotices />);
    expect(notice()).toBeTruthy();
  });

  it("ne s'affiche pas sur un écran qui ne joue rien", () => {
    // C'est la demande : l'avis vise les lectures en cours. Ailleurs, le bandeau suffit.
    maintenance = { active: false, noticeAt: 1000 };
    render(<MaintenanceNotices />);
    expect(notice()).toBeNull();
  });

  it("ne réapparaît pas au chargement suivant une fois vu", () => {
    maintenance = { active: false, noticeAt: 1000 };
    playback = { session: { itemId: "film-1" }, mode: "full" };
    render(<MaintenanceNotices />);
    expect(notice()).toBeTruthy();
    cleanup();

    // Même avis, écran remonté : le sondage le renvoie toutes les quinze secondes, et il ne doit
    // pas rouvrir la fenêtre à chaque fois.
    render(<MaintenanceNotices />);
    expect(notice()).toBeNull();
  });

  it("réapparaît pour un avis plus récent", () => {
    // Une date et non un drapeau : c'est ce qui permet de prévenir deux fois.
    maintenance = { active: false, noticeAt: 1000 };
    playback = { session: { itemId: "film-1" }, mode: "full" };
    render(<MaintenanceNotices />);
    cleanup();

    maintenance = { active: false, noticeAt: 2000 };
    render(<MaintenanceNotices />);
    expect(notice()).toBeTruthy();
  });

  it("se referme tout seul au bout d'un moment", () => {
    // Personne ne veut retrouver un avertissement périmé en revenant d'une pause.
    vi.useFakeTimers();
    try {
      maintenance = { active: false, noticeAt: 1000 };
      playback = { session: { itemId: "film-1" }, mode: "full" };
      render(<MaintenanceNotices />);
      expect(notice()).toBeTruthy();
      act(() => void vi.advanceTimersByTime(31_000));
      expect(notice()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("survit à un stockage indisponible", () => {
    // Navigation privée, stockage bloqué : l'avertissement doit passer quand même — c'est le bon
    // sens de l'erreur pour un avertissement.
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("stockage refusé");
    });
    try {
      maintenance = { active: false, noticeAt: 1000 };
      playback = { session: { itemId: "film-1" }, mode: "full" };
      render(<MaintenanceNotices />);
      expect(notice()).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});
