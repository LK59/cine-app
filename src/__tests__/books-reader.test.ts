import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  READER_PREFS_KEY,
  defaultReaderPrefs,
  loadReaderPrefs,
  normalizeReaderPrefs,
  readerCss,
  zoomedFontSize,
  resolvedTheme,
  saveReaderPrefs,
} from "@/lib/books/readerPrefs";
import { continueReading, groupBooks } from "@/lib/books/grouping";
import { compareBooks, plainOverview, withoutFolderSeries } from "@/lib/books/library";
import { bookRouteHash, parseBookRoute } from "@/lib/books/bookRoute";
import { displayTitle } from "@/lib/books/displayTitle";
import type { BookSummary } from "@/lib/books/types";

/**
 * Le lecteur de livres et sa grille (DECISIONS.md §127) : les réglages gardés par appareil, la
 * feuille de style qu'ils produisent, l'ordre des séries, l'adresse des fiches — et la copie de
 * foliate-js, dont les deux correctifs locaux ne doivent pas se perdre à la prochaine mise à jour.
 */

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("les réglages du lecteur", () => {
  it("par défaut : la page glisse, ou un fondu quand le système demande moins de mouvement ; thème qui suit le système", () => {
    expect(defaultReaderPrefs(false)).toMatchObject({ turn: "slide", theme: "auto", font: "book", fontSize: 100, justify: false });
    expect(defaultReaderPrefs(true).turn).toBe("fade");
  });
  it("une valeur relue est ramenée aux choix possibles", () => {
    expect(normalizeReaderPrefs({ fontSize: 9999, lineHeight: 0.2, theme: "rose", turn: "curl", margin: "huge", font: "comic", brightness: 0, warmth: 7, justify: "oui" })).toEqual({
      ...defaultReaderPrefs(false),
      fontSize: 200,
      lineHeight: 1.1,
      brightness: 0.4,
      warmth: 1,
    });
    expect(normalizeReaderPrefs({ fontSize: 113 }).fontSize).toBe(110);
    expect(normalizeReaderPrefs(null)).toEqual(defaultReaderPrefs(false));
  });
  it("un stockage qui lève rend les valeurs par défaut, et l'écriture ne lève pas", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(loadReaderPrefs()).toEqual(defaultReaderPrefs(false));
    expect(() => saveReaderPrefs(defaultReaderPrefs(false))).not.toThrow();
  });
  it("relit ce qu'il a écrit", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    saveReaderPrefs({ ...defaultReaderPrefs(false), theme: "sepia", fontSize: 130 });
    expect(JSON.parse(store.get(READER_PREFS_KEY) ?? "{}").theme).toBe("sepia");
    expect(loadReaderPrefs()).toMatchObject({ theme: "sepia", fontSize: 130 });
  });
  it("une page, deux pages, auto ; l'ancien interrupteur « deux pages » coupé devient « une page »", () => {
    expect(normalizeReaderPrefs({}).layout).toBe("auto");
    expect(normalizeReaderPrefs({ layout: "double" }).layout).toBe("double");
    expect(normalizeReaderPrefs({ spread: false }).layout).toBe("single");
    expect(normalizeReaderPrefs({ layout: "triple" }).layout).toBe("auto");
  });
  it("le zoom écrit la taille du curseur : bornée, au pas de 10", () => {
    expect(zoomedFontSize(100, 1.37)).toBe(140);
    expect(zoomedFontSize(150, 10)).toBe(200);
    expect(zoomedFontSize(100, 0.1)).toBe(70);
    expect(zoomedFontSize(120, 0)).toBe(120);
    expect(zoomedFontSize(120, Number.NaN)).toBe(120);
  });
  it("`auto` suit le système", () => {
    expect(resolvedTheme("auto", true)).toBe("dark");
    expect(resolvedTheme("auto", false)).toBe("light");
    expect(resolvedTheme("black", false)).toBe("black");
  });
  it("la feuille de style porte la taille, l'interligne, la police, la justification et les couleurs du thème", () => {
    const css = readerCss({ ...defaultReaderPrefs(false), fontSize: 135, lineHeight: 1.7, font: "literata", justify: false, theme: "black" }, false, "https://laterna.example");
    expect(css).toContain("font-size: 135% !important");
    expect(css).toContain("line-height: 1.7 !important");
    expect(css).toContain(`"Laterna Literata"`);
    expect(css).toContain(`url("https://laterna.example/books/fonts/literata-latin.woff2")`);
    expect(css).toContain("text-align: start !important");
    expect(css).toContain("background: #000000 !important");
    // La police du livre : aucune pile imposée, aucune police déclarée.
    const original = readerCss(defaultReaderPrefs(false), true, "https://laterna.example");
    expect(original).not.toContain("font-family");
    expect(original).not.toContain("@font-face");
  });
  it("les polices proposées existent dans `public/books/fonts`, avec leur licence", () => {
    for (const f of ["literata-latin.woff2", "literata-latin-ext.woff2", "literata-latin-italic.woff2", "literata-latin-ext-italic.woff2", "outfit-latin.woff2", "outfit-latin-ext.woff2", "OFL-Literata.txt", "OFL-Outfit.txt"]) {
      expect(fs.existsSync(path.join(process.cwd(), "public/books/fonts", f)), f).toBe(true);
    }
  });
});

const book = (over: Partial<BookSummary>): BookSummary => ({
  id: "0".repeat(32),
  name: "x",
  coverTag: null,
  seriesName: null,
  index: null,
  year: null,
  authors: [],
  played: false,
  progress: null,
  ...over,
});

