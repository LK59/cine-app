// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { useMeasuredCardHeight } from "@/lib/useMeasuredCardHeight";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { PlayerResultCard } from "@/components/player/PlayerResultCard";

/**
 * Le saut de « Tous les films » en remontant (13/10/2026). Mesuré dans WebKit (Playwright,
 * 390 × 844, lancer pendant la construction de la grille, remontée lente, trois passages) :
 * avant, 4 à 14 rangées jamais rendues se tassaient de 5 ou 22 px en entrant dans le champ — leurs
 * cartes mesuraient 206 ou 223 px, la feuille de style en supposait 228 ; après, cartes d'une seule
 * hauteur (224,75 px) supposées à leur mesure : 0 saut. Les séries (170 titres, grille construite
 * en 11 à 29 ms au lieu de 64 à 382) n'avaient aucune rangée jamais rendue, donc aucun saut.
 */
let observed: Element[] = [];
let callback: (() => void) | null = null;
class FakeResizeObserver {
  constructor(cb: () => void) {
    callback = cb;
  }
  observe(el: Element) { observed.push(el); }
  disconnect() { observed = []; }
}

function Grille({ n }: { n: number }) {
  const grid = useRef<HTMLDivElement>(null);
  useMeasuredCardHeight(grid, n);
  return (
    <div ref={grid} className="player-grid">
      {Array.from({ length: n }, (_, i) => (
        <button key={i} data-testid={`card${i}`} style={{ padding: "6px", border: "0" }} />
      ))}
    </div>
  );
}

describe("useMeasuredCardHeight", () => {
  beforeEach(() => {
    observed = [];
    callback = null;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pose la hauteur de contenu de la première carte comme hauteur supposée, et la suit", () => {
    let height = 236.75;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ height, width: 109, top: 0, left: 0, right: 109, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    );
    const { container } = render(<Grille n={5} />);
    const grid = container.querySelector(".player-grid") as HTMLElement;
    // 236,75 − 2 × 6 de marge intérieure (`grid-hover-zoom`) : la boîte que décrit `contain-intrinsic-size`.
    expect(grid.style.getPropertyValue("--card-h")).toBe("224.75px");
    expect(grid.hasAttribute("data-card-h")).toBe(true);
    expect(observed).toEqual([grid.firstElementChild]);
    // L'écran tourne : les colonnes s'élargissent, la carte aussi.
    height = 300;
    callback?.();
    expect(grid.style.getPropertyValue("--card-h")).toBe("288px");
  });

  // La première carte revient dans le champ à chaque remontée : réécrire la même valeur faisait
  // recalculer le style des huit cents cartes au moment où la rangée des filtres reparaît.
  it("n'écrit rien sur la grille quand la hauteur n'a pas changé", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ height: 236.75, width: 109, top: 0, left: 0, right: 109, bottom: 236.75, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    );
    const { container } = render(<Grille n={5} />);
    const grid = container.querySelector(".player-grid") as HTMLElement;
    const setProperty = vi.spyOn(grid.style, "setProperty");
    const setAttribute = vi.spyOn(grid, "setAttribute");
    callback?.();
    callback?.();
    expect(setProperty).not.toHaveBeenCalled();
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it("ne pose rien tant que la carte n'a pas de hauteur", () => {
    const { container } = render(<Grille n={3} />);
    const grid = container.querySelector(".player-grid") as HTMLElement;
    expect(grid.hasAttribute("data-card-h")).toBe(false);
  });
});

describe("PlayerResultCard uniforme", () => {
  afterEach(cleanup);
  it("réserve deux lignes de titre et la ligne de l'année, même absente", () => {
    const { container } = render(<PlayerResultCard kind="movie" title="Up" subtitle={null} poster={null} uniform />);
    const lines = container.querySelectorAll("p");
    expect(lines).toHaveLength(2);
    expect(lines[0].className).toContain("min-h-[2.75em]");
    expect(lines[1].getAttribute("aria-hidden")).not.toBeNull();
  });
  it("ailleurs, la carte garde sa hauteur naturelle", () => {
    const { container } = render(<PlayerResultCard kind="movie" title="Up" subtitle={null} poster={null} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("p")?.className).not.toContain("min-h-");
  });
});

describe("la grille complète branche les deux moitiés", () => {
  it("cartes uniformes, hauteur mesurée, et la règle qui la lit", () => {
    const sheet = readFileSync("src/components/cinema/CinemaBrowseSheet.tsx", "utf8");
    expect(sheet).toMatch(/useMeasuredCardHeight\(gridRef, grid\)/);
    expect(sheet).toMatch(/^\s*uniform$/m);
    const css = readFileSync("src/app/globals.css", "utf8");
    // Depuis le découpage en paquets (13/10/2026), la hauteur mesurée sert aux paquets — leurs rangées
    // fois une carte — et à leurs cartes.
    expect(css).toMatch(/\.grid-chunk \{[^}]*contain-intrinsic-size: auto calc\(var\(--rows, 8\) \* var\(--card-h, var\(--card-h-guess\)\)/);
    expect(css).toMatch(/\.grid-chunk > \* \{[^}]*contain-intrinsic-size: auto var\(--card-h, var\(--card-h-guess\)\);/);
  });
});
