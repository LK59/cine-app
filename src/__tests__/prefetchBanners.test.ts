// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Les visuels des fiches de la bannière du téléphone, demandés d'avance au repos — voir
// `prefetchSheetBanners` (Louis, 10/10/2026 : le relais affiche → visuel était brutal).

vi.mock("@/lib/uiQuiet", () => ({ whenUiQuiet: () => Promise.resolve() }));

import { prefetchSheetBanners, prefetchBannersForTests } from "@/lib/sheetMorph/prefetchBanners";

const requested: string[] = [];
const RealImage = globalThis.Image;

beforeEach(() => {
  requested.length = 0;
  prefetchBannersForTests.reset();
  class SpyImage {
    decoding = "";
    setAttribute() {}
    decode() {
      return Promise.resolve();
    }
    set src(url: string) {
      requested.push(url);
    }
  }
  globalThis.Image = SpyImage as unknown as typeof Image;
});

afterEach(() => {
  globalThis.Image = RealImage;
  Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
});

describe("prefetchSheetBanners", () => {
  it("demande l'adresse exacte que la fiche demandera, une fois", async () => {
    await prefetchSheetBanners(["https://img.test/a-backdrop.jpg", "https://img.test/b-backdrop.jpg", ""], () => false);
    await prefetchSheetBanners(["https://img.test/a-backdrop.jpg"], () => false);
    expect(requested).toEqual(["https://img.test/a-backdrop.jpg", "https://img.test/b-backdrop.jpg"]);
  });

  it("rien pendant un film (la bannière n'est plus à l'écran)", async () => {
    await prefetchSheetBanners(["https://img.test/a-backdrop.jpg"], () => true);
    expect(requested).toEqual([]);
  });

  it("rien sur une connexion qui demande l'économie de données", async () => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
    await prefetchSheetBanners(["https://img.test/a-backdrop.jpg"], () => false);
    expect(requested).toEqual([]);
  });

  it("rien si la demande est annulée avant le repos", async () => {
    const abort = new AbortController();
    abort.abort();
    await prefetchSheetBanners(["https://img.test/a-backdrop.jpg"], () => false, abort.signal);
    expect(requested).toEqual([]);
  });
});
