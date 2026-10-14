// @vitest-environment jsdom
// Le cinéma pendant une panne de Jellyfin (DECISIONS.md §92) : le bandeau, l'écran sans catalogue
// (Réessayer, essai automatique annoncé), le bouton Lecture qui le dit au lieu d'ouvrir, et l'appui
// sur un titre introuvable qui affiche un message au lieu de ne rien faire.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook, screen, act, cleanup, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

const info = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ info, success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => {
  const t = (key: string, vars?: Record<string, string>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
  return { useT: () => t, useLocale: () => ({ locale: "fr", setLocale: () => {} }) };
});
const mutateSpy = vi.fn(async (..._args: unknown[]) => undefined);
// `useSWRConfig().mutate` observé : c'est lui que Réessayer et l'essai automatique appellent.
vi.mock("swr", async (importOriginal) => {
  const real = await importOriginal<typeof import("swr")>();
  return { ...real, useSWRConfig: () => ({ ...real.useSWRConfig(), mutate: mutateSpy }) };
});
const cinemaNavigate = vi.fn();
vi.mock("@/lib/cinemaRoute", () => ({ cinemaNavigate: (...a: unknown[]) => cinemaNavigate(...a) }));

import { CatalogueOutageBanner, CatalogueUnavailable, useCatalogueOutage } from "@/components/cinema/CatalogueOutage";
import { catalogueSwrOptions, playBlockedByOutage, resetPlaybackOutage, sheetRepairDuring } from "@/lib/catalogueOutage";
import { PlaybackProvider, usePlayback } from "@/components/PlaybackProvider";
import { useRepairUnresolvedSheet } from "@/lib/useRepairUnresolvedSheet";
import { MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY } from "@/lib/catalogueKeys";
import { withCode } from "@/lib/upstreamError";

const unreachable = () => withCode(new Error("jellyfin ne répond pas"), "upstream_unreachable");

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  info.mockClear();
  cinemaNavigate.mockClear();
  resetPlaybackOutage();
  fetchMock = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ code: "upstream_unreachable" }) }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("le bandeau", () => {
  it("dit la panne quand Jellyfin est réputé hors ligne, et rien sinon", () => {
    const { rerender } = render(<CatalogueOutageBanner outage={{ jellyfinDown: true, stale: true }} />);
    expect(screen.getByTestId("catalogue-outage-banner").textContent).toBe("cinema.outage.banner");
    rerender(<CatalogueOutageBanner outage={{ jellyfinDown: false, stale: false }} />);
    expect(screen.queryByTestId("catalogue-outage-banner")).toBeNull();
  });

  it("le catalogue marqué est relu toutes les 30 s — et jamais en temps normal", () => {
    expect(catalogueSwrOptions.refreshInterval({ jellyfinDown: true })).toBe(30_000);
    expect(catalogueSwrOptions.refreshInterval({ stale: true })).toBe(30_000);
    expect(catalogueSwrOptions.refreshInterval({})).toBe(0);
    expect(catalogueSwrOptions.refreshInterval(undefined)).toBe(0);
  });
});

