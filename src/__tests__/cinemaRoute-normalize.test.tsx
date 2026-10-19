// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useCinemaRoute, cinemaNavigate, cinemaClose, closeAdminOnlyScreens, readCinemaRoute } from "@/lib/cinemaRoute";

/**
 * Les adresses incohérentes (DECISIONS.md §105, ROBUSTESSE-8) : nettoyées là où l'adresse est lue,
 * sans toucher aux adresses valides ni aux entrées que l'application a écrites.
 */

/** Arriver sur le cinéma par un lien direct : une entrée qui n'est pas la nôtre. */
function arrive(hash: string): void {
  window.history.replaceState(null, "", `/${hash}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

beforeEach(() => arrive(""));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("une adresse collée", () => {
  it.each([
    ["#serie=abc", ""],
    ["#film=-5", ""],
    ["#episodes=1", ""],
    ["#tab=series&episodes=1", "#tab=series"],
    ["#liste=1&compte=1&recherche=1", "#recherche=1"],
    ["#compte=1&liste=1", "#liste=1"],
    ["#compte=1&activite=1", "#activite=1"],
    ["#type=series", ""],
    ["#film=920&inconnu=3", "#film=920"],
    // Les téléchargements (§109) : tout onglet les referme, l'onglet reste.
    ["#telechargements=1&liste=1", "#liste=1"],
    ["#telechargements=1&compte=1", "#compte=1"],
  ])("%s devient « %s »", (pasted, expected) => {
    arrive(pasted);
    renderHook(() => useCinemaRoute());
    expect(window.location.hash).toBe(expected);
  });

  it.each([
    "#film=920",
    "#serie=1&episodes=1",
    "#episodes=1&serie=1&tab=series",
    "#recherche=1&film=920",
    "#film=920&serie=1",
    "#decouverte=12&type=series",
    "#compte=1",
    "#activite=journaux%3Asource%3Dplayer",
    "#telechargements=1",
    "#telechargements=1&film=920",
  ])("%s, valide, n'est pas réécrite", (valid) => {
    arrive(valid);
    renderHook(() => useCinemaRoute());
    expect(window.location.hash).toBe(valid);
  });

  it("un fragment tapé dans la barre est nettoyé aussi, sans rien empiler", () => {
    const { result } = renderHook(() => useCinemaRoute());
    const length = window.history.length;
    act(() => {
      window.history.pushState(null, "", "/#liste=1&recherche=1");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(window.location.hash).toBe("#recherche=1");
    expect(result.current).toMatchObject({ search: true, list: false });
    expect(window.history.length).toBe(length + 1);
  });

  it("ne touche pas une entrée que l'application a écrite", () => {
    renderHook(() => useCinemaRoute());
    act(() => cinemaNavigate({ search: true }));
    act(() => cinemaNavigate({ news: "1" }));
    act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
    expect(readCinemaRoute()).toMatchObject({ search: true, news: "1" });
  });

  it("ailleurs que sur le cinéma, rien n'est réécrit", () => {
    window.history.replaceState(null, "", "/gestion#liste=1&recherche=1");
    renderHook(() => useCinemaRoute());
    expect(window.location.hash).toBe("#liste=1&recherche=1");
  });
});

describe("episodes sans série", () => {
  // Téléphone : `#serie=1&episodes=1` puis Retour (lien direct, rien derrière) laissait `#episodes=1`.
  it("disparaît à la fermeture de la série, même si l'appelant l'oublie", () => {
    arrive("#serie=1&episodes=1");
    renderHook(() => useCinemaRoute());
    act(() => cinemaClose({ film: null, serie: null }));
    expect(window.location.hash).toBe("");
    expect(readCinemaRoute().episodes).toBe(false);
  });
});

describe("l'activité d'un compte qui n'est pas administrateur", () => {
  it("se referme une fois le rôle connu, sans rien empiler", () => {
    arrive("#activite=1");
    renderHook(() => useCinemaRoute());
    const length = window.history.length;
    act(() => closeAdminOnlyScreens(undefined));
    expect(readCinemaRoute().activity).toBe("1");
    act(() => closeAdminOnlyScreens(true));
    expect(readCinemaRoute().activity).toBe("1");
    act(() => closeAdminOnlyScreens(false));
    expect(readCinemaRoute().activity).toBeNull();
    expect(window.history.length).toBe(length);
  });
});
