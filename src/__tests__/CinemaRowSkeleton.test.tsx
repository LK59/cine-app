// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CinemaSkeletonCards, isRowPending } from "@/components/cinema/CinemaRowSkeleton";

// « Reprendre » et « Ma liste » tiennent leur place pendant qu'elles arrivent (21/09/2026) :
// jamais gardées sur l'appareil, donc jamais périmées, sans faire sauter l'écran.
afterEach(cleanup);

describe("CinemaSkeletonCards", () => {
  it("tient la place d'une rangée, sans rien offrir au clavier ni au lecteur d'écran", () => {
    const { container } = render(<CinemaSkeletonCards cardClassName="w-28" shape="poster" count={4} />);
    const cards = container.querySelectorAll("[data-row-skeleton]");
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card.getAttribute("aria-hidden")).toBe("true");
      expect(card.className).toContain("aspect-2/3");
      expect(card.tagName).toBe("DIV");
    }
  });

  it("prend la forme d'une image de reprise pour « Reprendre »", () => {
    const { container } = render(<CinemaSkeletonCards cardClassName="w-44" shape="still" />);
    expect(container.querySelector("[data-row-skeleton]")!.className).toContain("aspect-video");
  });
});

describe("isRowPending", () => {
  it("attend tant qu'il n'y a ni réponse ni erreur", () => {
    expect(isRowPending(undefined, undefined)).toBe(true);
    expect(isRowPending({ items: [] }, undefined)).toBe(false);
    // Une erreur rend la place au lieu de la tenir pour toujours.
    expect(isRowPending(undefined, new Error("réseau"))).toBe(false);
  });
});
