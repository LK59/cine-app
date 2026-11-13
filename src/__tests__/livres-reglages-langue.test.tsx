// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Les réglages du lecteur de livres et « Mes demandes » dans la langue du compte (13/11/2026) : « 100 % »
 * écrit en dur avec l'espace française jusqu'en anglais, l'interligne au point décimal en allemand, la
 * date d'une demande dans la langue du navigateur et la réponse entre guillemets français partout.
 */
const L = vi.hoisted(() => ({ locale: "en" }));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    key === "books.reader.percent" ? (L.locale === "en" ? `${vars?.pct}%` : `${vars?.pct} %`) : key,
  useLocale: () => ({ locale: L.locale }),
}));

import { ReaderSettingsPanel } from "@/components/books/ReaderPanels";
import { defaultReaderPrefs } from "@/lib/books/readerPrefs";

const COLORS = { bg: "#000", fg: "#fff", link: "#fff", dark: true };

afterEach(() => cleanup());

describe("réglages du lecteur", () => {
  it("en anglais : « 100% », sans l'espace française", () => {
    L.locale = "en";
    const { container } = render(<ReaderSettingsPanel prefs={{ ...defaultReaderPrefs(), fontSize: 100 }} colors={COLORS} onChange={vi.fn()} onClose={vi.fn()} />);
    expect(container.textContent).toContain("100%");
    expect(container.textContent).not.toContain("100 %");
  });

  it("en allemand : l'interligne à la virgule", () => {
    L.locale = "de";
    const { container } = render(<ReaderSettingsPanel prefs={{ ...defaultReaderPrefs(), lineHeight: 1.5 }} colors={COLORS} onChange={vi.fn()} onClose={vi.fn()} />);
    expect(container.textContent).toContain("1,50");
  });
});

describe("Mes demandes de livres", () => {
  it("la date dans la langue du compte, la réponse entre les guillemets de sa langue", () => {
    const source = readFileSync(path.join(process.cwd(), "src/components/books/BookRequests.tsx"), "utf8");
    expect(source).not.toMatch(/toLocaleDateString\(\)/);
    expect(source).not.toMatch(/« \{request\.reply\} »/);
    for (const l of ["fr", "en", "es", "de"]) {
      const dict = JSON.parse(readFileSync(path.join(process.cwd(), `src/locales/${l}.json`), "utf8"));
      expect(dict.books.requests.reply, l).toContain("{text}");
    }
  });
});