describe("la grille", () => {
  it("par série puis par tome, un tome inconnu après les autres, les livres sans série à la fin", () => {
    const books = [
      book({ name: "Seul" }),
      book({ name: "Hors-série", seriesName: "Cherub" }),
      book({ name: "Soleil noir", seriesName: "Cherub", index: 8 }),
      book({ name: "Mad dogs", seriesName: "Cherub", index: 8 }),
      book({ name: "Tome 10", seriesName: "Cherub", index: 10 }),
      book({ name: "Tome 2", seriesName: "Cherub", index: 2 }),
      book({ name: "A", seriesName: "Autre série", index: 1 }),
    ].sort(compareBooks);
    expect(books.map((b) => b.name)).toEqual(["A", "Tome 2", "Mad dogs", "Soleil noir", "Tome 10", "Hors-série", "Seul"]);
    const groups = groupBooks(books);
    expect(groups.map((g) => [g.series, g.books.length])).toEqual([["Autre série", 1], ["Cherub", 5], [null, 1]]);
  });
  it("« Continuer la lecture » : commencés, pas finis, le plus récent d'abord", () => {
    const p = (fraction: number, updatedAt: number, finished = false) => ({ cfi: "epubcfi(/6/2)", fraction, updatedAt, finished });
    const list = continueReading([
      book({ name: "fini", progress: p(1, 5, true) }),
      book({ name: "ancien", progress: p(0.3, 1) }),
      book({ name: "récent", progress: p(0.6, 9) }),
      book({ name: "jamais" }),
    ]);
    expect(list.map((b) => b.name)).toEqual(["récent", "ancien"]);
  });
  it("une « série » d'un seul livre sans tome est le nom de son dossier : le livre n'a pas de série", () => {
    const out = withoutFolderSeries([book({ name: "racine", seriesName: "books" }), book({ name: "hs", seriesName: "Cherub" }), book({ name: "t1", seriesName: "Cherub", index: 1 }), book({ name: "seul numéroté", seriesName: "Saga", index: 1 })]);
    expect(out.map((b) => b.seriesName)).toEqual([null, "Cherub", "Cherub", "Saga"]);
  });
  it("un résumé en HTML devient du texte", () => {
    expect(plainOverview("<p>Un&nbsp;<i>résumé</i></p><p>L&#39;autre &amp; fin</p>")).toBe("Un résumé\nL'autre & fin");
    expect(plainOverview(null)).toBe("");
  });
});

describe("l'adresse de la page des livres", () => {
  it("fiche et lecteur dans le fragment, un identifiant mal formé ne vaut rien", () => {
    const id = "ab".repeat(16);
    expect(parseBookRoute(`#livre=${id}`)).toEqual({ book: id, reading: false });
    expect(parseBookRoute(`#livre=${id}&lire`)).toEqual({ book: id, reading: true });
    expect(parseBookRoute("#livre=../../x&lire")).toEqual({ book: null, reading: false });
    expect(bookRouteHash({ book: id, reading: true })).toBe(`#livre=${id}&lire`);
  });
});

describe("la copie de foliate-js", () => {
  it("ses cadres n'ont jamais `allow-scripts` (correctif local)", () => {
    for (const f of ["paginator.js", "fixed-layout.js"]) {
      const src = read(`src/lib/books/foliate/${f}`);
      expect(src, f).not.toMatch(/allow-scripts['"]/);
      expect(src, f).toMatch(/setAttribute\('sandbox', 'allow-same-origin'\)/);
    }
  });
  it("n'ouvre que l'EPUB : aucun module absent n'est importé", () => {
    const dir = path.join(process.cwd(), "src/lib/books/foliate");
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      for (const m of read(`src/lib/books/foliate/${f}`).matchAll(/(?:from\s+|import\()\s*['"](\.\/[^'"]+)['"]/g)) {
        expect(fs.existsSync(path.join(dir, m[1])), `${f} → ${m[1]}`).toBe(true);
      }
    }
  });
  it("dit d'où elle vient : commit, licences", () => {
    // `UPSTREAM` et non le README : les `.md` ne vont pas dans l'image (`.dockerignore`), où les tests tournent aussi.
    expect(read("src/lib/books/foliate/UPSTREAM")).toMatch(/^https:\/\/github.com\/johnfactotum\/foliate-js\n[0-9a-f]{40}\n$/);
    expect(read("src/lib/books/foliate/LICENSE")).toMatch(/MIT/);
    expect(read("src/lib/books/foliate/vendor/zip.js.LICENSE")).toMatch(/BSD/);
  });
});

describe("le titre affiché", () => {
  it.each([
    ["Cherub - Tome 3 - Arizona Max", "Cherub", 3, "Arizona Max"],
    ["CHERUB 02 - Trafic", "Cherub", 2, "Trafic"],
    ["Cherub mission 16 - Hors la loi", "Cherub", 16, "Hors la loi"],
    ["Tome 13 - Le clan Aramov", "Cherub", 13, "Le clan Aramov"],
    ["Cherub - Cherub : Dossiers secrets", "Cherub", null, "Dossiers secrets"],
    ["100 jours en enfer", "Cherub", 1, "100 jours en enfer"],
    ["Harry Potter et la Chambre des secrets", "Harry Potter", 2, "Harry Potter et la Chambre des secrets"],
    ["Cherub - Tome 4", "Cherub", 4, "Tome 4"],
    ["Cherub", "Cherub", 1, "Cherub"],
    ["Seul", null, null, "Seul"],
    ["3 - Un titre", null, 3, "Un titre"],
    ["1984", null, 1, "1984"],
  ] as const)("%s → %s", (name, seriesName, index, expected) => {
    expect(displayTitle({ name, seriesName, index })).toBe(expected);
  });
});
