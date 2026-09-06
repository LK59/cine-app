import { describe, it, expect } from "vitest";
import { filterByTitle, sortList } from "@/lib/playerListSort";

const item = (title: string, year: number | null, addedAt: number | null) => ({ title, year, addedAt });

const LIST = [
  item("Alien", 1979, 300),
  item("Élève libre", 2008, null),
  item("Rocky 2", 1979, 200),
  item("Rocky 10", 2019, null),
  item("Zodiac", 2007, 100),
];

describe("filterByTitle", () => {
  it("gives everything back when nothing is typed", () => {
    expect(filterByTitle(LIST, "   ")).toHaveLength(5);
  });

  it("matches anywhere in the title, whatever the case", () => {
    expect(filterByTitle(LIST, "  ROCKY ").map((i) => i.title)).toEqual(["Rocky 2", "Rocky 10"]);
    expect(filterByTitle(LIST, "lien").map((i) => i.title)).toEqual(["Alien"]);
  });

  it("returns nothing rather than everything when there is no match", () => {
    expect(filterByTitle(LIST, "vaisseau")).toEqual([]);
  });
});

describe("sortList", () => {
  it("puts the most recently added first", () => {
    expect(sortList(LIST, "added").map((i) => i.title)).toEqual([
      "Alien", "Rocky 2", "Zodiac", "Élève libre", "Rocky 10",
    ]);
  });

  // Les listes qui viennent de Jellyfin n'ont pas de date d'ajout : les jeter en tête du tri
  // « récemment ajouté » serait aussi faux que de prétendre qu'elles datent de 1970.
  it("sends the ones with no date to the end, in alphabetical order", () => {
    const undated = sortList(LIST, "added").slice(-2).map((i) => i.title);
    expect(undated).toEqual(["Élève libre", "Rocky 10"]);
  });

  it("sorts titles the way a French reader expects", () => {
    expect(sortList(LIST, "title").map((i) => i.title)).toEqual([
      "Alien", "Élève libre", "Rocky 2", "Rocky 10", "Zodiac",
    ]);
  });

  it("sorts by year, newest first, and tolerates a missing one", () => {
    const withUnknown = [...LIST, item("Sans année", null, 50)];
    expect(sortList(withUnknown, "year").map((i) => i.year)).toEqual([2019, 2008, 2007, 1979, 1979, null]);
  });

  // Sans départage, deux titres à égalité se suivent dans l'ordre du serveur, qui n'est pas stable
  // d'une réponse à l'autre : la liste se réordonnerait toute seule entre deux visites.
  it("breaks every tie on the title", () => {
    const tied = [item("Boréal", 1979, null), item("Abyss", 1979, null)];
    for (const sort of ["added", "year"] as const) {
      expect(sortList(tied, sort).map((i) => i.title)).toEqual(["Abyss", "Boréal"]);
    }
  });

  it("leaves the list it was given alone", () => {
    const before = [...LIST];
    sortList(LIST, "title");
    expect(LIST).toEqual(before);
  });
});
