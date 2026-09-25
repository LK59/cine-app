import { describe, it, expect } from "vitest";
import {
  heroOffscreen,
  heroSignature,
  reconcileHeroOrder,
  resolveHeroCarousel,
  rowsDelayMs,
  noteHeroChange,
  upcomingImages,
} from "@/lib/heroCarousel";

/**
 * La bannière quand les données fraîches remplacent celles du cache (25/09/2026) : on suit le
 * titre affiché, une nouveauté vient au passage suivant, l'ordre officiel revient hors de l'écran.
 */
describe("reconcileHeroOrder", () => {
  it("prend l'ordre officiel quand rien n'était affiché", () => {
    expect(reconcileHeroOrder([], 0, ["a", "b"])).toEqual({ keys: ["a", "b"], index: 0 });
  });

  it("garde le titre à l'écran quand une nouveauté arrive en tête — l'index ne désigne pas un autre film", () => {
    // Le cache montrait A ; les données fraîches disent N, A, B, C.
    const next = reconcileHeroOrder(["a", "b", "c"], 0, ["n", "a", "b", "c"]);
    expect(next.keys[next.index]).toBe("a");
    // … et la nouveauté vient juste après lui : elle arrive au passage suivant.
    expect(next.keys[next.index + 1]).toBe("n");
  });

  it("garde le titre à sa place au milieu de la rotation — les barres ne sautent pas", () => {
    const next = reconcileHeroOrder(["a", "b", "c", "d", "e"], 2, ["n", "a", "b", "c", "d", "e"]);
    expect(next).toEqual({ keys: ["a", "b", "c", "n", "d", "e"], index: 2 });
  });

  it("place plusieurs nouveautés juste après, dans leur ordre officiel", () => {
    const next = reconcileHeroOrder(["a", "b"], 0, ["n1", "n2", "a", "b"]);
    expect(next.keys.slice(next.index)).toEqual(["a", "n1", "n2", "b"]);
  });

  it("ne bouge rien sans nouveauté, même si l'ordre officiel a changé", () => {
    expect(reconcileHeroOrder(["a", "b", "c"], 1, ["c", "b", "a"])).toEqual({ keys: ["a", "b", "c"], index: 1 });
  });

  it("retire un titre sorti de la liste, sauf celui qu'on regarde", () => {
    expect(reconcileHeroOrder(["a", "b", "c"], 1, ["a", "c"])).toEqual({ keys: ["a", "b", "c"], index: 1 });
    expect(reconcileHeroOrder(["a", "b", "c"], 0, ["a", "c"])).toEqual({ keys: ["a", "c"], index: 0 });
  });
});

describe("heroOffscreen — le moment de la remise à plat", () => {
  const route = { tab: "movies" as const, list: false, account: false, search: false, browse: null, activity: null };

  it("la bannière des films est à l'écran sur l'onglet Films", () => {
    expect(heroOffscreen("movies", route, "none")).toBe(false);
  });

  it.each([
    ["l'autre onglet", { ...route, tab: "series" as const }, "none"],
    ["Ma liste", { ...route, list: true }, "none"],
    ["le compte", { ...route, account: true }, "none"],
    ["la recherche", { ...route, search: true }, "none"],
    ["la grille complète", { ...route, browse: "*" }, "none"],
    ["l'activité", { ...route, activity: "1" }, "none"],
    ["un film en plein écran", route, "full"],
  ])("est hors de l'écran : %s", (_name, r, mode) => {
    expect(heroOffscreen("movies", r, mode)).toBe(true);
  });

  it("n'est pas hors de l'écran sous un film réduit : on la voit encore", () => {
    expect(heroOffscreen("movies", route, "mini")).toBe(false);
  });
});

describe("resolveHeroCarousel", () => {
  const films = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const keyOf = (f: { id: string }) => f.id;

  it("rend les titres dans l'ordre de la session", () => {
    expect(resolveHeroCarousel(["c", "a", "b"], 1, films, keyOf).items.map(keyOf)).toEqual(["c", "a", "b"]);
  });

  it("retrouve le titre à l'écran sorti de la liste, par le repli", () => {
    const gone = { id: "z" };
    const { items, index } = resolveHeroCarousel(["a", "z", "b"], 1, films, keyOf, (k) => (k === "z" ? gone : undefined));
    expect(items[index]).toBe(gone);
  });

  it("saute une clé introuvable sans décaler le titre désigné", () => {
    const { items, index } = resolveHeroCarousel(["x", "a", "b"], 2, films, keyOf);
    expect(items[index].id).toBe("b");
  });
});

describe("bannière d'abord, rangées ensuite", () => {
  it("les rangées attendent la fin du changement de bannière, puis plus du tout", () => {
    noteHeroChange(1000);
    expect(rowsDelayMs(1100)).toBe(200);
    expect(rowsDelayMs(1400)).toBe(0);
  });
});

describe("upcomingImages", () => {
  it("donne les images du titre suivant, en boucle, sans les vides", () => {
    const items = [{ a: "1.jpg", b: null }, { a: "2.jpg", b: "2-logo.png" }];
    const urlsOf = (i: { a: string; b: string | null }) => [i.a, i.b];
    expect(upcomingImages(items, 0, urlsOf)).toBe(heroSignature(["2.jpg", "2-logo.png"]));
    expect(upcomingImages(items, 1, urlsOf)).toBe(heroSignature(["1.jpg"]));
    expect(upcomingImages(items.slice(0, 1), 0, urlsOf)).toBe("");
  });
});
