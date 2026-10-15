// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { knownLogoRatio, prefetchLogo } from "@/lib/logoRatios";

/**
 * Le logo d'une fiche, téléchargé dès l'appui et sa forme notée à l'arrivée (15/10/2026) : la fiche
 * qui s'ouvre ensuite le montre d'emblée, au lieu de le cacher le temps de le mesurer elle-même.
 */
describe("prefetchLogo", () => {
  afterEach(() => vi.restoreAllMocks());

  /** jsdom ne charge pas d'image : on retient celle créée et on joue son chargement à la main. */
  function capture() {
    const made: HTMLImageElement[] = [];
    vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function (this: HTMLImageElement) {
      made.push(this);
    });
    return made;
  }

  it("la forme du logo est connue dès qu'il arrive, avant que la fiche ne le monte", () => {
    const made = capture();
    prefetchLogo("https://image.tmdb.org/t/p/w500/a.png");
    expect(made).toHaveLength(1);
    expect(knownLogoRatio("https://image.tmdb.org/t/p/w500/a.png")).toBeNull();
    vi.spyOn(made[0], "naturalWidth", "get").mockReturnValue(400);
    vi.spyOn(made[0], "naturalHeight", "get").mockReturnValue(100);
    made[0].onload?.(new Event("load"));
    expect(knownLogoRatio("https://image.tmdb.org/t/p/w500/a.png")).toBe(4);
  });

  it("un logo déjà mesuré n'est pas redemandé", () => {
    const made = capture();
    prefetchLogo("https://image.tmdb.org/t/p/w500/a.png");
    expect(made).toHaveLength(0);
  });

  it("une image sans hauteur (échec) ne note rien", () => {
    const made = capture();
    prefetchLogo("https://image.tmdb.org/t/p/w500/b.png");
    vi.spyOn(made[0], "naturalHeight", "get").mockReturnValue(0);
    made[0].onload?.(new Event("load"));
    expect(knownLogoRatio("https://image.tmdb.org/t/p/w500/b.png")).toBeNull();
  });
});
