// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));

import { HeroOverview } from "@/components/cinema/CinemaHero";

/**
 * Le synopsis de la bannière du bureau s'arrête sur une phrase entière, et ne retombe sur un
 * fondu vers la droite que si même la première déborde (23/09/2026). jsdom ne met rien en page :
 * la sonde mesure 20 px par tranche de 40 caractères, dans un paragraphe de 20 px d'interligne.
 */
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.dataset.heroProbe !== undefined ? Math.ceil((this.textContent?.length ?? 0) / 40) * 20 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 500 });
  const real = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
    const style = real(el);
    return (el as HTMLElement).dataset?.heroOverview !== undefined ? ({ ...style, lineHeight: "20px" } as CSSStyleDeclaration) : style;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const overview = (text: string) => <HeroOverview info={{ tmdb: { overview: text } }} fallback={null} />;
const box = () => document.querySelector<HTMLElement>("p[data-hero-overview]")!;
const shown = () => box().querySelector("span:not([data-hero-probe])")?.textContent;

describe("HeroOverview — la troncature", () => {
  it("s'arrête sur la dernière phrase entière qui tient dans deux lignes", () => {
    // 36 + 1 + 41 = 78 caractères : deux lignes. La troisième phrase n'y tient plus.
    render(overview("Un ancien Marine rentre à la maison. Son père accepte enfin de le ré-entraîner. Le tournoi approche."));
    expect(shown()).toBe("Un ancien Marine rentre à la maison. Son père accepte enfin de le ré-entraîner.");
    expect(box().className).not.toContain("clamp-fade-end-2");
  });

  it("affiche tout quand tout tient", () => {
    render(overview("Court et complet. Rien à couper."));
    expect(shown()).toBe("Court et complet. Rien à couper.");
  });

  it("retombe sur le fondu vers la droite quand la première phrase déborde", () => {
    const long = "Une seule phrase interminable qui ne s'arrête jamais et déborde largement des deux lignes prévues pour elle.";
    render(overview(long));
    expect(shown()).toBe(long);
    expect(box().className).toContain("clamp-fade-end-2");
  });

  it("ne laisse rien dans la sonde", () => {
    render(overview("Un ancien Marine rentre à la maison. Son père accepte enfin de le ré-entraîner. Le tournoi approche."));
    expect(box().querySelector("[data-hero-probe]")?.textContent).toBe("");
  });
});
