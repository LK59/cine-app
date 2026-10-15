// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { revealChosen } from "@/components/player/LiquidMenu";

/**
 * La ligne retenue d'un menu du lecteur amenée dans son cadre (passe de nuit du 15/10/2026,
 * LECTEUR-15). jsdom ne met rien en page : la liste et ses lignes sont mesurées à la main — une
 * liste de 280 px, des lignes de 48, posée à 100 px du haut, éventuellement agrandie par une
 * transformation (`scale`) comme pendant le geste liquide.
 */
function menu(rows: number, chosen: number | null, scale = 1) {
  const list = document.createElement("div");
  for (let i = 0; i < rows; i++) {
    const b = document.createElement("button");
    if (i === chosen) {
      const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      mark.setAttribute("data-option-on", "");
      b.append(mark);
    }
    list.append(b);
  }
  Object.defineProperty(list, "scrollHeight", { value: rows * 48 });
  Object.defineProperty(list, "clientHeight", { value: 280 });
  Object.defineProperty(list, "offsetHeight", { value: 280 });
  const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  list.getBoundingClientRect = () => rect(100, 280 * scale);
  Array.from(list.children).forEach((b, i) => {
    (b as HTMLElement).getBoundingClientRect = () => rect(100 + (i * 48 - list.scrollTop) * scale, 48 * scale);
  });
  return list;
}

describe("revealChosen — la ligne retenue dans le cadre", () => {
  it("fait défiler au plus près une ligne sous le bas du cadre", () => {
    const list = menu(8, 6);
    revealChosen(list);
    expect(list.scrollTop).toBe(7 * 48 - 280);
  });

  it("ramène une ligne restée au-dessus du haut du cadre", () => {
    const list = menu(12, 1);
    list.scrollTop = 200;
    revealChosen(list);
    expect(list.scrollTop).toBe(48);
  });

  it("ne bouge rien quand elle est déjà visible, ni quand rien n'est retenu", () => {
    const visible = menu(8, 2);
    revealChosen(visible);
    expect(visible.scrollTop).toBe(0);
    const none = menu(8, null);
    revealChosen(none);
    expect(none.scrollTop).toBe(0);
  });

  it("mesure en mise en page sous une transformation", () => {
    const list = menu(8, 6, 1.05);
    revealChosen(list);
    expect(list.scrollTop).toBeCloseTo(7 * 48 - 280, 5);
  });
});