describe("l'écran sans catalogue", () => {
  const withSwr = (ui: ReactNode) => {
    mutateSpy.mockClear();
    const view = render(<>{ui}</>);
    return { view, mutate: mutateSpy };
  };

  it("dit ce qui manque, relance les deux catalogues sur Réessayer, et annonce l'essai automatique", async () => {
    const { mutate } = withSwr(<CatalogueUnavailable error={unreachable()} />);
    expect(screen.getByText("player.libraryUnreachable")).toBeTruthy();
    expect(screen.getByText(/cinema\.outage\.nextRetry.*"30"/)).toBeTruthy();
    // Pas de « Mode standard » pour un spectateur : l'appelant ne le passe qu'à l'administrateur.
    expect(screen.queryByText("cinema.standardMode")).toBeNull();

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "cinema.outage.retry" })));
    expect(mutate).toHaveBeenCalledWith(MOVIES_CATALOGUE_KEY);
    expect(mutate).toHaveBeenCalledWith(SERIES_CATALOGUE_KEY);
  });

  it("le compte à rebours descend, et relance tout seul à zéro", async () => {
    const { mutate } = withSwr(<CatalogueUnavailable error={unreachable()} />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(screen.getByText(/cinema\.outage\.nextRetry.*"25"/)).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(25_100)));
    // L'essai part au tour suivant le zéro (posé par l'effet que le zéro déclenche).
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(mutate).toHaveBeenCalledWith(MOVIES_CATALOGUE_KEY);
    // Et le compte repart de trente.
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(screen.getByText(/cinema\.outage\.nextRetry.*"30"/)).toBeTruthy();
  });

  it("l'administrateur garde « Mode standard » à côté de Réessayer", () => {
    withSwr(
      <CatalogueUnavailable error={unreachable()}>
        <button type="button">cinema.standardMode</button>
      </CatalogueUnavailable>
    );
    expect(screen.getByText("cinema.standardMode")).toBeTruthy();
  });
});

describe("le bouton Lecture pendant la panne", () => {
  function wrapper({ children }: { children: ReactNode }) {
    return <PlaybackProvider>{children}</PlaybackProvider>;
  }

  it("n'ouvre pas le lecteur et dit pourquoi ; ouvre de nouveau une fois Jellyfin revenu", () => {
    const { result, rerender } = renderHook(
      ({ down }: { down: boolean }) => {
        useCatalogueOutage({ jellyfinDown: down, stale: down });
        return usePlayback();
      },
      { wrapper, initialProps: { down: true } }
    );
    act(() => result.current.play({ itemId: "1", title: "Dune", resumeAt: 0 }));
    expect(result.current.mode).toBe("closed");
    expect(result.current.session).toBeNull();
    expect(info).toHaveBeenCalledWith("cinema.outage.playBlocked");

    rerender({ down: false });
    act(() => result.current.play({ itemId: "1", title: "Dune", resumeAt: 0 }));
    expect(result.current.mode).toBe("full");
  });

  it("l'accueil démonté, la panne n'est plus l'affaire de personne : la gestion n'hérite d'aucun refus", () => {
    const { unmount } = renderHook(() => useCatalogueOutage({ jellyfinDown: true }));
    expect(playBlockedByOutage()).toBe(true);
    unmount();
    expect(playBlockedByOutage()).toBe(false);
  });
});

describe("un titre introuvable pendant la panne", () => {
  it("sans catalogue du tout (#film=138) : le message, et l'adresse rendue — au lieu de rien", () => {
    const during = sheetRepairDuring(138, unreachable(), undefined, undefined, undefined, { jellyfinDown: false, stale: false });
    expect(during.failed).toBe(true);
    renderHook(() => useRepairUnresolvedSheet("film=138", false, false, MOVIES_CATALOGUE_KEY, during));
    expect(info).toHaveBeenCalledWith("cinema.outage.titleUnreachable");
    expect(cinemaNavigate).toHaveBeenCalledWith({ film: null, serie: null, episodes: false }, "replace");
  });

  it("catalogue de secours en main, titre absent : le message de panne, pas « indisponible »", async () => {
    renderHook(() => useRepairUnresolvedSheet("film=999", false, true, MOVIES_CATALOGUE_KEY, { failed: false, outage: true }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    expect(info).toHaveBeenCalledWith("cinema.outage.titleUnreachable");
    expect(info).not.toHaveBeenCalledWith("cinema.titleUnavailable");
  });

  it("le catalogue d'un autre type ne compte pas : une série demandée lit l'erreur des séries", () => {
    expect(sheetRepairDuring(null, unreachable(), undefined, undefined, { items: [] }, { jellyfinDown: true, stale: true })).toEqual({ failed: false, outage: true });
  });
});
