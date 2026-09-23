import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Les polices viennent du dépôt depuis le 23/09/2026 : `next/font/google` les téléchargeait à
// chaque construction, seul accès réseau de `npm run build`, et une publication a échoué dessus.
const ROOT = path.resolve(__dirname, "..");
const FONTS = path.join(ROOT, "app", "fonts");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sources(full);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [full] : [];
  });
}

describe("polices servies depuis le dépôt", () => {
  it("aucune ne se télécharge plus à la construction", () => {
    const offenders = sources(ROOT).filter((file) => /from\s+["']next\/font\/google["']|@import[^;]*fonts\.googleapis/.test(fs.readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("chaque fichier que la feuille désigne existe, et chaque fichier présent est désigné", () => {
    const css = fs.readFileSync(path.join(FONTS, "fonts.css"), "utf8");
    const named = [...css.matchAll(/url\("\.\/([^"]+)"\)/g)].map((m) => m[1]).sort();
    const present = fs.readdirSync(FONTS).filter((f) => f.endsWith(".woff2")).sort();
    expect(named).toEqual(present);
  });

  it("pose les deux variables que l'interface emploie", () => {
    const css = fs.readFileSync(path.join(FONTS, "fonts.css"), "utf8");
    expect(css).toMatch(/--font-sans:\s*"Inter", "Inter Fallback"/);
    expect(css).toMatch(/--font-display:\s*"Bricolage Grotesque", "Bricolage Grotesque Fallback"/);
    // Les polices de repli aux mesures ajustées : sans elles, le texte bouge quand la police arrive.
    expect(css).toMatch(/font-family:Inter Fallback;[^}]*size-adjust/);
    expect(css).toMatch(/font-family:Bricolage Grotesque Fallback;[^}]*size-adjust/);
  });

  it("porte les licences", () => {
    for (const file of ["OFL-Inter.txt", "OFL-BricolageGrotesque.txt"]) {
      expect(fs.readFileSync(path.join(FONTS, file), "utf8")).toMatch(/SIL Open Font License, Version 1\.1/);
    }
  });
});
