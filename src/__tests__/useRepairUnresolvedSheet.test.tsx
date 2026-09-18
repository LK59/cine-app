// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

const cinemaNavigate = vi.fn();
vi.mock("@/lib/cinemaRoute", () => ({ cinemaNavigate: (...a: unknown[]) => cinemaNavigate(...a) }));

import { useRepairUnresolvedSheet } from "@/lib/useRepairUnresolvedSheet";

// Une adresse qui désigne un titre que rien ne peut afficher amputait l'écran : sur téléphone, la
// barre de navigation s'efface tant qu'une fiche est ouverte — et il n'y en avait aucune à fermer.

beforeEach(() => {
  vi.useFakeTimers();
  cinemaNavigate.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useRepairUnresolvedSheet", () => {
  it("efface une adresse qui ne mène à rien", () => {
    renderHook(() => useRepairUnresolvedSheet(true, false, true));
    act(() => void vi.advanceTimersByTime(2500));
    expect(cinemaNavigate).toHaveBeenCalledWith({ film: null, serie: null, episodes: false }, "replace");
  });

  it("ne touche à rien quand la fiche s'affiche", () => {
    renderHook(() => useRepairUnresolvedSheet(true, true, true));
    act(() => void vi.advanceTimersByTime(5000));
    expect(cinemaNavigate).not.toHaveBeenCalled();
  });

  it("attend que le catalogue soit là avant de conclure", () => {
    // Conclure sur un catalogue vide effacerait toutes les adresses au chargement.
    renderHook(() => useRepairUnresolvedSheet(true, false, false));
    act(() => void vi.advanceTimersByTime(5000));
    expect(cinemaNavigate).not.toHaveBeenCalled();
  });

  it("laisse une revalidation arriver la première", () => {
    // Effacer une adresse valable parce qu'on n'a pas attendu serait pire que le défaut réparé.
    const { rerender } = renderHook(({ resolved }) => useRepairUnresolvedSheet(true, resolved, true), {
      initialProps: { resolved: false },
    });
    act(() => void vi.advanceTimersByTime(1500));
    rerender({ resolved: true });
    act(() => void vi.advanceTimersByTime(5000));
    expect(cinemaNavigate).not.toHaveBeenCalled();
  });

  it("ne fait rien quand aucune fiche n'est demandée", () => {
    renderHook(() => useRepairUnresolvedSheet(false, false, true));
    act(() => void vi.advanceTimersByTime(5000));
    expect(cinemaNavigate).not.toHaveBeenCalled();
  });
});
