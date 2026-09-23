import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ROTATE_MS } from "@/lib/useRotatingIndex";

/**
 * La barre de progression des bannières dure exactement l'intervalle de rotation. Elle est écrite
 * en CSS, la rotation en JavaScript : les deux doivent dire la même chose, et la barre s'étire au
 * lieu de s'élargir (23/09/2026 — `width` animée recalculait la mise en page à chaque image).
 */
const css = fs.readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");

describe("la barre de progression des bannières", () => {
  it("dure l'intervalle de rotation", () => {
    const seconds = Number(/--animate-hero-fill: hero-fill (\d+(?:\.\d+)?)s/.exec(css)?.[1]);
    expect(seconds * 1000).toBe(ROTATE_MS);
  });

  it("s'étire par une échelle, sans toucher à la mise en page", () => {
    const frames = /@keyframes hero-fill \{[\s\S]*?\n {2}\}/.exec(css)?.[0] ?? "";
    expect(frames).toContain("scaleX(0)");
    expect(frames).not.toMatch(/width:/);
  });
});

describe("ce qui coûtait sans rien montrer", () => {
  // 23/09/2026 : la classe d'entrée des fiches du téléphone reste posée toute leur vie, et son
  // `will-change` gardait un calque plein écran en mémoire — deux quand les fiches s'empilent.
  it("l'entrée des fiches ne promeut pas leur calque pour toujours", () => {
    const entry = /@utility sheet-in \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(entry).toContain("animation: sheet-in");
    expect(entry).not.toContain("will-change");
  });

  // `transition-all` animait tout ce qui change, marges et tailles comprises.
  it("aucun transition-all dans le cinéma", () => {
    const dir = path.resolve(__dirname, "../components/cinema");
    const offenders = fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
      .map((e) => path.join(e.parentPath, e.name))
      // Une classe, pas une mention entre accents graves dans un commentaire.
      .filter((f) => /(^|[\s"'])transition-all(?=[\s"'`])/m.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
