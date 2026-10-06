import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";

/**
 * Une grille de l'activité qui n'a de colonnes qu'à partir d'une largeur (`sm:grid-cols-2`…) laisse
 * le téléphone sur une colonne implicite, dimensionnée sur le plus long contenu d'une ligne : le
 * 06/10/2026, un titre d'épisode faisait déborder toutes les cartes « En direct ». Chaque grille
 * nomme donc aussi sa colonne de base (`grid-cols-1` = minmax(0, 1fr)).
 */
const dirs = ["src/components/activity", "src/components/activity/views"];

describe("les grilles de l'activité", () => {
  it("ont toutes une colonne de base, bornée à l'écran", () => {
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
        const src = readFileSync(`${dir}/${f}`, "utf8");
        for (const m of src.matchAll(/className="([^"]*\bgrid\b[^"]*)"/g)) {
          const cls = m[1].split(/\s+/);
          const responsive = cls.some((c) => /^(sm|md|lg|xl|2xl):grid-cols-/.test(c));
          const base = cls.some((c) => /^grid-cols-/.test(c));
          if (responsive && !base) offenders.push(`${f}: ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
