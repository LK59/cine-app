import { describe, it, expect } from "vitest";
import { BANNER_WIDTH, bannerImage, variantPath } from "@/lib/optimizedImage";
import { logoForLocale, logoForScreen, type TitleArt } from "@/lib/title-art";

/**
 * La bannière et les logos en WebP par l'optimiseur (27/10/2026) : une adresse écrite à la main, qui
 * doit être exactement celle que l'optimiseur range et que le préchauffage prépare.
 */
describe("bannerImage", () => {
  it("passe une image TMDB par l'optimiseur, à la largeur demandée", () => {
    const url = "https://image.tmdb.org/t/p/w500/logo.png";
    expect(bannerImage(url, BANNER_WIDTH)).toBe(`/_next/image?url=${encodeURIComponent(url)}&w=640&q=75`);
    expect(bannerImage(url, BANNER_WIDTH)).toBe(variantPath(url, BANNER_WIDTH));
  });

  it("laisse un SVG, une image Jellyfin et l'absence telles quelles", () => {
    expect(bannerImage("https://image.tmdb.org/t/p/w500/logo.svg", BANNER_WIDTH)).toBe("https://image.tmdb.org/t/p/w500/logo.svg");
    expect(bannerImage("/api/jellyfin/image?itemId=a&kind=logo", BANNER_WIDTH)).toBe("/api/jellyfin/image?itemId=a&kind=logo");
    expect(bannerImage(null, BANNER_WIDTH)).toBeNull();
    expect(bannerImage("", BANNER_WIDTH)).toBeNull();
  });
});

describe("logoForScreen", () => {
  it("rend le logo de `logoForLocale`, converti", () => {
    const art: TitleArt = {
      logoUrl: "https://image.tmdb.org/t/p/w500/en.png",
      posterTextlessUrl: null,
      posterByLang: {},
      logosByLang: { fr: "https://image.tmdb.org/t/p/w500/fr.png", en: "https://image.tmdb.org/t/p/w500/en.png" },
    };
    const names = { fr: "Le titre", original: "The Title", originalLanguage: "en" };
    const raw = logoForLocale(art, names, "fr");
    expect(raw).toBe("https://image.tmdb.org/t/p/w500/fr.png");
    expect(logoForScreen(art, names, "fr")).toBe(variantPath(raw!, BANNER_WIDTH));
  });

  it("rend null sans logo", () => {
    expect(logoForScreen({ logoUrl: null, posterTextlessUrl: null, posterByLang: {} }, {}, "fr")).toBeNull();
  });
});
