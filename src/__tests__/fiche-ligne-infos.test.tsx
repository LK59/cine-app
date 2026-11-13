// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { DottedFacts } from "@/components/cinema/CinemaDetailExtras";

/**
 * La ligne d'infos sous le logo (relecture des fiches par le propriétaire, 13/11/2026) : au téléphone, un
 * « · » entre chaque élément — « 2015 [IMDb 8.5] 4 saisons 50min/ép. » se lisait d'un seul tenant —, et
 * « 4 saisons » au bureau aussi, à la même place, par la même règle.
 */

afterEach(() => cleanup());

/** Le texte lu, les points compris. */
const line = (el: Element) => Array.from(el.children).map((c) => c.textContent).join(" ");

describe("DottedFacts", () => {
  it("un point entre chaque élément présent, ni en tête, ni en queue, ni doublé", () => {
    const { container } = render(
      <DottedFacts>
        <span>2015</span>
        {false}
        <span>4 saisons</span>
        {null}
        <span>50 min/ép.</span>
        {undefined}
      </DottedFacts>
    );
    expect(line(container.firstElementChild!)).toBe("2015 · 4 saisons · 50 min/ép.");
    expect(container.querySelectorAll("[data-fact-dot]")).toHaveLength(2);
    for (const dot of container.querySelectorAll("[data-fact-dot]")) expect(dot.getAttribute("aria-hidden")).toBe("true");
  });

  it("un seul élément : aucun point", () => {
    const { container } = render(
      <DottedFacts>
        <span>2015</span>
      </DottedFacts>
    );
    expect(container.querySelectorAll("[data-fact-dot]")).toHaveLength(0);
  });
});

/** Le code sans ses commentaires — ce qu'il fait, pas ce qu'il raconte. */
const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("les deux fiches de série disent « 4 saisons » par la même règle", () => {
  it.each(["src/components/cinema/mobile/CinemaMobileDetail.tsx", "src/components/cinema/CinemaSeriesDetail.tsx"])("%s", (f) => {
    const src = code(f);
    expect(src).toMatch(/sheetSeasonCount\(/);
    expect(src).toContain('t("cinema.seasonCount", { n: seasonCount })');
  });

  it("au bureau, avant la durée d'un épisode — comme au téléphone", () => {
    for (const f of ["src/components/cinema/mobile/CinemaMobileDetail.tsx", "src/components/cinema/CinemaSeriesDetail.tsx"]) {
      const src = code(f);
      const seasons = src.indexOf('t("cinema.seasonCount"');
      const runtime = src.indexOf("runtimeLabel(", seasons);
      const imdb = src.indexOf("<ImdbBadge");
      expect([f, imdb > 0 && imdb < seasons && seasons < runtime]).toEqual([f, true]);
    }
  });

  it("les trois fiches séparent leur ligne d'infos par `DottedFacts`, les genres sur leur propre ligne dessous", () => {
    for (const file of ["src/components/cinema/mobile/CinemaMobileDetail.tsx", "src/components/cinema/CinemaMovieDetail.tsx", "src/components/cinema/CinemaSeriesDetail.tsx"]) {
      const src = code(file);
      expect(src, file).toMatch(/<DottedFacts className="flex flex-wrap/);
      // Les genres après la fin de la rangée à points, jamais dedans : sinon un « · » orphelin au bout de la ligne.
      const row = src.slice(src.indexOf("<DottedFacts"), src.indexOf("</DottedFacts>"));
      expect(row, file).not.toMatch(/item\.genres/);
    }
  });
});
