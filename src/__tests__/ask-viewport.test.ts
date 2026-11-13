import { describe, it, expect } from "vitest";
import { askPanelLayout, visibleArea } from "@/lib/ask/viewport";

// 13/11/2026 : l'iPhone de Louis, couché dans l'application installée, mesurait sa vue visuelle 932 × 0 — le panneau
// d'une personne s'ouvrait haut de 0. Une vue vide n'est pas une mesure : la fenêtre la remplace.
describe("la vue visible du panneau", () => {
  const win = { innerWidth: 932, innerHeight: 430 };

  it("une vue visuelle vide (932 × 0, relevé de l'iPhone) : la fenêtre entière", () => {
    expect(visibleArea({ width: 932, height: 0, offsetTop: 0, scale: 1 }, win)).toEqual({ width: 932, height: 430, offsetTop: 0, scale: 1 });
    expect(visibleArea({ width: 0, height: 430, offsetTop: 0, scale: 1 }, win)).toEqual({ width: 932, height: 430, offsetTop: 0, scale: 1 });
    expect(visibleArea(null, win)).toEqual({ width: 932, height: 430, offsetTop: 0, scale: 1 });
  });

  it("une vue visuelle mesurée (le clavier, le zoom) reste la référence", () => {
    expect(visibleArea({ width: 932, height: 210, offsetTop: 12, scale: 1 }, win)).toEqual({ width: 932, height: 210, offsetTop: 12, scale: 1 });
  });

  it("le panneau sur le côté, couché : toute la hauteur moins ses marges — plus jamais 0", () => {
    const area = visibleArea({ width: 932, height: 0, offsetTop: 0, scale: 1 }, win);
    const layout = askPanelLayout({ ...area, baseline: area.height, focused: false, layoutHeight: 430, layerTop: 0, context: "player" });
    expect(layout).toMatchObject({ mode: "full", sheet: false });
    expect(layout.mode === "full" ? layout.height : 0).toBe(406);
  });
});
