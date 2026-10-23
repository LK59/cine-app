import { describe, it, expect, beforeEach } from "vitest";
import { getDb, applyFixesLedger } from "@/lib/db";
import { FIXES_LEDGER, compareVersions, ledgerTarget, type FixLedgerEntry } from "@/lib/news/fixesLedger";
import { NEWS_LANGS, NEWS_LIMITS, type NewsContentByLang } from "@/lib/news/content";

/**
 * Le registre des corrections (DECISIONS.md §73, 20/10/2026) : chaque entrée rejoint la liste de sa
 * page publiée, une fois, sans changer le rang de la page — personne ne revoit la fenêtre.
 */

const fr = (fixes: { title: string; items: string[] }[] = []) => ({ sections: [], fixesSummary: "", fixes });

function page(version: string, seq: number | null, content: NewsContentByLang, status = "published") {
  getDb()
    .prepare("INSERT INTO news_pages (version, content, status, seq, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, 1, 1, 1)")
    .run(version, JSON.stringify(content), status, seq);
}
const contentOf = (version: string) =>
  JSON.parse((getDb().prepare("SELECT content FROM news_pages WHERE version = ?").get(version) as { content: string }).content) as NewsContentByLang;

const entry = (over: Partial<FixLedgerEntry> = {}): FixLedgerEntry => ({
  page: "8.61",
  version: "8.55.0",
  group: { fr: "Lecture", en: "Playback", es: "Reproducción", de: "Wiedergabe" },
  items: [{ fr: "Un défaut corrigé.", en: "A fixed bug.", es: "Un fallo corregido.", de: "Ein behobener Fehler." }],
  ...over,
});

beforeEach(() => {
  getDb().prepare("DELETE FROM news_pages").run();
  getDb().prepare("DELETE FROM migrations_done WHERE name LIKE 'news-fix:%'").run();
});

describe("verser le registre", () => {
  it("ajoute à son groupe dans chaque langue, une seule fois, sans toucher au rang", () => {
    page("8.61", 3, { fr: fr([{ title: "Lecture", items: ["Déjà là."] }]), en: fr([{ title: "Playback", items: ["Already."] }]) });
    applyFixesLedger(getDb(), [entry()]);
    applyFixesLedger(getDb(), [entry()]);
    const c = contentOf("8.61");
    expect(c.fr.fixes).toEqual([{ title: "Lecture", items: ["Déjà là.", "Un défaut corrigé."] }]);
    expect(c.en?.fixes[0].items).toEqual(["Already.", "A fixed bug."]);
    expect((getDb().prepare("SELECT seq FROM news_pages WHERE version = '8.61'").get() as { seq: number }).seq).toBe(3);
  });

  it("crée le groupe s'il manque, et ne double pas un texte déjà présent", () => {
    page("9.0", 7, { fr: fr([{ title: "Navigation", items: ["Un défaut corrigé."] }]) });
    applyFixesLedger(getDb(), [entry({ page: "9.0", group: { fr: "Navigation", en: "Navigation", es: "Navegación", de: "Navigation" } }), entry({ page: "9.0", version: "8.70.0" })]);
    const c = contentOf("9.0");
    expect(c.fr.fixes.map((g) => g.title)).toEqual(["Navigation", "Lecture"]);
    expect(c.fr.fixes[0].items).toEqual(["Un défaut corrigé."]);
  });

  it("une page nommée encore en brouillon : l'entrée l'attend", () => {
    page("9.0", 7, { fr: fr() });
    page("9.1", null, { fr: fr() }, "draft");
    applyFixesLedger(getDb(), [entry({ page: "9.1", version: "9.1.1" })]);
    expect(contentOf("9.0").fr.fixes).toEqual([]);
    expect(contentOf("9.1").fr.fixes).toEqual([]);
  });

  it("sans page nommée : la première qui couvre la version, sinon la dernière publiée", () => {
    const pages = [{ version: "8.61", seq: 3 }, { version: "8.68", seq: 6 }, { version: "9.1", seq: 8 }];
    expect(ledgerTarget(entry({ page: undefined, version: "8.64.1" }), pages)?.version).toBe("8.68");
    expect(ledgerTarget(entry({ page: undefined, version: "8.61" }), pages)?.version).toBe("8.61");
    expect(ledgerTarget(entry({ page: undefined, version: "9.3.2" }), pages)?.version).toBe("9.1");
    expect(compareVersions("8.64.1", "8.64")).toBeGreaterThan(0);
  });
});

describe("le registre lui-même", () => {
  // « 10.0 » : la page de Laterna, semée seulement sur l'installation qui annonce sa nouvelle adresse ;
  // ailleurs `ledgerTarget` retombe sur la dernière page publiée.
  const pages = ["8.44", "8.48", "8.61", "8.64", "8.68", "9.0", "9.1", "10.0"];

  it("chaque entrée vise une page qui existe, dans les quatre langues, aux bornes d'une page", () => {
    for (const e of FIXES_LEDGER) {
      expect(pages, e.version).toContain(e.page);
      for (const lang of NEWS_LANGS) {
        expect(e.group[lang], `${e.version} ${lang}`).toBeTruthy();
        expect(e.group[lang].length).toBeLessThanOrEqual(NEWS_LIMITS.sectionTitle);
        for (const item of e.items) {
          expect(item[lang], `${e.version} ${lang}`).toBeTruthy();
          expect(item[lang].length).toBeLessThanOrEqual(NEWS_LIMITS.fixItem);
        }
      }
    }
  });

  it("ni titres masqués, ni vocabulaire d'infrastructure, et l'allemand au vouvoiement", () => {
    const all = FIXES_LEDGER.flatMap((e) => e.items);
    for (const item of all) {
      for (const lang of NEWS_LANGS) expect(item[lang]).not.toMatch(/masqu|bloqu.*tag|dashboard|tableau de bord|\bstack\b/i);
      expect(item.de).not.toMatch(/\b(du|dein|deine|dich|dir)\b/);
    }
  });
});
