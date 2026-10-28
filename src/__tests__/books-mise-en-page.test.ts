import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { paginatorColumns, MARGIN_LAYOUT, LAYOUTS, type ReaderMargin } from "@/lib/books/readerPrefs";
import { duplicateKey } from "@/lib/books/metadata";

/**
 * Trois retours d'un iPhone (29/10/2026, DECISIONS.md §127) que le banc en vrai navigateur a reproduits :
 * le retournement 3D qui couchait le chapitre en colonnes d'un mot, « Deux pages » qui n'en montrait qu'une
 * sur un téléphone couché, et des doublons Stephen King que la clé ne reconnaissait pas.
 */

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

describe("les colonnes du paginateur", () => {
  // foliate-js relit `max-inline-size` par `parseFloat` : `min(680px, 520px)` donnait `NaN`, une largeur de
  // colonne invalide, et une seule page en « Deux pages ».
  it("une largeur en pixels que `parseFloat` lit, pour chaque disposition et chaque marge", () => {
    for (const layout of LAYOUTS) {
      for (const margin of Object.keys(MARGIN_LAYOUT) as ReaderMargin[]) {
        const { maxInlineSize, maxColumnCount } = paginatorColumns({ layout, margin });
        expect(maxInlineSize, `${layout}/${margin}`).toMatch(/^\d+(\.\d+)?px$/);
        expect(Number.isFinite(parseFloat(maxInlineSize))).toBe(true);
        expect(maxColumnCount).toBe(layout === "single" ? "1" : "2");
      }
    }
  });

  it("« Deux pages » borne la colonne à 520 px pour que deux tiennent sur un téléphone couché ; les autres gardent la largeur de lecture", () => {
    expect(paginatorColumns({ layout: "double", margin: "medium" }).maxInlineSize).toBe("520px");
    expect(paginatorColumns({ layout: "double", margin: "large" }).maxInlineSize).toBe("520px");
    expect(paginatorColumns({ layout: "auto", margin: "medium" }).maxInlineSize).toBe(MARGIN_LAYOUT.medium.maxInlineSize);
    expect(paginatorColumns({ layout: "single", margin: "small" }).maxInlineSize).toBe(MARGIN_LAYOUT.small.maxInlineSize);
    // foliate-js : divisor = min(colonnes, ceil(largeur / max-inline-size)). Un iPhone 15 couché : ~792 px.
    const divisor = (layout: "auto" | "single" | "double", width: number) => {
      const c = paginatorColumns({ layout, margin: "medium" });
      return Math.min(Number(c.maxColumnCount), Math.ceil(width / parseFloat(c.maxInlineSize)));
    };
    expect(divisor("double", 792)).toBe(2);
    expect(divisor("auto", 792)).toBe(2);
    expect(divisor("single", 792)).toBe(1);
    // Un iPhone SE couché (~620 px) : Auto n'en met qu'une, Deux pages en met deux.
    expect(divisor("auto", 620)).toBe(1);
    expect(divisor("double", 620)).toBe(2);
  });

  it("le lecteur passe par `paginatorColumns`, sans expression CSS dans l'attribut", () => {
    const reader = read("src/components/books/BookReader.tsx");
    expect(reader).toMatch(/const columns = paginatorColumns\(prefs\);/);
    expect(reader).not.toMatch(/max-inline-size", [^)]*min\(/);
  });
});

describe("le paginateur mesure sa boîte sans les transformations de la page", () => {
  // Pendant le retournement 3D, `rotateY` sur `<foliate-view>` : `getBoundingClientRect()` du conteneur
  // valait presque 0 px de large au moment où le chapitre suivant se mettait en colonnes.
  it("largeur, taille de page et taille de vue viennent de `layoutRect`", () => {
    const src = read("src/lib/books/foliate/paginator.js");
    expect(src).toMatch(/const layoutRect = el => \{/);
    expect(src).toMatch(/const \{ width, height \} = layoutRect\(this\.#container\)/);
    expect(src).toMatch(/return layoutRect\(this\.#container\)\[this\.sideProp\]/);
    expect(src).toMatch(/return layoutRect\(this\.#view\.element\)\[this\.sideProp\]/);
    expect(src).not.toMatch(/this\.#container\.getBoundingClientRect\(\)/);
    expect(src).not.toMatch(/this\.#view\.element\.getBoundingClientRect\(\)/);
    expect(read("src/lib/books/foliate/fixed-layout.js")).not.toMatch(/this\.getBoundingClientRect\(\)/);
  });

  it("`layoutRect` garde le rectangle dessiné quand il n'est pas transformé, la boîte de mise en page sinon", () => {
    const src = read("src/lib/books/foliate/paginator.js");
    const body = /const layoutRect = (el => \{[\s\S]*?\n\})/.exec(src)?.[1];
    expect(body).toBeTruthy();
    const layoutRect = new Function(`return (${body})`)() as (el: unknown) => { width: number; height: number };
    const el = (rect: { width: number; height: number }, offsetWidth: number, offsetHeight: number) => ({ getBoundingClientRect: () => rect, offsetWidth, offsetHeight });
    // Rien de transformé : la précision fractionnaire du rectangle.
    expect(layoutRect(el({ width: 365.5, height: 600.25 }, 366, 600))).toEqual({ width: 365.5, height: 600.25 });
    // Page de profil (rotateY(90deg)) : la boîte de mise en page.
    expect(layoutRect(el({ width: 0.000001, height: 600 }, 366, 600))).toEqual({ width: 366, height: 600 });
  });
});

describe("une copie par livre — sous-titres génériques et pluriels (Stephen King, 29/10/2026)", () => {
  const king = (name: string) => duplicateKey({ name, authors: ["Stephen King"] });
  it("les paires réelles sont reconnues", () => {
    const pairs: [string, string][] = [
      ["Bazaar", "Bazaar: roman"],
      ["Désolation", "Désolation: roman"],
      ["Roadmaster", "Roadmaster: roman"],
      ["Dreamcatcher", "Dreamcatcher: a novel"],
      ["Coeur perdu en Atlantide", "Coeurs perdus en Atlantide"],
      ["Cœurs perdus en Atlantide", "Coeurs perdus en Atlantide"],
      ["Carrie", "Carrie (poche)"],
      ["Ça", "Ça - roman"],
    ];
    for (const [a, b] of pairs) expect(king(a), `${a} / ${b}`).toBe(king(b));
  });

  it("des livres différents, une édition illustrée ou un tome restent à part", () => {
    expect(king("Brume")).not.toBe(king("Brume ; La Faucheuse: nouvelles"));
    expect(king("Les Trois Cartes")).not.toBe(king("La Tour Sombre 2 Les Trois Cartes(illustrée)"));
    expect(king("Les Trois Cartes")).not.toBe(king("Les Trois Cartes (illustrée)"));
    expect(king("Rêves et cauchemars")).not.toBe(king("Rêves et cauchemars (Tome 1)"));
    expect(king("Rêves et cauchemars (Tome 1)")).not.toBe(king("Rêves et cauchemars (Tome 2)"));
    expect(king("Sac d'os")).not.toBe(king("Sac d'os: la suite"));
    // Un trait d'union dans le titre n'est pas un sous-titre.
    expect(duplicateKey({ name: "Sauve-moi", authors: ["Guillaume Musso"] })).not.toBe(duplicateKey({ name: "Sauve", authors: ["Guillaume Musso"] }));
    // Le même titre chez deux auteurs reste deux livres.
    expect(king("Bazaar: roman")).not.toBe(duplicateKey({ name: "Bazaar", authors: ["Autre"] }));
  });
});
