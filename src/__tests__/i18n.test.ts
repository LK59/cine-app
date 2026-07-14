import { describe, it, expect } from "vitest";
import {
  createT,
  getLocaleFromCookie,
  getTmdbLocale,
  getVideoLangs,
} from "@/lib/i18n";

describe("createT", () => {
  const dict = { greeting: "Bonjour {name}", nested: { key: "Valeur" } };
  const fallback = { greeting: "Hello {name}", onlyInFallback: "Fallback text" };
  const t = createT(dict, fallback);

  it("resolves a key from the primary dict", () => {
    expect(t("greeting", { name: "Louis" })).toBe("Bonjour Louis");
  });

  it("resolves a nested key", () => {
    expect(t("nested.key")).toBe("Valeur");
  });

  it("falls back to the fallback dict when key is missing", () => {
    expect(t("onlyInFallback")).toBe("Fallback text");
  });

  it("returns the key itself when missing from both dicts", () => {
    expect(t("totally.missing")).toBe("totally.missing");
  });

  it("leaves unresolved interpolation placeholders untouched", () => {
    expect(t("greeting")).toBe("Bonjour {name}");
  });
});

describe("getLocaleFromCookie", () => {
  it("extracts a known locale", () => {
    expect(getLocaleFromCookie("cine-lang=en")).toBe("en");
  });

  it("extracts locale among multiple cookies", () => {
    expect(getLocaleFromCookie("foo=bar; cine-lang=es; other=1")).toBe("es");
  });

  it("returns null for an unknown locale value", () => {
    expect(getLocaleFromCookie("cine-lang=xx")).toBeNull();
  });

  it("returns null when cookie is absent", () => {
    expect(getLocaleFromCookie("foo=bar")).toBeNull();
  });
});

describe("getTmdbLocale", () => {
  it("maps known locales", () => {
    expect(getTmdbLocale("en")).toBe("en-US");
    expect(getTmdbLocale("es")).toBe("es-ES");
    expect(getTmdbLocale("de")).toBe("de-DE");
  });

  it("defaults to fr-FR for unknown or missing locale", () => {
    expect(getTmdbLocale("fr")).toBe("fr-FR");
    expect(getTmdbLocale(undefined)).toBe("fr-FR");
    expect(getTmdbLocale(null)).toBe("fr-FR");
    expect(getTmdbLocale("xx")).toBe("fr-FR");
  });
});

describe("getVideoLangs", () => {
  it("maps known locales", () => {
    expect(getVideoLangs("en")).toBe("en,null");
    expect(getVideoLangs("es")).toBe("es,en,null");
    expect(getVideoLangs("de")).toBe("de,en,null");
  });

  it("defaults to fr priority list", () => {
    expect(getVideoLangs("fr")).toBe("fr,en,null");
    expect(getVideoLangs(undefined)).toBe("fr,en,null");
  });
});
