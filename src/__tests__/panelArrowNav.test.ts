import { describe, it, expect } from "vitest";
import { chooseNext, type NavRect } from "@/lib/panelArrowNav";

/** Une grille de trois colonnes : cartes de 100×150, dix pixels de gouttière. */
function grid(count: number, columns = 3): NavRect[] {
  return Array.from({ length: count }, (_, i) => ({
    left: (i % columns) * 110,
    top: Math.floor(i / columns) * 160,
    width: 100,
    height: 150,
  }));
}

describe("chooseNext", () => {
  it("walks a row left and right", () => {
    const rects = grid(6);
    expect(chooseNext(rects, 0, "ArrowRight")).toBe(1);
    expect(chooseNext(rects, 1, "ArrowLeft")).toBe(0);
  });

  // Arriver au bout d'une ligne doit rendre la touche à la page — pour sortir vers le rail à
  // gauche, par exemple — et non repartir à l'autre bout de la rangée suivante.
  it("hands the key back at the end of a row instead of wrapping", () => {
    const rects = grid(6);
    expect(chooseNext(rects, 2, "ArrowRight")).toBeNull();
    expect(chooseNext(rects, 3, "ArrowLeft")).toBeNull();
  });

  it("moves between rows, keeping the column", () => {
    const rects = grid(9);
    expect(chooseNext(rects, 1, "ArrowDown")).toBe(4);
    expect(chooseNext(rects, 7, "ArrowUp")).toBe(4);
  });

  // Le cas qui casse une navigation naïve : une dernière rangée incomplète. Descendre depuis la
  // troisième colonne doit atterrir sur ce qui existe, pas dans le vide.
  it("lands on the nearest card when the row below is shorter", () => {
    const rects = grid(5);
    expect(chooseNext(rects, 2, "ArrowDown")).toBe(4);
  });

  // Et jamais deux rangées plus bas, même si l'alignement y est meilleur.
  it("never skips a row to find a better alignment", () => {
    const rects: NavRect[] = [
      { left: 0, top: 0, width: 100, height: 150 },
      { left: 300, top: 160, width: 100, height: 150 },
      { left: 0, top: 320, width: 100, height: 150 },
    ];
    expect(chooseNext(rects, 0, "ArrowDown")).toBe(1);
  });

  // Deux cartes d'une même rangée diffèrent de quelques pixels dès qu'un titre passe sur deux
  // lignes : une comparaison stricte du haut les séparerait.
  it("treats slightly misaligned cards as one row", () => {
    const rects: NavRect[] = [
      { left: 0, top: 0, width: 100, height: 150 },
      { left: 110, top: 4, width: 100, height: 146 },
    ];
    expect(chooseNext(rects, 0, "ArrowRight")).toBe(1);
    expect(chooseNext(rects, 0, "ArrowDown")).toBeNull();
  });

  it("enters the grid on the first item when nothing is focused", () => {
    const rects = grid(6);
    expect(chooseNext(rects, -1, "ArrowDown")).toBe(0);
    expect(chooseNext(rects, -1, "ArrowRight")).toBe(0);
    // Vers le haut ou la gauche, il n'y a rien à entrer : la touche reste à la page.
    expect(chooseNext(rects, -1, "ArrowUp")).toBeNull();
  });

  it("stops at the edges", () => {
    const rects = grid(6);
    expect(chooseNext(rects, 0, "ArrowUp")).toBeNull();
    expect(chooseNext(rects, 4, "ArrowDown")).toBeNull();
    expect(chooseNext([], 0, "ArrowDown")).toBeNull();
  });

  // Une liste d'une colonne est une grille comme une autre : le haut et le bas la parcourent,
  // la gauche et la droite n'y font rien.
  it("walks a single-column list", () => {
    const rects = grid(4, 1);
    expect(chooseNext(rects, 1, "ArrowDown")).toBe(2);
    expect(chooseNext(rects, 1, "ArrowUp")).toBe(0);
    expect(chooseNext(rects, 1, "ArrowRight")).toBeNull();
  });
});
