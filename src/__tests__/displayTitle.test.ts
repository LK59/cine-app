import { describe, it, expect } from "vitest";
import { displayTitle, episodeCode } from "@/lib/displayTitle";

describe("displayTitle", () => {
  it("nomme un épisode par sa série, son numéro et son titre", () => {
    // Straight from this server, specials season and all.
    expect(
      displayTitle(
        {
          Name: "La Genèse",
          Type: "Episode",
          SeriesName: "La Petite Maison dans la prairie",
          ParentIndexNumber: 0,
          IndexNumber: 1,
        },
        "peu importe"
      )
    ).toBe("La Petite Maison dans la prairie — S00E01 · La Genèse");
  });

  it("se contente de ce qu'il a", () => {
    const series = { Type: "Episode", SeriesName: "Utopia" };
    expect(displayTitle({ ...series, IndexNumber: 3, ParentIndexNumber: 2 }, "x")).toBe("Utopia — S02E03");
    expect(displayTitle({ ...series, Name: "Sans numéro" }, "x")).toBe("Utopia — Sans numéro");
    expect(displayTitle(series, "x")).toBe("Utopia");
    // A season nobody numbered still numbers its episode.
    expect(displayTitle({ ...series, IndexNumber: 7 }, "x")).toBe("Utopia — E07");
  });

  it("laisse un film tranquille", () => {
    expect(displayTitle({ Name: "Aftersun", Type: "Movie" }, "x")).toBe("Aftersun");
  });

  it("garde ce que l'appelant avait quand le serveur ne dit rien", () => {
    // Eight callers pass eight different titles; none of them should be lost to a failed lookup.
    expect(displayTitle(null, "Ce que l'appelant savait")).toBe("Ce que l'appelant savait");
    expect(displayTitle({ Type: "Movie" }, "Ce que l'appelant savait")).toBe("Ce que l'appelant savait");
  });

  it("distingue une saison zéro d'une saison absente", () => {
    // Zero is where a server keeps its specials, and treating it as missing loses the season.
    expect(episodeCode({ ParentIndexNumber: 0, IndexNumber: 1 })).toBe("S00E01");
    expect(episodeCode({ IndexNumber: 1 })).toBe("E01");
    expect(episodeCode({ ParentIndexNumber: 1 })).toBeNull();
  });
});
