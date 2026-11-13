// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SubtitleLayer } from "@/components/player/SubtitleLayer";
import { DEFAULT_SUBTITLE_STYLE } from "@/lib/subtitleStyle";

// 13/11/2026, *Mr. Robot* sur l'iPhone couché : une réplique de deux lignes sur trois, dans une colonne d'un huitième de
// l'écran — la ligne s'ajustait à son texte. Elle prend désormais la largeur de sa rangée ; la boîte est sur le texte.
describe("une ligne de sous-titres", () => {
  it("à la largeur de sa rangée, sans fond sur la ligne elle-même", () => {
    const { container } = render(<SubtitleLayer primary={"Elliot, si on ne peut pas\nparler de ça..."} style={DEFAULT_SUBTITLE_STYLE} chromeEdges={null} />);
    const line = container.querySelector("p")!;
    expect(line.className).toContain("w-full");
    expect(line.style.fontSize).not.toBe("");
    expect(line.textContent).toBe("Elliot, si on ne peut pas\nparler de ça...");
  });

  it("le fond « boîte » est porté par le texte, ligne par ligne — jamais par toute la largeur", () => {
    const { container } = render(<SubtitleLayer primary="Réplique." style={{ ...DEFAULT_SUBTITLE_STYLE, background: "box" }} chromeEdges={null} />);
    const line = container.querySelector("p")!;
    expect(line.style.backgroundColor).toBe("");
    const text = line.querySelector("span")!;
    expect(text.style.backgroundColor).not.toBe("");
    expect(text.style.padding).not.toBe("");
  });

  it("à deux sous-titres aussi", () => {
    const { container } = render(<SubtitleLayer dual primary="Bonjour." second="Hello." style={{ ...DEFAULT_SUBTITLE_STYLE, background: "box" }} chromeEdges={null} />);
    const lines = [...container.querySelectorAll("p")];
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.className).toContain("w-full");
      expect(line.style.backgroundColor).toBe("");
      expect(line.querySelector("span")!.style.backgroundColor).not.toBe("");
    }
  });
});
