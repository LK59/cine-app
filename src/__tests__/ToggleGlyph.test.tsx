// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ToggleGlyph } from "@/components/ToggleGlyph";

/**
 * L'icône d'un bouton à deux états confirme le geste (23/09/2026) — et seulement le geste :
 * ouvrir une fiche sur un film déjà vu n'anime rien.
 */
afterEach(cleanup);

const glyph = (on: boolean) => <ToggleGlyph on={on} onIcon={<svg data-on />} offIcon={<svg data-off />} />;
const span = () => document.querySelector<HTMLElement>("[data-toggle-glyph]")!;

describe("ToggleGlyph", () => {
  it.each([true, false])("n'anime rien à l'ouverture (état %s)", (on) => {
    render(glyph(on));
    expect(span().className).not.toMatch(/toggle-(on|off)/);
    expect(document.querySelector(on ? "[data-on]" : "[data-off]")).not.toBeNull();
  });

  it("rebondit et se dessine en passant à l'état actif", () => {
    const { rerender } = render(glyph(false));
    rerender(glyph(true));
    expect(span().className).toContain("toggle-on");
    expect(span().dataset.toggleGlyph).toBe("on");
    expect(document.querySelector("[data-on]")).not.toBeNull();
  });

  it("se repose simplement en revenant au repos, et repart à chaque changement", () => {
    const { rerender } = render(glyph(false));
    rerender(glyph(true));
    const first = span();
    rerender(glyph(false));
    expect(span().className).toContain("toggle-off");
    expect(span()).not.toBe(first);
  });
});

describe("les boutons à deux états passent tous par ToggleGlyph", () => {
  it.each([
    "src/components/cinema/CinemaMovieDetail.tsx",
    "src/components/cinema/CinemaSeriesDetail.tsx",
    "src/components/cinema/mobile/CinemaMobileDetail.tsx",
    "src/components/player/PlayerDiscoverSheet.tsx",
    "src/components/player/PlayerListAdd.tsx",
    "src/components/WatchlistButton.tsx",
  ])("%s", async (f) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8");
    expect(src).toContain("<ToggleGlyph on={");
    expect(src).not.toMatch(/\{(inList|watched|done) \? <(BookmarkCheck|CircleCheck|Check)\b/);
  });
});
