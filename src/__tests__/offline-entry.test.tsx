// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L'entrée hors ligne des téléchargements (bêta, DECISIONS.md §109) : le compte retenu sur
 * l'appareil, la page `/hors-ligne` qui s'en sert, le bouton de l'écran de chargement qui y mène au
 * bout de cinq secondes, et l'adresse publique.
 */

const adopt = vi.fn();
const init = vi.fn(async () => {});
let account: string | null = null;

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string) => k,
  useLocale: () => ({ locale: "fr", setLocale: async () => {} }),
}));
vi.mock("@/lib/persistentCache", () => ({ adoptSignedOutAccount: (a: string) => adopt(a) }));
vi.mock("@/lib/offline/deviceStore", () => ({ deviceStoreSupported: () => true }));
vi.mock("@/lib/offline/downloads", () => ({ initOfflineDownloads: () => init(), offlineAccount: () => account }));
vi.mock("@/components/offline/OfflineDownloadsView", () => ({ OfflineDownloadsView: () => <p>liste des téléchargements</p> }));
vi.mock("@/components/offline/OfflineDownloadControl", () => ({ BetaBadge: () => <span>bêta</span> }));

import { deviceKeepsDownloads, forgetOfflineAccount, rememberOfflineAccount, rememberedOfflineAccount, OFFLINE_BOOKS_COUNT_KEY, OFFLINE_ENTRY_PATH } from "@/lib/offline/offlineEntry";
import { OfflineEntryScreen } from "@/components/offline/OfflineEntryScreen";
import { SlowLaunchDownloads, SLOW_LAUNCH_MS } from "@/components/offline/SlowLaunchDownloads";
import { isPublicPath } from "@/lib/publicPaths";

beforeEach(() => {
  localStorage.clear();
  account = null;
  vi.clearAllMocks();
  init.mockReset();
  init.mockImplementation(async () => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("le compte retenu sur l'appareil", () => {
  it("se retient avec le nombre de ses téléchargements, et s'oublie", () => {
    expect(rememberedOfflineAccount()).toBeNull();
    rememberOfflineAccount("louis", 3);
    expect(rememberedOfflineAccount()).toEqual({ account: "louis", downloads: 3 });
    forgetOfflineAccount();
    expect(rememberedOfflineAccount()).toBeNull();
  });

  it("une valeur illisible ne nomme personne", () => {
    localStorage.setItem("cine-offline-entry", "{pas du json");
    expect(rememberedOfflineAccount()).toBeNull();
  });

  it("la déconnexion l'oublie — la page sans session ne montre plus ce dossier", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/signOut.ts"), "utf8");
    expect(src).toContain("forgetOfflineAccount()");
  });
});

describe("/hors-ligne", () => {
  it("est publique : le service worker la demande sans cookie", () => {
    expect(OFFLINE_ENTRY_PATH).toBe("/hors-ligne");
    expect(isPublicPath("/hors-ligne")).toBe(true);
  });

  it("montre le dossier du compte retenu, sans rien demander d'autre", async () => {
    rememberOfflineAccount("louis", 2);
    init.mockImplementation(async () => {
      account = "louis";
    });
    await act(async () => {
      render(<OfflineEntryScreen />);
    });
    expect(adopt).toHaveBeenCalledWith("louis");
    expect(screen.getByText("liste des téléchargements")).toBeTruthy();
  });

  it("sans compte retenu, le dit au lieu d'une liste vide", async () => {
    await act(async () => {
      render(<OfflineEntryScreen />);
    });
    expect(adopt).not.toHaveBeenCalled();
    expect(screen.getByText("player.downloads.entryNoAccount")).toBeTruthy();
  });

  it("sans compte de films retenu mais avec un livre gardé, montre la page (la section des livres y est)", async () => {
    localStorage.setItem(OFFLINE_BOOKS_COUNT_KEY, "1");
    await act(async () => {
      render(<OfflineEntryScreen />);
    });
    expect(screen.queryByText("player.downloads.entryNoAccount")).toBeNull();
    expect(screen.getByText("liste des téléchargements")).toBeTruthy();
  });
});

describe("« Accéder aux téléchargements » sur l'écran de chargement", () => {
  it("apparaît au bout de cinq secondes, seulement si ce compte a des téléchargements", () => {
    vi.useFakeTimers();
    rememberOfflineAccount("louis", 1);
    render(<SlowLaunchDownloads />);
    act(() => vi.advanceTimersByTime(SLOW_LAUNCH_MS - 1));
    expect(screen.queryByRole("button")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    const button = screen.getByRole("button", { name: "player.downloads.accessDownloads" });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, assign } });
    fireEvent.click(button);
    Object.defineProperty(window, "location", { configurable: true, value: original });
    expect(assign).toHaveBeenCalledWith("/hors-ligne");
  });

  it("rien pour un appareil sans téléchargement : ce serait une page vide", () => {
    vi.useFakeTimers();
    rememberOfflineAccount("louis", 0);
    render(<SlowLaunchDownloads />);
    act(() => vi.advanceTimersByTime(SLOW_LAUNCH_MS * 3));
    expect(screen.queryByRole("button")).toBeNull();
  });

  // 29/10/2026 : un iPhone qui ne gardait qu'un livre, lancé sans réseau, ne proposait pas les
  // téléchargements — la décision ne lisait que le nombre de films.
  it("apparaît aussi quand l'appareil ne garde qu'un livre", () => {
    vi.useFakeTimers();
    rememberOfflineAccount("louis", 0);
    localStorage.setItem(OFFLINE_BOOKS_COUNT_KEY, "1");
    render(<SlowLaunchDownloads />);
    act(() => vi.advanceTimersByTime(SLOW_LAUNCH_MS));
    expect(screen.getByRole("button", { name: "player.downloads.accessDownloads" })).toBeTruthy();
  });

  it("un livre seul, sans compte de films retenu : la même décision", () => {
    expect(deviceKeepsDownloads()).toBe(false);
    localStorage.setItem(OFFLINE_BOOKS_COUNT_KEY, "2");
    expect(deviceKeepsDownloads()).toBe(true);
    localStorage.setItem(OFFLINE_BOOKS_COUNT_KEY, "0");
    rememberOfflineAccount("louis", 3);
    expect(deviceKeepsDownloads()).toBe(true);
  });

  it("monté par l'écran de chargement, l'attente du catalogue des deux accueils et l'écran sans catalogue", () => {
    for (const f of [
      "src/app/(player)/page.tsx",
      "src/components/cinema/CinemaClient.tsx",
      "src/components/cinema/mobile/CinemaMobileClient.tsx",
      "src/components/cinema/CatalogueOutage.tsx",
    ]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).toContain("<SlowLaunchDownloads");
    }
  });
});
