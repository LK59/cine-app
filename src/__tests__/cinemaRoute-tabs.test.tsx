// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { cinemaClose, openLibraryTitle, readCinemaRoute, CLOSE_PANELS } from "@/lib/cinemaRoute";
import { openPanel, type PlayerPanel } from "@/components/player/playerNav";

/**
 * Les onglets de la barre ne s'empilent pas (DECISIONS.md §103).
 *
 * Passe de nuit du 15/10/2026 (ROBUSTESSE-14) : dix changements d'onglet, `depth` 0 → 10, dix
 * retours pour revenir au départ en repassant par chaque panneau. Ces tests jouent la même suite
 * d'appuis sur le vrai historique de jsdom — retours compris, qui y arrivent par `popstate`.
 */

function depth(): number {
  const d = (window.history.state as Record<string, unknown> | null)?.cinemaDepth;
  return typeof d === "number" ? d : 0;
}

function tap(panel: PlayerPanel): void {
  act(() => openPanel(panel, readCinemaRoute()));
}

/** Un retour du navigateur, attendu jusqu'à son `popstate`. */
async function back(): Promise<void> {
  const arrived = new Promise<void>((r) => window.addEventListener("popstate", () => r(), { once: true }));
  window.history.back();
  await act(async () => {
    await arrived;
  });
}

/** Ce que fait « Accueil » quand il rend l'entrée : attendre le retour qu'il a demandé. */
async function tapHomeAndSettle(): Promise<void> {
  const arrived = new Promise<void>((r) => window.addEventListener("popstate", () => r(), { once: true }));
  tap("home");
  // Réécrite sur place, l'adresse est déjà celle de l'accueil ; un retour demandé, pas encore.
  if (window.location.hash !== "") {
    await act(async () => {
      await arrived;
    });
  }
}

beforeEach(() => {
  window.history.replaceState(null, "", "/cinema");
  window.dispatchEvent(new PopStateEvent("popstate"));
});

afterEach(() => cleanup());

describe("les onglets de la barre (§103)", () => {
  it("la rafale de la passe de nuit : jamais plus d'une entrée au-dessus de l'accueil", async () => {
    const seen: number[] = [];
    for (const panel of ["search", "list", "account", "home", "search", "home", "account", "list", "search", "home"] as PlayerPanel[]) {
      if (panel === "home") await tapHomeAndSettle();
      else tap(panel);
      seen.push(depth());
    }
    // Avant : 1, 2, 3, … 10.
    expect(seen).toEqual([1, 1, 1, 0, 1, 0, 1, 1, 1, 0]);
    expect(window.location.hash).toBe("");
  });

  it("le premier Retour depuis un onglet ramène à ce qu'il y avait avant le premier onglet", async () => {
    tap("search");
    tap("list");
    tap("account");
    expect(readCinemaRoute().account).toBe(true);
    await back();
    expect(window.location.hash).toBe("");
    expect(depth()).toBe(0);
  });

  it("une fiche ouverte depuis un onglet s'empile toujours, et le Retour la referme seule", async () => {
    tap("search");
    act(() => openLibraryTitle("movie", 603, { search: true }));
    expect(depth()).toBe(2);
    await back();
    expect(readCinemaRoute()).toMatchObject({ search: true, film: null });
    expect(depth()).toBe(1);
    // Et l'onglet suivant remplace toujours l'entrée de l'onglet, retrouvée par le retour.
    tap("list");
    expect(depth()).toBe(1);
    expect(readCinemaRoute()).toMatchObject({ list: true, search: false });
  });

  it("un onglet ouvert par-dessus une fiche y ramène au Retour ; « Accueil » ne revient pas sur la fiche", async () => {
    act(() => openLibraryTitle("movie", 603));
    expect(depth()).toBe(1);
    tap("search");
    expect(depth()).toBe(2);
    tap("account");
    expect(depth()).toBe(2);
    // Ce que l'onglet recouvre n'est pas l'accueil : « Accueil » y va en réécrivant l'entrée.
    await tapHomeAndSettle();
    expect(window.location.hash).toBe("");
    expect(depth()).toBe(2);
    await back();
    expect(readCinemaRoute().film).toBe(603);
  });

  it("la croix d'un onglet (cinemaClose) rend aussi l'entrée, une seule fois", async () => {
    tap("list");
    tap("account");
    const arrived = new Promise<void>((r) => window.addEventListener("popstate", () => r(), { once: true }));
    act(() => {
      cinemaClose(CLOSE_PANELS);
      cinemaClose(CLOSE_PANELS);
    });
    await act(async () => {
      await arrived;
    });
    expect(depth()).toBe(0);
    expect(window.location.hash).toBe("");
  });
});
