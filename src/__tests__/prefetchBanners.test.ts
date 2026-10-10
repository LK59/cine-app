// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Les visuels des fiches de la bannière du téléphone, gardés décodés dès que sa liste est connue —
// voir `keepSheetBanners` (Louis, 10/10/2026 : au premier lancement, une fiche ouverte depuis la
// bannière s'ouvrait encore sur l'affiche en remplacement).

import {
  keepSheetBanners,
  prefetchBannersForTests,
  prefetchSheetBannerNow,
  releaseSheetBanners,
  suspendSheetBanners,
} from "@/lib/sheetMorph/prefetchBanners";

const requested: string[] = [];
const aborted: string[] = [];
const RealImage = globalThis.Image;
let loaded = new Set<string>();

beforeEach(() => {
  requested.length = 0;
  aborted.length = 0;
  loaded = new Set();
  prefetchBannersForTests.reset();
  class SpyImage {
    decoding = "";
    url = "";
    setAttribute() {}
    removeAttribute(name: string) {
      if (name === "src") aborted.push(this.url);
    }
    decode() {
      return Promise.resolve();
    }
    get complete() {
      return loaded.has(this.url);
    }
    get naturalWidth() {
      return loaded.has(this.url) ? 1280 : 0;
    }
    set src(url: string) {
      this.url = url;
      requested.push(url);
    }
  }
  globalThis.Image = SpyImage as unknown as typeof Image;
});

afterEach(() => {
  globalThis.Image = RealImage;
  Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
});

describe("keepSheetBanners", () => {
  it("demande tout de suite tous les visuels de la bannière, à l'adresse de la fiche, une fois", () => {
    keepSheetBanners("films", ["https://img.test/a.jpg", "https://img.test/b.jpg", "", null]);
    keepSheetBanners("films", ["https://img.test/a.jpg", "https://img.test/b.jpg"]);
    expect(requested).toEqual(["https://img.test/a.jpg", "https://img.test/b.jpg"]);
    expect(prefetchBannersForTests.kept()).toEqual(["https://img.test/a.jpg", "https://img.test/b.jpg"]);
  });

  it("une liste qui change : rend ceux qui en sortent, demande les nouveaux aussitôt", () => {
    keepSheetBanners("films", ["https://img.test/a.jpg", "https://img.test/b.jpg"]);
    keepSheetBanners("films", ["https://img.test/b.jpg", "https://img.test/c.jpg"]);
    expect(requested).toEqual(["https://img.test/a.jpg", "https://img.test/b.jpg", "https://img.test/c.jpg"]);
    expect(prefetchBannersForTests.kept().sort()).toEqual(["https://img.test/b.jpg", "https://img.test/c.jpg"]);
  });

  it("un film démarre : ce qui se télécharge encore est abandonné, ce qui est décodé reste gardé", () => {
    keepSheetBanners("films", ["https://img.test/a.jpg", "https://img.test/b.jpg"]);
    loaded.add("https://img.test/a.jpg");
    suspendSheetBanners("films");
    expect(aborted).toEqual(["https://img.test/b.jpg"]);
    expect(prefetchBannersForTests.kept()).toEqual(["https://img.test/a.jpg"]);
    // De retour : seul le visuel abandonné est redemandé.
    keepSheetBanners("films", ["https://img.test/a.jpg", "https://img.test/b.jpg"]);
    expect(requested.filter((u) => u.endsWith("b.jpg"))).toHaveLength(2);
    expect(requested.filter((u) => u.endsWith("a.jpg"))).toHaveLength(1);
  });

  it("la bannière d'un autre onglet, suspendue, n'abandonne pas les visuels de celle qui est à l'écran", () => {
    keepSheetBanners("films", ["https://img.test/a.jpg"]);
    suspendSheetBanners("series");
    expect(aborted).toEqual([]);
    expect(prefetchBannersForTests.kept()).toEqual(["https://img.test/a.jpg"]);
  });

  it("la bannière démontée rend ses visuels", () => {
    keepSheetBanners("films", ["https://img.test/a.jpg"]);
    releaseSheetBanners("films");
    expect(prefetchBannersForTests.kept()).toEqual([]);
  });

  it("rien sur une connexion qui demande l'économie de données", () => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
    keepSheetBanners("films", ["https://img.test/a.jpg"]);
    prefetchSheetBannerNow("https://img.test/b.jpg");
    expect(requested).toEqual([]);
  });
});

describe("prefetchSheetBannerNow", () => {
  it("à l'appui : une fois, et pas ce que la bannière garde déjà", () => {
    keepSheetBanners("films", ["https://img.test/a.jpg"]);
    prefetchSheetBannerNow("https://img.test/a.jpg");
    prefetchSheetBannerNow("https://img.test/b.jpg");
    prefetchSheetBannerNow("https://img.test/b.jpg");
    expect(requested).toEqual(["https://img.test/a.jpg", "https://img.test/b.jpg"]);
  });
});
