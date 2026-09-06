// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { recentSearches, rememberSearch, forgetSearches } from "@/lib/recentSearches";

beforeEach(() => window.localStorage.clear());

describe("recentSearches", () => {
  it("starts empty and keeps what was typed", () => {
    expect(recentSearches()).toEqual([]);
    rememberSearch("Nolan");
    expect(recentSearches()).toEqual(["Nolan"]);
  });

  it("puts the most recent first", () => {
    rememberSearch("Nolan");
    rememberSearch("Villeneuve");
    expect(recentSearches()).toEqual(["Villeneuve", "Nolan"]);
  });

  // Deux lignes pour la même recherche écrite autrement seraient du bruit ; mais on relit ce
  // qu'on a tapé, pas une version normalisée.
  it("does not repeat a search typed with another case, and shows the latest spelling", () => {
    rememberSearch("nolan");
    rememberSearch("Nolan");
    expect(recentSearches()).toEqual(["Nolan"]);
  });

  it("keeps the list short", () => {
    for (const q of ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"]) rememberSearch(q);
    expect(recentSearches()).toHaveLength(6);
    expect(recentSearches()[0]).toBe("h8");
  });

  // Une lettre n'est pas une recherche : la retenir remplirait la liste de bruit de frappe.
  it("ignores what is too short to be a search", () => {
    rememberSearch("a");
    rememberSearch("   ");
    expect(recentSearches()).toEqual([]);
  });

  it("trims what it keeps", () => {
    rememberSearch("  Dune  ");
    expect(recentSearches()).toEqual(["Dune"]);
  });

  it("forgets everything on request", () => {
    rememberSearch("Nolan");
    forgetSearches();
    expect(recentSearches()).toEqual([]);
  });

  it("survives a storage that refuses to answer", () => {
    window.localStorage.setItem("cine.player.recentSearches", "pas du json");
    expect(recentSearches()).toEqual([]);
  });
});

// `useSyncExternalStore` exige une identité stable tant que rien n'a changé : un nouveau tableau
// à chaque lecture le ferait boucler sans fin.
describe("recentSearches — identité de l'instantané", () => {
  it("gives back the same array until the list actually changes", () => {
    rememberSearch("Nolan");
    const first = recentSearches();
    expect(recentSearches()).toBe(first);

    rememberSearch("Villeneuve");
    expect(recentSearches()).not.toBe(first);
    expect(recentSearches()).toBe(recentSearches());
  });
});
