// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// CHASSE AUX BUGS zone 4 — copie du montage de prefetchBanners.test.ts.
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

describe("keepSheetBanners après une suspension (un film)", () => {
  it("la bannière revient avec une autre liste : les visuels de l'ancienne, décodés, sont rendus", () => {
    // Bannière des reprises au lancement, visuels décodés.
    keepSheetBanners("films", ["https://img.test/a.jpg", "https://img.test/b.jpg"]);
    loaded = new Set(["https://img.test/a.jpg", "https://img.test/b.jpg"]);
    // Un film démarre : suspendue, les décodés restent gardés (voulu).
    suspendSheetBanners("films");
    // Après le film, la bannière des reprises a changé (le film regardé en sort, un autre y entre).
    keepSheetBanners("films", ["https://img.test/c.jpg", "https://img.test/d.jpg"]);
    // Attendu (« une liste qui change rend ceux qui en sortent ») : seuls c et d restent gardés.
    // Constaté : a et b restent référencés pour toujours — `before` a été effacé par la suspension,
    // plus rien ne les rend. Un film = jusqu'à dix visuels 1280 px décodés de plus sur un iPhone.
    expect(prefetchBannersForTests.kept().sort()).toEqual(["https://img.test/c.jpg", "https://img.test/d.jpg"]);
  });
});
