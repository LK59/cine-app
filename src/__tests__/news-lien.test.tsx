// @vitest-environment jsdom
/**
 * Une entrée de Nouveautés peut citer une adresse (`link`) : son hôte devient un lien cliquable là où
 * il paraît (23/10/2026, la page Laterna et sa nouvelle adresse).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));

import { NewsEntryRow } from "@/components/news/NewsContentView";
import { newsLink, sanitizeContent } from "@/lib/news/content";
import { laternaNewsContent } from "@/lib/news/pageLaterna";

afterEach(() => cleanup());

describe("le lien d'une entrée de Nouveautés", () => {
  it("rend l'hôte cliquable dans le titre et dans la phrase, et ouvre l'adresse à part", () => {
    const { container } = render(
      <ul>
        <NewsEntryRow
          entry={{ icon: "phone", title: "Une nouvelle adresse : app.example.org", text: "Ouvrez app.example.org, connectez-vous.", badge: "", link: "https://app.example.org/" }}
        />
      </ul>,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.textContent).toBe("app.example.org");
      expect(a.getAttribute("href")).toBe("https://app.example.org/");
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    expect(container.textContent).toContain("Une nouvelle adresse : app.example.org");
  });

  it("sans lien, aucun <a>", () => {
    const { container } = render(<ul><NewsEntryRow entry={{ icon: "phone", title: "app.example.org", text: "", badge: "" }} /></ul>);
    expect(container.querySelector("a")).toBeNull();
  });

  it("n'accepte qu'une adresse https sans identifiants", () => {
    expect(newsLink("https://app.example.org/")).toBe("https://app.example.org/");
    for (const bad of ["http://app.example.org/", "javascript:alert(1)", "https://u:p@app.example.org/", "pas une adresse", 42, undefined]) {
      expect(newsLink(bad), String(bad)).toBeUndefined();
    }
    const clean = sanitizeContent({ sections: [{ title: "N", entries: [{ icon: "phone", title: "T", text: "", badge: "", link: "javascript:alert(1)" }] }], fixesSummary: "", fixes: [] });
    expect(clean.sections[0].entries[0]).not.toHaveProperty("link");
  });

  it("la page Laterna porte le lien de sa nouvelle adresse dans chaque langue", () => {
    const content = laternaNewsContent("app.example.org");
    for (const lang of ["fr", "en", "es", "de"] as const) {
      const phone = content[lang]!.sections[0].entries.find((e) => e.icon === "phone")!;
      expect(phone.link, lang).toBe("https://app.example.org/");
      expect(phone.title + phone.text, lang).toContain("app.example.org");
    }
  });
});
