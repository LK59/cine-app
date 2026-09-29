// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { createT, type Locale } from "@/lib/i18n";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";

/**
 * La signature « CineApp 8.1 par LK59 · GitHub » (DECISIONS.md §41).
 *
 * La langue est celle du vrai dictionnaire, pas une clé renvoyée telle quelle : c'est la valeur de
 * `signature.by` dans chaque langue que Louis a choisie (29/09/2026), et c'est elle qu'on vérifie.
 */
const DICTS: Record<Locale, Record<string, unknown>> = { fr, en, es, de };
const lang = vi.hoisted(() => ({ current: "fr" as Locale }));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => createT(DICTS[lang.current], DICTS.fr, lang.current),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Le composant relu après avoir posé la version : `APP_VERSION` est figée au chargement du module. */
async function renderWith(version: string | undefined, locale: Locale) {
  lang.current = locale;
  // `undefined` retire la variable : c'est la suite de tests, ou `next dev`, hors de tout build.
  vi.stubEnv("NEXT_PUBLIC_APP_VERSION", version);
  vi.resetModules();
  const { AppSignature } = await import("@/components/AppSignature");
  const { container } = render(<AppSignature />);
  return container.querySelector<HTMLElement>("[data-app-signature]")!;
}

describe("AppSignature", () => {
  it.each([
    ["fr", "CineApp 8.1 par LK59 · GitHub"],
    ["en", "CineApp 8.1 by LK59 · GitHub"],
    ["es", "CineApp 8.1 por LK59 · GitHub"],
    ["de", "CineApp 8.1 von LK59 · GitHub"],
  ] as const)("%s : « %s »", async (locale, text) => {
    const line = await renderWith("8.1.0", locale);
    expect(line.textContent).toBe(text);
  });

  it("montre le correctif quand il n'est pas nul, et « dev » hors build", async () => {
    expect((await renderWith("8.1.2", "en")).textContent).toBe("CineApp 8.1.2 by LK59 · GitHub");
    cleanup();
    expect((await renderWith(undefined, "en")).textContent).toBe("CineApp dev by LK59 · GitHub");
  });

  it("le lien mène au dépôt, dans un nouvel onglet, sans fuite d'origine", async () => {
    const line = await renderWith("8.1.0", "fr");
    const link = line.querySelector("a")!;
    expect(link.textContent).toBe("GitHub");
    expect(link.getAttribute("href")).toBe("https://github.com/LK59/cine-app");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("aria-label")).toBe("Code source sur GitHub (nouvel onglet)");
  });
});
